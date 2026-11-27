"""The contact-detail signal must be linear: a long run of word characters with dashes is not a quadratic scan."""

from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import privacy  # noqa: E402


def _seconds(text: str) -> float:
    start = time.perf_counter()
    privacy.classify(text)
    return time.perf_counter() - start


def test_a_long_dashed_run_without_an_at_sign_is_fast():
    assert _seconds("das-" * 8000) < 0.5


def test_other_long_inputs_are_fast():
    for text in ("a." * 16000, "a" * 32000, "+91 " * 8000, "x@" * 16000, ("word" + "-") * 8000 + "@"):
        assert _seconds(text) < 0.5, text[:10]


def test_real_contact_details_are_still_found():
    assert privacy.classify("write to someone@example.com please")["level"] == "private"
    assert privacy.classify("call +91 98765 43210 now")["level"] == "private"
    assert privacy.classify("mail a.b+c@mail-host.co.in today")["level"] == "private"
