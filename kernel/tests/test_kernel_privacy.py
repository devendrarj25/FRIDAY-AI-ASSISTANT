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

    def test_ordinary_words_are_not_financial(self):
        for text in (
            "how do I renew my passport",
            "what is an ssn",
            "the secret recipe uses cinnamon",
            "order 1000000000000001",
            "seen at 1729468800000",
        ):
            self.assertNotEqual(privacy.classify(text)["level"], "sensitive", text)

    def test_real_identifiers_are_a_hard_stop(self):
        decision = privacy.guard_egress(CLOUD, "card 4111 1111 1111 1111", connected=True)
        self.assertTrue(decision["hardStop"])
        self.assertIn("financial or identity number", decision["reason"])
        self.assertIn("local model", decision["reason"])
        self.assertFalse(decision["autoAllowed"])

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


class OwnerTextTests(unittest.TestCase):
    """`ownerText` carries what the owner brought into the turn (attachments, recalled memory, screen text).

    It sits in the system text the model reads, which the firewall skips, so the desktop sends it apart and
    the kernel classifies it with the owner's own words.
    """

    SECRET = "my password is hunter2"

    def test_ownerText_sensitive_with_innocent_prompt_is_sensitive(self):
        messages = [{"role": "system", "content": "You are FRIDAY."}, {"role": "user", "content": "summarise this"}]
        self.assertEqual(privacy.classify(privacy.user_content(messages))["level"], "public")
        text = privacy.user_content(messages, owner_text=self.SECRET)
        self.assertEqual(privacy.classify(text)["level"], "sensitive")
        self.assertTrue(privacy.guard_egress(CLOUD, text, connected=True)["hardStop"])

    def test_ownerText_may_be_a_list_of_parts(self):
        text = privacy.user_content("hello", owner_text=["a plain attachment", self.SECRET])
        self.assertEqual(privacy.classify(text)["level"], "sensitive")

    def test_ownerText_plain_text_stays_public_and_junk_is_ignored(self):
        self.assertEqual(privacy.user_content("hello", owner_text=None), "hello")
        self.assertEqual(privacy.user_content("hello", owner_text=42), "hello")
        self.assertEqual(privacy.user_content("hello", owner_text="  "), "hello")
        text = privacy.user_content("hello", owner_text="meeting notes about lunch")
        self.assertEqual(privacy.classify(text)["level"], "public")

    def test_ownerText_long_text_is_read_whole(self):
        long_text = ("lunch notes. " * 4000) + self.SECRET
        text = privacy.user_content("hello", owner_text=long_text)
        self.assertEqual(privacy.classify(text)["level"], "sensitive")


if __name__ == "__main__":
    unittest.main()
