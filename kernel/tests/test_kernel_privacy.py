"""Kernel-side privacy firewall: the same two-tier rules the desktop enforces."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import privacy  # noqa: E402


class Model:
    def __init__(self, mid, provider, options):
        self.id = mid
        self.label = mid
        self.provider = provider
        self.options = options


LOCAL = Model("llama3", "ollama", {"type": "local"})
CLOUD = Model("gpt-5", "openai", {"type": "cloud", "access": "paid"})


class ClassifyTests(unittest.TestCase):
    def test_public_chat_is_public(self):
        self.assertEqual(privacy.classify("what is 2+2")["level"], "public")

    def test_password_without_colon_is_sensitive(self):
        self.assertEqual(privacy.classify("password hunter2")["level"], "sensitive")

    def test_pin_is_sensitive(self):
        self.assertEqual(privacy.classify("the pin is 1234")["level"], "sensitive")
        self.assertEqual(privacy.classify("my passcode is 999999")["level"], "sensitive")


class GuardTests(unittest.TestCase):
    def test_local_is_never_gated(self):
        decision = privacy.guard_egress(LOCAL, "my password: hunter2")
        self.assertFalse(decision["requiresConfirmation"])
        self.assertTrue(decision["autoAllowed"])

    def test_lmstudio_and_vllm_are_local_kinds(self):
        for kind in ("lmstudio", "vllm"):
            engine = Model("m", kind, {"type": kind})
            self.assertTrue(privacy.is_local_kind(engine))
            decision = privacy.guard_egress(engine, "my password: hunter2")
            self.assertFalse(decision["requiresConfirmation"])
            self.assertTrue(decision["autoAllowed"])

    def test_public_to_connected_cloud_autosends(self):
        decision = privacy.guard_egress(CLOUD, "what is 2+2", connected=True)
        self.assertFalse(decision["requiresConfirmation"])
        self.assertTrue(decision["autoAllowed"])

    def test_sensitive_to_connected_cloud_always_asks(self):
        decision = privacy.guard_egress(CLOUD, "my password: hunter2", connected=True)
        self.assertTrue(decision["requiresConfirmation"])
        self.assertFalse(decision["autoAllowed"])
        self.assertEqual(decision["classification"]["level"], "sensitive")

    def test_unconnected_destination_asks(self):
        decision = privacy.guard_egress(CLOUD, "what is 2+2", connected=False)
        self.assertTrue(decision["requiresConfirmation"])

    def test_user_content_skips_system_persona(self):
        text = privacy.user_content(
            [
                {"role": "system", "content": "You are FRIDAY. password: should-not-count"},
                {"role": "user", "content": "hello"},
            ]
        )
        self.assertEqual(text, "hello")
        self.assertEqual(privacy.classify(text)["level"], "public")


if __name__ == "__main__":
    unittest.main()
