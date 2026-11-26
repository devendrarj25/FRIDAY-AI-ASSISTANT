"""The kernel reads the one shared SENSITIVE marker table (config/sensitive-markers.json)."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

KERNEL = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(KERNEL))

import privacy  # noqa: E402

ROOT = KERNEL.parent
FIXTURE = json.loads((ROOT / "core" / "__tests__" / "fixtures" / "sensitive-lines.json").read_text("utf-8"))
TABLE = json.loads((ROOT / "config" / "sensitive-markers.json").read_text("utf-8"))


class SharedLinesTests(unittest.TestCase):
    def test_fixture_is_big_enough(self):
        self.assertGreaterEqual(len(FIXTURE["sensitive"]), 29)
        self.assertGreaterEqual(len(FIXTURE["ordinary"]), 12)

    def test_every_sensitive_line_is_a_hard_stop(self):
        for line in FIXTURE["sensitive"]:
            self.assertEqual(privacy.classify(line)["level"], "sensitive", line)
            self.assertTrue(privacy.guard_egress({"type": "cloud"}, line, connected=True)["hardStop"], line)

    def test_ordinary_lines_are_not_sensitive(self):
        for line in FIXTURE["ordinary"]:
            self.assertNotEqual(privacy.classify(line)["level"], "sensitive", line)

    def test_a_secret_inside_a_longer_message_is_found(self):
        text = "Please summarise this note for me.\nमेरा ओटीपी 553920 है\nThanks."
        self.assertEqual(privacy.classify(text)["level"], "sensitive")


class OneTableTests(unittest.TestCase):
    def test_table_rows_have_the_documented_shape(self):
        self.assertGreaterEqual(len(TABLE["markers"]), 8)
        for row in TABLE["markers"]:
            self.assertTrue(row["pattern"] and row["kind"] and row["label"])
            self.assertIn(row["lang"], ("en", "hi", "hinglish"))
            self.assertIn(row["flags"], ("", "i"))

    def test_every_table_row_is_a_signal_with_its_label(self):
        labels = [signal["label"] for signal in privacy.SIGNALS]
        for row in TABLE["markers"]:
            self.assertIn(row["label"], labels)
        self.assertTrue(privacy.MARKERS_LOADED)

    def test_the_module_keeps_no_second_copy_of_the_markers(self):
        source = (KERNEL / "privacy.py").read_text("utf-8")
        self.assertFalse([ch for ch in source if "ऀ" <= ch <= "ॿ"])
        for needle in ("ghp_", "paasword", "seed phrase", "passcode|otp"):
            self.assertNotIn(needle, source)

    def test_a_missing_table_fails_closed(self):
        signals = privacy._load_markers(KERNEL / "no-such-table.json")
        self.assertEqual(len(signals), 1)
        self.assertEqual(signals[0]["level"], "sensitive")
        self.assertTrue(signals[0]["test"]("what is 2+2"))
        self.assertFalse(signals[0]["test"]("   "))

    def test_a_broken_table_fails_closed(self):
        import tempfile

        with tempfile.TemporaryDirectory() as folder:
            for body in ("not json", '{"markers": []}', '{"markers": [{"label": "x", "pattern": "("}]}'):
                table = Path(folder) / "table.json"
                table.write_text(body, encoding="utf-8")
                signals = privacy._load_markers(table)
                self.assertEqual(signals[0]["label"], privacy.MARKERS_MISSING_LABEL, body)


class SystemMessageTests(unittest.TestCase):
    def test_recalled_memory_in_a_system_message_is_classified(self):
        messages = [
            {"role": "system", "content": "You are FRIDAY."},
            {"role": "system", "content": "Relevant memory:\n- note: मेरा पासवर्ड abc123 है"},
            {"role": "user", "content": "hello"},
        ]
        text = privacy.user_content(messages)
        self.assertIn("abc123", text)
        self.assertNotIn("You are FRIDAY", text)
        self.assertEqual(privacy.classify(text)["level"], "sensitive")

    def test_conversation_gist_in_a_system_message_is_classified(self):
        messages = [
            {"role": "system", "content": "Earlier in this same conversation (shortened): my password is hunter2"},
            {"role": "user", "content": "go on"},
        ]
        self.assertEqual(privacy.classify(privacy.user_content(messages))["level"], "sensitive")

    def test_the_persona_and_tool_lists_stay_out(self):
        messages = [
            {"role": "system", "content": "Tools: api key: string, password: string"},
            {"role": "user", "content": "hello"},
        ]
        self.assertEqual(privacy.classify(privacy.user_content(messages))["level"], "public")


if __name__ == "__main__":
    unittest.main()
