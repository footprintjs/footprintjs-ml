"""Reference-trainer behavior that the SDK's generic contract cannot infer."""
import copy
import unittest

import numpy as np

from trainer import create_plugin


class ReferenceTrainerTests(unittest.TestCase):
    def test_continuation_preserves_A_and_matches_complete_checkpoint_resume(self):
        plugin = create_plugin({})
        validation = plugin.initialize()["datasets"]["validation"]["arrays"]
        a = plugin.train({"steps": 20}, None)
        saved_a = plugin.snapshot(a)
        b = plugin.train({"steps": 20}, a)
        resumed = plugin.train({"steps": 20}, plugin.restore(saved_a))
        direct = plugin.train({"steps": 40}, None)
        for name in ("weight", "bias"):
            np.testing.assert_array_equal(a[name], saved_a["arrays"][name])
            np.testing.assert_array_equal(b[name], resumed[name])
            np.testing.assert_array_equal(b[name], direct[name])
        self.assertEqual(a["steps"], 20)
        self.assertEqual(b["steps"], 40)
        self.assertLess(plugin.evaluate(b, validation, {})["mse"], plugin.evaluate(a, validation, {})["mse"])

    def test_snapshots_refuse_different_training_configuration_and_inference_contract(self):
        plugin = create_plugin({})
        snapshot = plugin.snapshot(plugin.train({"steps": 20}, None))
        with self.assertRaisesRegex(ValueError, "incompatible"):
            create_plugin({"seed": 2027}).restore(snapshot)
        changed = copy.deepcopy(snapshot)
        changed["metadata"]["contract"]["dependencies"]["numpy"] = "other-version"
        with self.assertRaisesRegex(ValueError, "incompatible"):
            plugin.restore(changed)

    def test_separate_validation_and_rejected_ignored_options(self):
        plugin = create_plugin({})
        datasets = plugin.initialize()["datasets"]
        train = datasets["train"]["arrays"]["x"][:, 0]
        validation = datasets["validation"]["arrays"]["x"][:, 0]
        self.assertFalse(set(train) & set(validation))
        for invalid in ({"steps": True}, {"steps": 0}, {"steps": 2, "ignoredOption": 1}):
            with self.assertRaises(ValueError):
                plugin.train(invalid, None)
        with self.assertRaises(ValueError):
            plugin.evaluate(plugin.train({"steps": 1}, None), datasets["validation"]["arrays"], {"ignoredOption": True})


if __name__ == "__main__":
    unittest.main()
