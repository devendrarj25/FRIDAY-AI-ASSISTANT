"""The stream engine chooser: measured speed per hardware tier, never an engine without its pin, Hinglish to an ear
that hears both, and the re-decoding ears (Hindi ear, resident Whisper) behind the same stream ops."""

from __future__ import annotations

import base64
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "kernel"))

import stream_ear  # noqa: E402
import stt  # noqa: E402
from la2_partials import TurnLanguage  # noqa: E402
from stream_commit import Word  # noqa: E402
from stream_ear import (  # noqa: E402
    RTF_LIMIT,
    EngineSpec,
    La2Engine,
    RtfLedger,
    StreamHost,
    TierChoice,
    choose_tier,
    hardware_tier,
)


@pytest.fixture
def registry(monkeypatch, tmp_path):
    monkeypatch.setenv("FRIDAY_ROOT", str(tmp_path))
    monkeypatch.setattr(stream_ear, "_REGISTRY", {})
    return tmp_path


def _reader_factory(log=None):
    def make(folder, turn, hotwords):
        def read(window, prompt):
            if log is not None:
                log.append((len(window), prompt, tuple(hotwords), turn.decode_language()))
            n = int(len(window) / 16000 / 0.4)
            return [Word(f"w{i}", i * 0.4, i * 0.4 + 0.4) for i in range(n)]

        return read

    return make


def _spec(name, folder, priority, languages=("hi", "en", "auto"), log=None):
    return EngineSpec(
        name,
        name,
        {},
        lambda: La2Engine(name, _reader_factory(log), hop_s=0.4),
        modules=("json",),
        languages=lambda _f: set(languages),
        priority=priority,
        locate=lambda: folder,
    )


def test_hardware_tiers():
    assert hardware_tier(64, 16, True) == "gpu"
    assert hardware_tier(8, 8, False) == "small-cpu"
    assert hardware_tier(32, 4, False) == "small-cpu"
    assert hardware_tier(16, 8, False) == "mid"


def test_the_ledger_averages_persists_and_ignores_nonsense(tmp_path):
    path = tmp_path / "rtf.json"
    ledger = RtfLedger(path)
    assert ledger.get("a", "mid") is None
    assert ledger.record("a", "mid", 1.0) == 1.0
    assert ledger.record("a", "mid", -1.0) is None and ledger.record("a", "moon", 0.5) is None
    assert ledger.record("a", "mid", float("nan")) is None
    assert ledger.record("a", "mid", 0.5) == pytest.approx(0.85)
    assert RtfLedger(path).get("a", "mid") == pytest.approx(0.85)
    path.write_text("{not json", encoding="utf-8")
    assert RtfLedger(path).get("a", "mid") is None
    path.write_text(json.dumps({"a": {"mid": "fast", "gpu": 0.1}, "b": [1]}), encoding="utf-8")
    assert RtfLedger(path).get("a", "gpu") is None  # a row with a bad value is dropped whole
    assert RtfLedger(None).record("x", "gpu", 0.2) == 0.2  # no file: memory only


def test_auto_skips_an_engine_measured_too_slow_on_this_tier(registry, tmp_path):
    stream_ear.register_engine(_spec("big", tmp_path, 1))
    stream_ear.register_engine(_spec("small", tmp_path, 2))
    ledger = RtfLedger(None)
    ledger.record("big", "small-cpu", RTF_LIMIT + 0.5)
    choice = choose_tier("auto", "hi", tier="small-cpu", ledger=ledger)
    assert choice == TierChoice("small", "ok", tmp_path, "small-cpu", None)
    assert choose_tier("auto", "hi", tier="gpu", ledger=ledger).engine == "big"  # measured slow elsewhere only
    assert choose_tier("auto", "hi", ledger=ledger).engine == "big"  # no tier, no gate
    assert choose_tier("big", "hi", tier="small-cpu", ledger=ledger).engine == "big"  # by name: the owner's call
    ledger.record("small", "small-cpu", 0.2)
    assert choose_tier("auto", "hi", tier="small-cpu", ledger=ledger).rtf == 0.2
    ledger.record("small", "small-cpu", 9.0)
    ledger.record("small", "small-cpu", 9.0)
    slow = choose_tier("auto", "hi", tier="small-cpu", ledger=ledger)
    assert slow.engine is None and slow.reason == "too-slow" and slow.tier == "small-cpu"


def test_an_engine_without_its_pin_is_never_chosen(registry, tmp_path):
    stream_ear.register_engine(_spec("first", None, 1))
    stream_ear.register_engine(_spec("second", tmp_path, 2, languages=("en",)))
    assert choose_tier("auto", "hi") == TierChoice(None, "pin-missing")  # the first candidate's reason
    assert choose_tier("auto", "en").engine == "second"
    assert choose_tier("first", "en") == TierChoice(None, "pin-missing")


def test_hinglish_goes_to_an_ear_that_hears_both_not_a_hindi_only_one(registry, tmp_path):
    stream_ear.register_engine(_spec("hindi-only", tmp_path, 1, languages=("hi", "en", "auto")))
    stream_ear.register_engine(_spec("mixed-ear", tmp_path, 2, languages=("hi", "en", "hi-en")))
    assert choose_tier("auto", "hi-en").engine == "mixed-ear"
    assert choose_tier("auto", "hinglish").engine == "mixed-ear"
    assert choose_tier("auto", "hi-IN").engine == "hindi-only"
    assert choose_tier("hindi-only", "hi-en").reason == "locale-unsupported"


def _pcm(seconds):
    return base64.b64encode(b"\x00\x00" * int(16000 * seconds)).decode()


def test_a_re_decoding_ear_streams_through_the_host_and_its_speed_is_measured(registry, tmp_path):
    log: list = []
    stream_ear.register_engine(_spec("la2", tmp_path, 1, log=log))
    ticks = iter(range(1000))
    host = StreamHost(clock=lambda: float(next(ticks)))
    host.hardware = lambda: "mid"
    opened = host.handle({"op": "stream-open", "streamEngine": "auto", "locale": "hi", "hotwords": ["Devendra"]})
    assert opened["ok"] is True and opened["engine"] == "la2" and opened["tier"] == "mid"
    assert opened["language"] == "hi" and opened["hotwords"] == 1
    events = []
    for _ in range(8):
        fed = host.handle({"op": "stream-feed", "streamId": opened["streamId"], "pcm": _pcm(0.32)})
        assert fed["ok"] is True
        events += fed["events"]
    partials = [e for e in events if e["type"] == "partial"]
    assert partials and all(e["language"] == "hi" for e in partials)
    assert log and all(row[2] == ("Devendra",) and row[3] == "hi" for row in log)
    closed = host.handle({"op": "stream-close", "streamId": opened["streamId"]})
    assert closed["final"] is True and closed["audioMs"] == 2560 and closed["engine"] == "la2"
    assert closed["text"].startswith("w0 w1") and closed["words"][0] == {"text": "w0", "startMs": 0, "endMs": 400}
    assert host.ledger().get("la2", "mid") == closed["rtf"]
    assert (tmp_path / "models" / stream_ear.RTF_FILE).is_file()


def test_a_broken_hardware_probe_means_no_gate_not_a_refusal(registry, tmp_path):
    stream_ear.register_engine(_spec("la2", tmp_path, 1))
    host = StreamHost()

    def boom():
        raise OSError("no wmi")

    host.hardware = boom
    opened = host.handle({"op": "stream-open", "streamEngine": "auto", "locale": "en"})
    assert opened["ok"] is True and "tier" not in opened


# ---- the ears the worker registers --------------------------------------------------------------------------------


def test_the_worker_registers_the_hindi_ear_and_the_resident_whisper():
    hindi = stream_ear.engine_spec(stt.STREAM_HINDI)
    whisper = stream_ear.engine_spec(stt.STREAM_WHISPER)
    assert hindi is not None and whisper is not None
    nemotron = stream_ear.engine_spec(stream_ear.ENGINE_NAME)
    assert nemotron is not None and nemotron.priority < hindi.priority < whisper.priority
    assert hindi.languages is not None and hindi.languages(Path()) == {"hi"}
    assert whisper.languages is not None and "hi-en" in whisper.languages(Path())
    assert stream_ear.HOST.hardware is stt.stream_hardware_tier


def test_the_whisper_ear_needs_a_resident_fast_model(monkeypatch):
    monkeypatch.setattr(stt, "_model", None)
    assert stt._whisper_stream_dir() is None
    monkeypatch.setattr(stt, "_model", object())
    monkeypatch.setattr(stt, "_model_name", "large-v3")
    monkeypatch.setattr(stt, "_device_name", "cpu")
    assert stt._whisper_stream_dir() is None  # too slow for live words on the processor
    monkeypatch.setattr(stt, "_model_name", "small")
    assert stt._whisper_stream_dir() is not None


def test_the_hindi_stream_reader_snaps_the_owners_words(monkeypatch):
    heard = {"words": [{"text": "देवेंदर", "start": 0.0, "end": 0.5}], "confidence": None}
    monkeypatch.setattr(stt.hindi_ear, "transcribe_words", lambda window: heard)
    read = stt._hindi_stream_reader(Path(), TurnLanguage("hi"), ["देवेंद्र"])
    assert [w.text for w in read([0.0] * 16000, "")] == ["देवेंद्र"]
    monkeypatch.setattr(stt.hindi_ear, "transcribe_words", lambda window: None)
    assert read([0.0] * 16000, "") == []


def test_the_hardware_probe_reads_memory_and_device(monkeypatch):
    monkeypatch.setattr(stt, "read_memory_mb", lambda: (4000.0, 8192.0))
    monkeypatch.setattr(stt, "_device_name", "cpu")
    assert stt.stream_hardware_tier() == "small-cpu"
    monkeypatch.setattr(stt, "_device_name", "cuda")
    assert stt.stream_hardware_tier() == "gpu"
    monkeypatch.setattr(stt, "read_memory_mb", lambda: None)
    assert stt.stream_hardware_tier() is None


def test_whisper_reader_rescore_reads_the_other_language_once():
    class Model:
        def __init__(self):
            self.calls = []

        def transcribe(self, clip, **kwargs):
            self.calls.append(kwargs["language"])
            return iter([SimpleNamespace(text=" open the calendar ")]), SimpleNamespace(language="en")

    model = Model()
    turn = TurnLanguage("hi-en")
    turn.observe("hi")
    reader = stt.WhisperStreamReader(turn, [], model_ref=lambda: model)
    words = [Word("मुझे", 0.0, 0.3), Word("चाहिए", 0.3, 0.6), Word("opn", 0.6, 0.9), Word("calendar", 0.9, 1.4),
             Word("today", 1.4, 1.8)]  # fmt: skip
    text, changed = reader.rescore([0.0] * 32000, words, turn)
    assert model.calls == ["en"] and changed == 1
    assert text == "मुझे चाहिए open the calendar"
