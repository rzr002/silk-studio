#!/usr/bin/env python3
"""Stateless implicit cloth reference using the installed open-source IPC Toolkit.

Units: metres, seconds, kilograms; spring compliance m/N. The incremental
potential is inertia m/(2h^2)||x-x_tilde||^2 + distance-spring energy + IPC
barrier. Spring Hessians are projected to PSD for Newton; forces are unchanged.
This is a frictionless, uncalibrated numerical reference, not manufacturing proof.
No request mutates its source or commits a partial physical time step.
"""
import argparse
import copy
import hashlib
import json
import math
import os
import time
import warnings

os.environ.setdefault('TBB_NUM_THREADS','1')
import ipctk
ipctk.set_num_threads(1)
import numpy as np
from scipy.sparse import coo_matrix,diags
from scipy.sparse.linalg import spsolve,MatrixRankWarning


class ReferenceError(Exception):
    def __init__(self,message,status='invalid-input',diagnostics=None):
        super().__init__(message)
        self.status=status
        self.diagnostics=diagnostics or {}


def matrix(value,label,columns=3):
    result=np.asarray(value,dtype=float)
    if not result.size or result.size%columns or not np.isfinite(result).all():
        raise ReferenceError(f'{label} must be a finite {columns}-column array')
    return np.asfortranarray(result.reshape(-1,columns))


def indices(value,n,label):
    raw=matrix(value,label)
    if np.any(raw!=np.floor(raw)) or raw.min()<0 or raw.max()>=n:
        raise ReferenceError(f'{label} has invalid vertex indices')
    faces=raw.astype(np.int32,order='F')
    if np.any((faces[:,0]==faces[:,1])|(faces[:,0]==faces[:,2])|(faces[:,1]==faces[:,2])):
        raise ReferenceError(f'{label} has repeated triangle vertices')
    return faces


class ElasticSprings:
    def __init__(self,constraints,n):
        self.n=n
        self.source=constraints
        self.a=np.array([c['a'] for c in constraints],dtype=np.int32)
        self.b=np.array([c['b'] for c in constraints],dtype=np.int32)
        self.rest=np.array([c['restLength'] for c in constraints],dtype=float)
        compliance=np.array([c['compliance'] for c in constraints],dtype=float)
        if np.any(self.a<0) or np.any(self.b<0) or np.any(self.a>=n) or np.any(self.b>=n) or np.any(self.a==self.b):
            raise ReferenceError('Invalid spring endpoints')
        if not np.isfinite(self.rest).all() or np.any(self.rest<=0) or not np.isfinite(compliance).all() or np.any(compliance<=0):
            raise ReferenceError('Native springs require positive finite rest length and compliance; hard zero-compliance constraints are unsupported','unsupported')
        # Local linear stiffness is ALREADY represented in compliance. Applying
        # c.stiffness again would square the effect of setRegion multipliers.
        self.k=1/compliance
        local=np.arange(3)
        ai=self.a[:,None]*3+local;bi=self.b[:,None]*3+local
        self.rows=np.concatenate([np.repeat(ai,3,axis=1).ravel(),np.repeat(bi,3,axis=1).ravel(),np.repeat(ai,3,axis=1).ravel(),np.repeat(bi,3,axis=1).ravel()])
        self.cols=np.concatenate([np.tile(ai,(1,3)).ravel(),np.tile(bi,(1,3)).ravel(),np.tile(bi,(1,3)).ravel(),np.tile(ai,(1,3)).ravel()])

    def evaluate(self,x,hessian=True,gradient=True,hessian_policy='psd'):
        if not len(self.a):
            return 0.,np.zeros(self.n*3),coo_matrix((self.n*3,self.n*3)).tocsc() if hessian else None
        delta=x[self.a]-x[self.b]
        length=np.linalg.norm(delta,axis=1)
        if np.any(length<1e-14):
            raise ReferenceError('Collapsed spring has no unique force direction','degenerate-state')
        direction=delta/length[:,None]
        extension=length-self.rest
        energy=float(.5*np.dot(self.k,extension*extension))
        if not gradient:
            return energy,None,None
        force=(self.k*extension)[:,None]*direction
        gradient=np.zeros_like(x)
        np.add.at(gradient,self.a,force);np.add.at(gradient,self.b,-force)
        if not hessian:
            return energy,gradient.ravel(),None
        # Exact tensile Hessian; compressive tangential eigenvalues are clamped.
        tangential=1-self.rest/length
        tangent=self.k*(tangential if hessian_policy=='exact' else np.maximum(0.,tangential))
        block=tangent[:,None,None]*np.eye(3)+(self.k-tangent)[:,None,None]*np.einsum('ij,ik->ijk',direction,direction)
        values=block.ravel()
        h=coo_matrix((np.concatenate([values,values,-values,-values]),(self.rows,self.cols)),shape=(self.n*3,self.n*3)).tocsc()
        return energy,gradient.ravel(),h


def elastic_terms(positions,constraints):
    x=matrix(positions,'positions')
    return ElasticSprings(constraints,len(x)).evaluate(x)


def lumped_mass(rest,faces,density):
    area=np.linalg.norm(np.cross(rest[faces[:,1]]-rest[faces[:,0]],rest[faces[:,2]]-rest[faces[:,0]]),axis=1)*.5
    if np.any(area<1e-16):
        raise ReferenceError('Natural mesh has a zero-area face')
    masses=np.zeros(len(rest))
    for column in range(3):
        np.add.at(masses,faces[:,column],area*density/3)
    return masses


def make_contact_mesh(cloth_rest,body_reference,cloth_faces,body_faces):
    """Build IPC reference metrics independently of the dynamic current pose.

    In particular, IPC's edge-edge mollifier derives its epsilon from rest
    edge lengths. Reinitializing these from every HTTP step's deformed cloth
    silently changes the contact energy between requests.
    """
    reference=np.asfortranarray(np.vstack([cloth_rest,body_reference]))
    faces=np.asfortranarray(np.vstack([cloth_faces,body_faces+len(cloth_rest)]))
    return ipctk.CollisionMesh(reference,ipctk.edges(faces),faces)


CONTACT_HASH_FORMAT='silk-contact-reference-v1: counts=i64le-C[nCloth,nBody,nClothFaces,nBodyFaces]; positions=f64le-C[clothNatural,bodyReference]; faces=i32le-C[clothFaces,bodyFaces+nCloth]'


def contact_reference_hash(cloth_rest,body_reference,cloth_faces,body_faces):
    counts=np.asarray([len(cloth_rest),len(body_reference),len(cloth_faces),len(body_faces)],dtype='<i8')
    reference=np.asarray(np.vstack([cloth_rest,body_reference]),dtype='<f8')
    faces=np.asarray(np.vstack([cloth_faces,body_faces+len(cloth_rest)]),dtype='<i4')
    digest=hashlib.sha256(b'silk-contact-reference-v1\0')
    for array in [counts,reference,faces]:
        digest.update(array.tobytes(order='C'))
    return digest.hexdigest()


def _failure(request,status,message,start,extra=None):
    snapshot=request.get('snapshot') or {}
    context=request.get('context') or {}
    return {'version':1,**{key:request.get(key) for key in ['epoch','requestId','designId','designRevision','baseStateId']},
            'committed':False,'status':status,'message':str(message),'advancedTime':0.,
            'pose':context.get('pose',0),'positions':copy.deepcopy(snapshot.get('positions',[])),
            'velocities':copy.deepcopy(snapshot.get('velocities',[])),
            'lambdas':[c.get('lambda',0) for c in snapshot.get('constraints',[])],
            'grabForceN':snapshot.get('grabForceN',0),'collisionStats':copy.deepcopy(snapshot.get('collisionStats',{})),
            'ms':(time.perf_counter()-start)*1000,'converged':False,
            'diagnostics':{'engine':'ipctk-native-reference','collisionFree':False,'physicsValidated':False,'manufacturingVerified':False,**(extra or {})}}


def _material_neighbours(rest,faces,distance):
    adjacency=[{} for _ in rest]
    for face in faces:
        for k in range(3):
            a,b=int(face[k]),int(face[(k+1)%3]);length=float(np.linalg.norm(rest[a]-rest[b]))
            adjacency[a][b]=length;adjacency[b][a]=length
    nearby=[]
    import heapq
    for source in range(len(rest)):
        distances={source:0.};queue=[(0.,source)]
        while queue:
            cost,a=heapq.heappop(queue)
            if cost!=distances[a]:
                continue
            for b,length in adjacency[a].items():
                candidate=cost+length
                if candidate<=distance and candidate<distances.get(b,math.inf):
                    distances[b]=candidate;heapq.heappush(queue,(candidate,b))
        nearby.append(set(distances))
    return nearby


def solve_step(request):
    """Return a full committed step or an atomic refusal under protocol version 1.

    The browser owns accepted state. All arrays are copied; no server model
    session, hidden body history, partial pose, or fallback XPBD solve exists.
    """
    start=time.perf_counter()
    try:
        return _solve_step(request,start)
    except ReferenceError as error:
        return _failure(request,error.status,error,start,error.diagnostics)
    except Exception as error:
        return _failure(request,'solver-error',f'{type(error).__name__}: {error}',start)


def _solve_step(request,start):
    if request.get('version')!=1:
        raise ReferenceError('Unsupported native protocol version')
    snapshot=request['snapshot'];step=request['step'];context=request['context'];body=request.get('body')
    if not isinstance(body,dict):
        raise ReferenceError('The native reference currently requires an explicit body mesh; body-free lab scenes are unsupported','unsupported')
    if snapshot.get('materialLaw') is not None:
        raise ReferenceError('Nonlinear directional material laws are not yet supported by this linear native reference','unsupported')
    pose=float(context['pose']);target_pose=float(step['pose'])
    if not math.isfinite(pose) or not math.isfinite(target_pose) or not 0<=pose<=55 or not 0<=target_pose<=55:
        raise ReferenceError('Body pose must be within 0–55 degrees')
    body0=matrix(body['previousPositions'],'previous body');body1=matrix(body['targetPositions'],'target body')
    if body0.shape!=body1.shape:
        raise ReferenceError('Moving body topology must remain unchanged','unsupported-body-motion')
    if pose!=target_pose and np.array_equal(body0,body1):
        raise ReferenceError('Requested pose changed but the supplied body geometry did not','unsupported-body-motion')
    if body.get('referencePositions') is None and pose!=0:
        raise ReferenceError('A nonzero accepted pose requires the fixed canonical body reference','unsupported')
    body_reference=matrix(body.get('referencePositions',body0),'body contact reference')
    if body_reference.shape!=body0.shape:
        raise ReferenceError('Body contact reference topology does not match')
    x0=matrix(snapshot['positions'],'cloth');rest=matrix(snapshot['rest'],'natural cloth');velocity=matrix(snapshot['velocities'],'velocities')
    n=len(x0)
    if n>40000 or len(body0)>100000 or rest.shape!=x0.shape or velocity.shape!=x0.shape:
        raise ReferenceError('Invalid native mesh sizes')
    cf=indices(snapshot['triangles'],n,'cloth triangles');bf=indices(body['triangles'],len(body0),'body triangles')
    density=float(snapshot.get('density',.12))
    if not math.isfinite(density) or density<=0:
        raise ReferenceError('Invalid surface density')
    mass=lumped_mass(rest,cf,density)
    if not np.isfinite(mass).all():
        raise ReferenceError('Nonfinite surface mass')
    springs=ElasticSprings(snapshot['constraints'],n)
    pins=snapshot.get('pins',[]);targets=dict(snapshot.get('pinTargets',[]))
    if len(set(pins))!=len(pins) or set(pins)!=set(targets):
        raise ReferenceError('Pinned indices and targets must agree')
    locked=np.flatnonzero(mass<=0).tolist()+pins
    for i in pins:
        if not isinstance(i,int) or i<0 or i>=n or len(targets[i])!=3 or not np.isfinite(targets[i]).all():
            raise ReferenceError('Invalid fixed target')
        if not np.array_equal(x0[i],targets[i]):
            raise ReferenceError('Moving kinematic cloth targets require continuation and are not yet supported','unsupported')
    grab=step.get('grabbed')
    if grab is not None:
        i=grab['index'];target=np.asarray(grab['target'],dtype=float)
        if not isinstance(i,int) or i<0 or i>=n or target.shape!=(3,) or not np.isfinite(target).all():
            raise ReferenceError('Invalid grab')
        if not np.array_equal(x0[i],target):
            raise ReferenceError('Moving grab targets are not yet supported by native reference','unsupported')
        locked.append(i)
    free_vertex=np.ones(n,dtype=bool);free_vertex[locked]=False
    free=np.flatnonzero(np.repeat(free_vertex,3))
    if not len(free):
        raise ReferenceError('No dynamic cloth degrees of freedom')
    dt=float(step['dt'])
    if not math.isfinite(dt) or not 0<dt<=1/30:
        raise ReferenceError('Invalid timestep')
    for key in ['gravity','collider','selfCollision','continuousCollision']:
        if not isinstance(step.get(key),bool):
            raise ReferenceError(f'{key} must be Boolean')
    if step['collider'] and not step['continuousCollision']:
        raise ReferenceError('Native reference requires continuous collision checking when body contact is enabled','unsupported')
    options=request.get('referenceSettings') or {}
    elastic_hessian=options.get('elasticHessian','psd')
    if elastic_hessian not in ['psd','exact-descent']:
        raise ReferenceError('Invalid elastic Hessian strategy')
    dhat=float(options.get('activationDistance',.001));dmin=float(options.get('minimumDistance',0))
    if not math.isfinite(dhat) or dhat<=0 or dhat>.02 or not math.isfinite(dmin) or not 0<=dmin<=.02:
        raise ReferenceError('Invalid numerical barrier distances')
    substeps=int(options.get('substeps',6 if step.get('quality')=='reference' else 1))
    if not 1<=substeps<=6:
        raise ReferenceError('Invalid reference substep count')
    h=dt/substeps
    max_iterations=int(options.get('maxIterations',{'fast':20,'standard':40,'reference':300}.get(step.get('quality'),40)))
    if not 1<=max_iterations<=1000:
        raise ReferenceError('Invalid Newton iteration bound')
    gradient_tolerance=float(options.get('gradientTolerance',1e-7))
    displacement_tolerance=float(options.get('displacementToleranceM',1e-6))
    decrement_tolerance=float(options.get('decrementToleranceJ',1e-12))
    if any(not math.isfinite(v) or v<=0 for v in [gradient_tolerance,displacement_tolerance,decrement_tolerance]):
        raise ReferenceError('Convergence tolerances must be positive and finite')
    x=np.asfortranarray(np.vstack([x0,body0]));faces=np.asfortranarray(np.vstack([cf,bf+n]))
    mesh=make_contact_mesh(rest,body_reference,cf,bf)
    reference_hash=contact_reference_hash(rest,body_reference,cf,bf)
    self_enabled=step['selfCollision'];body_enabled=step['collider']
    patches=ipctk.make_vertex_patches_filter(np.r_[np.zeros(n,dtype=np.int32),np.ones(len(body0),dtype=np.int32)])
    if self_enabled:
        neighbours=_material_neighbours(rest,cf,dhat*4)
        exclusions={(i,j):False for i,near in enumerate(neighbours) for j in near if i<j}
        local=ipctk.make_sparse_filter(exclusions,default_value=True)
        static=ipctk.make_static_obstacle_filter(n)
        mesh.can_collide=(static&local) if body_enabled else ((~patches)&static&local)
    else:
        mesh.can_collide=patches if body_enabled else ipctk.make_vertex_patches_filter(np.zeros(len(x),dtype=np.int32))
    contact_enabled=step['collider'] or self_enabled
    if contact_enabled and ipctk.has_intersections(mesh,x):
        raise ReferenceError('IPC requires an intersection-free initial mesh','initial-intersection')
    if contact_enabled:
        initial_contacts=ipctk.NormalCollisions();initial_contacts.build(mesh,x,dhat,dmin)
        initial_gap_squared=initial_contacts.compute_minimum_distance(mesh,x)
        if initial_gap_squared<=dmin*dmin:
            raise ReferenceError('Initial feature clearance violates the requested minimum distance','initial-clearance')
    coefficient=np.repeat(mass/(h*h),3)
    inertia_hessian=diags(coefficient,format='csc')
    all_alphas=[];iterations=0;energies=[];all_converged=True;barrier_stiffness=None;final_gradient=None;active_contacts=0
    min_gap=None;trace=[];convergence_criteria=[];body_continuation=[];direct_chords=[];hessian_fallbacks=0
    def progress():
        return {'newtonIterations':iterations,'iterationTrace':trace,'lineSearchAlphas':all_alphas,
                'substepEnergies':energies,'barrierStiffness':float(barrier_stiffness) if barrier_stiffness else None,
                'bodyContactEnabled':body_enabled,'selfCollision':self_enabled,
                'displacementToleranceM':displacement_tolerance,'decrementToleranceJ':decrement_tolerance,
                'bodyContinuation':body_continuation,'directSubstepChordCollisionFree':direct_chords,
                'elasticHessian':elastic_hessian,'hessianFallbacks':hessian_fallbacks,
                'contactReferenceHash':reference_hash,'contactReferenceHashFormat':CONTACT_HASH_FORMAT}
    for sub in range(substeps):
        sub_iteration_start=iterations
        accepted_start=x.copy(order='F')
        predictor=x[:n]+h*velocity*np.exp(-1.8*h)
        if step['gravity']:
            predictor[:,1]-=9.81*h*h
        predictor[~free_vertex]=x[:n][~free_vertex]
        unit_barrier=ipctk.BarrierPotential(dhat,1.)
        initial_elastic,initial_elastic_g,_=springs.evaluate(x[:n],False)
        initial_g=coefficient*(x[:n]-predictor).ravel()+initial_elastic_g
        contacts=ipctk.NormalCollisions()
        if contact_enabled:
            contacts.build(mesh,x,dhat,dmin)
        if options.get('barrierStiffness') is not None:
            barrier_stiffness=float(options['barrierStiffness'])
            if not math.isfinite(barrier_stiffness) or barrier_stiffness<=0:
                raise ReferenceError('Invalid barrier stiffness')
        elif contact_enabled:
            bg=unit_barrier.gradient(contacts,mesh,x)
            full_g=np.r_[initial_g,np.zeros(len(body0)*3)]
            barrier_stiffness,_=ipctk.initial_barrier_stiffness(float(np.linalg.norm(np.ptp(x,axis=0))),unit_barrier.barrier,dhat,float(np.mean(mass[free_vertex]))/(h*h),full_g,bg,dmin=dmin)
        else:
            barrier_stiffness=1.
        barrier=ipctk.BarrierPotential(dhat,barrier_stiffness)

        # Prescribed-body continuation is only a feasible Newton warm start.
        # Its alpha is a geometry parameter, never committed physical time.
        body_target=body1.copy(order='F') if sub==substeps-1 else body0+(body1-body0)*((sub+1)/substeps)
        if not np.array_equal(x[n:],body_target):
            if not body_enabled:
                x[n:]=body_target
            else:
                for stage in range(64):
                    if np.array_equal(x[n:],body_target):
                        break
                    c=ipctk.NormalCollisions();c.build(mesh,x,dhat,dmin)
                    bh=barrier.hessian(c,mesh,x,ipctk.PSDProjectionMethod.CLAMP)
                    _,_,eh=springs.evaluate(x[:n],True)
                    hcc=(eh+inertia_hessian+bh[:n*3,:n*3])[free,:][:,free].tocsc()
                    delta_body=(body_target-x[n:]).ravel()
                    delta_cloth=spsolve(hcc,-(bh[:n*3,n*3:]@delta_body)[free])
                    if not np.isfinite(delta_cloth).all():
                        raise ReferenceError('Body continuation predictor is nonfinite','body-continuation',progress())
                    direction=np.zeros(x.size);direction[free]=delta_cloth;direction[n*3:]=delta_body
                    direction=direction.reshape(-1,3)
                    proposal=np.asfortranarray(x+direction)
                    alpha=float(ipctk.compute_collision_free_stepsize(mesh,x,proposal,min_distance=dmin))
                    verified=False
                    for _ in range(45):
                        if alpha<1e-12:
                            break
                        trial=np.asfortranarray(x+alpha*direction)
                        if alpha==1:
                            trial[n:]=body_target
                        if ipctk.is_step_collision_free(mesh,x,trial,min_distance=dmin):
                            verified=True;break
                        alpha*=.5
                    if not verified:
                        raise ReferenceError('Prescribed body motion has no verified feasible continuation stage','body-continuation',progress())
                    x=trial
                    body_continuation.append({'substep':sub,'stage':stage,'alpha':alpha,'collisionFree':True,
                                              'remainingBodyDisplacementInfM':float(np.max(np.abs(body_target-x[n:]))),
                                              'physicalTimeCommitted':False})
                if not np.array_equal(x[n:],body_target):
                    raise ReferenceError('Prescribed body continuation did not reach the complete requested target','body-continuation',progress())

        def state(vertices,want_hessian=False,want_gradient=True,policy=None):
            elastic,g,eh=springs.evaluate(vertices[:n],want_hessian,want_gradient,
                hessian_policy=policy or ('exact' if elastic_hessian=='exact-descent' else 'psd'))
            residual=(vertices[:n]-predictor).ravel()
            energy=elastic+.5*np.dot(coefficient,residual*residual)
            gradient=g+coefficient*residual if want_gradient else None
            c=ipctk.NormalCollisions()
            if contact_enabled:
                c.build(mesh,vertices,dhat,dmin)
                energy+=barrier(c,mesh,vertices)
                if want_gradient:
                    gradient+=barrier.gradient(c,mesh,vertices)[:n*3]
            if want_hessian:
                hessian=eh+inertia_hessian
                if contact_enabled:
                    hessian+=barrier.hessian(c,mesh,vertices,ipctk.PSDProjectionMethod.CLAMP)[:n*3,:n*3]
                return float(energy),gradient,hessian,c
            return float(energy),gradient,None,c

        initial_energy,initial_gradient,_,_=state(x)
        tolerance=max(gradient_tolerance,np.linalg.norm(initial_gradient[free])*1e-7)
        converged=False;criterion=None
        for iteration in range(max_iterations):
            energy,gradient,hessian,contacts=state(x,True)
            if not np.isfinite(energy) or not np.isfinite(gradient).all() or not np.isfinite(hessian.data).all():
                raise ReferenceError('Nonfinite incremental potential','nonfinite')
            gradient_norm=float(np.linalg.norm(gradient[free]))
            if gradient_norm<=tolerance:
                converged=True;criterion='force-residual';break
            reduced=hessian[free,:][:,free].tocsc()
            with warnings.catch_warnings():
                warnings.simplefilter('error',MatrixRankWarning)
                direction_free=spsolve(reduced,-gradient[free])
            slope=float(np.dot(gradient[free],direction_free))
            used_hessian=elastic_hessian
            if elastic_hessian=='exact-descent' and (not np.isfinite(direction_free).all() or slope>=0):
                _,_,hessian,_=state(x,True,policy='psd')
                reduced=hessian[free,:][:,free].tocsc()
                direction_free=spsolve(reduced,-gradient[free]);slope=float(np.dot(gradient[free],direction_free))
                hessian_fallbacks+=1;used_hessian='psd-fallback'
            if not np.isfinite(direction_free).all() or slope>=0:
                raise ReferenceError('Newton direction is not finite descent','nonconverged',progress())
            displacement=float(np.max(np.abs(direction_free)))
            decrement=-.5*slope
            energy_tolerance=max(decrement_tolerance,abs(initial_energy)*1e-9)
            trace.append({'substep':sub,'iteration':iteration,'energyJ':energy,'gradientNormN':gradient_norm,
                          'newtonDisplacementInfM':displacement,'newtonDecrementJ':decrement,'decrementToleranceJ':energy_tolerance,
                          'hessian':used_hessian})
            if __name__=='__main__' and iteration%25==0:
                print(json.dumps({'substep':sub,'iteration':iteration,'elapsedMs':(time.perf_counter()-start)*1000,
                    'energyJ':energy,'gradientNormN':gradient_norm,'directionInfM':displacement,
                    'decrementJ':decrement,'contacts':len(contacts),'barrierStiffness':barrier_stiffness}),
                    file=__import__('sys').stderr,flush=True)
            # A force norm alone is scale dependent for very stiff elements.
            # Require BOTH a small full Newton displacement and small predicted
            # quadratic energy reduction. CCD/geometry postchecks remain required.
            if displacement<=displacement_tolerance and decrement<=energy_tolerance:
                converged=True;criterion='newton-displacement-and-decrement';break
            direction=np.zeros(x.size);direction[free]=direction_free;direction=direction.reshape(-1,3)
            proposal=np.asfortranarray(x+direction)
            alpha=float(ipctk.compute_collision_free_stepsize(mesh,x,proposal,min_distance=dmin)) if contact_enabled else 1.
            accepted=False
            for backtrack in range(45):
                if alpha<1e-12:
                    break
                trial=np.asfortranarray(x+alpha*direction)
                trial_energy,_,_,_=state(trial,want_gradient=False)
                if math.isfinite(trial_energy) and trial_energy<=energy+1e-4*alpha*slope:
                    if not contact_enabled or ipctk.is_step_collision_free(mesh,x,trial,min_distance=dmin):
                        accepted=True;break
                alpha*=.5
            if not accepted:
                raise ReferenceError('CCD/Armijo line search could not make a feasible descent step','nonconverged',progress())
            trace[-1]['acceptedAlpha']=alpha
            x=trial;iterations+=1;all_alphas.append(alpha)
        final_energy,final_gradient,_,contacts=state(x)
        if not converged and np.linalg.norm(final_gradient[free])<=tolerance:
            converged=True;criterion='force-residual'
        all_converged&=bool(converged)
        convergence_criteria.append(criterion)
        energies.append({'initial':initial_energy,'final':final_energy,'gradientNorm':float(np.linalg.norm(final_gradient[free])),'tolerance':float(tolerance),
                        'iterations':iterations-sub_iteration_start,'criterion':criterion})
        if not converged:
            raise ReferenceError(f'Newton iteration limit reached; gradient norm {np.linalg.norm(final_gradient[free]):.6g}','nonconverged',progress())
        direct_free=bool(not contact_enabled or ipctk.is_step_collision_free(mesh,accepted_start,x,min_distance=dmin))
        direct_chords.append(direct_free)
        # IPC's accepted continuation/Newton segments are checked individually.
        # A straight interpolation between the rendered frame endpoints is a
        # different trajectory, reported separately and never called certified.
        if options.get('requireDirectSubstepChord',False) and not direct_free:
            raise ReferenceError('The direct full-substep trajectory is not collision-free','substep-path',progress())
        velocity=(x[:n]-accepted_start[:n])/h;velocity[~free_vertex]=0
        active_contacts=len(contacts)
        squared=contacts.compute_minimum_distance(mesh,x) if contact_enabled else math.inf
        min_gap=float(math.sqrt(squared)) if math.isfinite(squared) else None
    collision_free=bool(not ipctk.has_intersections(mesh,x))
    if not collision_free:
        raise ReferenceError('Final mesh intersection postcheck failed','postcheck')
    lengths=np.linalg.norm(x[springs.a]-x[springs.b],axis=1)
    strain=lengths/springs.rest-1
    kinds=[c.get('kind','unknown') for c in snapshot['constraints']]
    guard=snapshot.get('strainLimit',2)
    guarded=np.array([k in ['weft','warp','shear','toe-cap'] for k in kinds],dtype=bool)
    max_guard=float(np.max(strain[guarded])) if guarded.any() else 0.
    if guard is not None and (not isinstance(guard,(int,float)) or guard<0 or guard>10):
        raise ReferenceError('Invalid numerical strain limit')
    if guard is not None and max_guard>guard+1e-5:
        raise ReferenceError(f'Native result exceeds the numerical extension guard: {max_guard:.6g}','strain-limit-exceeded')
    lambdas=(-h*h*springs.k*(lengths-springs.rest)).tolist()
    reaction=float(np.linalg.norm(final_gradient[grab['index']*3:grab['index']*3+3])) if grab else 0.
    diagnostics={'engine':'ipctk-native-reference','collisionFree':True,'bodyUnchanged':bool(np.array_equal(x[n:],body0)),
        'bodyTargetReached':bool(np.array_equal(x[n:],body1)),'bodyContinuation':body_continuation,
        'contactReference':'fixed-cloth-natural-and-body-reference','contactReferenceHash':reference_hash,'contactReferenceHashFormat':CONTACT_HASH_FORMAT,
        'bodyReferenceSource':'provided' if body.get('referencePositions') is not None else 'initial-zero-pose',
        'physicsValidated':False,'manufacturingVerified':False,'friction':'not-implemented','materialModel':'linear-distance-springs',
        'springHessian':elastic_hessian,'hessianFallbacks':hessian_fallbacks,'barrierStiffness':float(barrier_stiffness),'activationDistanceM':dhat,
        'minimumDistanceM':dmin,'minimumActiveGapM':min_gap,'selfCollision':self_enabled,'bodyContactEnabled':body_enabled,'materialNeighbourExclusionM':dhat*4 if self_enabled else 0,
        'newtonIterations':iterations,'lineSearchAlphas':all_alphas,'substepEnergies':energies,'maxStrain':float(np.max(strain)) if len(strain) else 0.,
        'totalMassKg':float(mass.sum()),'activeContacts':active_contacts,'fullSubstepChordChecked':True,
        'directSubstepChordCollisionFree':direct_chords,'trajectoryMode':'verified-piecewise-continuation-and-newton',
        'trajectoryModel':'verified-piecewise-solver-path','directChordCollisionFree':bool(all(direct_chords)),
        'verifiedPathSegments':iterations+len(body_continuation),'collisionScope':{'body':body_enabled,'self':self_enabled},
        'straightFrameInterpolationCertified':bool(all(direct_chords)),
        'iterationTrace':trace,'convergenceCriteria':convergence_criteria,'displacementToleranceM':displacement_tolerance,'decrementToleranceJ':decrement_tolerance}
    diagnostics['config']={'quality':step.get('quality'),'dtS':dt,'substeps':substeps,'substepDtS':h,'maxIterationsPerSubstep':max_iterations,
        'activationDistanceM':dhat,'minimumDistanceM':dmin,'displacementToleranceM':displacement_tolerance,
        'absoluteDecrementToleranceJ':decrement_tolerance,'relativeDecrementTolerance':1e-9,
        'absoluteGradientToleranceN':gradient_tolerance,'relativeGradientTolerance':1e-7,
        'elasticHessian':elastic_hessian,'friction':'not-implemented','physicsValidated':False}
    return {'version':1,**{key:request.get(key) for key in ['epoch','requestId','designId','designRevision','baseStateId']},
        'committed':True,'status':'accepted','advancedTime':dt,'pose':target_pose,
        'positions':x[:n].ravel().tolist(),'velocities':velocity.ravel().tolist(),'lambdas':lambdas,'grabForceN':reaction,
        'collisionStats':{'engine':'ipctk-native-reference','contacts':active_contacts,'continuousAlgorithm':'native-tight-inclusion-with-postcheck','edgeEdgeCCD':True,'movingTriangleCCD':True,'fullGuarantee':False},
        'ms':(time.perf_counter()-start)*1000,'converged':all_converged,'diagnostics':diagnostics}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input');parser.add_argument('--output')
    arguments=parser.parse_args()
    with open(arguments.input) if arguments.input else __import__('sys').stdin as source:
        response=solve_step(json.load(source))
    encoded=json.dumps(response,allow_nan=False)
    if arguments.output:
        with open(arguments.output,'w') as target:
            target.write(encoded+'\n')
    else:
        print(encoded)
