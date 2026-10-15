"""Real-library tests for the native implicit cloth reference adapter."""
import copy
import math
import importlib.util
from pathlib import Path
import unittest
import numpy as np

path=Path(__file__).with_name('ipc-cloth.py')
backend=None
if path.exists():
    spec=importlib.util.spec_from_file_location('ipc_cloth',path)
    backend=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(backend)

def payload():
    cloth=[0,0,.0005,.01,0,.0005,.005,.01,.0005]
    return {'version':1,'epoch':2,'requestId':7,'designId':'test','designRevision':3,'baseStateId':'state-1',
        'snapshot':{'positions':cloth,'rest':cloth.copy(),'velocities':[0,0,-.06]*3,
                    'triangles':[0,1,2],'constraints':[],'pins':[],'pinTargets':[],
                    'density':.12,'materialLaw':None,'strainLimit':2},
        'context':{'pose':0},'step':{'pose':0,'dt':1/60,'gravity':False,'collider':True,'selfCollision':False,'continuousCollision':True,'quality':'reference'},
        'body':{'previousPositions':[0,0,0,.01,0,0,.005,.01,0],
                'targetPositions':[0,0,0,.01,0,0,.005,.01,0],'triangles':[0,1,2]}}

class NativeClothTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(backend,'native reference module must exist')

    def test_elastic_energy_force_and_hessian_match_physical_compliance(self):
        x=np.array([[0.,0,0],[1.1,0,0]])
        c=[{'a':0,'b':1,'restLength':1.,'compliance':.5,'stiffness':8,'kind':'warp'}]
        energy,gradient,hessian=backend.elastic_terms(x,c)
        self.assertAlmostEqual(energy,.01)
        np.testing.assert_allclose(gradient,[-.2,0,0,.2,0,0],atol=1e-12)
        eps=1e-6
        for j in range(6):
            plus=x.copy().reshape(-1);minus=plus.copy();plus[j]+=eps;minus[j]-=eps
            ep,gp,_=backend.elastic_terms(plus.reshape(-1,3),c)
            em,gm,_=backend.elastic_terms(minus.reshape(-1,3),c)
            self.assertAlmostEqual((ep-em)/(2*eps),gradient[j],places=7)
            np.testing.assert_allclose((gp-gm)/(2*eps),hessian.toarray()[:,j],atol=1e-6)

    def test_compressive_spring_uses_psd_newton_hessian_without_changing_force(self):
        e,g,h=backend.elastic_terms(np.array([[0.,0,0],[.8,0,0]]),[{'a':0,'b':1,'restLength':1,'compliance':.5}])
        self.assertAlmostEqual(e,.04)
        self.assertAlmostEqual(g[0],.4)
        self.assertGreaterEqual(np.linalg.eigvalsh(h.toarray()).min(),-1e-12)

    def test_exact_system_newton_option_retains_compressive_curvature_and_derivative(self):
        x=np.array([[0.,0,0],[.8,0,0]])
        springs=backend.ElasticSprings([{'a':0,'b':1,'restLength':1,'compliance':.5}],2)
        e,g,h=springs.evaluate(x,hessian_policy='exact')
        eps=1e-6;plus=x.copy();minus=x.copy();plus[1,1]+=eps;minus[1,1]-=eps
        _,gp,_=springs.evaluate(plus,False);_,gm,_=springs.evaluate(minus,False)
        np.testing.assert_allclose((gp-gm)/(2*eps),h.toarray()[:,4],atol=1e-8)
        self.assertLess(np.linalg.eigvalsh(h.toarray()).min(),-.1)

    def test_native_barrier_keeps_a_through_body_target_on_the_original_side(self):
        request=payload();before=copy.deepcopy(request)
        result=backend.solve_step(request)
        self.assertTrue(result['committed'],result)
        self.assertEqual(result['pose'],0)
        self.assertEqual(result['advancedTime'],request['step']['dt'])
        self.assertGreater(np.asarray(result['positions']).reshape(-1,3)[:,2].min(),0)
        self.assertTrue(result['diagnostics']['collisionFree'])
        self.assertTrue(result['diagnostics']['bodyUnchanged'])
        self.assertFalse(result['diagnostics']['physicsValidated'])
        self.assertEqual(request,before,'stateless solve must not mutate the source request')

    def test_kinematic_pins_stay_exact_under_gravity(self):
        request=payload();request['step'].update(gravity=True,collider=False)
        request['snapshot']['velocities']=[0]*9
        request['snapshot']['pins']=[0]
        request['snapshot']['pinTargets']=[[0,request['snapshot']['positions'][:3]]]
        result=backend.solve_step(request)
        self.assertTrue(result['committed'],result)
        self.assertEqual(result['positions'][:3],request['snapshot']['positions'][:3])
        self.assertLess(result['positions'][4],request['snapshot']['positions'][4])
        self.assertTrue(np.isfinite(result['velocities']).all())

    def test_unsupported_motion_and_material_are_atomic_failures(self):
        for mutate in [lambda r:r['step'].update(pose=1),lambda r:r['snapshot'].update(materialLaw={'schema':'silk-material'})]:
            request=payload();mutate(request);before=copy.deepcopy(request)
            result=backend.solve_step(request)
            self.assertFalse(result['committed'])
            self.assertEqual(result['advancedTime'],0)
            self.assertEqual(result['pose'],request['context']['pose'])
            self.assertEqual(result['positions'],request['snapshot']['positions'])
            self.assertEqual(request,before)

    def test_self_only_switch_does_not_silently_enable_body_contact(self):
        request=payload();request['step'].update(collider=False,selfCollision=True)
        result=backend.solve_step(request)
        self.assertTrue(result['committed'],result)
        self.assertLess(np.asarray(result['positions']).reshape(-1,3)[:,2].max(),0)
        self.assertFalse(result['diagnostics']['bodyContactEnabled'])

    def test_missing_body_has_explicit_unsupported_result(self):
        request=payload();request['body']=None
        result=backend.solve_step(request)
        self.assertFalse(result['committed'])
        self.assertEqual(result['status'],'unsupported')
        self.assertEqual(result['positions'],request['snapshot']['positions'])

    def test_minimum_contact_gap_is_independent_of_barrier_activation_width(self):
        request=payload();request['snapshot']['velocities']=[0]*9
        request['referenceSettings']={'minimumDistance':.0001,'activationDistance':.00005}
        result=backend.solve_step(request)
        self.assertTrue(result['committed'],result)
        self.assertEqual(result['diagnostics']['minimumDistanceM'],.0001)

    def test_stiff_stationary_spring_uses_displacement_and_energy_convergence_scale(self):
        request=payload();request['step'].update(gravity=True,collider=False)
        request['snapshot']['velocities']=[0]*9
        request['snapshot']['pins']=[0,2]
        request['snapshot']['pinTargets']=[[i,request['snapshot']['positions'][i*3:i*3+3]] for i in [0,2]]
        request['snapshot']['constraints']=[{'a':0,'b':1,'kind':'warp','restLength':.01,'compliance':1e-14},
            {'a':2,'b':1,'kind':'weft','restLength':math.sqrt(.005**2+.01**2),'compliance':1e-14}]
        request['referenceSettings']={'gradientTolerance':1e-16}
        result=backend.solve_step(request)
        self.assertTrue(result['committed'],result)
        self.assertTrue(result['converged'])
        self.assertLess(np.max(np.abs(np.asarray(result['positions'])-request['snapshot']['positions'])),1e-8)

    def test_prescribed_body_motion_reaches_full_target_with_feasible_cloth_warmstart(self):
        request=payload();request['snapshot']['velocities']=[0]*9
        request['step']['pose']=.7
        request['body']['previousPositions']=[-.02,-.02,0,.03,-.02,0,.005,.04,0]
        request['body']['targetPositions']=request['body']['previousPositions'].copy()
        body=np.asarray(request['body']['targetPositions']).reshape(-1,3);body[:,2]+=.001
        request['body']['targetPositions']=body.ravel().tolist()
        result=backend.solve_step(request)
        self.assertTrue(result['committed'],result)
        self.assertEqual(result['pose'],.7)
        self.assertEqual(result['advancedTime'],1/60)
        self.assertGreater(np.asarray(result['positions']).reshape(-1,3)[:,2].min(),.001)
        self.assertTrue(result['diagnostics']['bodyTargetReached'])
        self.assertGreater(len(result['diagnostics']['bodyContinuation']),0)
        self.assertTrue(all(v['collisionFree'] for v in result['diagnostics']['bodyContinuation']))

    def test_last_prescribed_body_target_is_copied_exactly_despite_interpolation_roundoff(self):
        request=payload();request['snapshot']['velocities']=[0]*9;request['step']['pose']=.7
        a=np.asarray(request['body']['previousPositions']).reshape(-1,3);a[:,2]=.0001
        b=a.copy();b[:,2]=-.0002
        request['body']['previousPositions']=a.ravel().tolist();request['body']['targetPositions']=b.ravel().tolist()
        self.assertFalse(np.array_equal(a+(b-a),b),'fixture must expose endpoint roundoff')
        result=backend.solve_step(request)
        self.assertTrue(result['committed'],result)
        self.assertTrue(result['diagnostics']['bodyTargetReached'])

    def test_contact_mollifier_uses_fixed_natural_reference_at_the_same_current_geometry(self):
        x=np.array([[-.005,0,0],[.005,0,0],[0,-.01,0],[-.004,.0001,.0002],[.006,.00011,.0002],[0,.01,.0002]])
        faces=np.array([[0,1,2],[3,4,5]],dtype=np.int32);natural=x*.5
        mesh=backend.make_contact_mesh(natural[:3],natural[3:],faces[:1],faces[1:]-3)
        mesh.can_collide=backend.ipctk.make_static_obstacle_filter(3)
        c=backend.ipctk.NormalCollisions();c.build(mesh,x,.001);barrier=backend.ipctk.BarrierPotential(.001,100)
        expected=backend.ipctk.CollisionMesh(natural,backend.ipctk.edges(faces),faces)
        expected.can_collide=mesh.can_collide
        ec=backend.ipctk.NormalCollisions();ec.build(expected,x,.001)
        dynamic=backend.ipctk.CollisionMesh(x,backend.ipctk.edges(faces),faces);dynamic.can_collide=mesh.can_collide
        dc=backend.ipctk.NormalCollisions();dc.build(dynamic,x,.001)
        self.assertAlmostEqual(barrier(c,mesh,x),barrier(ec,expected,x),delta=1e-20)
        self.assertGreater(abs(barrier(c,mesh,x)-barrier(dc,dynamic,x)),1e-12)

    def test_contact_reference_identity_is_layout_independent_and_includes_fixed_topology(self):
        r=payload();cloth=np.asarray(r['snapshot']['rest']).reshape(-1,3);body=np.asarray(r['body']['previousPositions']).reshape(-1,3)
        faces=np.array([[0,1,2]],dtype=np.int32)
        identity=backend.contact_reference_hash(cloth,body,faces,faces)
        self.assertEqual(identity,backend.contact_reference_hash(np.asfortranarray(cloth),np.asfortranarray(body),faces,faces))
        self.assertNotEqual(identity,backend.contact_reference_hash(cloth,body,faces,faces[:,[0,2,1]]))

if __name__=='__main__':
    unittest.main()
