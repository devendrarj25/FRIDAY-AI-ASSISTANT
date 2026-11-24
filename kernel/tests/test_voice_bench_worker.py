"""The benchmark worker: a fake faster-whisper stands in, so no model, audio or network is needed."""

from __future__ import annotations

import io
import json
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "kernel"))

import voice_bench_worker as bench  # noqa: E402


class FakeModel:
    def __init__(self, folder: str, device: str, compute_type: str) -> None:
        self.args = (folder, device, compute_type)

    def transcribe(self, audio: str, language: str | None, beam_size: int, vad_filter: bool):
        assert beam_size == 1 and vad_filter is False
        if audio.endswith("boom.wav"):
            raise RuntimeError("decoder failed")
        seg = types.SimpleNamespace
        return iter([seg(text=" नमस्ते"), seg(text=" दुनिया ")]), seg(language=language)


def _folder(tmp_path: Path, tokenizer: bool = True) -> Path:
    for name in ("config.json", "model.bin") + (("tokenizer.json",) if tokenizer else ()):
        (tmp_path / name).write_bytes(b"x")
    return tmp_path


def _ticks(step: float):
    state = {"t": 0.0}

    def clock() -> float:
        state["t"] += step
        return state["t"]

    return clock


def test_loads_a_whole_folder_and_reports_first_and_final_time(tmp_path: Path) -> None:
    worker = bench.Worker(loader=FakeModel, clock=_ticks(0.01))
    loaded = worker.load({"dir": str(_folder(tmp_path)), "device": "cpu", "compute": "int8"})
    assert loaded["ok"] is True and loaded["loadMs"] == 10.0
    audio = tmp_path / "a.wav"
    audio.write_bytes(b"x")
    done = worker.transcribe({"audio": str(audio), "language": "hi"})
    assert done["ok"] is True
    assert done["text"] == "नमस्ते दुनिया"
    assert done["firstPartialMs"] < done["finalMs"]


def test_a_folder_without_a_tokenizer_is_refused_so_nothing_reaches_the_network(tmp_path: Path) -> None:
    worker = bench.Worker(loader=FakeModel)
    result = worker.load({"dir": str(_folder(tmp_path, tokenizer=False))})
    assert (result["ok"], result["reason"]) == (False, "tokenizer-missing")
    assert worker.load({"dir": str(tmp_path / "nope")})["reason"] == "files-missing"


def test_every_failure_is_an_answer(tmp_path: Path) -> None:
    worker = bench.Worker(loader=FakeModel)
    assert worker.transcribe({"audio": "x.wav"})["reason"] == "not-loaded"
    worker.load({"dir": str(_folder(tmp_path))})
    assert worker.transcribe({"audio": str(tmp_path / "missing.wav")})["reason"] == "audio-missing"
    boom = tmp_path / "boom.wav"
    boom.write_bytes(b"x")
    assert worker.transcribe({"audio": str(boom)})["reason"] == "transcribe-failed"

    def broken(*args: object, **kwargs: object) -> None:
        raise OSError("out of memory")

    assert bench.Worker(loader=broken).load({"dir": str(_folder(tmp_path))})["reason"] == "cannot-load"


def test_probe_names_a_missing_library(monkeypatch) -> None:
    monkeypatch.setitem(sys.modules, "faster_whisper", None)
    assert bench.Worker().probe()["reason"] == "runtime-missing"
    assert bench.Worker(loader=FakeModel).probe() == {"ok": True}


def test_serve_reads_lines_and_stops_on_shutdown() -> None:
    lines = "\n".join(
        [
            json.dumps({"op": "probe"}),
            "not json",
            json.dumps([1]),
            json.dumps({"op": "what"}),
            json.dumps({"op": "shutdown"}),
            json.dumps({"op": "probe"}),
        ]
    )
    out = io.StringIO()
    assert bench.serve(bench.Worker(loader=FakeModel), io.StringIO(lines), out) == 0
    answers = [json.loads(line) for line in out.getvalue().splitlines()]
    assert [a.get("reason") for a in answers] == [None, "bad-request", "bad-request", "unknown-op", None]
    assert answers[0]["ok"] is True and answers[4]["ok"] is True
