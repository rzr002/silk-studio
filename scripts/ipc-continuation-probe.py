#!/usr/bin/env python3
"""Independent native feasibility predictor, not a second cloth solver.

It tests prescribed moving-body continuation with barrier H_CB and a nine-DOF
cloth predictor. A final constitutive/inertial Newton solve is still required.
"""
import importlib.util
import json
from pathlib import Path
import os
os.environ.setdefault('TBB_NUM_THREADS','1')
import ipctk
ipctk.set_num_threads(1)
import numpy as np
from scipy.sparse import eye
from scipy.sparse.linalg import spsolve

spec=importlib.util.spec_from_file_location('ipc_probe',Path(__file__).with_name('ipc-probe.py'))
probe=importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def body_continuation():
    x=np.array([[0,0,.0005],[.01,0,.0005],[.005,.01,.0005],
                [0,0,0],[.01,0,0],[.005,.01,0.]])
    faces=np.array([[0,1,2],[3,4,5]],dtype=np.int32)
    mesh=ipctk.CollisionMesh(x,ipctk.edges(faces),faces)
    mesh.can_collide=ipctk.make_static_obstacle_filter(3)
    body_target=x[3:].copy();body_target[:,2]+=.001
    teleport=x.copy();teleport[3:]=body_target
    teleport_alpha=ipctk.compute_collision_free_stepsize(mesh,x,teleport)
    teleport_free=ipctk.is_step_collision_free(mesh,x,teleport)
    barrier=ipctk.BarrierPotential(.001,100)
    stages=[]
    for _ in range(20):
        if np.array_equal(x[3:],body_target):
            break
        collisions=ipctk.NormalCollisions();collisions.build(mesh,x,.001)
        hessian=barrier.hessian(collisions,mesh,x,ipctk.PSDProjectionMethod.CLAMP)
        body_delta=(body_target-x[3:]).ravel()
        # Body is a prescribed parameter. Only the cloth's nine DOF are solved.
        cloth_delta=spsolve(hessian[:9,:9]+.0072*eye(9,format='csc'),-hessian[:9,9:]@body_delta)
        proposal=x.copy();proposal[:3]+=cloth_delta.reshape(3,3);proposal[3:]=body_target
        alpha,raw,reductions,verified=probe.verified_safe_step(mesh,x,proposal)
        if not verified or alpha<1e-12:
            raise RuntimeError('Body continuation could not preserve feasibility')
        next_x=x+alpha*(proposal-x)
        if alpha==1:
            next_x[3:]=body_target
        stages.append({'rawAlpha':raw,'acceptedAlpha':alpha,'postcheckReductions':reductions,
                       'verified':verified,'bodyProgress':float(next_x[3:,2].mean()/.001),
                       'gapM':float(next_x[:3,2].min()-next_x[3:,2].max())})
        x=next_x
    completed=bool(np.array_equal(x[3:],body_target))
    assert not teleport_free
    assert completed
    assert all(stage['verified'] and stage['gapM']>0 for stage in stages)
    assert not ipctk.has_intersections(mesh,x)
    return {'threads':ipctk.get_num_threads(),'bodyOnlyFullMotionCCD':bool(teleport_free),
            'bodyOnlySafeAlpha':float(teleport_alpha),'stages':stages,'completedBodyTarget':completed,
            'finalIntersection':bool(ipctk.has_intersections(mesh,x)),
            'role':'feasible warm-start only; final target-pose Newton correction remains required',
            'physicalTimeOrVelocityCommitted':False}


def sparse_filters():
    n=4;labels=np.r_[np.zeros(n,dtype=np.int32),np.ones(3,dtype=np.int32)]
    cross=ipctk.make_vertex_patches_filter(labels)
    static=ipctk.make_static_obstacle_filter(n)
    # Example precomputed material neighbourhood exclusions: only i<j keys.
    local=ipctk.make_sparse_filter({(0,1):False,(1,2):False},default_value=True)
    filters={'both':static&local,'body_only':cross,'self_only':(~cross)&static&local,
             'none':~ipctk.CollisionFilter()}
    for mode,value in filters.items():
        for i in range(7):
            for j in range(i+1,7):
                bodypair=i>=n and j>=n;crosspair=(i<n)!=(j<n)
                localpair=(i,j) in [(0,1),(1,2)]
                expected=not bodypair and ((crosspair and mode in ['both','body_only']) or
                         (not crosspair and not localpair and mode in ['both','self_only']))
                assert bool(value(i,j))==expected,(mode,i,j)
    return {'modes':list(filters),'all21PairsPerModeMatch':True,
            'perPairPythonCallbackUsed':False,'factory':'make_sparse_filter & native composable filters'}


if __name__=='__main__':
    result={'bodyContinuation':body_continuation(),'sparseFilters':sparse_filters()}
    encoded=json.dumps(result,indent=2,allow_nan=False)
    if len(__import__('sys').argv)>1:
        Path(__import__('sys').argv[1]).write_text(encoded+'\n')
    print(encoded)
