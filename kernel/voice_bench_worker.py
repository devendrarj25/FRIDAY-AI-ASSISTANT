"""The measuring end of ``scripts/voice-bench.cjs`` for CTranslate2 speech models (faster-whisper).

One JSON object per line on stdin, one JSON answer per line on stdout. It opens one model folder and, for each audio
file, reports the text, the milliseconds to the first segment ("first partial": Whisper is not a streaming model, so
this is the first finished segment, not the first word) and to the final text, and the peak resident memory of this
process. It writes nothing, downloads nothing and keeps no audio. A missing library or folder is an answer, not a crash.

    {"op": "probe"}
    {"op": "load", "dir": "<model folder>", "device": "cpu", "compute": "int8"}
    {"op": "transcribe", "audio": "<file>", "language": "hi"}
    {"op": "shutdown"}
"""

from __future__ import annotations

import json
import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

NEEDED = ("config.json", "model.bin")


def _psutil_peak_mb() -> float | None:
    try:
        import psutil  # type: ignore[import-untyped]  # noqa: PLC0415

        info = psutil.Process().memory_info()
        return round((getattr(info, "peak_wset", None) or info.rss) / (1024 * 1024), 1)
    except Exception:  # noqa: BLE001 — psutil is optional; the next source answers
        return None


def _resource_peak_mb() -> float | None:
    try:
        import resource  # noqa: PLC0415

        return round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1)
    except Exception:  # noqa: BLE001 — no `resource` on Windows: unknown is the honest answer
        return None


def peak_rss_mb() -> float | None:
    """Peak resident memory of this process in MB, or None when this system cannot say."""
    found = _psutil_peak_mb()
    return found if found is not None else _resource_peak_mb()


class Worker:
    def __init__(self, loader: Any = None, clock: Callable[[], float] = time.perf_counter) -> None:
        self._loader = loader
        self._clock = clock
        self._model: Any = None

    def _whisper(self) -> Any:
        if self._loader is not None:
            return self._loader
        from faster_whisper import WhisperModel  # type: ignore[import-untyped]  # noqa: PLC0415

        return WhisperModel

    def probe(self) -> dict:
        try:
            self._whisper()
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "reason": "runtime-missing", "detail": f"{type(exc).__name__}: {str(exc)[:160]}"}
        return {"ok": True}

    def load(self, req: dict) -> dict:
        folder = Path(str(req.get("dir") or ""))
        missing = [name for name in NEEDED if not (folder / name).is_file()]
        if missing:
            return {"ok": False, "reason": "files-missing", "detail": ", ".join(missing)}
        if not (folder / "tokenizer.json").is_file():
            # faster-whisper would fetch a tokenizer from the network; a benchmark never does.
            return {"ok": False, "reason": "tokenizer-missing", "detail": "tokenizer.json is not in the folder"}
        started = self._clock()
        try:
            self._model = self._whisper()(
                str(folder), device=str(req.get("device") or "cpu"), compute_type=str(req.get("compute") or "int8")
            )
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "reason": "cannot-load", "detail": f"{type(exc).__name__}: {str(exc)[:160]}"}
        return {"ok": True, "loadMs": round((self._clock() - started) * 1000, 1), "rssMb": peak_rss_mb()}

    def transcribe(self, req: dict) -> dict:
        if self._model is None:
            return {"ok": False, "reason": "not-loaded", "detail": "send load first"}
        audio = str(req.get("audio") or "")
        if not Path(audio).is_file():
            return {"ok": False, "reason": "audio-missing", "detail": audio[-80:]}
        started = self._clock()
        first_ms: float | None = None
        parts: list[str] = []
        try:
            segments, _info = self._model.transcribe(
                audio, language=str(req.get("language") or "") or None, beam_size=1, vad_filter=False
            )
            for segment in segments:
                if first_ms is None:
                    first_ms = round((self._clock() - started) * 1000, 1)
                parts.append(str(segment.text))
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "reason": "transcribe-failed", "detail": f"{type(exc).__name__}: {str(exc)[:160]}"}
        final_ms = round((self._clock() - started) * 1000, 1)
        return {
            "ok": True,
            "text": "".join(parts).strip(),
            "firstPartialMs": first_ms if first_ms is not None else final_ms,
            "finalMs": final_ms,
            "rssMb": peak_rss_mb(),
        }

    def handle(self, req: dict) -> tuple[dict, bool]:
        op = str(req.get("op") or "")
        if op == "shutdown":
            return {"ok": True}, True
        if op == "probe":
            return self.probe(), False
        if op == "load":
            return self.load(req), False
        if op == "transcribe":
            return self.transcribe(req), False
        return {"ok": False, "reason": "unknown-op", "detail": op[:40]}, False


def serve(worker: Worker, stdin: Any = None, stdout: Any = None) -> int:
    source = stdin if stdin is not None else sys.stdin
    sink = stdout if stdout is not None else sys.stdout
    for line in source:
        text = line.strip()
        if not text:
            continue
        try:
            req = json.loads(text)
            if not isinstance(req, dict):
                raise ValueError("a request is an object")
            answer, stop = worker.handle(req)
        except ValueError as exc:
            answer, stop = {"ok": False, "reason": "bad-request", "detail": str(exc)[:120]}, False
        sink.write(json.dumps(answer) + "\n")
        sink.flush()
        if stop:
            break
    return 0


if __name__ == "__main__":
    raise SystemExit(serve(Worker()))
