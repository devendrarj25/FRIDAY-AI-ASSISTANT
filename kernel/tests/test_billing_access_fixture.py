"""The kernel and the desktop read one fixture, so free cannot drift."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import billing  # noqa: E402

FIXTURE = Path(__file__).resolve().parents[2] / "core" / "fixtures" / "billing-access-records.json"


class BillingAccessFixtureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = json.loads(FIXTURE.read_text(encoding="utf-8"))

    def test_each_record_matches_the_shared_class(self):
        self.assertFalse(self.data["paidAccess"])
        self.assertGreaterEqual(len(self.data["cases"]), 8)
        for case in self.data["cases"]:
            model = case["model"]
            klass = billing.billing_class(model)
            verdict = billing.guard(model, {})
            self.assertEqual(klass, case["class"], case["id"])
            self.assertEqual(verdict["allowed"], case["allowed"], case["id"])
            self.assertEqual(verdict["billingClass"], case["class"], case["id"])
            # Paid access is off. Allowed is true only for a free class.
            self.assertEqual(verdict["allowed"], klass == "free", case["id"])

    def test_stale_zero_cost_names_a_refresh(self):
        stale = next(case["model"] for case in self.data["cases"] if case["id"] == "stale-zero-cost")
        verdict = billing.guard(stale, {})
        self.assertFalse(verdict["allowed"])
        self.assertEqual(verdict["blockKind"], "unverified")
        self.assertIn("pricing info is stale, refresh now", verdict["reason"])


if __name__ == "__main__":
    unittest.main()
