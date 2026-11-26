"""One route per final reading: the turn's language skips whisper's language guess, the Hindi ear and faster-whisper do
not both decode one turn, the owner's words reach `hotwords`, and a short English final tries the base model first.

Measured on the 4-core Linux box (worker `transcribe_file`, FRIDAY_STT_THREADS unset, 8 short English and 8 short Hindi
clips of 2.3 to 3.2 s made with Supertonic, the box shared with other jobs; the owner's PC is unverified). Before is
the route of before this change (`route_open`), after is the route of this change, run clip by clip on the same worker:

* English chosen, an English turn before it: median final 2201 ms (whisper small, language guess on) -> 622 ms (base
  model, language known; 7 of 8 clips read by it, one fell back to whisper small), word error rate 0.042 -> 0.042.
* No language chosen, English turns in a row: median 1383 -> 623 ms. Half of these clips are kept by the Hindi ear as
  Devanagari spellings of English words (word error rate 0.56 before and after: the ear's gate is unchanged here).
* Hindi clips, Hindi chosen, none chosen, or none chosen after an English turn: 327 -> 331, 309 -> 303, 309 -> 304 ms,
  word error rate 0.062 unchanged (the ear keeps them; whisper never runs).
* Token scores (mean log-probability): the base model on English clips locked to en -0.13 to -0.96, so
  ``SHORT_FINAL_POLICY`` min_logprob -0.70 sends one clip of eight ("Call mom", -0.96) to the owner's model; whisper
  small locked to en on English -0.13 to -0.57, on Hindi clips forced to en -0.53 to -1.03, which is what
  ``LOCK_MIN_LOGPROB`` -0.60 is cut from.
* Tempo, same box earlier: whisper small final 2097 ms with the language guess about 1 s of it; the Hindi ear reads a
  1.7 s clip in 194 ms and a 6.6 s clip in 441 ms.
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "kernel"))

import stt  # noqa: E402


def _seg(text, ns=0.02, lp=-0.2):
    return SimpleNamespace(text=text, no_speech_prob=ns, avg_logprob=lp)


@pytest.fixture(autouse=True)
def _fresh(monkeypatch, tmp_path):
    monkeypatch.setenv("FRIDAY_ROOT", str(tmp_path))
    monkeypatch.setattr(stt, "_now", lambda: 1000.0)
    stt.reset_turn_prior()
    for key, value in (("model", None), ("name", ""), ("failed", False)):
        monkeypatch.setitem(stt._fast, key, value)
    monkeypatch.setattr(stt.voice_runtime, "score_turn", lambda *a, **k: {})
    yield
    stt.reset_turn_prior()


# ---- the route table ---------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("language", "pref", "prior", "ear", "lock", "why"),
    [
        ("", "en-US", "", False, None, "declared"),  # Indian English and Hinglish share a chosen language: listen first
        ("en", "en", "hi", False, None, "declared"),
        ("", "en-US", "en", False, "en", "prior-en"),
        ("", "en-IN", "hi", False, None, "declared"),
        ("", "hi-IN", "", True, None, "ear-first"),
        ("", "hi-IN", "en", True, None, "ear-first"),  # a declared Hindi turn is never moved by a prior
        ("", "auto", "", True, None, "ear-first"),
        ("", "auto", "hi", True, None, "ear-first"),
        ("", "auto", "en", True, None, "ear-first"),  # the ear still listens first and keeps Hindi from the lock
        ("", "", "en", True, None, "ear-first"),
        ("fr", "fr-FR", "", False, "fr", "declared"),
        ("hinglish", "hinglish", "en", False, None, "declared"),  # mixed speech is never forced into one language
        ("", "hi-Latn", "en", False, None, "roman"),  # the Roman Hinglish ear decides its own language
    ],
)
def test_the_route_of_one_turn(language, pref, prior, ear, lock, why):
    route = stt.route_turn(language, pref, prior)
    assert (route.ear, route.lock, route.why) == (ear, lock, why)
    assert (route.min_logprob is not None) == (lock is not None and why == "prior-en")
    assert route.lane == ("en" if pref.startswith("en") else "")


def test_an_open_turn_is_locked_to_english_only_after_the_ear_kept_nothing_and_only_with_the_ear_installed(monkeypatch):
    route = stt.route_turn("", "auto", "en")
    monkeypatch.setattr(stt.hindi_ear, "ready", lambda: True)
    locked = stt.lock_after_ear(route, "en", "auto")
    assert (locked.ear, locked.lock, locked.why, locked.lane) == (False, "en", "prior-en", "en")
    assert locked.min_logprob == stt.LOCK_MIN_LOGPROB
    assert stt.lock_after_ear(route, "", "auto") is route  # no English before it
    assert stt.lock_after_ear(route, "hi", "auto") is route
    declared_hindi = stt.route_turn("", "hi-IN", "en")
    assert stt.lock_after_ear(declared_hindi, "en", "hi") is declared_hindi  # a declared Hindi turn is never locked
    monkeypatch.setattr(stt.hindi_ear, "ready", lambda: False)
    assert stt.lock_after_ear(route, "en", "auto") is route  # nothing would stand between a Hindi turn and the lock


def test_an_open_route_is_the_behaviour_of_before_this_change():
    for pref in ("en-US", "auto"):
        route = stt.route_turn("", pref, "en", open_route=True)
        assert route.lock is None and route.min_logprob is None and route.why == "open" and route.lane == ""
    assert stt.route_turn("", "auto", "en", open_route=True).ear is True
    assert stt.route_turn("", "en-US", "", open_route=True).ear is False


def test_resolve_language_still_leaves_hindi_and_english_to_detect():
    assert stt.resolve_language("en-US") is None and stt.resolve_language("hi-IN") is None
    assert stt.resolve_language("fr") == "fr"


def test_the_prior_is_the_last_strong_script_agreeing_reading_and_it_expires(monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(stt, "_now", lambda: clock[0])
    assert stt.turn_prior() == ""
    stt.note_turn_language("open the calendar", "en", 0.95)
    assert stt.turn_prior() == "en"
    clock[0] += stt.PRIOR_TTL_S - 1
    assert stt.turn_prior() == "en"
    clock[0] += 2
    assert stt.turn_prior() == ""  # a stale turn says nothing about this one
    stt.note_turn_language("मौसम कैसा है", "hi", None)
    assert stt.turn_prior() == "hi"
    stt.note_turn_language("open the calendar", "en", 0.95)
    stt.note_turn_language("calendar खोलो", "hi", 0.9)  # mixed script: no prior
    assert stt.turn_prior() == ""
    stt.note_turn_language("open the calendar", "en", 0.95)
    stt.note_turn_language("open the calendar", "en", 0.55)  # a weak guess clears it
    assert stt.turn_prior() == ""
    stt.note_turn_language("open the calendar", "en", 0.95)
    stt.note_turn_language("", "en", 0.99)  # nothing heard keeps nothing
    assert stt.turn_prior() == ""


# ---- the whisper call: language, hotwords --------------------------------------------------------------------------


class _Whisper:
    """A resident model that answers by the language it is given, so a lock can be seen to help or hurt."""

    def __init__(self, by_language=None, default=None):
        self.calls: list[dict] = []
        self.by_language = by_language or {}
        self.default = default if default is not None else [_seg("open the calendar")]

    def transcribe(self, payload, **kwargs):
        self.calls.append(kwargs)
        info = SimpleNamespace(
            duration=2.0,
            language=kwargs.get("language") or "en",
            language_probability=0.97,
            duration_after_vad=2.0,
        )
        return iter(self.by_language.get(kwargs.get("language"), self.default)), info


def _wire(monkeypatch, model, fast=None):
    monkeypatch.setattr(stt, "get_model", lambda *a, **k: model)
    monkeypatch.setattr(stt, "fast_english_model", lambda: fast)
    monkeypatch.setitem(stt._fast, "name", "base" if fast is not None else "")
    monkeypatch.setattr(stt, "_record_hearing", lambda *a, **k: None)
    monkeypatch.setattr(stt, "_counters", {"heard": 0, "dropped": {}})


def _final(language="", pref="auto", size="", extras=None, seconds=2.0, model="small"):
    samples = [0.01] * int(16000 * seconds)
    return stt._transcribe_prepared(
        "x.wav",
        samples,
        model,
        language,
        "",
        None,
        pref,
        size,
        "",
        {"durationMs": int(seconds * 1000)},
        None,
        {**(extras or {}), "turn_prior": stt.turn_prior()},  # what `_transcribe_file` hands down
    )


def _no_ear(monkeypatch):
    monkeypatch.setattr(stt.hindi_ear, "transcribe", lambda samples: pytest.fail("the Hindi ear must not listen"))


def test_a_declared_english_turn_with_no_english_before_it_still_guesses(monkeypatch):
    model = _Whisper()
    _wire(monkeypatch, model)
    _no_ear(monkeypatch)
    result = _final(pref="en-US")
    assert result["text"] == "open the calendar"
    assert [call["language"] for call in model.calls] == [None]


def test_a_declared_english_turn_after_an_english_turn_skips_the_language_guess(monkeypatch):
    model = _Whisper()
    _wire(monkeypatch, model)
    _no_ear(monkeypatch)
    stt.note_turn_language("what time is it", "en", 0.97)
    _final(pref="en-US")
    assert [call["language"] for call in model.calls] == ["en"]


def test_a_declared_hindi_turn_keeps_the_guess_when_the_ear_is_absent(monkeypatch):
    model = _Whisper()
    _wire(monkeypatch, model)
    _final(pref="hi-IN")
    assert [call["language"] for call in model.calls] == [None]  # Hinglish stays one open reading


def _ear(monkeypatch, text, confidence):
    heard: list[str] = []

    def listen(samples):
        heard.append("ear")
        return text

    monkeypatch.setattr(stt.hindi_ear, "transcribe", listen)
    monkeypatch.setattr(stt.hindi_ear, "last_confidence", lambda: confidence)
    monkeypatch.setattr(stt.hindi_ear, "ready", lambda: True)
    return heard


def test_an_english_turn_before_makes_the_next_open_turn_skip_the_language_guess(monkeypatch):
    model = _Whisper()
    _wire(monkeypatch, model)
    stt.note_turn_language("what time is it", "en", 0.97)
    heard = _ear(monkeypatch, "ओपन द कैलेंडर", -0.9)  # the ear is unsure: English
    _final(pref="auto")
    assert heard == ["ear"] and [call["language"] for call in model.calls] == ["en"]


def test_a_hindi_turn_after_an_english_one_is_read_by_the_ear_and_never_locked_to_english(monkeypatch):
    model = _Whisper()
    _wire(monkeypatch, model)
    stt.note_turn_language("what time is it", "en", 0.97)
    heard = _ear(monkeypatch, "मौसम कैसा है", -0.05)
    result = _final(pref="auto")
    assert heard == ["ear"] and model.calls == [] and result["engine"] == "hindi-ear"


def test_without_the_ear_installed_an_open_turn_after_english_still_guesses(monkeypatch):
    model = _Whisper()
    _wire(monkeypatch, model)
    stt.note_turn_language("what time is it", "en", 0.97)
    monkeypatch.setattr(stt.hindi_ear, "transcribe", lambda samples: None)
    monkeypatch.setattr(stt.hindi_ear, "ready", lambda: False)
    _final(pref="auto")
    assert [call["language"] for call in model.calls] == [None]


def test_with_no_prior_the_ear_listens_first_and_is_the_only_decode_when_it_is_sure(monkeypatch):
    model = _Whisper()
    _wire(monkeypatch, model)
    monkeypatch.setattr(stt.hindi_ear, "transcribe", lambda samples: "मौसम कैसा है")
    monkeypatch.setattr(stt.hindi_ear, "last_confidence", lambda: -0.05)
    monkeypatch.setattr(stt.hindi_ear, "tries_ear", lambda *a: True)
    result = _final(pref="auto")
    assert result["engine"] == "hindi-ear" and model.calls == []


def test_an_unsure_ear_hands_over_once_and_whisper_decodes_one_time(monkeypatch):
    model = _Whisper()
    _wire(monkeypatch, model)
    monkeypatch.setattr(stt.hindi_ear, "transcribe", lambda samples: "ओपन द कैलेंडर")
    monkeypatch.setattr(stt.hindi_ear, "last_confidence", lambda: -0.9)
    result = _final(pref="auto")
    assert result["engine"] == "faster-whisper" and result["text"] == "open the calendar"
    assert len(model.calls) == 1  # one decode: no second look at a turn the ear already judged


def test_a_poor_locked_read_is_heard_again_open_so_a_misjudged_turn_is_not_lost(monkeypatch):
    # The ear was unsure and the prior locked English, but the locked read scores badly: the turn is read again open.
    garbled = [_seg("a day ago", lp=-1.1)]
    model = _Whisper(by_language={"en": garbled}, default=[_seg("kal ka mausam", lp=-0.3)])
    _wire(monkeypatch, model)
    stt.note_turn_language("what time is it", "en", 0.97)
    heard = _ear(monkeypatch, "कल का मौसम", -0.9)
    result = _final(pref="auto")
    assert [call["language"] for call in model.calls] == ["en", None]
    assert heard == ["ear", "ear"]  # the open route listens with the ear again, then guesses
    assert result["text"] == "kal ka mausam"
    assert stt.turn_prior() == ""  # the prior that misled is gone


def test_a_poor_locked_english_read_is_heard_again_without_the_lock(monkeypatch):
    model = _Whisper(by_language={"en": [_seg("a day ago", lp=-1.3)]}, default=[_seg("kal mausam", lp=-0.4)])
    _wire(monkeypatch, model)
    _no_ear(monkeypatch)
    stt.note_turn_language("what time is it", "en", 0.97)
    result = _final(pref="en-US")
    assert [call["language"] for call in model.calls] == ["en", None]
    assert result["text"] == "kal mausam"


def test_an_empty_locked_read_is_silence_not_a_reason_to_decode_again(monkeypatch):
    model = _Whisper(default=[])
    _wire(monkeypatch, model)
    _no_ear(monkeypatch)
    stt.note_turn_language("what time is it", "en", 0.97)
    _final(pref="en-US")
    assert len(model.calls) == 1 and model.calls[0]["language"] == "en"


def _file_turn(monkeypatch, model, provisional=False, pref="en-US"):
    monkeypatch.setattr(stt, "prepare_audio", lambda path: (path, [0.01] * 32000, None, {"durationMs": 2000}))
    monkeypatch.setattr(stt, "load_audio_array", lambda path: [0.01] * 32000)
    return stt._transcribe_file("x.wav", "small", "", "", None, pref, "", "", False, None, provisional)


def test_a_finished_turn_sets_the_prior_and_the_next_turn_uses_it(monkeypatch):
    model = _Whisper()
    _wire(monkeypatch, model)
    _no_ear(monkeypatch)
    _file_turn(monkeypatch, model)
    assert stt.turn_prior() == "en"
    _file_turn(monkeypatch, model)
    assert [call["language"] for call in model.calls] == [None, "en"]  # the first guessed, the second knew


def test_a_preview_neither_sets_nor_uses_the_prior(monkeypatch):
    model = _Whisper()
    _wire(monkeypatch, model)
    _no_ear(monkeypatch)
    _file_turn(monkeypatch, model, provisional=True)
    assert stt.turn_prior() == ""
    stt.note_turn_language("what time is it", "en", 0.97)
    _file_turn(monkeypatch, model, provisional=True)
    assert model.calls[-1]["language"] is None  # a partial reading stays open


def test_a_direct_decode_never_reads_the_workers_prior(monkeypatch):
    model = _Whisper()
    _wire(monkeypatch, model)
    _no_ear(monkeypatch)
    stt.note_turn_language("what time is it", "en", 0.97)
    stt._transcribe_prepared("x.wav", [0.01] * 32000, "small", "", "", None, "en-US", "", "", {}, None, None)
    assert model.calls[0]["language"] is None


# ---- the owner's words ---------------------------------------------------------------------------------------------


def test_the_owners_words_reach_whisper_next_to_the_prompt(monkeypatch):
    model = _Whisper()
    _wire(monkeypatch, model)
    _final(pref="auto", extras={"hotwords": "Devendra, FRIDAY"})
    call = model.calls[0]
    assert call["hotwords"] == "Devendra, FRIDAY"
    assert call["initial_prompt"]  # the prompt stays: faster-whisper puts both in the decoder context


def test_hotwords_are_dropped_when_a_prefix_is_set_because_the_library_ignores_them():
    kwargs = {"hotwords": "Devendra", "prefix": "Open", "language": "en"}
    assert "hotwords" not in stt.guard_hotwords(kwargs)
    keep = {"hotwords": "Devendra", "language": "en"}
    assert stt.guard_hotwords(keep)["hotwords"] == "Devendra"
    assert stt.guard_hotwords({"prefix": "Open"}) == {"prefix": "Open"}


# ---- the short English final: the base model first ---------------------------------------------------------------


def test_the_short_final_policy_is_one_named_table():
    row = stt.SHORT_FINAL_POLICY["en"]
    assert row["size"] == "base" and 0 < row["max_clip_s"] <= 6 and -1.0 < row["min_logprob"] < 0
    assert 0 < row["max_no_speech"] <= 1


def test_a_short_english_final_after_english_uses_the_base_model_when_it_is_sure(monkeypatch):
    main, fast = _Whisper(), _Whisper(default=[_seg("open the calendar", lp=-0.15)])
    _wire(monkeypatch, main, fast=fast)
    stt.note_turn_language("what time is it", "en", 0.97)
    _ear(monkeypatch, None, None)
    result = _final(pref="auto")
    assert main.calls == [] and [c["language"] for c in fast.calls] == ["en"]
    assert result["text"] == "open the calendar" and result["model"] == "base"


def test_a_declared_english_final_with_no_lock_needs_a_confident_english_guess_from_the_base_model(monkeypatch):
    main, fast = _Whisper(), _Whisper(default=[_seg("open the calendar", lp=-0.15)])
    _wire(monkeypatch, main, fast=fast)
    _no_ear(monkeypatch)
    result = _final(pref="en-US")
    assert main.calls == [] and [c["language"] for c in fast.calls] == [None]  # (the fake guesses en at 0.97)
    assert result["model"] == "base"


@pytest.mark.parametrize(
    ("language", "probability", "locked", "sure"),
    [("hi", 0.97, False, False), ("en", 0.6, False, False), ("en", 0.97, False, True), ("hi", 0.6, True, True)],
)
def test_an_open_fast_read_stands_only_as_confident_english(language, probability, locked, sure):
    read = {"text": "x", "avgLogprob": -0.1, "language": language, "languageProbability": probability}
    assert stt.fast_read_sure(read, locked) is sure


def test_an_unsure_fast_read_is_decoded_again_by_the_owners_model(monkeypatch):
    main = _Whisper(default=[_seg("open the calendar", lp=-0.2)])
    fast = _Whisper(default=[_seg("open the colander", lp=-0.9)])
    _wire(monkeypatch, main, fast=fast)
    stt.note_turn_language("what time is it", "en", 0.97)
    _ear(monkeypatch, None, None)
    result = _final(pref="auto")
    assert len(fast.calls) == 1 and len(main.calls) == 1
    assert result["text"] == "open the calendar" and result["model"] != "base"


def test_a_fast_read_with_no_text_goes_to_the_owners_model(monkeypatch):
    main, fast = _Whisper(), _Whisper(default=[])
    _wire(monkeypatch, main, fast=fast)
    stt.note_turn_language("what time is it", "en", 0.97)
    _ear(monkeypatch, None, None)
    result = _final(pref="auto")
    assert len(main.calls) == 1 and result["text"] == "open the calendar"


def test_a_fast_model_that_fails_to_decode_rests_and_the_owners_model_answers(monkeypatch):
    class Broken:
        def transcribe(self, payload, **kwargs):
            raise RuntimeError("broken weights")

    main = _Whisper()
    _wire(monkeypatch, main, fast=Broken())
    stt.note_turn_language("what time is it", "en", 0.97)
    _ear(monkeypatch, None, None)
    result = _final(pref="auto")
    assert result["text"] == "open the calendar" and len(main.calls) == 1
    assert stt._fast["failed"] is True


@pytest.mark.parametrize(
    ("kind", "kwargs", "prior"),
    [
        ("an owner who chose a size", {"pref": "auto", "size": "small"}, "en"),
        ("a long clip", {"pref": "auto", "seconds": 9.0}, "en"),
        ("a Hindi turn", {"pref": "hi-IN"}, "en"),
        ("an open turn with no prior", {"pref": "auto"}, ""),
        ("an owner model as small as the fast one", {"pref": "auto", "model": "base"}, "en"),
    ],
)
def test_the_fast_model_is_never_asked_outside_its_lane(monkeypatch, kind, kwargs, prior):
    main = _Whisper()
    _wire(monkeypatch, main, fast=_Whisper())
    monkeypatch.setattr(stt, "fast_english_model", lambda: pytest.fail(f"asked for {kind}"))
    _ear(monkeypatch, None, None)
    if prior:
        stt.note_turn_language("what time is it", "en", 0.97)
    _final(**kwargs)
    assert len(main.calls) >= 1


def test_the_fast_model_is_only_the_installed_one_and_never_loads_under_memory_pressure(monkeypatch, tmp_path):
    assert stt.fast_size_dir("base") is None  # nothing on disk
    folder = tmp_path / "cache" / "stt" / "base"
    folder.mkdir(parents=True)
    (folder / "config.json").write_text("{}", encoding="utf-8")
    assert stt.fast_size_dir("base") is None  # the weights are missing
    (folder / "model.bin").write_bytes(b"x")
    assert stt.fast_size_dir("base") == folder
    loads: list[str] = []
    monkeypatch.setattr(stt, "_import_whisper", lambda: lambda target, **k: loads.append(target) or object())
    monkeypatch.setattr(stt, "memory_pressure", lambda: {"level": "high", "totalMb": 8000})
    assert stt.fast_english_model() is None and loads == []
    monkeypatch.setattr(stt, "memory_pressure", lambda: {"level": "ok", "totalMb": 16000})
    first = stt.fast_english_model()
    assert first is not None and stt.fast_english_model() is first and len(loads) == 1  # opened once
    assert "base" in stt.loaded_names()
    stt.unload_models()
    assert "base" not in stt.loaded_names()


def test_a_fast_model_that_will_not_open_is_never_tried_again_in_this_worker(monkeypatch, tmp_path):
    folder = tmp_path / "cache" / "stt" / "base"
    folder.mkdir(parents=True)
    for name in ("config.json", "model.bin"):
        (folder / name).write_bytes(b"x")
    tries: list[int] = []

    def boom(*a, **k):
        tries.append(1)
        raise RuntimeError("broken weights")

    monkeypatch.setattr(stt, "_import_whisper", lambda: boom)
    monkeypatch.setattr(stt, "memory_pressure", lambda: {"level": "ok", "totalMb": 16000})
    assert stt.fast_english_model() is None and stt.fast_english_model() is None
    assert len(tries) == 1
