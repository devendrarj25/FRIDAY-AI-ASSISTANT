"""Every model gets the earlier turns of the conversation, bounded and privacy-checked."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from router import Model, history_budget, history_messages  # noqa: E402


def model(provider: str, endpoint: str, context_k: int = 8, kind: str = "local") -> Model:
    return Model(
        id=f"{provider}:m",
        label="m",
        provider=provider,
        endpoint=endpoint,
        context_k=context_k,
        options={"type": kind},
    )


LOCAL = model("ollama", "http://127.0.0.1:11434")
CLOUD = model("openai", "https://api.openai.com/v1", 128, "cloud")

TALK = [
    {"role": "user", "text": "open the report"},
    {"role": "friday", "text": "Opened it. Anything to change?"},
    {"role": "user", "text": "yes, make it shorter"},
]


class ConversationHistoryTests(unittest.TestCase):
    def test_turns_become_alternating_chat_messages_without_the_asked_turn(self):
        out = history_messages(TALK, [LOCAL], prompt="yes, make it shorter")
        self.assertEqual([m["role"] for m in out], ["user", "assistant"])
        self.assertEqual(out[1]["content"], "Opened it. Anything to change?")

    def test_a_follow_up_has_something_to_refer_to(self):
        out = history_messages(TALK[:2], [LOCAL], prompt="and the other one?")
        self.assertIn("open the report", out[0]["content"])

    def test_sensitive_lines_stay_off_cloud_models_but_not_local_ones(self):
        talk = [
            {"role": "user", "text": "my card number is 1234", "sensitive": True},
            {"role": "friday", "text": "I will not repeat it."},
        ]
        self.assertEqual(history_messages(talk, [CLOUD], prompt="ok"), [])
        local = history_messages(talk, [LOCAL], prompt="ok")
        self.assertTrue(any("card number" in m["content"] for m in local))
        mixed = history_messages(talk, [LOCAL, CLOUD], prompt="ok")
        self.assertFalse(any("card number" in m["content"] for m in mixed))

    def test_a_long_talk_is_bounded_and_older_turns_become_a_short_gist(self):
        talk = []
        for i in range(60):
            talk.append({"role": "user", "text": f"question number {i} " + "x" * 400})
            talk.append({"role": "friday", "text": f"answer number {i} " + "y" * 400})
        out = history_messages(talk, [LOCAL], prompt="next")
        size = sum(len(m["content"]) for m in out if m["role"] != "system")
        self.assertLessEqual(size, history_budget([LOCAL]) + 800)
        self.assertEqual(out[0]["role"], "system")
        self.assertIn("Earlier in this same conversation", out[0]["content"])
        self.assertIn("answer number 59", out[-1]["content"])

    def test_a_small_context_window_gets_a_smaller_budget(self):
        tiny = model("ollama", "http://127.0.0.1:11434", 2)
        self.assertLess(history_budget([tiny]), history_budget([CLOUD]))
        self.assertGreaterEqual(history_budget([tiny]), 1500)

    def test_junk_in_gives_nothing_out(self):
        self.assertEqual(history_messages(None, [LOCAL]), [])
        self.assertEqual(history_messages([{"role": "tool", "text": "x"}, "x", {}], [LOCAL]), [])

    def test_no_two_messages_with_the_same_role_in_a_row(self):
        talk = [
            {"role": "user", "text": "a"},
            {"role": "user", "text": "b"},
            {"role": "friday", "text": "c"},
        ]
        out = history_messages(talk, [LOCAL], prompt="d")
        roles = [m["role"] for m in out]
        self.assertEqual(roles, ["user", "assistant"])
        self.assertIn("a\nb", out[0]["content"])


if __name__ == "__main__":
    unittest.main()
