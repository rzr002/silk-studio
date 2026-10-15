"""Real native-library acceptance checks; run in the isolated ipctk environment."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("ipc_probe", Path(__file__).with_name("ipc-probe.py"))
probe = importlib.util.module_from_spec(spec)
if spec.loader:
    spec.loader.exec_module(probe)


class IPCProbeTests(unittest.TestCase):
    def test_mid_edge_crossing_is_detected_even_when_endpoints_miss(self):
        result = probe.edge_crossing_probe()
        self.assertTrue(result["hit"])
        self.assertTrue(result["endpoint_only_would_miss"])
        self.assertFalse(result["full_step_collision_free"])
        self.assertGreater(result["safe_alpha"], 0)
        self.assertLess(result["safe_alpha"], result["analytic_impact_time"])
        self.assertTrue(result["accepted_step_collision_free"])
        self.assertGreater(result["thick_safe_gap_m"], .001)
        self.assertEqual(result["miss_safe_alpha"], 1)

    def test_coplanar_edge_crossing_is_not_skipped(self):
        result = probe.coplanar_edge_probe()
        self.assertTrue(result["hit"])
        self.assertGreater(result["safe_alpha"], 0)
        self.assertLess(result["safe_alpha"], .25)

    def test_filters_keep_cross_contact_and_exclude_body_body_and_legal_adjacency(self):
        result = probe.collision_filter_probe()
        self.assertEqual(result["cross_only"], {"cloth_cloth": False, "cloth_body": True, "body_body": False})
        self.assertEqual(result["self_and_body"], {"cloth_cloth": True, "cloth_body": True, "body_body": False})
        self.assertEqual(result["resting_adjacent_triangles_active_collisions"], 0)
        self.assertEqual(result["resting_adjacent_triangles_safe_alpha"], 1)

    def test_point_and_moving_triangle_ccd_both_work(self):
        result = probe.vertex_face_probe()
        for case in [result["static_triangle"], result["moving_triangle"]]:
            self.assertTrue(case["hit"])
            self.assertGreater(case["safe_alpha"], 0)
            self.assertLess(case["safe_alpha"], case["analytic_impact_time"])

    def test_barrier_has_finite_energy_derivatives_and_repulsive_force(self):
        result = probe.barrier_probe()
        self.assertGreater(result["energy"], 0)
        self.assertTrue(result["finite"])
        self.assertEqual(result["gradient_shape"], [18])
        self.assertEqual(result["hessian_shape"], [18, 18])
        self.assertGreater(result["hessian_nnz"], 0)
        self.assertGreater(result["upper_triangle_outward_force"], 0)
        self.assertLess(result["gradient_finite_difference_relative_error"], 1e-5)
        self.assertAlmostEqual(result["minimum_distance_m"], .0005)

    def test_static_body_cloth_only_newton_example_stays_collision_free(self):
        result = probe.cloth_only_optimization_probe()
        self.assertTrue(result["body_unchanged"])
        self.assertFalse(result["final_intersection"])
        self.assertLess(result["target_gap_m"], 0)
        self.assertGreater(result["final_gap_m"], 0)
        self.assertLess(result["final_energy"], result["initial_energy"])
        self.assertLess(result["final_gradient_norm"], 1e-8)
        self.assertGreater(result["iterations"], 0)


if __name__ == "__main__":
    unittest.main()
