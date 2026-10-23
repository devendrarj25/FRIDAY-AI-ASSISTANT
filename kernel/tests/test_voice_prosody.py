"""Voice tone cues: pitch, spread, loudness, voiced share of one utterance."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import voice_runtime  # noqa: E402


def _voice(f0: float, amp: float, wobble: float = 0.0, secs: float = 1.5):
    import numpy as np

    rate = 16000
    t = np.arange(int(rate * secs)) / rate
    freq = f0 * (1 + wobble * np.sin(2 * np.pi * 3 * t))
    phase = 2 * np.pi * np.cumsum(freq) / rate
    signal = sum(np.sin(k * phase) / k for k in range(1, 6))
    return (signal / np.max(np.abs(signal)) * amp).astype(np.float32)


class VoiceProsody(unittest.TestCase):
    def test_pitch_is_measured_within_three_percent(self):
        for f0 in (110.0, 200.0, 260.0):
            row = voice_runtime.voice_prosody(_voice(f0, 0.3))
            self.assertTrue(row["ok"])
            self.assertAlmostEqual(row["pitchHz"], f0, delta=f0 * 0.03)

    def test_a_tense_voice_is_higher_louder_and_livelier_than_a_calm_one(self):
        calm = voice_runtime.voice_prosody(_voice(110.0, 0.1))
        tense = voice_runtime.voice_prosody(_voice(260.0, 0.6, wobble=0.15))
        self.assertGreater(tense["pitchHz"], calm["pitchHz"])
        self.assertGreater(tense["energyDbfs"], calm["energyDbfs"])
        self.assertGreater(tense["pitchSpreadSemitones"], calm["pitchSpreadSemitones"])

    def test_silence_and_short_clips_say_why_instead_of_guessing(self):
        import numpy as np

        self.assertEqual(voice_runtime.voice_prosody(np.zeros(16000, dtype=np.float32))["reason"], "no voiced frames")
        self.assertEqual(voice_runtime.voice_prosody(np.zeros(100, dtype=np.float32))["reason"], "too short")

    def test_real_synthesised_speech_when_espeak_exists(self):
        import stt

        clip, engine = stt.synth_speech_clip("Friday, please open the report")
        if clip is None:
            self.skipTest(engine)
        row = voice_runtime.voice_prosody(clip)
        self.assertTrue(row["ok"], row)
        self.assertGreater(row["pitchHz"], 60)
        self.assertLess(row["pitchHz"], 400)
        self.assertGreater(row["voicedShare"], 0.1)

    def test_the_hearing_facts_carry_the_tone(self):
        root = Path(__file__).resolve().parents[1]
        body = (root / "stt.py").read_text(encoding="utf-8")
        self.assertIn('hearing["prosody"] = voice_runtime.voice_prosody(raw, PROBE_RATE)', body)
        # The tone is read from the microphone's own clip, never the gain-lifted copy.
        self.assertNotIn("voice_prosody(original", body)


if __name__ == "__main__":
    unittest.main()
