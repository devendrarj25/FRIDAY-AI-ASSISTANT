"""Kernel-side billing firewall: the same rules the desktop enforces."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import billing  # noqa: E402


class Model:
    def __init__(self, mid, provider, options):
        self.id = mid
        self.label = mid
        self.provider = provider
        self.options = options


LOCAL = Model("llama3", "ollama", {"type": "local"})
FREE = Model("free-cloud", "openrouter", {"type": "cloud", "access": "free"})
PAID = Model("gpt-5", "openai", {"type": "cloud", "access": "paid"})
UNKNOWN = Model("mystery", "somewhere", {"type": "cloud"})


class BillingClassTests(unittest.TestCase):
    def test_unknown_is_never_free(self):
        self.assertEqual(billing.billing_class(UNKNOWN), "unknown")
        self.assertTrue(billing.is_billable(UNKNOWN))
        self.assertFalse(billing.is_billable(LOCAL))
        self.assertFalse(billing.is_billable(FREE))
        self.assertTrue(billing.is_billable(None))

    def test_access_record_verified_free_quota_is_free(self):
        model = Model(
            "gemini-flash",
            "gemini",
            {
                "type": "cloud",
                "access": "unknown",
                "accessRecord": {
                    "billingMode": "FREE_QUOTA",
                    "eligibility": "ELIGIBLE",
                    "verification": "VERIFIED",
                },
            },
        )
        self.assertEqual(billing.billing_class(model), "free")
        self.assertTrue(billing.guard(model, billing.DEFAULT_BILLING)["allowed"])

    def test_exhausted_credits_are_not_paid(self):
        model = Model(
            "cerebras-x",
            "cerebras",
            {
                "type": "cloud",
                "accessRecord": {
                    "billingMode": "FREE_CREDIT",
                    "eligibility": "EXHAUSTED",
                    "verification": "VERIFIED",
                },
            },
        )
        self.assertEqual(billing.billing_class(model), "unknown")
        self.assertFalse(billing.guard(model, billing.DEFAULT_BILLING, policy="free-only")["allowed"])


class GuardTests(unittest.TestCase):
    def test_local_and_free_always_allowed(self):
        for model in (LOCAL, FREE):
            self.assertTrue(billing.guard(model, billing.DEFAULT_BILLING)["allowed"])

    def test_paid_and_unknown_blocked_until_owner_authorises(self):
        paid = billing.guard(PAID, billing.DEFAULT_BILLING, policy="free-preferred")
        self.assertFalse(paid["allowed"])
        self.assertTrue(paid["requiresApproval"])
        unknown = billing.guard(UNKNOWN, billing.DEFAULT_BILLING, policy="free-preferred")
        self.assertFalse(unknown["allowed"])
        self.assertTrue(unknown["requiresApproval"])
        self.assertFalse(billing.guard(UNKNOWN, billing.DEFAULT_BILLING, policy="free-only")["allowed"])

    def test_unknown_allowed_only_when_owner_authorises(self):
        self.assertTrue(
            billing.guard(
                UNKNOWN,
                {"paidAccess": True},
                explicit_paid=True,
                policy="free-preferred",
            )["allowed"]
        )

    def test_auto_paid_alone_is_not_authorisation(self):
        verdict = billing.guard(PAID, {"autoPaidUsage": True})
        self.assertFalse(verdict["allowed"])

    def test_paid_needs_explicit_choice_unless_auto_paid(self):
        unlocked = {"paidAccess": True}
        self.assertFalse(billing.guard(PAID, unlocked)["allowed"])
        self.assertTrue(billing.guard(PAID, unlocked, explicit_paid=True)["allowed"])
        self.assertTrue(billing.guard(PAID, {"paidAccess": True, "autoPaidUsage": True})["allowed"])

    def test_free_only_policy_and_kill_switch_win(self):
        self.assertFalse(
            billing.guard(
                PAID,
                {"paidAccess": True, "autoPaidUsage": True},
                explicit_paid=True,
                policy="free-only",
            )["allowed"]
        )
        killed = {"paidAccess": True, "autoPaidUsage": True, "killSwitch": True}
        self.assertFalse(billing.guard(PAID, killed, explicit_paid=True)["allowed"])
        self.assertTrue(billing.guard(LOCAL, killed)["allowed"])

    def test_paid_only_excludes_free_and_still_needs_unlock(self):
        unlocked = {"paidAccess": True, "autoPaidUsage": True}
        self.assertFalse(billing.guard(LOCAL, unlocked, policy="paid-only")["allowed"])
        self.assertFalse(billing.guard(FREE, unlocked, policy="paid-only")["allowed"])
        self.assertTrue(billing.guard(PAID, unlocked, policy="paid-only")["allowed"])
        self.assertFalse(billing.guard(PAID, billing.DEFAULT_BILLING, policy="paid-only")["allowed"])

    def test_session_grant_expires(self):
        now = 1_000_000
        live = {"grantScope": "session", "grantUntil": now + 5_000}
        self.assertTrue(billing.guard(PAID, live, now=now)["allowed"])
        self.assertFalse(billing.guard(PAID, live, now=now + 10_000)["allowed"])


if __name__ == "__main__":
    unittest.main()


class ConsumeGrantTests(unittest.TestCase):
    """A one-shot unlock must be spent by the process that opens the socket."""

    def test_request_scope_is_spent(self):
        spent = billing.consume_grant({"grantScope": "request", "grantUntil": 0})
        self.assertEqual(spent["grantScope"], "off")

    def test_session_and_always_survive(self):
        for scope in ("session", "always"):
            keep = billing.consume_grant({"grantScope": scope, "grantUntil": 9_999_999_999_999})
            self.assertEqual(keep["grantScope"], scope)

    def test_spent_grant_no_longer_authorises_a_paid_model(self):
        state = {"grantScope": "request"}
        self.assertTrue(billing.guard(PAID, state).get("allowed"))
        spent = billing.consume_grant(state)
        self.assertFalse(billing.guard(PAID, spent).get("allowed"))


if __name__ == "__main__":
    unittest.main()
