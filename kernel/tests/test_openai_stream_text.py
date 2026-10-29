"""OpenAI-compatible SSE frames must yield actual assistant text."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from router import coerce_stream_text, openai_frame_text


def test_delta_content_string():
    assert openai_frame_text({"choices": [{"delta": {"content": "Hi"}}]}) == "Hi"


def test_delta_text_and_choices_text():
    assert openai_frame_text({"choices": [{"delta": {"text": "A"}}]}) == "A"
    assert openai_frame_text({"choices": [{"text": "B"}]}) == "B"


def test_content_parts_join():
    frame = {"choices": [{"delta": {"content": [{"type": "text", "text": "Hel"}, {"type": "text", "text": "lo"}]}}]}
    assert openai_frame_text(frame) == "Hello"


def test_done_and_empty_are_none():
    assert openai_frame_text({"choices": [{"delta": {}}]}) is None
    assert coerce_stream_text("") is None
    assert coerce_stream_text(None) is None
