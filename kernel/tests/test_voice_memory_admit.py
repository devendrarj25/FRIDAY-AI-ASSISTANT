"""One admission check before every speech model load: under memory pressure the worker evicts in a fixed order
(stream, base, owner model, Hindi ear) and refuses a load that would still cross the critical line. Fake memory
readings and fake models only: no weights, no wall clock."""

from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "kernel"))

import hindi_ear  # noqa: E402
import stream_ear  # noqa: E402
import stt  # noqa: E402

TOTAL_MB = 16 * 1024  # the critical line of a 16 GB PC is 7%: about 1147 MB free
SIZES = {"stream": 900, "fast": 300, "whisper": 700, "hindi-ear": 400}


class _Engine:
    name = "stream-ear-nemotron"
    loaded = True

    def __init__(self) -> None:
        self.closed = 0

    def close(self) -> None:
        self.closed += 1
        self.loaded = False


@pytest.fixture
def machine(monkeypatch, tmp_path):
    """A worker whose free memory is ``empty`` MB minus what is resident, read again after every eviction."""
    monkeypatch.setenv("FRIDAY_ROOT", str(tmp_path))
    monkeypatch.setattr(stt, "_fallbacks", {})
    monkeypatch.setattr(stt, "_last_admit", None)
    monkeypatch.setattr(stt, "_model", None)
    monkeypatch.setattr(stt, "_model_name", None)
    monkeypatch.setattr(stt, "_fast", {"model": None, "name": "", "failed": False})
    monkeypatch.setattr(stt, "_now", lambda: 1000.0)
    monkeypatch.setattr(hindi_ear, "_model", None)
    monkeypatch.setattr(hindi_ear, "_model_dir", "")
    monkeypatch.setattr(hindi_ear, "_broken", {})
    host = stream_ear.StreamHost()
    monkeypatch.setattr(stream_ear, "HOST", host)
    state = {"empty": 4000.0, "reads": 0}

    def resident() -> dict[str, bool]:
        return {
            "stream": bool(stream_ear.HOST.loaded_name()),
            "fast": stt._fast["model"] is not None,
            "whisper": stt._model is not None,
            "hindi-ear": hindi_ear.loaded(),
        }

    def reader() -> tuple[float, float]:
        state["reads"] += 1
        used = sum(SIZES[kind] for kind, on in resident().items() if on)
        return state["empty"] - used, float(TOTAL_MB)

    monkeypatch.setattr(stt, "read_memory_mb", reader)

    def load(*kinds: str) -> None:
        for kind in kinds:
            if kind == "stream":
                host._engine = _Engine()  # type: ignore[assignment]
                host._spec = stream_ear.engine_spec(stream_ear.ENGINE_NAME)
            elif kind == "fast":
                stt._fast.update(model=object(), name="base")
            elif kind == "whisper":
                monkeypatch.setattr(stt, "_model", object())
                monkeypatch.setattr(stt, "_model_name", "small")
            elif kind == "hindi-ear":
                monkeypatch.setattr(hindi_ear, "_model", object())
                monkeypatch.setattr(hindi_ear, "_model_dir", "ear")

    state["load"] = load  # type: ignore[assignment]
    state["resident"] = resident  # type: ignore[assignment]
    return state


def _by_kind() -> dict[str, int]:
    return stt.cache_status()["fallbacks"]["byKind"]


def test_with_room_a_load_is_admitted_and_nothing_is_dropped(machine):
    machine["load"]("stream", "fast", "whisper")
    machine["empty"] = 9000.0
    assert stt.admit("hindi-ear", 400) is True
    assert all(on for kind, on in machine["resident"]().items() if kind != "hindi-ear")
    assert _by_kind() == {}
    assert stt.cache_status()["admit"]["verdict"] == "load"


def test_under_critical_the_stream_goes_first_and_eviction_stops_once_the_load_fits(machine):
    machine["load"]("stream", "fast", "whisper")
    machine["empty"] = 2700.0  # 800 MB free: critical; dropping the stream gives 1700, enough for 400 more
    assert stt.memory_pressure()["level"] == "critical"
    assert stt.admit("hindi-ear", 400) is True
    assert machine["resident"]() == {"stream": False, "fast": True, "whisper": True, "hindi-ear": False}
    assert _by_kind() == {"evicted-stream": 1}
    assert stt.cache_status()["admit"]["evicted"] == ["stream"]


def test_the_eviction_order_is_stream_base_owner_model_then_hindi_ear(machine):
    machine["load"]("stream", "fast", "whisper", "hindi-ear")
    machine["empty"] = 2750.0  # 400 MB free: the punctuation model (the Hindi ear's slot) takes the three others
    assert stt.admit("punct", 1000) is True
    assert stt.cache_status()["admit"]["evicted"] == ["stream", "fast", "whisper"]
    assert machine["resident"]() == {"stream": False, "fast": False, "whisper": False, "hindi-ear": True}
    machine["load"]("fast", "whisper")
    machine["empty"] = 2200.0  # 800 MB free: a stream engine takes the base, the owner model, then the Hindi ear
    assert stt.admit("stream", 900) is True
    assert stt.cache_status()["admit"]["evicted"] == ["fast", "whisper", "hindi-ear"]
    assert not any(machine["resident"]().values())
    assert _by_kind() == {"evicted-stream": 1, "evicted-fast": 2, "evicted-whisper": 2, "evicted-hindi-ear": 1}


def test_a_load_that_cannot_fit_even_after_every_eviction_is_refused_and_drops_nothing(machine):
    machine["load"]("fast", "whisper")
    machine["empty"] = 2000.0  # 1000 MB free; dropping both gives 2000, and 2000 - 900 is under the line
    assert stt.admit("stream", 900) is False
    assert machine["resident"]()["fast"] and machine["resident"]()["whisper"]
    assert _by_kind() == {"admit-refused-stream": 1}
    assert stt.cache_status()["admit"]["verdict"] == "refused"


def test_a_load_never_evicts_its_own_slot(machine):
    machine["load"]("hindi-ear")
    machine["empty"] = 1500.0  # 1100 MB free, only the Hindi ear resident
    assert stt.admit("hindi-ear", 400) is False
    assert hindi_ear.loaded() and _by_kind() == {"admit-refused-hindi-ear": 1}


def test_a_live_stream_is_never_dropped_under_the_owner(machine):
    machine["load"]("stream")
    stream_ear.HOST.active = "s1"
    machine["empty"] = 2000.0
    assert stt.admit("hindi-ear", 400) is False
    assert stream_ear.HOST.loaded_name() and stream_ear.HOST.active == "s1"


def test_an_unreadable_machine_admits_every_load(machine, monkeypatch):
    monkeypatch.setattr(stt, "read_memory_mb", lambda: None)
    assert stt.admit("stream", 5000) is True and _by_kind() == {}


def test_the_owner_model_is_required_it_evicts_the_others_but_is_never_refused(machine, monkeypatch):
    monkeypatch.setattr(stt, "_import_whisper", lambda: object)
    monkeypatch.setattr(
        stt,
        "model_load_kwargs",
        lambda name, path=None: {"target": name, "device": "cpu", "compute_type": "int8", "reason": "t"},
    )
    monkeypatch.setattr(stt, "open_whisper", lambda _cls, wanted, spec: (object(), "cpu"))
    machine["load"]("stream", "fast", "hindi-ear")
    machine["empty"] = 1500.0  # nothing makes room for the small model: every other one goes and it loads anyway
    stt.get_model("small")
    assert stt._model_name == "small"
    assert stt.cache_status()["admit"]["evicted"] == ["stream", "fast", "hindi-ear"]
    assert stt.cache_status()["admit"]["verdict"] == "over-line"


def test_the_base_model_asks_for_admission_and_a_refusal_leaves_it_closed(machine, monkeypatch, tmp_path):
    folder = tmp_path / "cache" / "stt" / "base"
    folder.mkdir(parents=True)
    for name in ("config.json", "model.bin"):
        (folder / name).write_bytes(b"x")
    monkeypatch.setattr(stt, "_import_whisper", lambda: object)
    monkeypatch.setattr(stt, "memory_pressure", lambda: {"level": "ok", "availableMb": 9000, "totalMb": TOTAL_MB})
    asked: list[tuple[str, float]] = []
    monkeypatch.setattr(stt, "admit", lambda kind, mb, required=False: asked.append((kind, mb)) or False)
    assert stt.fast_english_model() is None
    assert asked == [("fast", stt.load_estimate_mb("base"))]
    assert stt._fast["failed"] is False  # refused, not broken: it is tried again when memory returns


def test_the_hindi_ear_asks_for_admission_and_a_refusal_is_not_a_broken_folder(machine, monkeypatch, tmp_path):
    _stage(tmp_path)
    loads = _fake_onnx_asr(monkeypatch)
    asked: list[str] = []
    verdict = {"ok": False}
    monkeypatch.setattr(hindi_ear, "admit_hook", lambda kind, mb: asked.append(kind) or verdict["ok"])
    assert hindi_ear.transcribe([0.01] * 16000) is None and loads == []
    assert hindi_ear.last_skip() == "low-memory" and hindi_ear.ready() and hindi_ear.error() is None
    verdict["ok"] = True
    assert hindi_ear.transcribe([0.01] * 16000) == "आज मौसम अच्छा है" and len(loads) == 1
    assert hindi_ear.last_skip() == "" and asked == ["hindi-ear", "hindi-ear"]


def test_the_punctuation_model_is_skipped_when_it_is_refused(machine, monkeypatch, tmp_path):
    _stage(tmp_path)
    _fake_onnx_asr(monkeypatch)
    import hindi_punct

    monkeypatch.setattr(hindi_punct, "ready", lambda: True)
    monkeypatch.setattr(hindi_punct, "_runtime", None)
    monkeypatch.setattr(hindi_punct, "apply", lambda text: pytest.fail("the punctuation model must not open"))
    monkeypatch.setattr(hindi_ear, "admit_hook", lambda kind, mb: kind != "punct")
    assert hindi_ear.transcribe([0.01] * 16000) == "आज मौसम अच्छा है"


def test_the_stream_engine_asks_for_admission_and_a_refusal_falls_back(machine, monkeypatch, tmp_path):
    opened: list[str] = []

    class Fake:
        name = "fake-stream"
        loaded = False

        def open(self, model_dir, **options):
            opened.append(str(model_dir))
            self.loaded = True
            return {"engine": self.name}

        def reset(self):
            pass

        def close(self):
            self.loaded = False

    spec = stream_ear.EngineSpec(name="fake-stream", folder="fake", files={}, factory=Fake, load_mb=900.0)  # type: ignore[arg-type]
    choice = stream_ear.TierChoice(engine="fake-stream", model_dir=tmp_path, reason="ok", tier=None, rtf=None)
    monkeypatch.setattr(stream_ear, "choose_tier", lambda *a, **k: choice)
    monkeypatch.setattr(stream_ear, "engine_spec", lambda name: spec)
    asked: list[tuple[str, float]] = []
    verdict = {"ok": False}
    monkeypatch.setattr(stream_ear, "admit_hook", lambda kind, mb: asked.append((kind, mb)) or verdict["ok"])
    reply = stream_ear.HOST.handle({"op": "stream-open", "streamEngine": "fake-stream"})
    assert reply["ok"] is False and reply["reason"] == "low-memory" and reply["fallback"] is True and opened == []
    warm = stream_ear.HOST.warm({"streamEngine": "fake-stream"})
    assert warm["ok"] is False and warm["reason"] == "low-memory" and opened == []
    verdict["ok"] = True
    assert stream_ear.HOST.handle({"op": "stream-open", "streamEngine": "fake-stream"})["ok"] is True
    assert asked == [("stream", 900.0)] * 3
    stream_ear.HOST.handle({"op": "stream-close", "finalize": False})
    stream_ear.HOST.handle({"op": "stream-open", "streamEngine": "fake-stream"})
    assert len(asked) == 3  # a resident engine is reused without asking again


def test_an_engine_that_reads_resident_models_does_not_ask(machine, monkeypatch, tmp_path):
    spec = stream_ear.EngineSpec(name="la2", folder="x", files={}, factory=lambda: None)  # type: ignore[arg-type]
    assert spec.load_mb == 0.0
    nemotron = stream_ear.engine_spec(stream_ear.ENGINE_NAME)
    assert nemotron is not None and nemotron.load_mb > 0


def test_the_speaker_model_is_left_off_when_it_is_refused(monkeypatch):
    monkeypatch.setattr(stream_ear, "admit_hook", lambda kind, mb: kind != "speaker")
    engine = stream_ear.TransducerEngine()
    engine._open_scene({"scene": "score", "otherVoice": "score"})
    assert engine._scene is not None and engine._scene.speaker is None and engine._scene.score_speaker is False
    engine._open_scene({"otherVoice": "hold"})
    assert engine._scene is None and engine._hold_other is False


def test_the_worker_wires_its_admission_into_the_ears():
    assert hindi_ear.admit_hook is stt.admit and stream_ear.admit_hook is stt.admit


# ---- a Hindi turn after the Hindi ear was evicted ------------------------------------------------------------------


def _stage(root: Path) -> Path:
    folder = root / "models" / hindi_ear.MODEL_DIR
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "vocab.txt").write_text("x", encoding="utf-8")
    (folder / "config.json").write_text("{}", encoding="utf-8")
    with (folder / hindi_ear.MODEL_FILE).open("wb") as handle:
        handle.truncate(hindi_ear.MIN_MODEL_BYTES + 1)  # sparse: no real bytes
    return folder


def _fake_onnx_asr(monkeypatch, text="आज मौसम अच्छा है"):
    loads: list[str] = []

    class Model:
        def recognize(self, audio, sample_rate=16000):
            return text

    def load_model(kind, path=None, quantization=None):
        loads.append(str(path))
        return Model()

    monkeypatch.setitem(sys.modules, "onnx_asr", types.SimpleNamespace(load_model=load_model))
    return loads


def _whisper(monkeypatch) -> list[object]:
    seen: list[object] = []

    def consume(model, payload, kwargs, on_partial):
        seen.append(kwargs.get("language"))
        return {
            "text": "मुझे चाय चाहिए",
            "language": "hi",
            "languageProbability": 0.99,
            "avgLogprob": -0.2,
            "noSpeechProb": 0.01,
            "noSpeechNote": "",
            "policyCode": "",
            "vadMs": 1000,
            "durationMs": 1000,
        }

    monkeypatch.setattr(stt.voice_runtime, "score_turn", lambda *a, **k: {})
    monkeypatch.setattr(stt, "get_model", lambda *a, **k: object())
    monkeypatch.setattr(stt, "fast_english_model", lambda: None)
    monkeypatch.setattr(stt, "_consume_whisper", consume)
    return seen


def _evict_the_ear(machine, monkeypatch, tmp_path) -> list[str]:
    _stage(tmp_path)
    loads = _fake_onnx_asr(monkeypatch)
    machine["empty"] = 9000.0
    assert hindi_ear.transcribe([0.01] * 16000) and hindi_ear.loaded()
    machine["empty"] = 2400.0  # critical: the Hindi ear is dropped for a big load
    assert stt.admit("stream", 900) is True and not hindi_ear.loaded()
    assert _by_kind()["evicted-hindi-ear"] == 1
    return loads


def test_the_next_hindi_turn_after_an_eviction_reloads_the_ear(machine, monkeypatch, tmp_path):
    loads = _evict_the_ear(machine, monkeypatch, tmp_path)
    machine["empty"] = 9000.0
    _whisper(monkeypatch)
    result = stt._transcribe_prepared("x.wav", [0.01] * 16000, "base", "hi", "", None, "hi")
    assert result["engine"] == "hindi-ear" and result["language"] == "hi" and len(loads) == 2


@pytest.mark.parametrize("mode", ["hi", "auto"])
def test_a_hindi_turn_the_ear_cannot_reload_for_falls_back_with_a_status_line_never_english(
    machine, monkeypatch, tmp_path, mode
):
    loads = _evict_the_ear(machine, monkeypatch, tmp_path)
    machine["empty"] = 1500.0  # nothing left to evict and no room for the ear
    seen = _whisper(monkeypatch)
    stt.note_turn_language("what time is it", "en", 0.97)  # an English turn before: auto would lock English
    result = stt._transcribe_prepared("x.wav", [0.01] * 16000, "base", mode, "", None, mode)
    assert len(loads) == 1, "the refused ear must not open"
    assert result["engine"] == "faster-whisper" and seen and "en" not in seen
    assert "Hindi ear" in result["languageNote"] and "memory" in result["languageNote"]
    assert _by_kind()["admit-refused-hindi-ear"] >= 1
