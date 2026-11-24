"""The live-words pass: timed words from the audio so far, by the fastest suitable engine, never counted or recorded."""

from __future__ import annotations

import sys
import types
import wave
from pathlib import Path
from types import SimpleNamespace

import pytest

KERNEL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(KERNEL))

import hindi_ear  # noqa: E402
import stt  # noqa: E402
import whisper_ears  # noqa: E402

RATE = 16000


def _wav(path: Path, seconds: float = 3.0) -> str:
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(RATE)
        out.writeframes(b"\x10\x00" * int(RATE * seconds))
    return str(path)


def _word(text: str, start: float, end: float):
    return SimpleNamespace(word=f" {text}", start=start, end=end, probability=0.9)


def _seg(text: str, start: float, end: float, words=None, nsp=0.01, lp=-0.2):
    if words is None:
        step = (end - start) / max(1, len(text.split()))
        words = [_word(w, start + i * step, start + (i + 1) * step) for i, w in enumerate(text.split())]
    return SimpleNamespace(text=f" {text}", start=start, end=end, words=words, no_speech_prob=nsp, avg_logprob=lp)


class FakeModel:
    def __init__(self, segments, language="en", probability=0.97, on_segment=None):
        self.segments = segments
        self.language = language
        self.probability = probability
        self.on_segment = on_segment
        self.calls: list[dict] = []
        self.heard_seconds: list[float] = []

    def transcribe(self, payload, **kwargs):
        self.calls.append(kwargs)
        self.heard_seconds.append(len(payload) / RATE)

        def gen():
            for index, segment in enumerate(self.segments):
                if self.on_segment:
                    self.on_segment(index)
                yield segment

        info = SimpleNamespace(
            language=self.language, language_probability=self.probability, duration=3.0, duration_after_vad=2.5
        )
        return gen(), info


@pytest.fixture(autouse=True)
def _clean(monkeypatch, tmp_path):
    monkeypatch.setenv("FRIDAY_ROOT", str(tmp_path))
    monkeypatch.delenv("FRIDAY_STT_WORD_TIMESTAMPS", raising=False)
    monkeypatch.setattr(stt, "_cancelled_keys", type(stt._cancelled_keys)(maxlen=32), raising=False)
    monkeypatch.setattr(stt, "_model_name", "small")
    monkeypatch.setattr(stt, "_device_name", "cpu")
    monkeypatch.setattr(stt, "get_model", lambda *a, **k: pytest.fail("a live pass never loads a model"))
    monkeypatch.setattr(stt, "_record_hearing", lambda *a, **k: pytest.fail("a live pass is never recorded"))
    monkeypatch.setattr(stt.voice_runtime, "score_turn", lambda *a, **k: {})
    whisper_ears.reset_failures()
    before = dict(stt._counters["dropped"]), stt._counters["heard"]
    yield
    assert (dict(stt._counters["dropped"]), stt._counters["heard"]) == before, "a live pass is never counted"
    whisper_ears.reset_failures()


def _resident(monkeypatch, model: FakeModel, name: str = "small") -> FakeModel:
    monkeypatch.setattr(stt, "_model", model)
    monkeypatch.setattr(stt, "_model_name", name)
    return model


def _ask(tmp_path: Path, seconds: float = 3.0, **extra) -> dict:
    request = {
        "op": "transcribe",
        "audio": _wav(tmp_path / "live.wav", seconds),
        "provisional": True,
        "live": True,
        "utteranceId": "live-1",
        **extra,
    }
    return stt.handle_request(request)


def _ear(monkeypatch, words, confidence=-0.1, ready=True):
    """A Hindi ear that answers (words, confidence) for any audio, and records how long the audio was."""
    heard: list[float] = []

    def transcribe_words(samples):
        heard.append(len(samples) / RATE)
        if words is None:
            return None
        return {"text": " ".join(w["text"] for w in words), "words": words, "confidence": confidence}

    monkeypatch.setattr(hindi_ear, "ready", lambda: ready)
    monkeypatch.setattr(hindi_ear, "transcribe_words", transcribe_words)
    return heard


# ---- the Hindi ear's timed words ------------------------------------------------------------------------------


def test_the_ear_groups_tokens_into_words_with_times():
    words = hindi_ear.group_words([" आज", " मौ", "सम", " अच्छा", " है"], [0.1, 0.4, 0.5, 0.9, 1.3], 1.6)
    assert [w["text"] for w in words] == ["आज", "मौसम", "अच्छा", "है"]
    assert [w["start"] for w in words] == [0.1, 0.4, 0.9, 1.3]
    assert all(w["end"] > w["start"] for w in words)
    assert all(a["end"] <= b["start"] + 1e-9 for a, b in zip(words, words[1:], strict=False))
    assert words[-1]["end"] <= 1.6


def test_the_ear_reads_a_sentencepiece_word_mark_and_never_joins_across_words():
    words = hindi_ear.group_words(["▁कल", "▁सुबह"], [0.2, 0.7], 1.0)
    assert [w["text"] for w in words] == ["कल", "सुबह"]


def test_the_ear_spreads_words_by_length_when_the_runtime_gives_no_token_times():
    words = hindi_ear.group_words(None, None, 2.0, text="नमस्ते दुनिया")
    assert [w["text"] for w in words] == ["नमस्ते", "दुनिया"]
    assert words[0]["start"] == 0.0 and words[-1]["end"] == pytest.approx(2.0)
    assert words[0]["end"] <= words[1]["start"] + 1e-9
    assert hindi_ear.group_words(["a"], [0.1, 0.2], 1.0, text="") == []  # mismatched lengths and no text


def _stage(tmp_path: Path) -> None:
    folder = tmp_path / "models" / hindi_ear.MODEL_DIR
    folder.mkdir(parents=True)
    for name in ("vocab.txt", "config.json"):
        (folder / name).write_text("x", encoding="utf-8")
    with (folder / hindi_ear.MODEL_FILE).open("wb") as handle:
        handle.truncate(hindi_ear.MIN_MODEL_BYTES + 1)


def _onnx(monkeypatch, text, tokens, stamps, logprobs):
    heard = SimpleNamespace(text=text, tokens=tokens, timestamps=stamps, logprobs=logprobs)

    class Timed:
        def recognize(self, audio, sample_rate=16000):
            return heard

    class Model:
        def with_timestamps(self):
            return Timed()

    monkeypatch.setattr(hindi_ear, "_model", None)
    monkeypatch.setattr(hindi_ear, "_timed", None)
    monkeypatch.setitem(sys.modules, "onnx_asr", types.SimpleNamespace(load_model=lambda *a, **k: Model()))


def test_transcribe_words_gives_text_words_and_the_mean_score(monkeypatch, tmp_path):
    _stage(tmp_path)
    _onnx(monkeypatch, "आज मौसम", [" आज", " मौ", "सम"], [0.1, 0.5, 0.6], [-0.1, -0.3, -0.2])
    out = hindi_ear.transcribe_words([0.01] * RATE)
    assert out is not None
    assert out["text"] == "आज मौसम"
    assert [w["text"] for w in out["words"]] == ["आज", "मौसम"]
    assert out["confidence"] == pytest.approx(-0.2)
    assert hindi_ear.last_confidence() == pytest.approx(-0.2)


def test_transcribe_words_gives_way_when_there_is_no_hindi_or_no_ear(monkeypatch, tmp_path):
    assert hindi_ear.transcribe_words([0.01] * RATE) is None  # nothing on disk
    _stage(tmp_path)
    _onnx(monkeypatch, "hello there", [" hello", " there"], [0.1, 0.5], [-0.1, -0.1])
    assert hindi_ear.transcribe_words([0.01] * RATE) is None  # no Devanagari: not Hindi
    _onnx(monkeypatch, "आज", [" आज"], [0.1], [-0.1])
    assert hindi_ear.transcribe_words([0.01] * 100) is None  # under 0.2 s


# ---- one live pass --------------------------------------------------------------------------------------------


def test_english_is_read_by_the_resident_model_locked_to_english_with_word_times(monkeypatch, tmp_path):
    model = _resident(monkeypatch, FakeModel([_seg("open the mail", 0.2, 1.4)]))
    ear = _ear(monkeypatch, [{"text": "x", "start": 0, "end": 1}])
    out = stt.handle_request({"op": "transcribe", "audio": _wav(tmp_path / "a.wav"), "provisional": True, "live": True,
                              "language": "en", "utteranceId": "live-1", "id": 4})  # fmt: skip
    assert out["ok"] is True and out["final"] is False and out["utteranceId"] == "live-1"
    assert out["text"] == "open the mail"
    assert [w["text"] for w in out["words"]] == ["open", "the", "mail"]
    assert out["words"][0]["start"] == pytest.approx(0.2) and out["words"][-1]["end"] == pytest.approx(1.4)
    assert out["segments"] == [{"start": pytest.approx(0.2), "end": pytest.approx(1.4)}]
    assert out["language"] == "en" and out["languageProbability"] == pytest.approx(0.97)
    assert out["engine"] == "faster-whisper"
    kwargs = model.calls[0]
    assert kwargs["language"] == "en" and kwargs["word_timestamps"] is True and kwargs["beam_size"] == 1
    assert kwargs["condition_on_previous_text"] is False and kwargs["vad_filter"] is True
    assert kwargs["temperature"] == 0.0
    assert ear == [], "English never reaches the Hindi ear"


def test_a_live_pass_needs_a_model_that_is_already_loaded(monkeypatch, tmp_path):
    monkeypatch.setattr(stt, "_model", None)
    out = _ask(tmp_path, language="en")
    assert out["ok"] is False and out["reason"] == "not-ready"


def test_a_heavy_model_on_the_processor_is_too_slow_for_live_words_but_not_on_a_gpu(monkeypatch, tmp_path):
    model = _resident(monkeypatch, FakeModel([_seg("hello there friend", 0.1, 1.0)]), "medium")
    out = _ask(tmp_path, language="en")
    assert out["ok"] is False and out["reason"] == "live-too-heavy"
    assert model.calls == []
    monkeypatch.setattr(stt, "_device_name", "cuda")
    assert _ask(tmp_path, language="en")["ok"] is True


def test_hindi_is_read_by_the_ear_when_it_is_sure_and_never_by_whisper(monkeypatch, tmp_path):
    model = _resident(monkeypatch, FakeModel([_seg("never used", 0, 1)]))
    ear_words = [{"text": "आज", "start": 0.1, "end": 0.4}, {"text": "मौसम", "start": 0.5, "end": 1.0}]
    _ear(monkeypatch, ear_words, confidence=-0.1)
    out = _ask(tmp_path, language="hi", speechPref="hi-IN")
    assert out["engine"] == "hindi-ear" and out["language"] == "hi"
    assert [w["text"] for w in out["words"]] == ["आज", "मौसम"]
    assert out["segments"] == [{"start": 0.1, "end": 1.0}]
    assert out["text"] == "आज मौसम"
    assert model.calls == []


def test_an_unsure_ear_in_auto_hands_the_pass_to_whisper_with_the_language_free(monkeypatch, tmp_path):
    model = _resident(monkeypatch, FakeModel([_seg("send the report today", 0.1, 1.5)]))
    _ear(monkeypatch, [{"text": "सेंड", "start": 0.1, "end": 0.5}], confidence=-0.9)
    out = _ask(tmp_path)  # no language chosen: auto
    assert out["engine"] == "faster-whisper" and out["text"] == "send the report today"
    assert model.calls[0]["language"] is None


def test_a_missing_ear_leaves_hindi_to_whisper_locked_to_hindi(monkeypatch, tmp_path):
    model = _resident(monkeypatch, FakeModel([_seg("आज मौसम", 0.1, 1.0)], language="hi"))
    _ear(monkeypatch, None, ready=False)
    out = _ask(tmp_path, language="hi", speechPref="hi")
    assert model.calls[0]["language"] == "hi" and out["language"] == "hi"


def test_a_locked_language_hint_from_an_earlier_pass_decides_when_nothing_was_chosen(monkeypatch, tmp_path):
    model = _resident(monkeypatch, FakeModel([_seg("open the mail", 0.1, 1.4)]))
    ear = _ear(monkeypatch, [{"text": "x", "start": 0, "end": 1}])
    _ask(tmp_path, language="en")  # the renderer sends the language the last sure pass heard
    assert model.calls[0]["language"] == "en" and ear == []


def test_mixed_speech_is_routed_per_segment_by_script_and_by_the_roman_hindi_lexicon(monkeypatch, tmp_path):
    _resident(
        monkeypatch,
        FakeModel(
            [
                _seg("send the quarterly report", 0.2, 1.8),
                _seg("mujhe meeting ka time batao", 2.0, 3.4),
                _seg("फिर मिलते हैं", 3.6, 4.6),
            ]
        ),
    )
    ear = _ear(
        monkeypatch,
        [{"text": "कल", "start": 0.1, "end": 0.5}, {"text": "सुबह", "start": 0.6, "end": 1.1}],
        confidence=-0.15,
    )
    # the whole window is mixed, so the ear is unsure of it; only the Roman Hindi segment is re-read by the ear
    seen: list[float] = []

    def transcribe_words(samples):
        seen.append(round(len(samples) / RATE, 1))
        if len(seen) == 1:
            return {"text": "x", "words": [], "confidence": -0.8}
        return {
            "text": "कल सुबह",
            "words": [{"text": "कल", "start": 0.1, "end": 0.5}, {"text": "सुबह", "start": 0.6, "end": 1.1}],
            "confidence": -0.15,
        }

    monkeypatch.setattr(hindi_ear, "transcribe_words", transcribe_words)
    del ear
    out = _ask(tmp_path, seconds=5.0)
    assert [w["text"] for w in out["words"]] == ["send", "the", "quarterly", "report", "कल", "सुबह", "फिर", "मिलते", "हैं"]
    kal = out["words"][4]
    assert kal["start"] == pytest.approx(2.0 - 0.1 + 0.1)  # the ear's 0.1 s, shifted to the segment start (less pad)
    assert out["language"] == "mixed"
    assert len(seen) == 2, "the window once, then the one Roman Hindi segment"
    # English words stay Latin, Hindi words stay Devanagari, and no word holds two scripts
    for word in out["words"]:
        latin = any("a" <= c.lower() <= "z" for c in word["text"])
        deva = any("ऀ" <= c <= "ॿ" for c in word["text"])
        assert not (latin and deva)


def test_a_roman_hindi_segment_the_ear_is_not_sure_of_stays_as_whisper_wrote_it(monkeypatch, tmp_path):
    _resident(monkeypatch, FakeModel([_seg("mujhe meeting ka time batao", 0.2, 1.8)]))
    _ear(monkeypatch, [{"text": "x", "start": 0, "end": 1}], confidence=-0.9)
    out = _ask(tmp_path)
    assert out["text"] == "mujhe meeting ka time batao"


def test_english_and_a_chosen_language_never_route_segments_to_the_ear(monkeypatch, tmp_path):
    _resident(monkeypatch, FakeModel([_seg("mujhe meeting ka time batao", 0.2, 1.8)]))
    ear = _ear(monkeypatch, [{"text": "x", "start": 0, "end": 1}])
    out = _ask(tmp_path, language="en", speechPref="en-IN")
    assert out["text"] == "mujhe meeting ka time batao" and ear == []


def test_roman_hinglish_mode_uses_the_hinglish_ear_only_when_it_is_already_resident(monkeypatch, tmp_path):
    folder = tmp_path / "models" / whisper_ears.HINGLISH_ID
    folder.mkdir(parents=True)
    for name in whisper_ears.REQUIRED:
        (folder / name).write_text("x", encoding="utf-8")
    with (folder / "model.bin").open("wb") as handle:
        handle.truncate(whisper_ears.MIN_BYTES[whisper_ears.HINGLISH_ID] + 1)
    model = _resident(monkeypatch, FakeModel([_seg("mujhe meeting ka time batao", 0.2, 1.8)]), "small")
    ear = _ear(monkeypatch, [{"text": "x", "start": 0, "end": 1}])
    out = _ask(tmp_path, language="hi-Latn", speechPref="hi-Latn")
    assert out["ok"] is False and out["reason"] == "not-ready" and model.calls == [], "no load for a guess"
    _resident(monkeypatch, model, str(folder))
    out = _ask(tmp_path, language="hi-Latn", speechPref="hi-Latn")
    assert out["ok"] is True and model.calls[0]["language"] == "en" and ear == []
    assert out["language"] == "hi" and out["engine"] == "hinglish-ear"


def test_noise_a_loop_and_an_unsure_silence_are_dropped_per_segment(monkeypatch, tmp_path):
    _resident(
        monkeypatch,
        FakeModel(
            [
                _seg("thanks for watching", 0.0, 1.0, nsp=0.9, lp=-1.5),
                _seg("go go go go go", 1.0, 2.0),
                _seg("play some music", 2.0, 3.0),
            ]
        ),
    )
    out = _ask(tmp_path, language="en")
    assert out["text"] == "play some music"


def test_a_segment_without_word_times_is_spread_across_its_own_span(monkeypatch, tmp_path):
    _resident(monkeypatch, FakeModel([_seg("set a timer", 1.0, 2.2, words=[])]))
    out = _ask(tmp_path, language="en")
    assert [w["text"] for w in out["words"]] == ["set", "a", "timer"]
    assert out["words"][0]["start"] == pytest.approx(1.0) and out["words"][-1]["end"] == pytest.approx(2.2)


def test_audio_longer_than_thirty_seconds_is_cut_at_the_front_and_the_times_follow(monkeypatch, tmp_path):
    model = _resident(monkeypatch, FakeModel([_seg("still talking", 1.0, 2.0)]))
    out = _ask(tmp_path, seconds=35.0, language="en")
    assert model.heard_seconds[0] == pytest.approx(30.0)
    assert out["words"][0]["start"] == pytest.approx(6.0)  # 5 s dropped, so 1.0 s in the cut audio is 6.0 s in the clip
    assert out["durationMs"] == pytest.approx(35_000, abs=5)


def test_silence_and_a_clip_that_is_too_short_answer_empty_without_a_decode(monkeypatch, tmp_path):
    model = _resident(monkeypatch, FakeModel([_seg("hello", 0, 1)]))
    out = _ask(tmp_path, seconds=0.1, language="en")
    assert out["ok"] is True and out["words"] == [] and out["text"] == "" and model.calls == []


def test_a_cancel_between_segments_stops_the_pass_and_it_is_never_heard(monkeypatch, tmp_path):
    model = _resident(
        monkeypatch,
        FakeModel(
            [_seg("one two", 0, 1), _seg("three four", 1, 2), _seg("five six", 2, 3)],
            on_segment=lambda index: stt.request_cancel("live-1") if index == 1 else None,
        ),
    )
    out = _ask(tmp_path, language="en")
    assert out["ok"] is False and out["reason"] == "cancelled" and out["cancelled"] is True
    assert model.calls  # it did start; the later segment was never used


def test_a_cancel_that_arrived_first_ends_the_pass_before_any_work(monkeypatch, tmp_path):
    model = _resident(monkeypatch, FakeModel([_seg("one two", 0, 1)]))
    stt.request_cancel("live-1")
    out = _ask(tmp_path, language="en")
    assert out["reason"] == "cancelled" and model.calls == []


def test_a_live_flag_without_provisional_is_an_ordinary_final_decode(monkeypatch, tmp_path):
    seen = {}

    def final(*args, **kwargs):
        seen["called"] = True
        return {"ok": True, "text": "final words"}

    monkeypatch.setattr(stt, "transcribe_file", final)
    out = stt.handle_request({"op": "transcribe", "audio": _wav(tmp_path / "f.wav"), "live": True})
    assert out["text"] == "final words" and seen["called"]
    assert "words" not in out


def test_the_mixed_segment_helper_wants_two_roman_hindi_words_that_are_half_the_latin_words():
    assert whisper_ears.roman_hindi_segment("mujhe meeting ka time batao")
    assert not whisper_ears.roman_hindi_segment("send the quarterly report")
    assert not whisper_ears.roman_hindi_segment("kal")  # one word is a hint, not a segment
    assert not whisper_ears.roman_hindi_segment("आज मौसम")  # already Devanagari
    assert not whisper_ears.roman_hindi_segment("")
    assert not whisper_ears.roman_hindi_segment("mujhe ek meeting schedule karni hai")  # under half: English-led
