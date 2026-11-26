"""The text gates: the moved ones stay importable from stt, and the new ones (compression ratio, speech fraction,
phrase table, token confidence, short clips) decide on numbers alone. No model, no audio, no network, no clock."""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

KERNEL = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(KERNEL))

import stt  # noqa: E402
import transcript_gate as gate  # noqa: E402

HINDI_SENTENCE = "क्रोम खोलो और दिल्ली का मौसम बताओ मुझे आज बारिश होगी क्या"
LOOP = "धन्यवाद धन्यवाद धन्यवाद धन्यवाद धन्यवाद"


def test_moved_gates_are_the_same_objects_in_stt() -> None:
    for name in (
        "apply_no_speech_policy",
        "is_noise_hallucination",
        "is_invented_noise",
        "is_repetition_loop",
        "is_foreign_script",
        "live_segment_is_noise",
    ):
        assert getattr(stt, name) is getattr(gate, name), name
    assert stt.NOISE_PHRASE_MAX_SECONDS == gate.NOISE_PHRASE_MAX_SECONDS == 2.5
    assert stt.LIVE_NOISE_NO_SPEECH == 0.6 and stt.LIVE_NOISE_LOGPROB == -1.0
    assert "thank you" in stt._NOISE_PHRASES and "धन्यवाद" in stt._NOISE_PHRASES


def test_compression_ratio_separates_speech_from_a_loop() -> None:
    assert gate.compression_ratio("") == 0.0
    for spoken in ("open chrome and search for the latest news about the weather in Delhi today", HINDI_SENTENCE):
        assert gate.compression_ratio(spoken) < 1.7, spoken
        assert not gate.is_compression_loop(spoken)
    assert gate.compression_ratio(LOOP) > gate.COMPRESSION_RATIO_MAX
    assert gate.is_compression_loop(LOOP)
    assert gate.is_compression_loop("x" * 400)


def test_a_short_text_is_never_called_a_compression_loop() -> None:
    assert not gate.is_compression_loop("ha ha ha")  # under the byte floor; the loop gate speaks for it
    assert gate.is_repetition_loop("ha ha ha")


def test_policy_drops_a_compression_loop_even_with_strong_evidence() -> None:
    text, note, code = gate.apply_no_speech_policy(LOOP, 0.0, -0.1, 8.0)
    assert (text, code) == ("", "no-speech")
    assert "compression" in note
    assert gate.apply_no_speech_policy(HINDI_SENTENCE, 0.0, -0.1, 8.0) == (HINDI_SENTENCE, "", "")


def test_speech_gate_needs_voice_before_trusting_text() -> None:
    assert gate.speech_gate(None, None, "anything") == ""  # no VAD figure, no gate
    assert gate.speech_gate(0.9, 90, "open chrome") == "no-speech"  # under 120 ms is never a word
    assert gate.speech_gate(0.9, 120, "open chrome") == ""
    assert gate.speech_gate(0.1, 300, "open chrome") == "no-speech"  # a sliver of a longer clip
    assert gate.speech_gate(0.3, 300, "open chrome") == ""
    assert gate.speech_gate(0.05, 900, "open chrome") == ""  # 600 ms voiced is speech whatever the share
    assert gate.speech_gate(0.1, 300, "haan") == ""  # a command word needs no share
    assert gate.speech_gate(float("nan"), float("nan"), "x") == ""


def test_policy_uses_the_speech_gate_only_when_it_is_given_numbers() -> None:
    assert gate.apply_no_speech_policy("open chrome", 0.0, -0.2, 6.0) == ("open chrome", "", "")
    text, note, code = gate.apply_no_speech_policy("open chrome", 0.0, -0.2, 6.0, speech_fraction=0.1, voiced_ms=200)
    assert (text, code) == ("", "no-speech") and "too little voice" in note


def test_phrase_table_is_per_language_and_whole_text_only() -> None:
    assert gate.is_noise_hallucination("सब्सक्राइब", 0.3, -0.9, 1.0)
    assert gate.is_noise_hallucination("Thanks for watching!", 0.05, -0.2, 1.4)
    assert gate.is_noise_hallucination("Dhanyavad", 0.3, None, None)
    assert gate.is_noise_hallucination("Don't forget to subscribe", 0.3, None, None)
    assert not gate.is_noise_hallucination("thank you for opening the report", 0.4, -0.8, 1.0)
    assert not gate.is_noise_hallucination("धन्यवाद", 0.05, -0.2, 6.0)  # clear and long: the owner may mean it
    assert {"en", "hi", "xx"} <= set(gate.NOISE_PHRASES_BY_LANGUAGE)


def test_a_known_language_uses_its_phrases_plus_english() -> None:
    assert gate.is_blacklisted_phrase("शुक्रिया", "hi")
    assert gate.is_blacklisted_phrase("thank you", "hi")
    assert not gate.is_blacklisted_phrase("dhanyavad", "en")
    assert gate.is_blacklisted_phrase("dhanyavad", "")  # language unknown: every row


def test_token_confidence_helpers() -> None:
    assert gate.mean_token_confidence([0.9, 0.5, "x", None, float("nan")]) == pytest.approx(0.7)
    assert gate.mean_token_confidence([]) is None
    assert gate.logprob_to_confidence(0.0) == pytest.approx(1.0)
    assert gate.logprob_to_confidence(None) is None
    assert gate.confidence_trusted(None)  # no score: today's behaviour
    assert gate.confidence_trusted(0.35) and not gate.confidence_trusted(0.2)


def test_stream_text_is_dropped_on_low_token_confidence() -> None:
    assert gate.stream_text_dropped(HINDI_SENTENCE, confidence=-0.2, language="hi") == ""
    assert gate.stream_text_dropped(HINDI_SENTENCE, confidence=-1.8, language="hi") == "low-confidence"
    assert gate.stream_text_dropped(HINDI_SENTENCE, confidence=None) == ""
    assert gate.stream_text_dropped("", confidence=-9.0) == ""
    assert gate.stream_text_dropped(LOOP, confidence=-0.1) == "no-speech"
    assert gate.stream_text_dropped("open chrome", confidence=-0.1, speech_fraction=0.05, voiced_ms=100) == "no-speech"


def test_vad_evidence_turns_two_durations_into_the_gate_inputs() -> None:
    assert gate.vad_evidence(1.5, 6.0) == (0.25, 1500.0)
    assert gate.vad_evidence(None, 6.0) == (None, None)
    assert gate.vad_evidence(1.0, 0) == (None, None)
    assert gate.vad_evidence(9.0, 6.0)[0] == 1.0


def test_command_words_are_found_and_snapped() -> None:
    assert gate.lexicon_match("Haan.") == "haan"
    assert gate.lexicon_match("Theek hai!") == "theek hai"
    assert gate.lexicon_match("नहीं") == "नहीं"
    assert gate.lexicon_match("open") == ""
    assert gate.snap_to_lexicon("han") == "haan"
    assert gate.snap_to_lexicon("rukko") == "ruko"
    assert gate.snap_to_lexicon("banana") == ""


def test_short_clip_decode_drops_the_prompt_and_keeps_the_language() -> None:
    assert gate.short_clip_decode(0.4, "hi", "Hinglish prompt") == ("hi", "")
    assert gate.short_clip_decode(0.4, None, "Hinglish prompt") == (None, "")
    assert gate.short_clip_decode(0.6, "hi", "p") == ("hi", "p")  # 600 ms is not short
    assert gate.short_clip_decode(None, "hi", "p") == ("hi", "p")
    assert gate.is_short_clip(0.59) and not gate.is_short_clip(0.0) and not gate.is_short_clip(1.0)


def test_short_clip_keeps_a_command_word_and_drops_a_doubtful_reading() -> None:
    assert gate.short_clip_verdict("Yes.", -2.5) == ("Yes.", "")  # a lexicon hit needs no confidence
    assert gate.short_clip_verdict("han", None) == ("haan", "")  # a near miss snaps
    assert gate.short_clip_verdict("hello", -0.3) == ("hello", "")  # confident enough
    assert gate.short_clip_verdict("hello", -1.5) == ("", "no-speech")
    assert gate.short_clip_verdict("hello", None) == ("", "no-speech")  # unknown confidence is not accepted


def test_policy_applies_the_short_clip_rule_only_under_600_ms() -> None:
    assert gate.apply_no_speech_policy("Haan", 0.0, -2.0, 0.4)[0] == "Haan"
    assert gate.apply_no_speech_policy("kya", 0.0, -2.0, 0.4)[2] == "no-speech"
    assert gate.apply_no_speech_policy("kya", 0.0, -2.0, 1.4)[0] == "kya"


def test_live_segment_gate_now_also_catches_a_compression_loop() -> None:
    assert gate.live_segment_is_noise(LOOP, 0.0, -0.1)
    assert not gate.live_segment_is_noise(HINDI_SENTENCE, 0.0, -0.1)
    assert gate.live_segment_is_noise("Thank you.", 0.3, -0.2)


def _segments(rows):
    return iter([SimpleNamespace(**r) for r in rows])


class _Model:
    def __init__(self, text: str, duration: float, after_vad: float | None) -> None:
        self.row = {"text": text, "no_speech_prob": 0.0, "avg_logprob": -0.2, "start": 0.0, "end": duration}
        self.info = SimpleNamespace(
            duration=duration, duration_after_vad=after_vad, language="en", language_probability=0.9
        )

    def transcribe(self, _payload, **_kwargs):
        return _segments([self.row]), self.info


def test_whisper_pass_drops_text_when_the_vad_kept_too_little_voice() -> None:
    quiet = stt._consume_whisper(_Model("open chrome", 6.0, 0.06), "x", {}, None)
    assert quiet["text"] == "" and quiet["policyCode"] == "no-speech"
    clear = stt._consume_whisper(_Model("open chrome", 6.0, 3.0), "x", {}, None)
    assert clear["text"] == "open chrome" and clear["policyCode"] == ""


def test_whisper_pass_without_a_vad_figure_is_not_gated() -> None:
    result = stt._consume_whisper(_Model("open chrome", 6.0, None), "x", {}, None)
    assert result["text"] == "open chrome"


def test_hindi_stream_reader_drops_a_reading_it_does_not_trust(monkeypatch: pytest.MonkeyPatch) -> None:
    heard = {"text": HINDI_SENTENCE, "words": [{"text": "क्रोम", "start": 0.0, "end": 0.4}], "confidence": -0.2}
    monkeypatch.setattr(stt.hindi_ear, "transcribe_words", lambda _w: dict(heard))
    monkeypatch.setattr(stt, "touch", lambda: None)
    read = stt._hindi_stream_reader(Path("."), stt.TurnLanguage(""), [])
    assert [w.text for w in read([0.0] * 16000, "")] == ["क्रोम"]
    heard["text"] = LOOP
    assert read([0.0] * 16000, "") == []
