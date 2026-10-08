"""Speech model boot plan. No download and no microphone."""

import unittest

from kernel import stt


class BootModelTests(unittest.TestCase):
    def test_auto_starts_on_base_then_small(self):
        plan = stt.boot_model("auto")
        self.assertEqual(plan["model"], "base")
        self.assertEqual(plan["upgrade"], "small")

    def test_a_slow_locked_model_steps_down(self):
        plan = stt.boot_model("small", failed=True, elapsed_ms=10, budget_ms=1)
        self.assertEqual(plan["model"], "base")

    def test_a_ready_small_model_stays(self):
        plan = stt.boot_model("auto", base_cached=True, small_cached=True)
        self.assertEqual(plan["model"], "small")
        self.assertIsNone(plan["upgrade"])


if __name__ == "__main__":
    unittest.main()
