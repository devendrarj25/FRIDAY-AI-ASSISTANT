"""OpenRouter connected, listed 396 models, and every chat came back empty.

The cause: OpenAI-wire providers deliver rate limits, upstream outages and
moderation refusals as an *error frame inside a 200 stream*. The parser read
the frame, found no `choices`, and continued - so the turn ended with no text
and no error. That silence is now a real, reported failure.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from router import Model, _frame_error


def openrouter(label="openrouter/free"):
    return Model(
        id=label,
        label=label,
        provider="openrouter",
        endpoint="https://openrouter.ai/api/v1",
    )


def test_error_frame_names_the_model_and_the_provider_s_own_words():
    said = _frame_error(
        openrouter(),
        {"code": 429, "message": "Rate limit exceeded: free-models-per-day"},
    )
    assert "openrouter/free" in said
    assert "429" in said
    assert "Rate limit exceeded: free-models-per-day" in said


def test_upstream_outage_detail_is_kept_not_flattened():
    said = _frame_error(
        openrouter(),
        {
            "code": 502,
            "message": "Provider returned error",
            "metadata": {"raw": "upstream model is offline"},
        },
    )
    assert "upstream model is offline" in said


def test_a_plain_string_error_frame_is_still_reported():
    said = _frame_error(openrouter(), "something went wrong")
    assert "something went wrong" in said
    assert "openrouter/free" in said


def test_an_empty_reply_is_never_reported_as_success():
    # A frame carrying an error must produce a message, never "".
    for problem in ({"message": "x"}, {"error": "y"}, "z", {"code": 400}):
        assert _frame_error(openrouter(), problem).strip()
