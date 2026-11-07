"""Language and script spans for speech (mixed Hindi and English)."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import language_segmenter as seg  # noqa: E402


class SegmentTests(unittest.TestCase):
    def test_empty_gives_no_spans(self) -> None:
        self.assertEqual(seg.segment("   "), [])

    def test_pure_hindi_is_one_span(self) -> None:
        spans = seg.segment("मुझे आज का मौसम बताओ")
        self.assertEqual([s.lang for s in spans], ["hi"])

    def test_pure_english_is_one_span(self) -> None:
        spans = seg.segment("Open the report and read it")
        self.assertEqual([(s.lang, s.text) for s in spans], [("en", "Open the report and read it")])

    def test_mixed_keeps_written_order_and_is_not_na(self) -> None:
        text = "Please open Chrome now और फिर रिपोर्ट का सारांश बनाओ"
        spans = seg.segment(text)
        self.assertEqual([s.lang for s in spans], ["en", "hi"])
        self.assertEqual(" ".join(s.text for s in spans).split(), text.split())
        self.assertNotIn("na", {s.lang for s in spans})

    def test_one_english_word_inside_hindi_is_not_its_own_request(self) -> None:
        spans = seg.segment("मेरी report का सारांश बनाओ")
        self.assertEqual(len(spans), 1)
        self.assertEqual(spans[0].lang, "hi")

    def test_lone_leading_english_word_joins_the_hindi_clause(self) -> None:
        spans = seg.segment("Friday मेरी बात सुनो")
        self.assertEqual([s.lang for s in spans], ["hi"])

    def test_span_count_is_bounded(self) -> None:
        text = " ".join("one two काम करो" if i % 2 else "three four go now" for i in range(30))
        spans = seg.segment(text)
        self.assertLessEqual(len(spans), seg.MAX_SPANS)
        self.assertEqual("".join(s.text for s in spans).replace(" ", ""), text.replace(" ", ""))

    def test_digits_and_punctuation_stay_in_their_span(self) -> None:
        spans = seg.segment("आज 25 जनवरी है, call me at 5 pm")
        self.assertEqual([s.lang for s in spans], ["hi", "en"])
        self.assertIn("25", spans[0].text)
        self.assertIn("5", spans[1].text)

    def test_only_digits_use_the_requested_language(self) -> None:
        self.assertEqual(seg.segment("2025", "hi-IN")[0].lang, "hi")
        self.assertEqual(seg.segment("2025", "en-IN")[0].lang, "en")

    def test_dominant_lang(self) -> None:
        self.assertEqual(seg.dominant_lang("open Chrome करो"), "en")
        self.assertEqual(seg.dominant_lang("क्रोम खोलो please"), "hi")
        self.assertEqual(seg.dominant_lang("", "hi-IN"), "hi")

    def test_roman_hindi_ratio_is_a_hint(self) -> None:
        self.assertGreater(seg.roman_hindi_ratio("Aaj ka weather batao"), 0.3)
        self.assertEqual(seg.roman_hindi_ratio("Open the file"), 0.0)
        self.assertEqual(seg.roman_hindi_ratio("नमस्ते"), 0.0)


class SpeakSpansTests(unittest.TestCase):
    """speak_wav_bytes reads each language span in its own language, in order."""

    def test_mixed_text_is_read_span_by_span_with_one_voice(self) -> None:
        import io
        import types
        from unittest import mock

        import soundfile as sf  # type: ignore
        import voice_runtime

        calls: list[tuple[str, str, str]] = []

        class FakeTTS:
            sample_rate = 8000

            def __init__(self, **_kwargs: object) -> None:
                pass

            def get_voice_style(self, name: str) -> str:
                return name

            def synthesize(self, text: str, voice_style: str, lang: str, **_kw: object):
                calls.append((text, lang, voice_style))
                return [0.1] * 800, 0.1

        fake = types.SimpleNamespace(TTS=FakeTTS)
        with (
            mock.patch.object(voice_runtime, "supertonic_dir", return_value=Path(".")),
            mock.patch.dict(sys.modules, {"supertonic": fake}),
            mock.patch.object(voice_runtime, "_tts", None),
        ):
            data = voice_runtime.speak_wav_bytes("Please open Chrome now और फिर रिपोर्ट का सारांश बनाओ")
        self.assertIsNotNone(data)
        self.assertEqual([c[1] for c in calls], ["en", "hi"])
        self.assertEqual({c[2] for c in calls}, {voice_runtime.SUPERTONIC_VOICE})
        self.assertNotIn("na", [c[1] for c in calls])
        audio, rate = sf.read(io.BytesIO(data or b""))
        self.assertEqual(rate, 8000)
        gap = int(8000 * voice_runtime.SPAN_GAP_SECONDS)
        self.assertEqual(len(audio), 800 * 2 + gap)

    def test_single_script_is_one_call(self) -> None:
        import types
        from unittest import mock

        import voice_runtime

        calls: list[str] = []

        class FakeTTS:
            sample_rate = 8000

            def __init__(self, **_kwargs: object) -> None:
                pass

            def get_voice_style(self, name: str) -> str:
                return name

            def synthesize(self, text: str, lang: str, **_kw: object):
                calls.append(lang)
                return [0.1] * 80, 0.01

        with (
            mock.patch.object(voice_runtime, "supertonic_dir", return_value=Path(".")),
            mock.patch.dict(sys.modules, {"supertonic": types.SimpleNamespace(TTS=FakeTTS)}),
            mock.patch.object(voice_runtime, "_tts", None),
        ):
            self.assertIsNotNone(voice_runtime.speak_wav_bytes("मुझे आज का मौसम बताओ"))
        self.assertEqual(calls, ["hi"])


class VoiceStyleTests(unittest.TestCase):
    """Only F1..F5 and M1..M5 reach the model; anything else is the default, never a failed reply."""

    def test_names(self) -> None:
        import voice_runtime

        self.assertEqual(voice_runtime.voice_style_name("f3"), "F3")
        self.assertEqual(voice_runtime.voice_style_name(" M5 "), "M5")
        for bad in ("", "F6", "F0", "../x", "F22", "x1", None):
            self.assertEqual(voice_runtime.voice_style_name(bad or ""), voice_runtime.SUPERTONIC_VOICE)

    def test_style_reaches_the_model_and_a_missing_style_falls_back(self) -> None:
        import types
        from unittest import mock

        import voice_runtime

        asked: list[str] = []

        class FakeTTS:
            sample_rate = 8000

            def __init__(self, **_kwargs: object) -> None:
                pass

            def get_voice_style(self, name: str) -> str:
                asked.append(name)
                if name == "F5":
                    raise KeyError(name)
                return name

            def synthesize(self, text: str, voice_style: str, **_kw: object):
                return [0.1] * 80, 0.01

        with (
            mock.patch.object(voice_runtime, "supertonic_dir", return_value=Path(".")),
            mock.patch.dict(sys.modules, {"supertonic": types.SimpleNamespace(TTS=FakeTTS)}),
            mock.patch.object(voice_runtime, "_tts", None),
        ):
            self.assertIsNotNone(voice_runtime.speak_wav_bytes("hello there", 1.0, "en-IN", "F3"))
            self.assertIsNotNone(voice_runtime.speak_wav_bytes("hello there", 1.0, "en-IN", "F5"))
            self.assertIsNotNone(voice_runtime.speak_wav_bytes("hello there", 1.0, "en-IN", "bad"))
        self.assertEqual(asked, ["F3", "F5", voice_runtime.SUPERTONIC_VOICE, voice_runtime.SUPERTONIC_VOICE])


if __name__ == "__main__":
    unittest.main()
