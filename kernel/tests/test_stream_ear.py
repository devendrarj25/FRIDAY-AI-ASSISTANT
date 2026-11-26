"""FRIDAY Ears: the engine protocol, the registry, the tier choice, the endpointing glue and the worker slot.

Fake sessions only; the pin tree is made of sparse files of the pinned sizes, so nothing big is written and nothing
depends on the network, the date or this machine's folders.
"""

from __future__ import annotations

import base64
import json
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import stream_ear  # noqa: E402
from endpointer import EndpointConfig  # noqa: E402
from fake_transducer import FakeModel, install_fake_engine, pcm_bytes, write_model_dir  # noqa: E402
from stream_ear import (  # noqa: E402
    ENGINE_NAME,
    NEMOTRON_FILES,
    EnergyVad,
    EngineSpec,
    StreamHost,
    SttEngine,
    TierChoice,
    TransducerEngine,
    choose_tier,
    engine_names,
    model_root,
    pin_dir,
    register_engine,
    runtime_ready,
)
from transducer_loop import CPU, NemotronStream, TransducerError  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
OPEN_CHROME = [(1, 1), (3, 2), (3, 3), (3, 4), (6, 5)]


def real_languages_bytes() -> bytes:
    """A languages.json of exactly the pinned size (2020 bytes): the real keys we use, padded with whitespace."""
    body = json.dumps(
        {
            "numPrompts": 128,
            "promptDictionary": {"en-US": 0, "en": 0, "hi-IN": 6, "hi": 6, "auto": 101},
            "autoSlot": 101,
        }
    ).encode()
    return body + b" " * (NEMOTRON_FILES["languages.json"] - len(body))


def pin_tree(root: Path, *, short: str | None = None) -> Path:
    """<root>/models/stream-ear-nemotron with every pinned file at its exact size (sparse), or one file 1 byte short."""
    folder = root / "models" / ENGINE_NAME
    folder.mkdir(parents=True)
    for name, size in NEMOTRON_FILES.items():
        path = folder / name
        if name == "languages.json":
            path.write_bytes(real_languages_bytes())
        else:
            with path.open("wb") as handle:
                handle.truncate(size)
        if name == short:
            with path.open("r+b") as handle:
                handle.truncate(size - 1)
    return folder


@pytest.fixture
def friday_root(tmp_path, monkeypatch):
    monkeypatch.setenv("FRIDAY_ROOT", str(tmp_path))
    return tmp_path


# ---- the pin and the registry -------------------------------------------------------------------------------------


def test_the_size_table_equals_the_pin_in_voice_pins():
    text = (REPO / "electron" / "voice-pins.cjs").read_text(encoding="utf-8")
    start = text.index('"soniqo/Nemotron-3.5-ASR-Streaming-Multilingual-0.6B-ONNX-INT8": {\n    revision')
    block = text[start : text.index("\n  },\n", start)]
    pinned = {
        m.group(1): int(m.group(2))
        for m in re.finditer(r'"([\w.\-]+)": \{\s*sha256: "[0-9a-f]{64}",\s*bytes: (\d+)', block)
    }
    assert pinned == NEMOTRON_FILES
    weights = (REPO / "electron" / "voice-weights.cjs").read_text(encoding="utf-8")
    assert 'STREAM_EAR_REPO = "soniqo/Nemotron-3.5-ASR-Streaming-Multilingual-0.6B-ONNX-INT8"' in weights
    assert re.search(r'catalogId: "stream-ear-nemotron",\s*repo: STREAM_EAR_REPO', weights)


def test_the_engine_is_registered_with_its_aliases_and_files():
    assert ENGINE_NAME in engine_names()
    spec = stream_ear.engine_spec(ENGINE_NAME)
    assert spec is not None and spec.folder == "stream-ear-nemotron" and "nemotron" in spec.aliases
    assert dict(spec.files) == NEMOTRON_FILES
    assert isinstance(TransducerEngine(), SttEngine)


def test_model_root_follows_friday_root(monkeypatch, tmp_path):
    monkeypatch.setenv("FRIDAY_ROOT", str(tmp_path))
    assert model_root() == tmp_path / "models"
    monkeypatch.setenv("FRIDAY_ROOT", "  ")
    assert model_root() == Path.home() / ".friday" / "models"


def test_pin_dir_needs_every_file_at_its_exact_size(tmp_path):
    spec = stream_ear.engine_spec(ENGINE_NAME)
    assert spec is not None
    assert pin_dir(spec, tmp_path / "models") is None  # nothing there
    pin_tree(tmp_path)
    assert pin_dir(spec, tmp_path / "models") == tmp_path / "models" / ENGINE_NAME
    (tmp_path / "models" / ENGINE_NAME / "vocab.json").unlink()
    assert pin_dir(spec, tmp_path / "models") is None


@pytest.mark.parametrize("short", ["encoder.onnx", "decoder.onnx.data", "joint.onnx.data", "vocab.json"])
def test_a_partial_download_is_not_a_pin(tmp_path, short):
    spec = stream_ear.engine_spec(ENGINE_NAME)
    pin_tree(tmp_path, short=short)
    assert spec is not None and pin_dir(spec, tmp_path / "models") is None


# ---- the tier choice: setting AND pin ------------------------------------------------------------------------------


@pytest.mark.parametrize("setting", [None, False, "", "off", "OFF", " false ", "0", "none", "default", "disabled"])
def test_the_setting_off_never_picks_the_engine_even_with_the_pin_on_disk(tmp_path, setting):
    pin_tree(tmp_path)
    assert choose_tier(setting, "en-US", root=tmp_path / "models") == TierChoice(None, "off")


@pytest.mark.parametrize("setting", ["auto", "AUTO", " auto ", "nemotron", "Nemotron", "stream-ear-nemotron"])
def test_setting_on_and_pin_on_disk_picks_it(tmp_path, setting):
    folder = pin_tree(tmp_path)
    choice = choose_tier(setting, "hi-IN", root=tmp_path / "models")
    assert choice == TierChoice(ENGINE_NAME, "ok", folder)


def test_setting_on_without_the_pin_stays_off(tmp_path):
    assert choose_tier("auto", "en-US", root=tmp_path / "models") == TierChoice(None, "pin-missing")
    pin_tree(tmp_path, short="encoder.onnx")
    assert choose_tier("auto", "en-US", root=tmp_path / "models").reason == "pin-missing"


@pytest.mark.parametrize("setting", ["moonshine", "true", "1", 7, "nemotron-4"])
def test_an_unknown_setting_is_not_a_yes(tmp_path, setting):
    pin_tree(tmp_path)
    got = choose_tier(setting, "en-US", root=tmp_path / "models")
    assert got.engine is None and got.reason in {"unknown-engine", "off"}


def test_a_missing_runtime_or_an_unheard_locale_degrades_with_a_reason(tmp_path):
    pin_tree(tmp_path)
    root = tmp_path / "models"
    assert choose_tier("auto", "en-US", root=root, find_spec=lambda name: None).reason == "runtime-missing"
    assert choose_tier("auto", "xx-YY", root=root).reason == "locale-unsupported"
    assert choose_tier("auto", "hi_IN", root=root).engine == ENGINE_NAME
    assert choose_tier("auto", "", root=root).engine == ENGINE_NAME
    assert choose_tier("auto", "auto", root=root).engine == ENGINE_NAME
    assert runtime_ready(stream_ear.engine_spec(ENGINE_NAME)) is True  # type: ignore[arg-type]


def test_auto_goes_through_the_registry_in_priority_order(tmp_path, monkeypatch):
    monkeypatch.setattr(stream_ear, "_REGISTRY", dict(stream_ear._REGISTRY))
    folder = tmp_path / "models" / "other"
    folder.mkdir(parents=True)
    (folder / "m.bin").write_bytes(b"12")
    register_engine(EngineSpec("other-ear", "other", {"m.bin": 2}, TransducerEngine, priority=1))
    assert engine_names()[0] == "other-ear"
    assert choose_tier("auto", root=tmp_path / "models").engine == "other-ear"
    assert choose_tier("stream-ear-nemotron", root=tmp_path / "models").reason == "pin-missing"  # asked by name


# ---- the energy gate -----------------------------------------------------------------------------------------------


def test_the_energy_gate_hears_a_tone_and_counts_the_silence_after_it():
    import numpy as np

    vad = EnergyVad()
    tone = np.sin(np.arange(320) * 0.3).astype(np.float32) * 0.3
    quiet = np.zeros(320, np.float32)
    assert [vad.push(quiet) for _ in range(10)] == [0.0] * 10 and vad.silence_ms == 200
    for _ in range(5):
        vad.push(tone)
    assert vad.probability == 1.0 and vad.silence_ms == 0
    for _ in range(5):
        vad.push(quiet)
    assert vad.probability == 0.0 and vad.silence_ms == 60  # three quiet slices already read as silence
    vad.reset()
    assert vad.silence_ms == 0 and vad.probability == 0.0


# ---- the engine ----------------------------------------------------------------------------------------------------


def make_engine(tmp_path, model=None, **kw):
    model = model or FakeModel(script=OPEN_CHROME)
    folder = write_model_dir(tmp_path / "model", model.dims)
    engine = TransducerEngine(NemotronStream(model.factory, threads=1), **kw)
    return engine, model, folder


SPEECH = pcm_bytes(0.9, 0.3)
QUIET = pcm_bytes(2.0)


def drive(engine, data, step=3200):
    events = []
    for i in range(0, len(data), step):
        events += engine.feed(data[i : i + step])
    return events


def test_speech_then_quiet_makes_partials_then_one_end_of_turn(tmp_path):
    engine, _, folder = make_engine(tmp_path)
    info = engine.open(folder, locale="en-US")
    assert info["engine"] == ENGINE_NAME and info["providers"] == [CPU] and info["hotwords"] == 0
    events = drive(engine, SPEECH + QUIET)
    kinds = [e["event"] for e in events if e["type"] == "endpoint"]
    assert kinds[0] == "StartOfTurn" and kinds.count("StartOfTurn") == 1
    assert kinds[-1] == "EndOfTurn" and kinds.count("EndOfTurn") == 1
    partials = [e for e in events if e["type"] == "partial"]
    assert [p["text"] for p in partials] == ["Open", "Open Chrome,", "Open Chrome, please"]
    assert [p["revision"] for p in partials] == sorted(p["revision"] for p in partials)
    first_end = next(i for i, e in enumerate(events) if e.get("event") == "EndOfTurn")
    assert max(i for i, e in enumerate(events) if e["type"] == "partial") < first_end  # the words came first
    end = events[first_end]
    assert end["silenceMs"] >= 420 and end["audioMs"] > 900  # the wait the endpointer asks for after a finished phrase


def test_without_the_silero_file_a_silero_request_keeps_the_energy_gate_and_the_same_turn(tmp_path, monkeypatch):
    import vad_onnx

    monkeypatch.setattr(vad_onnx, "find_model", lambda: None)
    engine, _, folder = make_engine(tmp_path)
    info = engine.open(folder, locale="en-US", ears={"vad": "silero", "vadStart": 0.6})
    assert info["vad"] == "energy" and isinstance(engine._vad, EnergyVad)
    kinds = [e["event"] for e in drive(engine, SPEECH + QUIET) if e["type"] == "endpoint"]
    assert kinds[0] == "StartOfTurn" and kinds[-1] == "EndOfTurn"


def test_the_end_of_turn_waits_longer_after_a_mid_thought_word(tmp_path):
    """ "Open Chrome," ends with a comma, so the wait is the long one (1200 ms) and the turn is still open at 800."""
    engine, _, folder = make_engine(tmp_path, FakeModel(script=OPEN_CHROME[:4]))
    engine.open(folder)
    events = drive(engine, SPEECH + pcm_bytes(0.8))
    assert engine.partial()["text"] == "Open Chrome,"
    assert [e["event"] for e in events if e["type"] == "endpoint"][-1] != "EndOfTurn"
    assert engine.endpoint()["inTurn"] is True
    events += drive(engine, pcm_bytes(1.0))
    assert "EndOfTurn" in [e.get("event") for e in events]


def test_partials_commit_words_once_two_updates_agree(tmp_path):
    engine, _, folder = make_engine(tmp_path)
    engine.open(folder)
    seen = []
    for event in drive(engine, SPEECH + pcm_bytes(0.5)):
        if event["type"] == "partial":
            seen.append((event["committed"], event["text"]))
    committed = [c for c, _ in seen]
    assert all(b.startswith(a) for a, b in zip(committed, committed[1:], strict=False))  # committed only grows
    assert seen[-1][1] == "Open Chrome, please"
    final = engine.finalize()
    assert final["text"] == final["committed"] == "Open Chrome, please" == engine.committed()
    assert [w["text"] for w in final["words"]] == ["Open", "Chrome,", "please"]
    assert final["words"][0]["startMs"] == 80 and final["engine"] == ENGINE_NAME
    assert final["audioMs"] == 900 + 500 and final["rtf"] >= 0 and final["providers"] == [CPU]


def test_open_again_keeps_the_sessions_and_starts_a_clean_turn(tmp_path):
    engine, model, folder = make_engine(tmp_path)
    engine.open(folder, locale="en-US")
    drive(engine, SPEECH + QUIET)
    engine.finalize()
    assert len(model.opened) == 3
    info = engine.open(folder, locale="hi-IN", hotwords=["Open Chrome"])
    assert len(model.opened) == 3 and info["loadMs"] == 0 and info["hotwords"] == 1
    assert engine.partial()["text"] == "" and engine.committed() == "" and engine.endpoint()["inTurn"] is False
    assert model.sessions["encoder.onnx"].calls  # earlier calls stay recorded; the new turn starts at zero caches
    drive(engine, SPEECH)
    assert engine.finalize()["locale"] == "hi-IN"
    engine.open(folder, providers=["cpu", "directml"])  # a different provider list reopens the sessions
    assert len(model.opened) == 6


def test_hotwords_are_capped_in_count_and_length(tmp_path):
    engine, _, folder = make_engine(tmp_path)
    many = ["Open"] * 500 + ["Open Chrome " * 100_000]
    info = engine.open(folder, hotwords=many)
    assert info["hotwords"] <= stream_ear.MAX_HOTWORDS and info["hotwords"] >= 1


def test_reset_and_close(tmp_path):
    engine, _, folder = make_engine(tmp_path)
    engine.open(folder)
    drive(engine, SPEECH)
    engine.reset()
    assert engine.partial()["text"] == "" and engine.loaded
    engine.close()
    assert not engine.loaded
    with pytest.raises(RuntimeError):
        engine.feed(SPEECH)
    with pytest.raises(RuntimeError):
        engine.finalize()


def test_a_bad_locale_raises_the_transducer_kind(tmp_path):
    engine, _, folder = make_engine(tmp_path)
    with pytest.raises(TransducerError) as bad:
        engine.open(folder, locale="xx-YY")
    assert bad.value.kind == "locale"


def test_the_endpoint_options_are_limited_to_the_known_fields(tmp_path):
    engine, _, folder = make_engine(tmp_path)
    engine.open(folder, endpoint={"open_silence_ms": 300, "bogus": 1, "hard_cap_ms": 900})
    assert engine._endpoint_config.open_silence_ms == 300 and engine._endpoint_config.hard_cap_ms == 900


# ---- the turn protocol, Smart Turn on a VAD stop and the final gate -------------------------------------------------

EARS = {"vad": "energy", "eagerness": "normal", "eagerTurn": True}


class Scorer:
    """Stands in for ``voice_runtime.score_turn``: records every call and answers ``probability``."""

    def __init__(self, probability: float | None = 0.9, reason: str = ""):
        self.probability, self.reason, self.calls = probability, reason, []

    def __call__(self, samples, rate):
        self.calls.append((len(samples), rate))
        if self.probability is None:
            return {"ok": True, "ready": False, "probability": None, "reason": self.reason}
        return {"ok": True, "ready": True, "probability": self.probability, "complete": True, "reason": ""}


def turn_events(engine, data, step=640):
    """Feed in 20 ms steps and keep the turn notes with the audio position they came at."""
    seen, fed = [], 0
    for i in range(0, len(data), step):
        engine.feed(data[i : i + step])
        fed += step // 32
        seen += [(fed, t["event"], t) for t in engine.take_turns()]
    return seen


def test_without_ears_there_are_no_turn_events_no_scoring_and_no_gate(tmp_path):
    scorer = Scorer()
    engine, _, folder = make_engine(tmp_path, turn_scorer=scorer)
    engine.open(folder, locale="en-US")
    events = drive(engine, SPEECH + QUIET)
    assert engine.take_turns() == [] and scorer.calls == []
    assert engine._endpoint_config == EndpointConfig()  # the defaults stay
    assert [e["event"] for e in events if e["type"] == "endpoint"][-1] == "EndOfTurn"
    assert "dropped" not in engine.finalize()


def test_with_ears_the_turn_runs_start_partial_eager_end_with_the_fields_the_renderer_reads(tmp_path):
    scorer = Scorer(0.9)
    engine, _, folder = make_engine(tmp_path, turn_scorer=scorer)
    info = engine.open(folder, locale="en-US", ears=EARS)
    assert (
        info["vad"] == "energy" and engine._endpoint_config.open_silence_ms == 420
    )  # the normal preset keeps today's pause
    seen = turn_events(engine, SPEECH + QUIET)
    assert [e for _, e, _ in seen if e != "partial"] == ["start", "eager", "end"]
    first = seen[0][2]
    assert set(first) == {"turnId", "event", "text", "vadP", "speechMs"} and first["turnId"] == 1
    assert [t["text"] for _, e, t in seen if e == "partial"][-1] == "Open Chrome, please"
    eager = next(t for _, e, t in seen if e == "eager")
    assert eager["text"] == "Open Chrome, please" and eager["speechMs"] >= 700
    end = next(t for _, e, t in seen if e == "end")
    assert end["text"] == eager["text"]  # the speculative reply is adopted: same words


def test_smart_turn_runs_once_per_pause_after_200_ms_on_the_last_8_seconds(tmp_path):
    scorer = Scorer(0.9)
    engine, _, folder = make_engine(tmp_path, turn_scorer=scorer)
    engine.open(folder, locale="en-US", ears=EARS)
    drive(engine, SPEECH + pcm_bytes(0.16))
    assert scorer.calls == []  # 160 ms of quiet is not a VAD stop yet
    drive(engine, pcm_bytes(0.1))
    assert [rate for _, rate in scorer.calls] == [16000]
    drive(engine, pcm_bytes(1.0))
    assert len(scorer.calls) == 1  # one answer per pause
    long = pcm_bytes(0.9, 0.3) * 12 + pcm_bytes(0.4)
    engine.reset()
    engine.open(folder, locale="en-US", ears=EARS)
    drive(engine, long)
    assert scorer.calls[-1][0] <= 16000 * 8  # never more than the last 8 s


def test_the_model_is_asked_again_on_the_whole_turn_after_speech_resumes(tmp_path):
    scorer = Scorer(0.3)
    engine, _, folder = make_engine(tmp_path, turn_scorer=scorer)
    engine.open(folder, ears={**EARS, "eagerTurn": False})
    drive(engine, SPEECH + pcm_bytes(0.4))
    assert len(scorer.calls) == 1
    drive(engine, SPEECH + pcm_bytes(0.4))
    assert len(scorer.calls) == 2 and scorer.calls[1][0] > scorer.calls[0][0]  # the second read has the extra speech


def test_eager_then_resumed_when_speech_returns_and_no_eager_without_the_setting(tmp_path):
    engine, _, folder = make_engine(tmp_path, turn_scorer=Scorer(0.55))
    engine.open(folder, locale="en-US", ears=EARS)
    seen = turn_events(engine, SPEECH + pcm_bytes(0.4) + SPEECH + QUIET)
    names = [e for _, e, _ in seen if e != "partial"]
    assert names[:3] == ["start", "eager", "resumed"] and names[-1] == "end"
    assert len({t["turnId"] for _, _, t in seen}) == 1
    off, _, folder2 = make_engine(tmp_path / "b", turn_scorer=Scorer(0.9))
    off.open(folder2, locale="en-US", ears={**EARS, "eagerTurn": False})
    assert "eager" not in [e for _, e, _ in turn_events(off, SPEECH + QUIET)]


def test_a_confident_score_ends_the_turn_sooner_and_a_low_one_waits_for_the_fallback(tmp_path):
    ends = {}
    for name, probability in (("none", None), ("sure", 0.9), ("unsure", 0.2)):
        engine, _, folder = make_engine(tmp_path / name, turn_scorer=Scorer(probability, "smart-turn file absent"))
        engine.open(folder, ears={**EARS, "eagerTurn": False})
        seen = turn_events(engine, SPEECH + pcm_bytes(3.6))
        ends[name] = next(at for at, e, _ in seen if e == "end") - len(SPEECH) // 32
    assert ends["sure"] < ends["none"] < ends["unsure"]
    assert 2900 <= ends["unsure"] <= 3200  # the 3.0 s silence fallback of the normal preset
    assert ends["sure"] <= 360


def test_a_missing_smart_turn_file_is_asked_once_and_never_blocks_the_turn(tmp_path):
    scorer = Scorer(None, "smart-turn file absent")
    engine, _, folder = make_engine(tmp_path, turn_scorer=scorer)
    engine.open(folder, ears=EARS)
    seen = turn_events(engine, SPEECH + pcm_bytes(0.4) + SPEECH + QUIET)
    assert len(scorer.calls) == 1 and [e for _, e, _ in seen][-1] == "end"
    assert "eager" not in [e for _, e, _ in seen]  # an eager end needs a real score


def test_a_failing_scorer_degrades_to_the_silence_rules(tmp_path):
    def broken(samples, rate):
        raise RuntimeError("onnx exploded")

    engine, _, folder = make_engine(tmp_path, turn_scorer=broken)
    engine.open(folder, ears=EARS)
    seen = turn_events(engine, SPEECH + QUIET)
    assert [e for _, e, _ in seen][-1] == "end"


@pytest.mark.parametrize("filler", ["matlab", "umm"])
def test_a_hesitation_word_holds_the_end_and_sends_no_eager(tmp_path, filler):
    engine, _, folder = make_engine(tmp_path)
    engine.open(folder, ears=EARS)
    engine._turn_scorer = Scorer(0.9)
    seen = turn_events(engine, SPEECH)
    engine._turn.last_text = f"mujhe batana tha {filler}"  # the recogniser's last words
    seen += turn_events(engine, pcm_bytes(1.0))
    assert [e for _, e, _ in seen if e not in ("partial", "start")] == []  # no eager, and no end within 1 s
    assert engine.endpoint()["requiredWaitMs"] >= 420 + 780 and engine.endpoint()["inTurn"] is True
    seen += turn_events(engine, pcm_bytes(1.0))
    assert [e for _, e, _ in seen if e == "end"] == ["end"]


def test_ears_without_an_eagerness_keep_the_default_endpointer(tmp_path):
    engine, _, folder = make_engine(tmp_path)
    engine.open(folder, ears={"vad": "energy"})
    assert engine._endpoint_config == EndpointConfig()
    engine.open(folder, ears={"vad": "energy", "eagerness": "patient"}, endpoint={"hard_cap_ms": 900})
    assert engine._endpoint_config.open_silence_ms == 800 and engine._endpoint_config.hard_cap_ms == 900
    engine.open(folder)  # a plain stream after a preset goes back to the constructor config
    assert engine._endpoint_config == EndpointConfig()


class Level:
    """A Silero stand-in: p is high for a loud frame, low for a quiet one (``SileroStream`` adds hysteresis)."""

    def __call__(self, frame):
        return 0.9 if float((frame * frame).mean()) ** 0.5 > 0.02 else 0.05

    def reset(self):
        pass


def with_silero(engine):
    import vad_onnx

    engine._vad = vad_onnx.SileroGate(vad_onnx.SileroStream(scorer=Level()), fallback=EnergyVad())
    engine.vad_engine = "silero"


def test_a_final_reading_goes_through_the_transcript_gate_with_the_voiced_time(tmp_path, monkeypatch):
    seen = {}

    def fake_gate(text, **kw):
        seen.update(kw, text=text)
        return "no-speech"

    monkeypatch.setattr(stream_ear, "stream_text_dropped", fake_gate)
    engine, _, folder = make_engine(tmp_path)
    engine.open(folder, locale="hi-IN", ears=EARS)
    with_silero(engine)
    drive(engine, SPEECH + QUIET)
    final = engine.finalize()
    assert final["text"] == "" and final["committed"] == "" and final["words"] == [] and final["dropped"] == "no-speech"
    assert seen["text"] == "Open Chrome, please" and seen["language"] == "hi"
    assert 700 <= seen["voiced_ms"] <= 1000 and 0.2 < seen["speech_fraction"] < 0.6


def test_too_little_voice_drops_the_final_and_enough_voice_keeps_it(tmp_path):
    engine, _, folder = make_engine(tmp_path)
    engine.open(folder, locale="en-US", ears=EARS)
    with_silero(engine)
    drive(engine, SPEECH + QUIET)
    engine._voiced_ms = 60  # under the 120 ms that is never a word
    assert engine.finalize()["dropped"] == "no-speech"
    again, _, folder2 = make_engine(tmp_path / "b")
    again.open(folder2, locale="en-US", ears=EARS)
    with_silero(again)
    drive(again, SPEECH + QUIET)
    final = again.finalize()
    assert final["text"] == "Open Chrome, please" and "dropped" not in final


def test_the_host_returns_the_last_turn_note_and_all_of_them(host, monkeypatch):
    monkeypatch.setattr(stream_ear, "_smart_turn_scorer", Scorer(0.9))
    host.handle({"op": "stream-open", "streamEngine": "auto", "locale": "en-US", "ears": EARS})
    data, notes, last = SPEECH + QUIET, [], None
    for i in range(0, len(data), 6400):
        reply = host.handle({"op": "stream-feed", "pcm": b64(data[i : i + 6400])})
        assert reply["ok"] and set(reply["endpoint"]) >= {"event", "inTurn"}  # the old fields are still there
        if "turn" in reply:
            assert reply["turn"] == reply["turns"][-1]
            notes += reply["turns"]
            last = reply["turn"]
    assert [n["event"] for n in notes if n["event"] != "partial"] == ["start", "eager", "end"]
    assert last is not None and last["event"] == "end"
    host.handle({"op": "stream-close"})
    host.handle({"op": "stream-open", "streamEngine": "auto", "locale": "en-US"})
    assert "turn" not in host.handle({"op": "stream-feed", "pcm": b64(SPEECH)})


# ---- the worker slot ----------------------------------------------------------------------------------------------


@pytest.fixture
def host(tmp_path, monkeypatch):
    """A StreamHost whose registered engine is the fake model living in <FRIDAY_ROOT>/models/<folder>."""
    h = StreamHost()
    h.model = install_fake_engine(monkeypatch, tmp_path, OPEN_CHROME)  # type: ignore[attr-defined]
    return h


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def test_stream_ops_are_off_by_default_and_load_nothing(host):
    for setting in ({}, {"streamEngine": "off"}, {"streamEngine": ""}, {"engine": "none"}):
        reply = host.handle({"op": "stream-open", "locale": "en-US", **setting})
        assert reply["ok"] is False and reply["reason"] == "stream-engine-off" and reply["fallback"] is True
    assert host.loaded_name() == [] and host.active is None and host.model.opened == []  # type: ignore[attr-defined]


def test_stream_open_without_the_pin_falls_back_and_says_why(tmp_path, monkeypatch):
    monkeypatch.setenv("FRIDAY_ROOT", str(tmp_path))
    reply = StreamHost().handle({"op": "stream-open", "streamEngine": "auto", "locale": "hi-IN", "streamId": "u1"})
    assert reply == {"ok": False, "op": "stream-open", "streamId": "u1", "reason": "pin-missing", "fallback": True}


def test_a_full_utterance_through_the_ops(host):
    opened = host.handle({"op": "stream-open", "streamEngine": "auto", "locale": "en-US", "streamId": "u1"})
    assert opened["ok"] and opened["streamId"] == "u1" and opened["engine"] == ENGINE_NAME
    assert opened["chunkMs"] == 160 and opened["providers"] == [CPU] and "replaced" not in opened
    assert host.loaded_name() == [ENGINE_NAME] and host.active == "u1"
    texts, kinds = [], []
    data = SPEECH + QUIET
    for i in range(0, len(data), 6400):
        reply = host.handle({"op": "stream-feed", "streamId": "u1", "pcm": b64(data[i : i + 6400])})
        assert reply["ok"] and reply["streamId"] == "u1" and reply["audioMs"] > 0
        texts.append(reply["text"])
        kinds += [e["event"] for e in reply["events"] if e["type"] == "endpoint"]
        assert set(reply["endpoint"]) >= {"event", "requiredWaitMs", "reason", "inTurn"}
    assert texts[-1] == "Open Chrome, please" and kinds[0] == "StartOfTurn" and kinds[-1] == "EndOfTurn"
    closed = host.handle({"op": "stream-close", "streamId": "u1"})
    assert closed["ok"] and closed["final"] is True and closed["text"] == "Open Chrome, please"
    assert closed["words"][0]["text"] == "Open" and closed["engine"] == ENGINE_NAME
    assert host.active is None and host.loaded_name() == [ENGINE_NAME]  # the model stays resident for the next turn
    assert host.handle({"op": "stream-feed", "pcm": b64(SPEECH)})["reason"] == "no-stream"


def test_the_stream_id_defaults_and_is_cleaned(host):
    assert host.handle({"op": "stream-open", "streamEngine": "auto"})["streamId"] == "default"
    assert host.handle({"op": "stream-open", "streamEngine": "auto", "streamId": "x" * 200})["streamId"] == "x" * 64
    assert host.handle({"op": "stream-open", "streamEngine": "auto", "streamId": 7})["streamId"] == "7"
    assert host.handle({"op": "stream-open", "streamEngine": "auto", "streamId": {"a": 1}})["streamId"] == "default"


def test_opening_a_second_stream_replaces_the_first_and_reuses_the_model(host):
    host.handle({"op": "stream-open", "streamEngine": "auto", "streamId": "a"})
    again = host.handle({"op": "stream-open", "streamEngine": "auto", "streamId": "b"})
    assert again["ok"] and again["replaced"] == "a" and host.active == "b"
    assert len(host.model.opened) == 3  # type: ignore[attr-defined]
    stale = host.handle({"op": "stream-feed", "streamId": "a", "pcm": b64(SPEECH)})
    assert stale["ok"] is False and stale["reason"] == "no-stream"
    assert host.handle({"op": "stream-feed", "streamId": "b", "pcm": b64(SPEECH)})["ok"] is True


def test_close_without_finalize_drops_the_audio(host):
    host.handle({"op": "stream-open", "streamEngine": "auto", "streamId": "a"})
    host.handle({"op": "stream-feed", "pcm": b64(SPEECH)})
    dropped = host.handle({"op": "stream-close", "streamId": "a", "finalize": False})
    assert dropped == {"ok": True, "op": "stream-close", "streamId": "a", "final": False}
    assert host.active is None
    host.handle({"op": "stream-open", "streamEngine": "auto", "streamId": "b"})
    assert host.handle({"op": "stream-close"})["audioMs"] == 0  # none of the dropped audio is left


@pytest.mark.parametrize(
    ("req", "reason"),
    [
        ({"op": "stream-feed"}, "bad-audio"),
        ({"op": "stream-feed", "pcm": 12}, "bad-audio"),
        ({"op": "stream-feed", "pcm": "!!not base64!!"}, "bad-audio"),
        ({"op": "stream-feed", "pcm": "A" * (stream_ear.MAX_FEED_BYTES * 2)}, "too-large"),
    ],
)
def test_bad_audio_is_refused_and_the_stream_stays_open(host, req, reason):
    host.handle({"op": "stream-open", "streamEngine": "auto", "streamId": "a"})
    reply = host.handle(req)
    assert reply["ok"] is False and reply["reason"] == reason and host.active == "a"


def test_an_empty_feed_is_fine(host):
    host.handle({"op": "stream-open", "streamEngine": "auto"})
    reply = host.handle({"op": "stream-feed", "pcm": ""})
    assert reply["ok"] and reply["events"] == [] and reply["text"] == ""


def test_an_unsupported_locale_is_a_fallback_not_an_error(host):
    reply = host.handle({"op": "stream-open", "streamEngine": "auto", "locale": "xx-YY"})
    assert reply["ok"] is False and reply["reason"] == "locale-unsupported" and reply["fallback"] is True


def test_a_model_that_fails_to_open_falls_back_and_leaves_no_stream(host):
    def refuse(*_args, **_kwargs):
        raise TransducerError("runtime", "the session would not start")

    host.handle({"op": "stream-open", "streamEngine": "auto", "streamId": "a"})
    assert host._engine is not None
    host._engine.close()
    host._engine.open = refuse  # type: ignore[method-assign]
    reply = host.handle({"op": "stream-open", "streamEngine": "auto", "streamId": "b"})
    assert reply["ok"] is False and reply["reason"] == "open-failed" and reply["fallback"] is True
    assert "would not start" in reply["error"] and host.active is None


def test_a_crash_inside_a_feed_closes_that_stream_only(host):
    host.handle({"op": "stream-open", "streamEngine": "auto"})
    assert host._engine is not None

    def boom(_pcm):
        raise TransducerError("runtime", "the run failed")

    host._engine.feed = boom  # type: ignore[method-assign]
    reply = host.handle({"op": "stream-feed", "pcm": b64(SPEECH)})
    assert reply["ok"] is False and reply["reason"] == "runtime" and host.active is None


def test_unload_drops_the_model_and_names_it(host):
    host.handle({"op": "stream-open", "streamEngine": "auto"})
    assert host.unload() == [ENGINE_NAME]
    assert host.loaded_name() == [] and host.active is None
    assert host.unload() == []
    assert host.handle({"op": "stream-feed", "pcm": b64(SPEECH)})["reason"] == "no-stream"
    reopened = host.handle({"op": "stream-open", "streamEngine": "auto"})
    assert reopened["ok"] and reopened["loadMs"] >= 0


def test_status_and_an_unknown_op(host):
    status = host.status()
    assert status["engines"] == [ENGINE_NAME] and status["loaded"] is False and status["active"] is None
    assert status["pinReady"] is True
    assert host.handle({"op": "stream-bogus"})["reason"] == "unknown-op"
