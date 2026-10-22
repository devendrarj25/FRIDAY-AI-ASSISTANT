"""Persistent STT worker: status/ping without loading weights; shutdown reaps."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

KERNEL = Path(__file__).resolve().parent.parent
SCRIPT = KERNEL / "stt.py"
sys.path.insert(0, str(KERNEL))


class SttServeTests(unittest.TestCase):
    def test_serve_status_does_not_construct_a_model(self):
        proc = subprocess.Popen(
            [sys.executable, str(SCRIPT), "--serve"],
            cwd=str(KERNEL),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            assert proc.stdin and proc.stdout
            proc.stdin.write(json.dumps({"id": 1, "op": "status"}) + "\n")
            proc.stdin.flush()
            first = json.loads(proc.stdout.readline())
            self.assertEqual(first.get("id"), 1)
            self.assertEqual(first.get("loadCount"), 0)
            self.assertIn("moonshineReady", first)
            self.assertIs(first.get("windowsSpeech"), False)
            proc.stdin.write(json.dumps({"id": 2, "op": "status"}) + "\n")
            proc.stdin.flush()
            second = json.loads(proc.stdout.readline())
            self.assertEqual(second.get("id"), 2)
            self.assertEqual(second.get("loadCount"), 0)
            proc.stdin.write(json.dumps({"id": 3, "op": "shutdown"}) + "\n")
            proc.stdin.flush()
            proc.wait(timeout=10)
            self.assertEqual(proc.returncode, 0)
        finally:
            if proc.poll() is None:
                proc.kill()

    def test_probe_reports_ladder_facts_before_a_missing_whisper_exit(self):
        text = SCRIPT.read_text(encoding="utf-8")
        self.assertLess(text.index("if args.probe:"), text.index("if _import_whisper() is None:"))
        proc = subprocess.run(
            [sys.executable, str(SCRIPT), "--probe"],
            cwd=str(KERNEL),
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        payload = json.loads(proc.stdout)
        self.assertIn("moonshineReady", payload)
        self.assertIs(payload.get("windowsSpeech"), False)
        self.assertTrue(payload["ladder"]["local"])


class SttAudioGuardTests(unittest.TestCase):
    def test_av_range_accepts_17_and_18_and_rejects_19(self):
        import stt

        self.assertTrue(stt.av_in_range("17.0.0"))
        self.assertTrue(stt.av_in_range("18.0.0"))
        self.assertTrue(stt.av_in_range("18.1.0"))
        self.assertFalse(stt.av_in_range("16.1.0"))
        self.assertFalse(stt.av_in_range("19.0.0"))
        self.assertFalse(stt.av_in_range("19.0.2"))
        guard = stt.av_guard()
        if guard["installed"] and not guard["ok"]:
            self.assertIn("dependency-incompatible", guard["reason"])
            self.assertIn("av>=17.0.0,<19", guard["fix"])
        elif not guard["installed"]:
            self.assertTrue(guard["skipped"])
            self.assertIn("skipped", guard["reason"])

    def test_native_wav_becomes_a_float_array_without_pyav(self):
        import stt

        try:
            import numpy  # noqa: F401
        except ImportError:
            self.skipTest("numpy is not installed")
        with tempfile.TemporaryDirectory() as tmp:
            wav = stt.write_probe_wav(str(Path(tmp) / "clip.wav"))
            audio = stt.read_pcm16_wav(wav)
            self.assertIsNotNone(audio)
            assert audio is not None
            self.assertEqual(int(audio.shape[0]), int(1.5 * 16000))
            self.assertLess(float(audio.dtype.itemsize), 8)
            text = SCRIPT.read_text(encoding="utf-8")
            prepare = text.split("def prepare_audio", 1)[1].split("def transcribe_moonshine", 1)[0]
            self.assertNotIn("decode_audio", prepare)
            self.assertNotIn("metadata_errors", prepare)

    def test_metadata_errors_becomes_a_typed_dependency_fault(self):
        import stt

        fault = stt.classify_stt_exception(TypeError("open() got an unexpected keyword argument 'metadata_errors'"))
        self.assertEqual(fault.kind, "dependency-incompatible")
        self.assertIn("dependency-incompatible: av", str(fault))
        self.assertIn("av>=17.0.0,<19", fault.fix)
        self.assertEqual(stt.classify_stt_exception(MemoryError("CUDA out of memory")).kind, "oom")
        self.assertEqual(stt.classify_stt_exception(TimeoutError("timed out")).kind, "timeout")
        self.assertEqual(stt.classify_stt_exception(RuntimeError("not a wav")).kind, "audio-invalid")
        missing = stt.classify_stt_exception(FileNotFoundError("model not found"))
        self.assertEqual(missing.kind, "model-missing")

    def test_self_test_fails_when_transcription_raises(self):
        import stt

        def boom(_samples):
            raise TypeError("open() got an unexpected keyword argument 'metadata_errors'")

        result = stt.run_speech_self_test(transcribe=boom)
        self.assertFalse(result["ok"])
        self.assertFalse(result["skipped"])
        self.assertEqual(result["sttClass"], "dependency-incompatible")
        self.assertTrue(result["local"])

    def test_self_test_skip_is_visible_without_faster_whisper(self):
        import stt

        try:
            import faster_whisper  # noqa: F401
        except ImportError:
            result = stt.run_speech_self_test()
            self.assertTrue(result["ok"])
            self.assertTrue(result["skipped"])
            self.assertTrue(result.get("reason"))
            self.assertTrue(result["local"])
            return
        result = stt.run_speech_self_test()
        if result.get("skipped"):
            self.skipTest(result.get("reason") or "speech model is not on disk")
        self.assertTrue(result["ok"], result)
        self.assertIn("transcribeMs", result)
        self.assertIn("loadMs", result)
        self.assertGreaterEqual(result["transcribeMs"], 0)
        self.assertTrue(result["local"])

    def test_ladder_moves_to_the_next_local_engine(self):
        import stt

        moon = stt.live_ladder(
            {
                "whisperReady": False,
                "weightsReady": False,
                "english": True,
                "moonshineReady": True,
                "windowsSpeech": True,
            }
        )
        self.assertEqual(moon["engine"], "moonshine")
        windows = stt.live_ladder(
            {
                "whisperReady": False,
                "weightsReady": False,
                "english": False,
                "moonshineReady": True,
                "windowsSpeech": True,
            }
        )
        self.assertEqual(windows["engine"], "windows-speech")


if __name__ == "__main__":
    unittest.main()
