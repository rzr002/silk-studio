#!/usr/bin/env python3
"""Executable IPC Toolkit evaluation. No product solver or HTTP route is installed.

Run with /tmp/silk-ipctk-env/bin/python scripts/ipc-probe.py.
Optional --stocking-input uses paired cloth/body linear-motion samples, in metres:
  {cloth:{positions0,positions1,triangles},body:{positions0,positions1,triangles}}
Arrays may be flat JSON arrays; topology must remain fixed during one query.
"""
import argparse
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import time

os.environ.setdefault("TBB_NUM_THREADS", "1")
import ipctk
ipctk.set_num_threads(1)
import numpy as np
from scipy.sparse import eye
from scipy.sparse.linalg import spsolve


def edge_crossing_probe():
    # The moving edge's endpoints stay 10 mm from the static edge at impact.
    # A vertex-only test misses the two interior points crossing at t=.5.
    x0 = np.array([[-.01, 0, 0], [.01, 0, 0], [0, -.01, .01], [0, .01, .01]])
    x1 = x0.copy()
    x1[2:, 2] = -.01
    edges = np.array([[0, 1], [2, 3]], dtype=np.int32)
    mesh = ipctk.CollisionMesh(x0, edges)
    ccd = ipctk.TightInclusionCCD()
    hit, narrow_alpha = ccd.edge_edge_ccd(*x0, *x1)
    endpoint_hits = []
    for point, a, b in [(0, 2, 3), (1, 2, 3), (2, 0, 1), (3, 0, 1)]:
        endpoint_hits.append(bool(ccd.point_edge_ccd(x0[point], x0[a], x0[b], x1[point], x1[a], x1[b])[0]))
    alpha = ipctk.compute_collision_free_stepsize(mesh, x0, x1)
    thick_alpha = ipctk.compute_collision_free_stepsize(mesh, x0, x1, min_distance=.001)
    accepted = x0 + alpha * (x1-x0)
    miss = x1.copy()
    miss[2:, 0] = .03  # Move to the side first: this full linear trajectory misses.
    return {
        "hit": bool(hit), "analytic_impact_time": .5,
        "narrow_safe_alpha": float(narrow_alpha), "safe_alpha": float(alpha),
        "endpoint_only_would_miss": not any(endpoint_hits), "endpoint_point_edge_hits": endpoint_hits,
        "closest_endpoint_distance_at_impact_m": .01,
        "full_step_collision_free": bool(ipctk.is_step_collision_free(mesh, x0, x1)),
        "accepted_step_collision_free": bool(ipctk.is_step_collision_free(mesh, x0, accepted)),
        "thick_safe_alpha": float(thick_alpha), "thick_safe_gap_m": float(.01-.02*thick_alpha),
        "miss_safe_alpha": float(ipctk.compute_collision_free_stepsize(mesh, x0, miss)),
    }


def vertex_face_probe():
    ccd = ipctk.TightInclusionCCD()
    p0 = np.array([0., 0., .01])
    p1 = np.array([0., 0., -.01])
    triangle = np.array([[-.02, -.02, 0], [.02, -.02, 0], [0, .02, 0.]])
    cases = {}
    for name, triangle_motion in [("static_triangle", 0), ("moving_triangle", .003)]:
        next_triangle = triangle.copy()
        next_triangle[:, 2] += triangle_motion
        hit, alpha = ccd.point_triangle_ccd(p0, *triangle, p1, *next_triangle)
        cases[name] = {"hit": bool(hit), "safe_alpha": float(alpha),
                       "analytic_impact_time": .01/(.02+triangle_motion)}
    return cases


def coplanar_edge_probe():
    x0 = np.array([[-.01, 0, 0], [.01, 0, 0], [0, .005, 0], [0, .015, 0]])
    x1 = x0.copy()
    x1[2:, 1] -= .02
    hit, alpha = ipctk.TightInclusionCCD().edge_edge_ccd(*x0, *x1)
    return {"hit": bool(hit), "safe_alpha": float(alpha), "analytic_impact_time": .25}


def collision_filter_probe():
    cross = ipctk.make_vertex_patches_filter(np.array([0, 0, 0, 0, 1, 1, 1], dtype=np.int32))
    standard = ipctk.make_static_obstacle_filter(4)
    predicate = lambda f: {"cloth_cloth": bool(f(0, 1)), "cloth_body": bool(f(0, 4)), "body_body": bool(f(4, 5))}
    x = np.array([[0, 0, 0], [.01, 0, 0], [0, .01, 0], [.01, .01, 0.],
                  [0, 0, .01], [.01, 0, .01], [0, .01, .01]])
    faces = np.array([[0, 1, 2], [1, 3, 2], [4, 5, 6]], dtype=np.int32)
    mesh = ipctk.CollisionMesh(x, ipctk.edges(faces), faces)
    mesh.can_collide = standard
    collisions = ipctk.NormalCollisions()
    collisions.build(mesh, x, .001)
    return {"cross_only": predicate(cross), "self_and_body": predicate(standard),
            "resting_adjacent_triangles_active_collisions": len(collisions),
            "resting_adjacent_triangles_safe_alpha": float(ipctk.compute_collision_free_stepsize(mesh, x, x, min_distance=.001))}


def closest_stencil(collisions, mesh, x, n_cloth):
    """Copy only numbers out of borrowed native stencils; retain their owner."""
    minimum, result = float("inf"), None
    for i in range(len(collisions)):
        squared = collisions[i].compute_distance(x, mesh.edges, mesh.faces)
        if squared >= minimum:
            continue
        minimum = squared
        ids = [int(v) for v in collisions[i].vertex_ids(mesh.edges, mesh.faces) if v >= 0]
        result = {"distance_m": float(np.sqrt(squared)), "vertex_ids": ids,
                  "groups": ["cloth" if v < n_cloth else "body" for v in ids],
                  "type": type(collisions[i]).__name__}
    return result


def verified_safe_step(mesh, x0, x1, min_distance=0):
    """CCD bound followed by an independent continuous-path acceptance query."""
    raw_alpha = ipctk.compute_collision_free_stepsize(mesh, x0, x1, min_distance=min_distance)
    alpha = raw_alpha
    for reductions in range(20):
        accepted = x0+alpha*(x1-x0)
        if ipctk.is_step_collision_free(mesh, x0, accepted, min_distance=min_distance):
            return float(alpha), float(raw_alpha), reductions, True
        alpha *= .5
    return 0., float(raw_alpha), 20, False


def barrier_probe():
    dhat = .001
    x = np.array([[0, 0, 0], [.01, 0, 0], [.005, .01, 0],
                  [0, 0, .0005], [.01, 0, .0005], [.005, .01, .0005]])
    faces = np.array([[0, 1, 2], [3, 4, 5]], dtype=np.int32)
    mesh = ipctk.CollisionMesh(x, ipctk.edges(faces), faces)
    collisions = ipctk.NormalCollisions()
    collisions.build(mesh, x, dhat)
    barrier = ipctk.BarrierPotential(dhat, stiffness=1e3)
    energy = barrier(collisions, mesh, x)
    gradient = barrier.gradient(collisions, mesh, x)
    hessian = barrier.hessian(collisions, mesh, x, ipctk.PSDProjectionMethod.CLAMP)
    epsilon = 1e-8
    plus, minus = x.copy(), x.copy()
    plus[3, 2] += epsilon
    minus[3, 2] -= epsilon
    finite_difference = (barrier(collisions, mesh, plus)-barrier(collisions, mesh, minus))/(2*epsilon)
    return {
        "energy": float(energy), "active_collisions": len(collisions),
        "gradient_shape": list(gradient.shape), "hessian_shape": list(hessian.shape),
        "hessian_nnz": hessian.nnz,
        "finite": bool(np.isfinite(energy) and np.isfinite(gradient).all() and np.isfinite(hessian.data).all()),
        "gradient_layout": "vertex-major xyz, verified against finite difference",
        "upper_triangle_outward_force": float(-gradient.reshape(-1, 3)[3:, 2].sum()),
        "gradient_finite_difference_relative_error": float(abs(gradient[11]-finite_difference)/abs(finite_difference)),
        "projection_api": False,
        "hessian_psd_projection_is_not_geometry_projection": True,
        # Version 1.6.0 returns SQUARED distance despite the Python docstring.
        # Verified here against the known parallel-plane gap of 0.0005 metres.
        "minimum_distance_m": float(np.sqrt(collisions.compute_minimum_distance(mesh, x))),
    }


def cloth_only_optimization_probe():
    """Nine cloth DOF, nine fixed body DOF, inertia + native IPC barrier.

    A minimal Newton/CCD line-search example, not a cloth constitutive solver.
    The requested target is THROUGH the rigid triangle; the accepted answer is
    the minimizer on its original side. Body variables never enter the solve.
    """
    x = np.array([[0, 0, .0005], [.01, 0, .0005], [.005, .01, .0005],
                  [0, 0, 0], [.01, 0, 0], [.005, .01, 0.]])
    body = x[3:].copy()
    target = x[:3].copy()
    target[:, 2] = -.0005
    faces = np.array([[0, 1, 2], [3, 4, 5]], dtype=np.int32)
    mesh = ipctk.CollisionMesh(x, ipctk.edges(faces), faces)
    mesh.can_collide = ipctk.make_static_obstacle_filter(3)
    barrier = ipctk.BarrierPotential(.001, stiffness=100)
    # Each cloth vertex is 2 mg; this is a toy numerical input, not calibration.
    coefficient = 2e-6/(1/60)**2

    def state(vertices):
        contacts = ipctk.NormalCollisions()
        contacts.build(mesh, vertices, .001)
        residual = (vertices[:3]-target).reshape(-1)
        energy = coefficient*.5*np.dot(residual, residual)+barrier(contacts, mesh, vertices)
        gradient = coefficient*residual+barrier.gradient(contacts, mesh, vertices)[:9]
        return float(energy), gradient, contacts

    initial_energy, _, _ = state(x)
    iterations, accepted_alphas = 0, []
    for iteration in range(40):
        energy, gradient, contacts = state(x)
        if np.linalg.norm(gradient) < 1e-10:
            break
        hessian = barrier.hessian(contacts, mesh, x, ipctk.PSDProjectionMethod.CLAMP)[:9, :9]+coefficient*eye(9, format="csc")
        direction = spsolve(hessian, -gradient)
        proposal = x.copy()
        proposal[:3] += direction.reshape(3, 3)
        alpha = ipctk.compute_collision_free_stepsize(mesh, x, proposal)
        for _ in range(35):
            trial = x+alpha*(proposal-x)
            trial_energy, _, _ = state(trial)
            if trial_energy <= energy+1e-4*alpha*np.dot(gradient, direction):
                break
            alpha *= .5
        else:
            raise RuntimeError("Toy IPC line search did not converge")
        if alpha < 1e-12:
            raise RuntimeError("Toy IPC solve stalled at the collision barrier")
        x = trial
        accepted_alphas.append(float(alpha))
        iterations = iteration+1
    final_energy, gradient, _ = state(x)
    return {"free_dofs": 9, "fixed_body_dofs": 9, "iterations": iterations,
            "body_unchanged": bool(np.array_equal(x[3:], body)),
            "initial_energy": initial_energy, "final_energy": final_energy,
            "final_gradient_norm": float(np.linalg.norm(gradient)),
            "target_gap_m": float(target[:, 2].mean()), "final_gap_m": float(x[:3, 2].min()),
            "final_intersection": bool(ipctk.has_intersections(mesh, x)),
            "accepted_alphas": accepted_alphas,
            "calibrated": False, "cloth_elasticity_included": False}


def matrix(value, columns, dtype, label):
    result = np.asarray(value, dtype=dtype)
    if result.size % columns:
        raise ValueError(f"{label} does not have {columns} columns")
    result = np.asfortranarray(result.reshape(-1, columns))
    if not np.isfinite(result).all():
        raise ValueError(f"{label} has nonfinite values")
    return result


def stocking_probe(path, min_distance=0):
    if not np.isfinite(min_distance) or min_distance < 0:
        raise ValueError("Minimum distance must be finite and nonnegative")
    data = json.loads(Path(path).read_text())
    cloth, body = data["cloth"], data["body"]
    c0, c1 = [matrix(cloth[key], 3, float, f"cloth.{key}") for key in ("positions0", "positions1")]
    b0, b1 = [matrix(body[key], 3, float, f"body.{key}") for key in ("positions0", "positions1")]
    if c0.shape != c1.shape or b0.shape != b1.shape:
        raise ValueError("Topology changed inside a CCD query")
    cf = matrix(cloth["triangles"], 3, np.int32, "cloth.triangles")
    bf = matrix(body["triangles"], 3, np.int32, "body.triangles")
    if cf.size and (cf.min() < 0 or cf.max() >= len(c0)):
        raise ValueError("Invalid cloth face index")
    if bf.size and (bf.min() < 0 or bf.max() >= len(b0)):
        raise ValueError("Invalid body face index")
    x0, x1 = np.asfortranarray(np.vstack([c0, b0])), np.asfortranarray(np.vstack([c1, b1]))
    faces = np.asfortranarray(np.vstack([cf, bf+len(c0)]))
    edges = ipctk.edges(faces)
    start = time.perf_counter()
    mesh = ipctk.CollisionMesh(x0, edges, faces)
    build_ms = (time.perf_counter()-start)*1000
    result = {"cloth_vertices": len(c0), "body_vertices": len(b0), "faces": len(faces),
              "edges": len(edges), "mesh_build_ms": build_ms, "min_distance_m": min_distance,
              "trajectory": "linear interpolation of ALL cloth and body vertices"}
    for name, filter_value in [
        ("body_cloth_only", ipctk.make_vertex_patches_filter(np.r_[np.zeros(len(c0), dtype=np.int32), np.ones(len(b0), dtype=np.int32)])),
        ("cloth_self_and_body", ipctk.make_static_obstacle_filter(len(c0))),
    ]:
        mesh.can_collide = filter_value
        start = time.perf_counter()
        initial_intersection = ipctk.has_intersections(mesh, x0)
        initial_check_ms = (time.perf_counter()-start)*1000
        if initial_intersection:
            result[name] = {"initial_intersection": True, "refused": "CCD requires an intersection-free initial state", "initial_check_ms": initial_check_ms}
            continue
        collisions = ipctk.NormalCollisions()
        collisions.build(mesh, x0, max(.005, min_distance*2))
        gap_squared = collisions.compute_minimum_distance(mesh, x0)
        gap = float(np.sqrt(gap_squared)) if np.isfinite(gap_squared) else None
        feature = closest_stencil(collisions, mesh, x0, len(c0))
        if gap is not None and gap <= min_distance:
            result[name] = {"initial_intersection": False, "initial_minimum_gap_m": gap,
                            "initial_check_ms": initial_check_ms, "safe_alpha": 0, "closest_feature": feature,
                            "refused": "Initial feature clearance does not satisfy requested minimum distance"}
            continue
        start = time.perf_counter()
        alpha, raw_alpha, reductions, verified = verified_safe_step(mesh, x0, x1, min_distance)
        ccd_ms = (time.perf_counter()-start)*1000
        accepted = x0+alpha*(x1-x0)
        result[name] = {
            "initial_intersection": False, "initial_check_ms": initial_check_ms,
            "initial_minimum_gap_m": gap,
            "closest_feature": feature,
            "safe_alpha": float(alpha), "raw_ccd_alpha": raw_alpha, "postcheck_reductions": reductions,
            "verified": verified, "ccd_and_postcheck_ms": ccd_ms,
            "full_step_collision_free": bool(ipctk.is_step_collision_free(mesh, x0, x1, min_distance=min_distance)),
            "accepted_step_collision_free": bool(ipctk.is_step_collision_free(mesh, x0, accepted, min_distance=min_distance)),
            "accepted_intersection": bool(ipctk.has_intersections(mesh, accepted)),
            "initial_and_final_body_match_must_be_preserved": True,
        }
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stocking-input", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--min-distance", type=float, default=0,
                        help="Required feature separation in metres; zero tests non-intersection only")
    args = parser.parse_args()
    report = {
        "date": "2026-10-15", "python": platform.python_version(), "platform": platform.platform(),
        "versions": {name: importlib.metadata.version(name) for name in ("ipctk", "numpy", "scipy")},
        "threads": ipctk.get_num_threads(), "thread_environment": os.environ["TBB_NUM_THREADS"], "edge_edge": edge_crossing_probe(),
        "point_triangle": vertex_face_probe(), "coplanar_edge": coplanar_edge_probe(), "filters": collision_filter_probe(), "barrier": barrier_probe(),
        "cloth_only_optimization": cloth_only_optimization_probe(),
        "product_integrated": False, "manufacturing_validated": False,
    }
    if args.stocking_input:
        report["stocking_candidate"] = stocking_probe(args.stocking_input, args.min_distance)
    rendered = json.dumps(report, indent=2, allow_nan=False)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered+"\n")
    print(rendered)


if __name__ == "__main__":
    main()
