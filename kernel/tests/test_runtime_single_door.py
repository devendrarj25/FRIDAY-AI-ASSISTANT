"""One door: ``InferenceSession(`` is opened in exactly one kernel file, ``friday_runtime.py``.

A source pin, so a new voice module that opens its own session (and so skips the thread budget, the hash check and the
CPU fallback) fails here. The packages ``supertonic`` and ``onnx_asr`` open sessions inside themselves; that is outside
this scan and is named in ``friday_runtime``'s docstring.
"""

from __future__ import annotations

import re
from pathlib import Path

KERNEL = Path(__file__).resolve().parents[1]
CALL = re.compile(r"\bInferenceSession\s*\(")
DOOR_USERS = (
    "denoise_onnx",
    "ear_scene",
    "friday_voice",
    "hindi_punct",
    "nemo_ear",
    "transducer_loop",
    "tts_hindi_light",
    "vad_onnx",
    "voice_pin_selftest",
    "voice_runtime",
    "wake_features",
    "wake_word",
)


def _hits() -> dict[str, int]:
    found: dict[str, int] = {}
    for path in sorted(KERNEL.glob("*.py")):
        count = len(CALL.findall(path.read_text(encoding="utf-8")))
        if count:
            found[path.name] = count
    return found


def test_inference_session_is_called_in_one_kernel_file_only():
    assert set(_hits()) == {"friday_runtime.py"}


def test_the_door_opens_it_in_one_place():
    assert _hits()["friday_runtime.py"] == 1


def test_every_voice_module_that_opens_a_graph_goes_through_the_door():
    for name in DOOR_USERS:
        source = (KERNEL / f"{name}.py").read_text(encoding="utf-8")
        assert "friday_runtime.open_session(" in source, name
