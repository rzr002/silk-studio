"""CPU Newton/Style3D benchmark from the exact JS-generated mesh and mass data.
Run .venv-backend/bin/python scripts/benchmark-backends.py after the .mjs script.
First-time Warp compilation is recorded separately from warm solve timings.
"""
import json,time,platform,importlib.metadata,traceback,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
EVIDENCE=ROOT/'evidence';EVIDENCE.mkdir(exist_ok=True)
import warp as wp
wp.config.kernel_cache_dir=str(EVIDENCE/'backend-warp-cache')
import numpy as np
import newton
from newton.solvers import style3d
data=json.loads((EVIDENCE/'backend-input.json').read_text());cfg=data['config'];saved=data['snapshot']
vertices=np.asarray(saved['rest'],dtype=np.float32).reshape(-1,3);triangles=np.asarray(saved['triangles'],dtype=np.int32)
moduli=data['infinitesimalAffineModuliNPerM']
result={'backend':'newton-SolverStyle3D','device':'cpu','versions':{p:importlib.metadata.version(p) for p in ['newton','warp-lang','numpy']},'python':sys.version,'platform':platform.platform(),'config':cfg,'affineModuliNPerM':moduli,'style3dBendingN_m':1e-6,'cases':[],'caveats':data['caveats']}
def make_case(name):
    started=time.perf_counter();builder=newton.ModelBuilder(up_axis='Y',gravity=wp.vec3(*cfg['gravity']))
    newton.solvers.SolverStyle3D.register_custom_attributes(builder)
    style3d.add_cloth_mesh(builder,pos=wp.vec3(0,0,0),rot=wp.quat_identity(),vel=wp.vec3(0,0,0),vertices=vertices.tolist(),indices=triangles.tolist(),density=cfg['density'],panel_verts=[[u*cfg['width'],v*cfg['height']] for u,v in np.asarray(saved['uv']).reshape(-1,2)],panel_indices=triangles.tolist(),tri_aniso_ke=wp.vec3(moduli['weft'],moduli['warp'],moduli['shear']),edge_aniso_ke=wp.vec3(1e-6,1e-6,1e-6))
    original_masses=np.asarray(builder.particle_mass,dtype=float)
    fixed=list(saved['pins']);grasp=cfg['cols']//2
    if name=='displacement':fixed.append(grasp)
    for i in fixed:builder.particle_mass[i]=0
    model=builder.finalize(device='cpu');solver=newton.solvers.SolverStyle3D(model,iterations=cfg['iterations'],linear_iterations=8);solver.collision=None
    state0,state1=model.state(),model.state();control=model.control();setup=time.perf_counter()-started
    start=vertices[grasp].copy();timings=[];h=cfg['dt']/cfg['substeps'];cold=None
    for frame in range(cfg['frames']):
        t=time.perf_counter()
        target=start+np.asarray([.1,-.09,0],np.float32)*min(1,(frame+1)/60)
        for _ in range(cfg['substeps']):
            state0.clear_forces()
            if name=='displacement':
                q=state0.particle_q.numpy();q[grasp]=target;state0.particle_q.assign(q)
                qd=state0.particle_qd.numpy();qd[grasp]=0;state0.particle_qd.assign(qd)
            solver.step(state0,state1,control,None,h);state0,state1=state1,state0
        wp.synchronize_device('cpu');elapsed=(time.perf_counter()-t)*1000
        if cold is None:cold=elapsed
        timings.append(elapsed)
        q=state0.particle_q.numpy()
        if not np.isfinite(q).all():raise RuntimeError(f'{name} nonfinite at frame {frame}')
    q=state0.particle_q.numpy();warm=np.asarray(timings[10:]);anchor=float(np.linalg.norm(q[saved['pins']]-vertices[saved['pins']],axis=1).max());strains=[]
    for c in saved['constraints']:
        if c['kind'] in ['weft','warp','shear']:strains.append(abs(float(np.linalg.norm(q[c['a']]-q[c['b']]))/c['restLength']-1))
    return {'name':name,'finite':True,'anchorMaxErrorM':anchor,'maxEdgeStrain':max(strains),'meanEdgeStrain':float(np.mean(strains)),'bottomMid':q[grasp].tolist(),'maxDisplacementM':float(np.linalg.norm(q-vertices,axis=1).max()),'meanStepMs':float(warm.mean()),'medianStepMs':float(np.median(warm)),'warmupFrames':10,'frames':cfg['frames'],'firstStepIncludingJitMs':cold,'setupIncludingJitSeconds':setup,'massMaxDifferenceKg':float(np.max(np.abs(original_masses-np.asarray(data['masses'])))),'fullPhysicalMassKg':float(original_masses.sum()),'finalPositions':q.tolist()}
try:
    wp.init()
    with wp.ScopedDevice('cpu'):
        for case in ['gravity','displacement']:
            print(f'RUNNING {case}',flush=True);result['cases'].append(make_case(case));print(json.dumps({k:v for k,v in result['cases'][-1].items() if k!='finalPositions'}),flush=True)
    result['status']='completed'
except Exception:
    result['status']='failed';result['error']=traceback.format_exc();traceback.print_exc()
finally:
    (EVIDENCE/'backend-newton.json').write_text(json.dumps(result,indent=2))
    (EVIDENCE/'backend-environment.json').write_text(json.dumps({k:v for k,v in result.items() if k in ['versions','python','platform','device','status','error']},indent=2))
if result['status']!='completed':sys.exit(1)
