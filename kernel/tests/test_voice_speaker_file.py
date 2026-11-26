"""The kernel looks for the speaker file the optional pin downloads; a hand-placed legacy file still counts."""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

KERNEL = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(KERNEL))

import voice_runtime  # noqa: E402


class SpeakerFileTests(unittest.TestCase):
    def _status(self, files: list[tuple[str, ...]]) -> dict:
        with tempfile.TemporaryDirectory() as tmp:
            for parts in files:
                target = Path(tmp, "models", *parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(b"onnx")
            previous = os.environ.get("FRIDAY_ROOT")
            os.environ["FRIDAY_ROOT"] = tmp
            try:
                return voice_runtime.speaker_status()
            finally:
                if previous is None:
                    os.environ.pop("FRIDAY_ROOT", None)
                else:
                    os.environ["FRIDAY_ROOT"] = previous

    def test_nothing_on_disk_is_not_ready(self):
        status = self._status([])
        self.assertFalse(status["ready"])
        self.assertEqual(status["engine"], "none")

    def test_the_pinned_download_is_found(self):
        status = self._status([voice_runtime.SPEAKER_PINNED])
        self.assertEqual(voice_runtime.SPEAKER_PINNED, ("speaker-wespeaker", "onnx", "model_int8.onnx"))
        self.assertTrue(status["ready"])
        self.assertEqual(status["engine"], "wespeaker-resnet34-lm")
        self.assertFalse(status["gate"])

    def test_a_hand_placed_legacy_file_still_counts(self):
        status = self._status([(voice_runtime.SPEAKER_FILE,)])
        self.assertTrue(status["ready"])
        self.assertEqual(status["engine"], "wespeaker-ecapa")

    def test_an_empty_pinned_file_is_not_a_model(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp, "models", *voice_runtime.SPEAKER_PINNED)
            target.parent.mkdir(parents=True)
            target.write_bytes(b"")
            previous = os.environ.get("FRIDAY_ROOT")
            os.environ["FRIDAY_ROOT"] = tmp
            try:
                self.assertEqual(voice_runtime.speaker_status()["engine"], "none")
            finally:
                if previous is None:
                    os.environ.pop("FRIDAY_ROOT", None)
                else:
                    os.environ["FRIDAY_ROOT"] = previous


if __name__ == "__main__":
    unittest.main()
