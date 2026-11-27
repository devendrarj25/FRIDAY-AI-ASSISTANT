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
        self.assertGreaterEqual(len(FIXTURE["sensitive"]), 50)
        self.assertGreaterEqual(len(FIXTURE["ordinary"]), 40)

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


SECRETS = ("password", "pin", "otp", "cvv", "passcode", "paasword", "पासवर्ड", "पासकोड", "ओटीपी", "सीवीवी", "पिन")
VALUES = ("hunter", "हंटर", "sunshine", "सनशाइन", "nine one two", "ek do teen", "12", "abcd1234")
ORDERS = (
    lambda s, v: f"{s} hai {v}",
    lambda s, v: f"{s} है {v}",
    lambda s, v: f"mera {s} {v} hai",
    lambda s, v: f"{s} {v} है",
)
CLOSED_ORDERS = (
    lambda s, w: f"{s} hai {w}",
    lambda s, w: f"{s} {w} hai",
    lambda s, w: f"mera {s} {w} है",
)


class ValueRuleTests(unittest.TestCase):
    """Any value after or before है / hai is a secret; a question, filler or stop word is not."""

    def test_generated_lines_agree_with_the_desktop_firewall_and_renderer(self):
        wrong = []
        for secret in SECRETS:
            for value in VALUES:
                for order in ORDERS:
                    line = order(secret, value)
                    if privacy.classify(line)["level"] != "sensitive":
                        wrong.append(f"sensitive: {line}")
            for word in TABLE["words"]["closed"]:
                for order in CLOSED_ORDERS:
                    line = order(secret, word)
                    if privacy.classify(line)["level"] == "sensitive":
                        wrong.append(f"ordinary: {line}")
        self.assertEqual(wrong, [])

    def test_the_closed_lists_are_data_in_the_table(self):
        for word in ("kya", "kab", "kaise", "manager", "reset", "bhool", "क्या", "कैसे", "रीसेट", "भूल", "याद"):
            self.assertIn(word, TABLE["words"]["closed"])
        for word in ("mera", "hai", "aur", "है", "में", "वह"):
            self.assertIn(word, TABLE["words"]["stop"])
        source = (KERNEL / "privacy.py").read_text("utf-8")
        for needle in ("kaise", "manager", "tareeka", "chhah"):
            self.assertNotIn(needle, source)

    def test_an_unknown_placeholder_or_a_non_word_list_fails_closed(self):
        import tempfile

        row = {"label": "x", "pattern": "\\b(?:{{words.a}})\\b", "flags": "i"}
        bad_tables = (
            {"markers": [row], "words": {"a": ["ok|.*"]}},
            {"markers": [row], "words": {}},
            {"markers": [{**row, "pattern": "{{nope}}"}]},
        )
        with tempfile.TemporaryDirectory() as folder:
            for body in bad_tables:
                table = Path(folder) / "table.json"
                table.write_text(json.dumps(body), encoding="utf-8")
                self.assertEqual(privacy._load_markers(table)[0]["label"], privacy.MARKERS_MISSING_LABEL, body)
            table = Path(folder) / "good.json"
            table.write_text(json.dumps({"markers": [row], "words": {"a": ["ok", "kya"]}}), encoding="utf-8")
            self.assertEqual(privacy._load_markers(table)[0]["label"], "x")


class NormaliseTests(unittest.TestCase):
    def test_every_shared_normalise_case(self):
        for text, expected in FIXTURE["normalise"]:
            self.assertEqual(privacy.normalise_text(text), expected, text)

    def test_safe_on_empty_and_non_text(self):
        self.assertEqual(privacy.normalise_text(""), "")
        self.assertEqual(privacy.normalise_text(None), "")

    def test_what_speech_to_text_writes_for_a_secret_is_sensitive(self):
        for line in (
            "OTP है 482913",
            "mera O T P 482913",
            "मेरा ओ.टी.पी. 482913",
            "Password hai mera 4821",
            "pass word hai 4821",
        ):
            self.assertEqual(privacy.classify(line)["level"], "sensitive", line)

    def test_a_bare_hindi_word_with_no_value_stays_ordinary(self):
        for line in ("पासवर्ड बदलने का तरीका क्या है?", "कल की बैठक गुप्त रखना", "टोकन नंबर 45 कब आएगा?", "मेरा आधार कब बना?"):
            self.assertNotEqual(privacy.classify(line)["level"], "sensitive", line)

    def test_the_character_classes_live_in_the_table_only(self):
        source = (KERNEL / "privacy.py").read_text("utf-8")
        for needle in ("0966", "200d"):
            self.assertNotIn(needle, source)


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


_CODE = "".join(["4", "8", "2", "9", "1", "3"])
_GAP_SENSITIVE = (
    "Your verification code for login is {c}",
    "the OTP that I got is {c}",
    "OTP aaya tha {c} use karo",
    "ओटीपी आया था {c} इस्तेमाल करो",
    "{c} is your OTP for transaction of INR 5,000 at AMAZON. Do not share it",
    "Use {c} as your OTP",
    "OTP for txn of Rs 5,000 at Amazon is {c}. Valid for 10 minutes",
    "Dear customer, your one time password for the login to your account is {c}",
    "Your security code for the bank app has been sent and it is {c}",
    "Your login code was sent to your phone earlier today and it is {c}",
)
_GAP_ORDINARY = (
    "the verification code field is empty and the form shows an error today",
    "otp kab aayega mujhe batao jaldi",
    "what is an otp and how does it work in banking",
    "my pin code is 110001",
    "the postal code is 110001",
    "OTP support is open from 9 to 5",
    "the verification code expires after 10 minutes",
)


_GROUPED_SENSITIVE = (
    "otp {a}-{b}",
    "otp ({c})",
    "OTP [{c}]",
    "use {d} {e} as otp",
    "use {a} {b} as the otp",
    "the OTP that I received on my phone just now from the bank is {c}",
    "bank ka code {c} hai",
    "bank code {c} hai",
    "bank ka code {s} hai",
    "code is {s}",
    "your code is {s}",
    "ओटीपी {a}-{b}",
    "ओटीपी ({c})",
    "बैंक का कोड {c} है",
    "बैंक का ओटीपी जो अभी फोन पर आया है {c}",
    "mera bank ka otp abhi phone par aaya hai {c}",
    "कोड है {s}",
)
_GROUPED_ORDINARY = (
    "bank ka code review kal hai",
    "the code is in main.cjs",
    "the code is 4829 lines long",
    "the code compiles fine and the build passes on every machine today",
    "my pin code is 110001",
    "mera pin code 110001 hai",
    "the postal code is 110001",
    "otp kab aayega mujhe batao jaldi",
    "the verification code field is empty and the form shows an error today",
    "I scored 482913 points as a player",
    "bank ka code of conduct padhna hai",
    "बैंक का कोड रिव्यू कल है",
    "कोड ठीक चल रहा है",
)


def _grouped(template: str) -> str:
    c = "".join(["4", "8", "2", "9", "1", "3"])
    return template.format(a=c[:3], b=c[3:], c=c, d=c[:4], e=c[4:], s=" ".join(c))


class CodeWithGroupedDigitsTests(unittest.TestCase):
    def test_grouped_bracketed_and_longer_gap_codes_are_sensitive(self):
        for template in _GROUPED_SENSITIVE:
            line = _grouped(template)
            self.assertEqual(privacy.classify(line)["level"], "sensitive", line)
            self.assertTrue(privacy.guard_egress({"type": "cloud"}, line, connected=True)["hardStop"], line)

    def test_ordinary_lines_stay_public(self):
        for line in _GROUPED_ORDINARY:
            self.assertNotEqual(privacy.classify(line)["level"], "sensitive", line)

    def test_the_new_rows_stay_fast_on_long_inputs(self):
        import time

        for unit in ("otp 1 ", "bank ka code ", "code is 4 8 ", "otp (", "ओटीपी 12-", "w " * 9 + "otp "):
            text = (unit * (32000 // len(unit) + 1))[:32000]
            start = time.perf_counter()
            privacy.classify(text)
            self.assertLess(time.perf_counter() - start, 0.5, unit)


class CodeWithWordsBetweenTests(unittest.TestCase):
    def test_a_code_named_with_words_before_its_value_is_sensitive(self):
        for template in _GAP_SENSITIVE:
            line = template.format(c=_CODE)
            self.assertEqual(privacy.classify(line)["level"], "sensitive", line)

    def test_ordinary_talk_about_codes_stays_ordinary(self):
        for line in _GAP_ORDINARY:
            self.assertNotEqual(privacy.classify(line)["level"], "sensitive", line)

    def test_long_inputs_do_not_blow_up(self):
        import time

        for unit in ("otp ", "verification code ", "ओटीपी ", "a-", "1 ", "otp for the x, " + "w " * 4):
            text = (unit * (32000 // len(unit) + 1))[:32000]
            start = time.perf_counter()
            privacy.classify(text)
            self.assertLess(time.perf_counter() - start, 0.5, unit)
