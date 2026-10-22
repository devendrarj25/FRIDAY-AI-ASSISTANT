"""Hearing path: denoise scale, loudness guard, one no-speech rule, drop codes."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import stt  # noqa: E402
import voice_runtime  # noqa: E402


def _voiced(seconds: float = 1.0, peak: float = 0.5):
    import numpy as np

    t = np.arange(int(16000 * seconds)) / 16000
    wave = np.sin(2 * np.pi * 180 * t) * (0.6 + 0.4 * np.sin(2 * np.pi * 3 * t))
    wave = wave + 0.3 * np.sin(2 * np.pi * 540 * t)
    return (wave / np.max(np.abs(wave)) * peak).astype(np.float32)


class DenoiseScale(unittest.TestCase):
    def test_output_stays_unit_float_at_every_level(self):
        try:
            import numpy as np
            from pyrnnoise import RNNoise  # noqa: F401
        except ImportError:
            self.skipTest("pyrnnoise or numpy is not installed")
        for peak in (0.9, 0.5, 0.05, 0.008):
            cleaned = np.asarray(voice_runtime.denoise_pcm(_voiced(1.0, peak), 16000))
            self.assertEqual(cleaned.dtype, np.float32)
            self.assertLessEqual(float(np.max(np.abs(cleaned))), 1.0, f"peak {peak}")
            # Same scale as the input: never the int16 scale, never silence.
            self.assertLess(float(np.max(np.abs(cleaned))), peak * 3 + 0.01, f"peak {peak}")
            self.assertGreater(float(np.max(np.abs(cleaned))), peak * 0.3, f"peak {peak}")

    def test_int16_scale_frames_are_clipped_and_scaled_in_one_place(self):
        import numpy as np

        class Fake:
            def __init__(self, _rate):
                pass

            def denoise_chunk(self, pcm, partial=True):
                yield 0.9, (pcm * 1.0).astype(np.int16) * 1  # int16 frame like pyrnnoise

        import types

        module = types.ModuleType("pyrnnoise")
        module.RNNoise = Fake
        sys.modules["pyrnnoise"] = module
        try:
            loud = np.full(1600, 0.9, dtype=np.float32)
            out = np.asarray(voice_runtime.denoise_pcm(loud, 16000))
            self.assertLessEqual(float(np.max(np.abs(out))), 1.0)
            self.assertAlmostEqual(float(out[0]), 0.9, places=3)
        finally:
            del sys.modules["pyrnnoise"]


class LoudnessGuard(unittest.TestCase):
    def test_louder_quieter_and_clipped_results_fall_back_to_the_original(self):
        import numpy as np

        original = _voiced(0.5, 0.1)
        for cleaned, reason in (
            (original * 6.0, "denoise-skipped: louder than the original"),
            (original * 0.05, "denoise-skipped: removed the signal"),
            (np.clip(original * 20.0, -1.0, 1.0), "denoise-skipped: louder than the original"),
        ):
            chosen, note = voice_runtime.guard_denoised(original, cleaned)
            self.assertEqual(note, reason)
            self.assertTrue(np.array_equal(chosen, original))
        flat = np.full(1600, 0.4, dtype=np.float32)
        clipped = np.concatenate([flat[:800], np.ones(800, dtype=np.float32)])
        chosen, note = voice_runtime.guard_denoised(flat, clipped * 1.0)
        self.assertTrue(note.startswith("denoise-skipped"))
        kept, note = voice_runtime.guard_denoised(original, original * 0.8)
        self.assertEqual(note, "")


class NoSpeechRule(unittest.TestCase):
    def test_one_threshold_and_both_conditions_to_drop_text(self):
        thr = voice_runtime.NO_SPEECH_THRESHOLD
        low = voice_runtime.LOW_CONFIDENCE_LOGPROB
        text, _note, code = stt.apply_no_speech_policy("open chrome", thr + 0.1, low + 0.4)
        self.assertEqual((text, code), ("open chrome", ""))
        text, _note, code = stt.apply_no_speech_policy("open chrome", thr - 0.2, low - 0.5)
        self.assertEqual((text, code), ("open chrome", ""))
        text, _note, code = stt.apply_no_speech_policy("open chrome", thr + 0.1, None)
        self.assertEqual((text, code), ("open chrome", ""))
        text, note, code = stt.apply_no_speech_policy("thank you", thr + 0.1, low - 0.3)
        self.assertEqual((text, code), ("", "low-confidence"))
        self.assertIn("avg_logprob", note)
        self.assertEqual(stt.apply_no_speech_policy("", thr, None)[2], "no-speech")
        self.assertEqual(stt.apply_no_speech_policy("", 0.1, None)[2], "empty")

    def test_the_kernel_is_the_only_place_with_the_number(self):
        root = Path(__file__).resolve().parents[2]
        for rel in ("src/lib/friday/voice-stt.ts", "src/lib/friday/voice-hearing.ts"):
            body = (root / rel).read_text(encoding="utf-8")
            self.assertNotIn(">= 0.7", body, rel)
            self.assertNotIn(">= 0.65", body, rel)


class DropCodes(unittest.TestCase):
    def test_every_empty_utterance_gets_exactly_one_known_code(self):
        cases = {
            "no-frames": dict(duration_ms=0),
            "too-short": dict(duration_ms=120),
            "denoise-skipped": dict(duration_ms=900, denoise_note="denoise-skipped: clipped"),
            "no-speech": dict(duration_ms=900, rms_dbfs=-62.0),
            "low-confidence": dict(duration_ms=900, policy_code="low-confidence"),
            "empty": dict(duration_ms=900, rms_dbfs=-20.0, vad_ms=400),
        }
        for want, kwargs in cases.items():
            self.assertEqual(stt.drop_code("", **kwargs), want)
            self.assertIn(want, voice_runtime.DROP_CODES)
        self.assertEqual(stt.drop_code("open chrome", duration_ms=900), "")
        self.assertIn("stt-fault", voice_runtime.DROP_CODES)

    def test_counters_split_heard_from_dropped_by_reason(self):
        before = stt.counters_payload()
        stt.note_outcome("")
        stt.note_outcome("no-speech")
        stt.note_outcome("no-speech")
        stt.note_outcome("stt-fault")
        after = stt.counters_payload()
        self.assertEqual(after["heard"], before["heard"] + 1)
        self.assertEqual(after["dropped"]["no-speech"], before["dropped"]["no-speech"] + 2)
        self.assertEqual(after["dropped"]["stt-fault"], before["dropped"]["stt-fault"] + 1)
        self.assertEqual(set(after["dropped"]), set(voice_runtime.DROP_CODES))


class HearingSelfTest(unittest.TestCase):
    """The self-test drives the real WAV -> prepare_audio -> denoise path.

    Only the recogniser is a stand-in here (the Whisper weights are not on every
    machine). A real Whisper run happens on a machine that has the weights.
    """

    def _stand_in_recogniser(self, seen: list):
        def run(path: str) -> dict:
            _audio, samples, _cleanup, hearing = stt.prepare_audio(path)
            import numpy as np

            seen.append((hearing, float(np.max(np.abs(samples)))))
            loud_enough = hearing["rmsDbfs"] is not None and hearing["rmsDbfs"] > -50.0
            return {
                "text": "Friday what time is it" if loud_enough else "",
                "dropCode": "" if loud_enough else "no-speech",
                "audio": hearing,
            }

        return run

    def test_three_levels_pass_through_the_real_denoise_path(self):
        seen: list = []
        report = stt.run_hearing_self_test(
            synth=lambda: (_voiced(1.2, 0.8), "stand-in"),
            transcribe=self._stand_in_recogniser(seen),
        )
        self.assertFalse(report["skipped"])
        self.assertTrue(report["ok"], report)
        self.assertEqual([row["level"] for row in report["levels"]], [0.5, 0.05, 0.008])
        self.assertEqual(len(seen), 3)
        for hearing, peak in seen:
            self.assertLessEqual(peak, 1.0)
            # RNNoise may treat a synthetic tone as noise. The guard then
            # hands Whisper the original, and says so.
            self.assertIn(hearing["denoiseNote"][:16], {"", "denoise-skipped:"})

    def test_a_level_that_hears_nothing_fails_not_passes(self):
        report = stt.run_hearing_self_test(
            levels=(0.5,),
            synth=lambda: (_voiced(1.0, 0.8), "stand-in"),
            transcribe=lambda _path: {"text": "", "dropCode": "empty"},
        )
        self.assertFalse(report["ok"])
        self.assertEqual(report["levels"][0]["dropCode"], "empty")

    def test_no_synthesiser_is_a_visible_skip(self):
        report = stt.run_hearing_self_test(synth=lambda: (None, "no speech synthesiser"))
        self.assertTrue(report["skipped"])
        self.assertIn("synthesiser", report["reason"])

    def test_real_synthesiser_and_whisper_when_both_exist(self):
        clip, engine = stt.synth_speech_clip()
        if clip is None:
            self.skipTest(engine)
        report = stt.run_hearing_self_test()
        if report["skipped"]:
            self.skipTest(report["reason"][:120])
        for row in report["levels"]:
            self.assertTrue(row["ok"], row)

    def test_words_heard_needs_whole_words(self):
        self.assertEqual(stt.words_heard("Friday, what time is it?"), ["friday", "what", "time"])
        self.assertEqual(stt.words_heard("sometimes"), [])


class PipelineOrder(unittest.TestCase):
    def test_voice_and_chat_share_one_brain_funnel(self):
        root = Path(__file__).resolve().parents[2]
        mode = (root / "src/lib/friday/assistant-mode.ts").read_text(encoding="utf-8")
        # Heard text enters handleHeard, then the shared brain, never a second one.
        self.assertIn("this.handleHeard(text, meta?.wake ?? null)", mode)
        self.assertIn("brain.subscribe(() => this.speakNewReplies())", mode)
        self.assertIn("brain.send(command, payload)", mode)


if __name__ == "__main__":
    unittest.main()
