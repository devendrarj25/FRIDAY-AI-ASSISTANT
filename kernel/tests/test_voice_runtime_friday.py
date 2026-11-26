"""The FRIDAY Voice speaking path of the voice worker: engine choice, persona, clauses, finishing, status.

No model file and no network: a stand-in engine hands out audio with the half second of padding the real graphs
leave, and records every call. The ``supertonic`` package path is a second stand-in.
"""

from __future__ import annotations

import base64
import importlib.util
import json
import sys
import types
from pathlib import Path

import numpy as np
import pytest

KERNEL = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(KERNEL))

import friday_voice  # noqa: E402
import tts_delivery  # noqa: E402
import voice_fx  # noqa: E402
import voice_persona  # noqa: E402
import voice_runtime  # noqa: E402

RATE = 8000
PAD = RATE // 2  # the digital silence the real graphs put around a clause
PRESETS = ("F1", "F2", "F3", "F4", "F5", "M1", "M2")


class StandInEngine:
    """Shaped like ``friday_voice.FridayVoice``: a tone whose length follows the text, padded with silence."""

    sample_rate = RATE
    _indexer = None

    def __init__(self):
        self.calls: list[dict] = []
        self.styles_asked: list[str] = []
        self.warm = 0
        self.on_synth = None
        self.fail = False

    def style(self, name):
        key = str(name).upper()
        if key not in PRESETS:
            raise KeyError(name)
        self.styles_asked.append(key)
        k = float(PRESETS.index(key) + 1)
        return friday_voice.Style(np.full((1, 2, 3), k, dtype=np.float32), np.full((1, 2, 3), 10 * k, dtype=np.float32))

    def synth(self, text, lang, style, *, steps=5, speed=1.0, seed=None):
        if self.fail:
            raise RuntimeError("graph failed")
        self.calls.append({"text": text, "lang": lang, "steps": steps, "speed": speed, "style": style})
        if self.on_synth is not None:
            self.on_synth(len(self.calls))
        count = RATE * max(1, len(text)) // 40
        body = 0.5 * np.sin(np.linspace(0, 300 * np.pi, count)).astype(np.float32)
        pad = np.zeros(PAD, dtype=np.float32)
        return np.concatenate([pad, body, pad])

    def warm_up(self):
        self.warm += 1
        return 0.0


class PipTTS:
    """Stand-in for the ``supertonic`` package, so a fallback is visible."""

    sample_rate = 22050
    seen: list[str] = []

    def __init__(self, *args, **kwargs):
        pass

    def get_voice_style(self, name):
        return name

    def synthesize(self, text, voice_style=None, total_steps=5, speed=1.0, lang="en", silence_duration=0.12):
        PipTTS.seen.append(text)
        return np.full(2205, 0.2, dtype=np.float32), 0.1


@pytest.fixture
def engine(monkeypatch, tmp_path):
    voice_runtime.reset_speech_state()
    voice_runtime.reset_cancelled()
    PipTTS.seen = []
    fake_pkg = types.ModuleType("supertonic")
    fake_pkg.TTS = PipTTS  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "supertonic", fake_pkg)
    monkeypatch.setattr(voice_runtime, "supertonic_dir", lambda: tmp_path)
    monkeypatch.setattr(voice_runtime, "_tts", None)
    monkeypatch.setattr(voice_runtime, "_tts_dir", "")
    stand_in = StandInEngine()
    opened: list[dict] = []

    def open_voice(model_dir, *, threads=None):
        opened.append({"dir": str(model_dir), "threads": threads})
        return stand_in

    monkeypatch.setattr(friday_voice, "open_voice", open_voice)
    stand_in.opened = opened  # type: ignore[attr-defined]
    yield stand_in
    voice_runtime.reset_speech_state()
    voice_runtime.reset_cancelled()


def _pcm(body: dict) -> np.ndarray:
    assert body["ok"] is True, body
    return np.frombuffer(base64.b64decode(body["pcm16"]), dtype="<i2").astype(np.float32) / 32768.0


def _speak(**req) -> dict:
    return voice_runtime.speak_pcm_payload({"text": "Hello there.", **req})


def _zero_runs(audio: np.ndarray, minimum: int) -> list[tuple[int, int]]:
    runs, start = [], None
    for index, value in enumerate(audio):
        if value == 0.0 and start is None:
            start = index
        elif value != 0.0 and start is not None:
            if index - start >= minimum:
                runs.append((start, index))
            start = None
    if start is not None and len(audio) - start >= minimum:
        runs.append((start, len(audio)))
    return runs


# ---------------------------------------------------------------- engine choice


def test_the_own_engine_speaks_when_it_opens_and_the_package_is_never_touched(engine):
    body = _speak(text="Open the calendar.")
    assert body["ok"] is True and body["sampleRate"] == RATE
    assert [c["text"] for c in engine.calls] == ["Open the calendar."]
    assert PipTTS.seen == []
    assert engine.calls[0]["lang"] == "en"


def test_without_the_engine_the_package_speaks_as_it_always_did(engine, monkeypatch):
    monkeypatch.setattr(friday_voice, "open_voice", lambda model_dir, *, threads=None: None)
    body = _speak(text="Open the calendar.")
    assert body["ok"] is True and body["sampleRate"] == 22050
    assert PipTTS.seen == ["Open the calendar."] and engine.calls == []


def test_an_engine_error_falls_back_to_the_package_and_stops_after_three_in_a_row(engine):
    engine.fail = True
    for _ in range(voice_runtime.ENGINE_MAX_FAILURES):
        body = _speak(text="Good morning.")
        assert body["ok"] is True and body["sampleRate"] == 22050
    assert len(PipTTS.seen) == voice_runtime.ENGINE_MAX_FAILURES
    opened_before = len(engine.opened)  # type: ignore[attr-defined]
    engine.fail = False
    body = _speak(text="Good morning.")
    assert body["sampleRate"] == 22050 and engine.calls == []  # the engine is not tried again
    assert len(engine.opened) == opened_before  # type: ignore[attr-defined]
    status = voice_runtime.tts_status()
    assert status["own"] is False and "stopped" in status["reason"]


def test_one_success_resets_the_failure_count(engine):
    engine.fail = True
    _speak()
    engine.fail = False
    assert _speak()["sampleRate"] == RATE
    engine.fail = True
    _speak()
    engine.fail = False
    assert _speak()["sampleRate"] == RATE


def test_no_model_folder_is_a_refusal(engine, monkeypatch):
    monkeypatch.setattr(voice_runtime, "supertonic_dir", lambda: None)
    assert _speak() == {"ok": False, "reason": voice_runtime.LOCAL_TTS_REASON}


def test_the_engine_gets_a_bounded_thread_count(monkeypatch):
    for cores, expected in ((None, 1), (1, 1), (2, 1), (4, 2), (6, 3), (8, 3), (64, 3)):
        monkeypatch.setattr(voice_runtime.os, "cpu_count", lambda c=cores: c)
        assert voice_runtime._voice_threads() == expected


def test_one_engine_serves_every_request_and_nothing_grows_without_bound(engine):
    for index in range(150):
        assert _speak(text=f"Number {index}.", utt=f"utt-{index}")["ok"] is True
    assert len(engine.opened) == 1  # type: ignore[attr-defined]
    assert engine.opened[0]["threads"] == voice_runtime._voice_threads()  # type: ignore[attr-defined]
    assert len(voice_runtime._utterances) <= voice_runtime.UTTERANCE_KEEP
    assert len(voice_runtime._personas) <= 2


# ---------------------------------------------------------------- the voice


def test_the_persona_whitelist_never_passes_a_path_or_a_new_name():
    for asked, expected in (
        ("", "friday"),
        (None, "friday"),
        (7, "friday"),
        ("FRIDAY", "friday"),
        (" Friday-Bright ", "friday-bright"),
        ("friday-calm", "friday-calm"),
        ("f3", "F3"),
        ("M2", "M2"),
        ("M5", "friday"),
        ("../../models/x", "friday"),
        ("friday\x00F1", "friday"),
        ("friday;rm -rf", "friday"),
        ("x" * 200, "friday"),
        ("nobody", "friday"),
    ):
        assert voice_runtime.persona_name(asked) == expected, asked
    assert voice_runtime.voice_style_name("f3") == "F3"  # the package path keeps its preset-only rule
    assert voice_runtime.voice_style_name("friday") == voice_runtime.SUPERTONIC_VOICE


def test_the_default_voice_is_a_blend_of_presets_and_a_preset_passes_through(engine):
    _speak()
    assert set(engine.styles_asked) <= set(PRESETS) and len(set(engine.styles_asked)) > 1
    blended = engine.calls[0]["style"]
    _speak(style="F3")
    assert np.array_equal(engine.calls[1]["style"].ttl, engine.style("F3").ttl)
    assert not np.array_equal(blended.ttl, engine.calls[1]["style"].ttl)
    _speak(style="../../etc/passwd")
    assert np.array_equal(engine.calls[2]["style"].ttl, blended.ttl)


def test_the_persona_is_resolved_once_per_recipe(engine, monkeypatch):
    made = []
    real = voice_persona.resolve

    def counting(voice_id, voice):
        made.append(voice_id)
        return real(voice_id, voice)

    monkeypatch.setattr(voice_persona, "resolve", counting)
    for _ in range(5):
        _speak()
    assert made == ["friday"]
    _speak(style="friday-calm")
    assert made == ["friday", "friday-calm"]


def test_speed_is_the_request_rate_times_the_recipe_scale_and_never_leaves_the_engine_range(engine):
    scale = voice_persona.resolve("friday", engine).speed_scale
    _speak(speed=1.0)
    _speak(speed=1.2)
    _speak(speed=9.0)
    _speak(speed=0.01)
    speeds = [c["speed"] for c in engine.calls]
    assert speeds[0] == pytest.approx(scale, abs=1e-3)
    assert speeds[1] == pytest.approx(1.2 * scale, abs=1e-3)
    assert speeds[2] == pytest.approx(2.0 * scale, abs=1e-3)  # the request rate is clamped first, then scaled
    assert speeds[3] == pytest.approx(max(0.7, 0.7 * scale), abs=1e-3)
    assert all(0.7 <= s <= 2.0 for s in speeds)


# ---------------------------------------------------------------- clauses, steps, trim, pauses


TWO = "Open the calendar and read my next meeting aloud please. Then tell me about the weather today."


def test_the_opening_clause_uses_fewer_steps_and_later_ones_the_recipe(engine):
    recipe = voice_persona.resolve("friday", engine).steps
    _speak(text=TWO, first=True)
    steps = [c["steps"] for c in engine.calls]
    assert len(steps) >= 2
    assert steps[0] == min(voice_runtime.FIRST_CLAUSE_STEPS, recipe)
    assert all(s == recipe for s in steps[1:])
    engine.calls.clear()
    _speak(text=TWO)
    assert {c["steps"] for c in engine.calls} == {recipe}


def test_a_long_first_sentence_is_cut_short_only_for_the_opening_request(engine):
    sentence = "Open the calendar and read me my next meeting and then the weather forecast for tomorrow."
    _speak(text=sentence, first=True)
    cut = [c["text"] for c in engine.calls]
    engine.calls.clear()
    _speak(text=sentence)
    whole = [c["text"] for c in engine.calls]
    assert len(cut) == 2 and len(whole) == 1
    assert cut[0].endswith(",") and cut[0].split()[:3] == sentence.split()[:3]


def test_the_padding_of_each_clause_is_trimmed_so_the_first_sound_is_not_delayed(engine):
    body = _speak(text="Hello.")
    audio = _pcm(body)
    raw = RATE * len("Hello.") // 40 + 2 * PAD
    assert audio.size < raw - PAD // 2  # most of the half second at the start and the end is gone
    voiced = np.flatnonzero(np.abs(audio) > 1e-3)
    assert voiced.size and voiced[0] < RATE * 0.06


def test_clause_edges_are_soft(engine):
    audio = _pcm(_speak(text="Hello there my friend."))
    assert abs(audio[0]) < 0.01 and abs(audio[-1]) < 0.01
    assert float(np.max(np.abs(audio))) <= 1.0


def test_clauses_are_separated_by_the_pause_of_their_ending_and_pause_ms_trails_the_request(engine):
    plain = _pcm(_speak(text=TWO))
    runs = _zero_runs(plain, int(RATE * 0.2))
    assert runs, "the sentence break leaves a silence"
    assert runs[0][1] - runs[0][0] >= int(RATE * 0.24)
    trailing = _pcm(_speak(text="Hello.", pauseMs=300))
    assert trailing.size - np.flatnonzero(trailing != 0.0)[-1] - 1 >= int(RATE * 0.3)
    capped = _pcm(_speak(text="Hello.", pauseMs=99999))
    base = _pcm(_speak(text="Hello."))
    assert capped.size - base.size == int(RATE * voice_runtime.MAX_PAUSE_MS / 1000)
    assert _pcm(_speak(text="Hello.", pauseMs=-5)).size == base.size
    assert _pcm(_speak(text="Hello.", pauseMs="no")).size == base.size


def test_the_reply_text_is_capped_like_before(engine):
    _speak(text="word " * 2000 + ".")
    assert sum(len(c["text"]) for c in engine.calls) <= voice_runtime.MAX_SPEAK_CHARS + 40


def test_hindi_english_and_hinglish_clauses_keep_their_language(engine):
    _speak(text="नमस्ते, आप कैसे हैं?")
    _speak(text="Good evening, how are you?")
    _speak(text="आप मेरे लिए calendar open करें please.")
    _speak(text="Main ghar ja raha hoon.")
    langs = [c["lang"] for c in engine.calls]
    assert langs == ["hi", "en", "hi", "hi"]
    roman = engine.calls[3]["text"]  # Roman Hindi is written in Devanagari and read as Hindi
    assert "ghar" not in roman and "घर" in roman


# ---------------------------------------------------------------- finishing chain across clauses


class RecordingChain(voice_fx.FxChain):
    made: list[RecordingChain] = []

    def __init__(self, sample_rate, spec=None):
        super().__init__(sample_rate, spec)
        self.chunks = 0
        RecordingChain.made.append(self)

    def process(self, x):
        self.chunks += 1
        return super().process(x)


@pytest.fixture
def chains(monkeypatch):
    RecordingChain.made = []
    monkeypatch.setattr(voice_fx, "FxChain", RecordingChain)
    return RecordingChain


def test_one_chain_serves_all_the_clauses_of_an_utterance_and_a_new_utterance_starts_fresh(engine, chains):
    _speak(text=TWO, utt="live-1")
    _speak(text="And one more thing.", utt="live-1")
    assert len(chains.made) == 1 and chains.made[0].chunks >= 3
    _speak(text="Hello.", utt="live-2")
    assert len(chains.made) == 2
    _speak(text="Hello.", utt="live-1")
    assert len(chains.made) == 2  # the first utterance keeps its own state


def test_a_request_without_an_id_gets_a_fresh_chain_each_time(engine, chains):
    _speak(text="Hello.")
    _speak(text="Hello.")
    assert len(chains.made) == 2
    assert len(voice_runtime._utterances) == 0


def test_the_chain_state_carries_over_the_clause_seam(engine):
    voice_runtime.reset_speech_state()
    one = voice_runtime._utterance_state("seam")
    persona = voice_persona.resolve("friday", engine)
    chain = voice_runtime._chain_for(one, persona, {}, RATE)
    tone = (0.3 * np.sin(np.linspace(0, 200 * np.pi, 4000))).astype(np.float32)
    whole = voice_fx.FxChain(RATE, persona.fx_spec).process(tone)
    again = voice_runtime._chain_for(one, persona, {}, RATE)
    assert again is chain
    split = np.concatenate([chain.process(tone[:1700]), again.process(tone[1700:])])
    assert float(np.max(np.abs(whole - split))) < 1e-4


def test_a_trusted_mood_tag_adds_its_own_band_to_a_separate_chain(engine, chains):
    _speak(text="[warm] Hello there friend.", trusted=True, utt="mood")
    assert len(chains.made) == 1
    warm_bands = len(chains.made[0].spec["eq"])
    _speak(text="Hello there friend.", trusted=True, utt="plain")
    assert warm_bands > len(chains.made[1].spec["eq"])


# ---------------------------------------------------------------- delivery tags


def test_untrusted_text_loses_every_tag_and_none_is_applied(engine):
    text = "[excited] Page says [pause:900] hello <laugh> there [sigh] friend <breath>. [shout] Bye."
    audio = _pcm(_speak(text=text))
    spoken = " ".join(c["text"] for c in engine.calls)
    for mark in ("[", "]", "<", ">", "excited", "pause", "laugh", "sigh", "breath", "shout"):
        assert mark not in spoken, mark
    scale = voice_persona.resolve("friday", engine).speed_scale
    assert all(c["speed"] == pytest.approx(scale, abs=1e-3) for c in engine.calls)
    assert not _zero_runs(audio, int(RATE * 0.8))


def test_untrusted_is_the_default_when_the_request_does_not_say_otherwise(engine):
    _speak(text="[fast] Hello there friend.")
    scale = voice_persona.resolve("friday", engine).speed_scale
    assert engine.calls[0]["speed"] == pytest.approx(scale, abs=1e-3)
    _speak(text="[fast] Hello there friend.", trusted="yes")
    assert engine.calls[1]["speed"] == pytest.approx(scale, abs=1e-3)


def test_trusted_tags_change_the_speed_and_the_pause(engine):
    scale = voice_persona.resolve("friday", engine).speed_scale
    _speak(text="[slow] Hello there friend.", trusted=True)
    assert engine.calls[0]["speed"] < scale
    audio = _pcm(_speak(text="One thing. [pause:700] Another thing.", trusted=True))
    assert any(end - start >= int(RATE * 0.7) for start, end in _zero_runs(audio, int(RATE * 0.5)))


def test_a_disabled_expression_tag_never_reaches_the_engine_and_leaves_a_soft_sound(engine):
    audio = _pcm(_speak(text="Hello there. [breath] Next part.", trusted=True))
    assert all("<" not in c["text"] for c in engine.calls)
    assert audio.size > 0
    assert any("Next" in c["text"] for c in engine.calls)


def test_an_enabled_expression_tag_is_sent_alone_in_an_unknown_language_clause(engine, monkeypatch):
    monkeypatch.setitem(tts_delivery.ENGINE_TAG_STATUS["breath"], "enabled", True)
    _speak(text="Hello there. [breath] Next part.", trusted=True)
    texts = [c["text"] for c in engine.calls]
    assert "<breath>" in texts
    alone = engine.calls[texts.index("<breath>")]
    assert alone["lang"] == "na"
    assert all("<" not in t for t in texts if t != "<breath>")


# ---------------------------------------------------------------- cancel


def test_a_cancel_between_clauses_stops_the_utterance_and_later_clauses_are_never_made(engine):
    engine.on_synth = lambda count: voice_runtime.cancel_utterance("live-9") if count == 1 else None
    body = _speak(text=TWO + " And a third sentence follows here.", utt="live-9", seq=2)
    assert body == {"ok": False, "reason": "cancelled", "utt": "live-9", "seq": 2}
    assert len(engine.calls) == 1
    again = _speak(text="Hello.", utt="live-9")
    assert again["reason"] == "cancelled" and len(engine.calls) == 1


def test_the_stop_check_runs_before_each_clause_in_the_array_path(engine):
    seen = []

    def stop():
        seen.append(len(engine.calls))
        return len(seen) > 3

    with pytest.raises(voice_runtime.SpeechCancelled):
        voice_runtime._speak_array(TWO, 1.0, "", "", stop=stop)
    assert len(engine.calls) <= 2


def test_a_cancel_is_never_counted_as_an_engine_failure(engine):
    engine.on_synth = lambda count: voice_runtime.cancel_utterance("live-3")
    for _ in range(5):
        voice_runtime.reset_cancelled()
        assert _speak(utt="live-3")["reason"] == "cancelled"
    assert voice_runtime._engine_failures == 0


# ---------------------------------------------------------------- status and warm-up


def _model_folder(root: Path) -> Path:
    base = root / "supertonic-3"
    (base / "onnx").mkdir(parents=True)
    for name in (*friday_voice.GRAPHS.values(), "unicode_indexer.json"):
        (base / "onnx" / name).write_bytes(b"x")
    (base / "onnx" / "tts.json").write_text(json.dumps({"ae": {"sample_rate": 44100}}), encoding="utf-8")
    return base


def test_the_status_reports_the_own_engine_in_the_fields_the_doctor_reads(tmp_path, monkeypatch):
    voice_runtime.reset_speech_state()
    folder = _model_folder(tmp_path)
    monkeypatch.setattr(voice_runtime, "supertonic_dir", lambda: folder)
    monkeypatch.setattr(importlib.util, "find_spec", lambda name, *a, **k: object())
    status = voice_runtime.tts_status()
    assert status["engine"] == "friday-voice" and status["own"] is True and status["ready"] is True
    assert status["voiceId"] == "friday" and status["sampleRate"] == 44100
    assert status["recipeVersion"] == voice_persona.RECIPE_VERSION and status["reason"] == ""
    assert status["offlineFallback"] == "sapi" and status["cloud"] == "opt-in"
    assert voice_runtime.status()["tts"]["engine"] == "friday-voice"


def test_the_status_says_package_when_only_the_package_can_speak_and_none_without_a_folder(tmp_path, monkeypatch):
    voice_runtime.reset_speech_state()
    partial = tmp_path / "partial"
    (partial / "onnx").mkdir(parents=True)
    monkeypatch.setattr(voice_runtime, "supertonic_dir", lambda: partial)
    status = voice_runtime.tts_status()
    assert status["engine"] == "supertonic-3" and status["own"] is False and status["ready"] is True
    assert status["voiceId"] == voice_runtime.SUPERTONIC_VOICE and status["sampleRate"] == 0
    monkeypatch.setattr(voice_runtime, "supertonic_dir", lambda: None)
    gone = voice_runtime.tts_status()
    assert gone["engine"] == "none" and gone["own"] is False and gone["ready"] is False
    assert gone["reason"] == voice_runtime.LOCAL_TTS_REASON


def test_warm_up_opens_the_engine_once_and_runs_a_tiny_clause_through_the_whole_path(engine, monkeypatch):
    reply, stop = voice_runtime._handle({"op": "warm-up"})
    assert stop is False
    assert reply["ok"] is True and reply["engine"] == "friday-voice" and reply["voiceId"] == "friday"
    assert reply["sampleRate"] == RATE and isinstance(reply["ms"], int)
    assert engine.warm == 1 and len(engine.calls) == 1
    assert engine.calls[0]["steps"] == min(voice_runtime.FIRST_CLAUSE_STEPS, voice_persona.DEFAULT_STEPS)
    voice_runtime._handle({"op": "warm-up", "style": "friday-calm"})
    assert len(engine.opened) == 1  # type: ignore[attr-defined]


def test_warm_up_without_the_engine_loads_the_package_or_says_why_not(engine, monkeypatch):
    monkeypatch.setattr(friday_voice, "open_voice", lambda model_dir, *, threads=None: None)
    reply, _ = voice_runtime._handle({"op": "warm-up"})
    assert reply["ok"] is True and reply["engine"] == "supertonic-3" and PipTTS.seen == ["Ready."]
    monkeypatch.setattr(voice_runtime, "supertonic_dir", lambda: None)
    assert voice_runtime._handle({"op": "warm-up"})[0] == {"ok": False, "reason": voice_runtime.LOCAL_TTS_REASON}


def test_a_warm_up_that_raises_is_a_report_not_a_crash(engine):
    engine.fail = True
    reply, _ = voice_runtime._handle({"op": "warm-up"})
    assert reply["ok"] is False and reply["reason"].startswith("warm-up-failed")


# ---------------------------------------------------------------- the older callers


def test_the_wav_and_pcm_paths_agree_on_the_new_engine(engine):
    made = voice_runtime._speak_array("Hello there friend.", 1.0, "", "")
    assert made is not None and made[1] == RATE and made[0].dtype == np.float32
    pcm = voice_runtime.speak_pcm16("Hello there friend.", 1.0, "", "")
    assert pcm is not None and pcm[1] == RATE and len(pcm[0]) == 2 * made[0].size


def test_a_text_with_nothing_to_say_is_no_audio_and_no_package_call(engine):
    assert voice_runtime._speak_array("   ") is None
    assert voice_runtime._speak_array("***") is None
    assert PipTTS.seen == []


# ---------------------------------------------------------------- pausedMs and wordTimes in the reply


def _clip_ms(body: dict) -> float:
    return _pcm(body).size * 1000.0 / RATE


def test_pausedms_counts_the_silence_the_kernel_put_in_and_clamps_the_trailing_pause(engine):
    base = _speak(text="Hello.")
    assert base["pausedMs"] == 0
    for asked, expected in ((0, 0), (300, 300), (5000, voice_runtime.MAX_PAUSE_MS)):
        body = _speak(text="Hello.", pauseMs=asked)
        assert body["pausedMs"] == expected
        assert _clip_ms(body) - _clip_ms(base) == pytest.approx(expected, abs=1.0)


def test_pausedms_includes_the_gap_between_clauses_and_a_pause_tag(engine):
    two = _speak(text=TWO)
    assert two["pausedMs"] > 0
    plain = _speak(text="One thing. Another thing.", trusted=True)
    tagged = _speak(text="One thing. [pause:400] Another thing.", trusted=True)
    assert tagged["pausedMs"] == 400 > plain["pausedMs"]
    assert tagged["pausedMs"] <= _clip_ms(tagged)


def test_wordtimes_are_monotone_inside_the_clip_and_end_before_the_trailing_pause(engine):
    for text in ("Open the calendar for tomorrow.", "मैं ठीक हूँ, आप कैसे हैं।", "Kal ka meeting रद्द कर दो, please."):
        body = _speak(text=text, pauseMs=250)
        times = body["wordTimes"]
        assert times, text
        assert len(times) == len(text.split())  # the front end may tidy a mark, never a word
        previous = 0.0
        for item in times:
            assert item["startMs"] >= previous - 1e-6 and item["endMs"] >= item["startMs"]
            previous = item["endMs"]
        assert previous <= _clip_ms(body) - 250 + 1.0
        assert previous >= _clip_ms(body) - 250 - 2.0 * 1000.0 * PAD / RATE


def test_wordtimes_skip_the_pauses_between_clauses_and_cover_only_spoken_words(engine):
    body = _speak(text="One thing. [pause:700] Another thing.", trusted=True)
    words = [t["word"] for t in body["wordTimes"]]
    assert words == ["One", "thing.", "Another", "thing."]
    gap = body["wordTimes"][2]["startMs"] - body["wordTimes"][1]["endMs"]
    assert gap >= 700 - 1.0


def test_wordtimes_are_capped_at_400_words(engine):
    body = _speak(text=("word " * 100 + ". ") * 4)
    assert 0 < len(body["wordTimes"]) <= 400


def test_a_package_fallback_reply_has_no_pause_or_word_data_even_after_an_engine_reply(engine, monkeypatch):
    assert _speak(text="Hello there.", pauseMs=300)["wordTimes"]
    monkeypatch.setattr(friday_voice, "open_voice", lambda *a, **k: None)
    voice_runtime.reset_speech_state()
    body = _speak(text="Hello there.", pauseMs=300)
    assert body["ok"] is True and body["pausedMs"] == 0 and "wordTimes" not in body


def test_an_engine_that_fails_midway_falls_back_with_no_stale_word_data(engine):
    _speak(text="Hello there.", pauseMs=300)
    engine.fail = True
    body = _speak(text="Hello there.", pauseMs=300)
    assert body["pausedMs"] == 0 and "wordTimes" not in body
