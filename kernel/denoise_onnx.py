"""FRIDAY Ears: streaming ONNX speech denoisers (DPDFNet 2 and GTCRN) over the pinned files, no torch.

Both models work on one short-time spectrum frame at a time and carry their recurrent state between frames, so
the wrapper cuts the audio into overlapping frames, runs the graph, and overlap-adds the answers:

* ``dpdfnet2``: 320-sample Vorbis window, 160-sample hop (10 ms), 161 bins; the graph has two inputs (``spec``
  and a flat ``state``) and the first state is not zeros (the graph's metadata carries the initial values);
* ``gtcrn``: 512-sample sqrt-Hann window, 256-sample hop (16 ms), 257 bins; the graph carries three cache tensors
  whose shapes are read from the graph and start at zero.

The output lags the input by ``window - hop`` samples (10 ms and 16 ms); ``flush`` drains them, so a clip comes out
with the length it went in. Nothing here raises to the caller: a missing file, a missing runtime, a graph that does
not open, a graph that throws, or a non-finite answer turns the denoiser into a passthrough from the first
unprocessed sample on (no gap, no repeat) and ``status()`` says why. The wrapper is not connected to the live
stream; ``ears.denoise`` stays a stored value until a later change reads it.
"""

from __future__ import annotations

import os
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

import friday_runtime
import numpy as np

RATE = 16000
DENOISE_ENGINES = ("dpdfnet2", "gtcrn")


class DenoiseUnavailable(RuntimeError):
    """The model file or its runtime is missing or wrong; the caller keeps the audio as it is."""


@dataclass(frozen=True)
class EngineSpec:
    """One pinned denoiser. ``bytes`` is the pinned size (electron/voice-pins.cjs); a partial file is never opened."""

    name: str
    catalog_id: str
    file: str
    bytes: int
    family: str
    win: int
    hop: int
    delay: int = 0  # samples the graph itself holds back (measured against the publisher's own clips, 2026-11-26)

    @property
    def bins(self) -> int:
        return self.win // 2 + 1

    @property
    def latency_ms(self) -> float:
        """Live latency: the frame still filling (window minus hop) plus the graph's own delay."""
        return (self.win - self.hop + self.delay) * 1000 / RATE


ENGINES: dict[str, EngineSpec] = {
    "dpdfnet2": EngineSpec("dpdfnet2", "denoise-dpdfnet", "onnx/dpdfnet2.onnx", 10_178_747, "dpdfnet", 320, 160, 640),
    "gtcrn": EngineSpec("gtcrn", "denoise-gtcrn", "gtcrn_simple.onnx", 535_638, "gtcrn", 512, 256),
}


def models_root() -> Path:
    root = os.environ.get("FRIDAY_ROOT", "").strip()
    return (Path(root) if root else Path.home() / ".friday") / "models"


def find_model(spec: EngineSpec, root: Path | None = None) -> Path | None:
    """``<FRIDAY_ROOT>/models/<catalog id>/<file>`` when it is there with its exact pinned size, else None."""
    path = (root or models_root()) / spec.catalog_id / spec.file
    try:
        return path if path.stat().st_size == spec.bytes else None
    except OSError:
        return None


def window_for(spec: EngineSpec) -> np.ndarray:
    """The window used to analyse and again to synthesise; at 50 percent overlap the product adds up to 1."""
    n = np.arange(spec.win, dtype=np.float64)
    if spec.family == "gtcrn":
        return np.sqrt(0.5 - 0.5 * np.cos(2.0 * np.pi * n / spec.win)).astype(np.float32)  # sqrt of a periodic Hann
    s = np.sin(0.5 * np.pi * (n + 0.5) / (spec.win / 2.0))
    return np.sin(0.5 * np.pi * s * s).astype(np.float32)  # Vorbis


# ---- the graphs (one frame of spectrum in, one out, state inside) ------------------------------------------------


class Graph(Protocol):
    def __call__(self, ri: Any) -> Any: ...

    def reset(self) -> None: ...


_SESSIONS: dict[str, Any] = {}
_SESSIONS_LOCK = threading.Lock()


def _session(path: Path) -> Any:
    """One shared onnxruntime session per file (thread-safe to run; every stream keeps its own state)."""
    key = str(path)
    with _SESSIONS_LOCK:
        cached = _SESSIONS.get(key)
        if cached is not None:
            return cached
        try:
            import onnxruntime  # type: ignore  # noqa: F401 — only the check: the door opens the file
        except ImportError as exc:
            raise DenoiseUnavailable("onnxruntime is not installed") from exc
        try:
            made = friday_runtime.open_session(path, "denoise")
        except Exception as exc:  # noqa: BLE001
            raise DenoiseUnavailable(f"the model did not open: {type(exc).__name__}: {exc}"[:300]) from exc
        _SESSIONS[key] = made
        return made


def forget_sessions() -> None:
    with _SESSIONS_LOCK:
        _SESSIONS.clear()


def _shape_ok(declared: Any, want: list[int]) -> bool:
    return list(declared) == want


class DpdfGraph:
    """``spec [1,1,bins,2]`` and a flat ``state`` in; ``spec_e`` and ``state_out`` out. The first state is metadata."""

    def __init__(self, session: Any, spec: EngineSpec) -> None:
        ins, outs = session.get_inputs(), session.get_outputs()
        if len(ins) != 2 or len(outs) != 2 or not _shape_ok(ins[0].shape, [1, 1, spec.bins, 2]):
            raise DenoiseUnavailable("the graph is not the DPDFNet streaming signature (spec, state)")
        meta = session.get_modelmeta().custom_metadata_map
        try:
            size = int(meta["state_size"])
            erb_n = int(meta["erb_norm_state_size"])
            spec_n = int(meta["spec_norm_state_size"])
            erb = np.array([float(x) for x in meta["erb_norm_init"].split(",")], dtype=np.float32)
            norm = np.array([float(x) for x in meta["spec_norm_init"].split(",")], dtype=np.float32)
        except (KeyError, ValueError) as exc:
            raise DenoiseUnavailable(f"the graph lacks its state metadata ({type(exc).__name__})") from exc
        if erb.size != erb_n or norm.size != spec_n or erb_n + spec_n > size or ins[1].shape != [size]:
            raise DenoiseUnavailable("the state metadata does not match the graph")
        self._session = session
        self._names = (ins[0].name, ins[1].name, outs[0].name, outs[1].name)
        init = np.zeros(size, dtype=np.float32)
        init[:erb_n] = erb
        init[erb_n : erb_n + spec_n] = norm
        self._init = init
        self.state = init.copy()

    def reset(self) -> None:
        self.state = self._init.copy()

    def __call__(self, ri: Any) -> Any:
        spec_in, state_in, spec_out, state_out = self._names
        out, state = self._session.run(
            [spec_out, state_out],
            {spec_in: ri.reshape(1, 1, -1, 2).astype(np.float32, copy=False), state_in: self.state},
        )
        self.state = np.asarray(state, dtype=np.float32)
        return np.asarray(out, dtype=np.float32).reshape(-1, 2)


class GtcrnGraph:
    """``mix [1,bins,1,2]`` plus three caches in; ``enh`` plus the three caches out. The caches start at zero."""

    CACHES = ("conv_cache", "tra_cache", "inter_cache")

    def __init__(self, session: Any, spec: EngineSpec) -> None:
        ins = {i.name: i for i in session.get_inputs()}
        outs = [o.name for o in session.get_outputs()]
        if "mix" not in ins or any(c not in ins for c in self.CACHES) or len(outs) != 4:
            raise DenoiseUnavailable("the graph is not the GTCRN streaming signature (mix and three caches)")
        if not _shape_ok(ins["mix"].shape, [1, spec.bins, 1, 2]):
            raise DenoiseUnavailable("the GTCRN graph does not read 257 bins")
        shapes: dict[str, tuple[int, ...]] = {}
        for name in self.CACHES:
            dims = ins[name].shape
            if not all(isinstance(d, int) and d > 0 for d in dims):
                raise DenoiseUnavailable(f"the cache {name} has no fixed shape")
            shapes[name] = tuple(int(d) for d in dims)
        self._session = session
        self._shapes = shapes
        self._outs = outs
        self.caches: dict[str, Any] = {}
        self.reset()

    def reset(self) -> None:
        self.caches = {n: np.zeros(s, dtype=np.float32) for n, s in self._shapes.items()}

    def __call__(self, ri: Any) -> Any:
        feed = {"mix": ri.reshape(1, -1, 1, 2).astype(np.float32, copy=False), **self.caches}
        out = self._session.run(self._outs, feed)
        self.caches = {n: np.asarray(v, dtype=np.float32) for n, v in zip(self.CACHES, out[1:], strict=True)}
        return np.asarray(out[0], dtype=np.float32).reshape(-1, 2)


def open_graph(spec: EngineSpec, path: Path) -> Graph:
    session = _session(path)
    return DpdfGraph(session, spec) if spec.family == "dpdfnet" else GtcrnGraph(session, spec)


# ---- the frame loop (analysis, graph, synthesis, overlap-add) ----------------------------------------------------


class FrameLoop:
    """Frames of ``win`` samples every ``hop``; the output is committed ``hop`` samples at a time."""

    def __init__(self, graph: Graph, spec: EngineSpec) -> None:
        self.graph, self.spec = graph, spec
        self.window = window_for(spec)
        self.reset()

    def reset(self) -> None:
        self.graph.reset()
        # The raw samples not yet committed to the output (fewer than one window).
        self.pending = np.zeros(0, dtype=np.float32)
        self.overlap = np.zeros(self.spec.win, dtype=np.float32)
        self.fed = 0
        self.emitted = 0
        self.frames = 0
        self.salvage = np.zeros(0, dtype=np.float32)

    def process(self, x: Any) -> Any:
        """Enhanced samples for the whole frames now complete. If the graph fails mid-call, the frames already committed
        stay in ``salvage`` (and ``pending`` still holds the raw samples after them), so nothing is lost or repeated."""
        spec = self.spec
        self.pending = np.concatenate([self.pending, x])
        self.fed += int(x.size)
        out: list[Any] = []
        try:
            while self.pending.size >= spec.win:
                spectrum = np.fft.rfft(self.pending[: spec.win] * self.window)
                ri = np.stack([spectrum.real, spectrum.imag], axis=-1).astype(np.float32)
                enhanced = np.asarray(self.graph(ri), dtype=np.float32)
                if enhanced.shape != (spec.bins, 2) or not np.isfinite(enhanced).all():
                    raise ValueError("the graph answered with a wrong or non-finite spectrum")
                frame = np.fft.irfft(enhanced[:, 0] + 1j * enhanced[:, 1], n=spec.win) * self.window
                self.overlap += frame.astype(np.float32)
                out.append(self.overlap[: spec.hop].copy())
                self.overlap[: spec.win - spec.hop] = self.overlap[spec.hop :]
                self.overlap[spec.win - spec.hop :] = 0.0
                self.pending = self.pending[spec.hop :]
                self.frames += 1
                self.emitted += spec.hop
        except Exception:
            self.salvage = np.concatenate(out) if out else np.zeros(0, dtype=np.float32)
            raise
        return np.concatenate(out) if out else np.zeros(0, dtype=np.float32)

    def flush(self) -> Any:
        """Zeros push the last samples through, then the answer is cut to exactly the samples that went in."""
        owed = self.fed - self.emitted
        if owed <= 0:
            return np.zeros(0, dtype=np.float32)
        spec = self.spec
        frames = -(-self.fed // spec.hop)  # frames needed so that frames * hop covers every sample fed
        pad = max(0, (frames - 1) * spec.hop + spec.win - self.fed)
        tail = self.process_padded(np.zeros(pad, dtype=np.float32))
        return tail[:owed]

    def process_padded(self, zeros: Any) -> Any:
        fed = self.fed
        try:
            return self.process(zeros)
        finally:
            self.fed = fed  # the padding is not audio the caller sent


# ---- the safe wrapper --------------------------------------------------------------------------------------------


def _as_float(pcm: Any) -> Any:
    """Mono float32 samples from int16 bytes, an int array or a float array; NaN and infinity become 0, else raises."""
    if isinstance(pcm, (bytes, bytearray, memoryview)):
        return np.frombuffer(bytes(pcm), dtype="<i2").astype(np.float32) / 32768.0
    arr = np.asarray(pcm)
    if arr.dtype.kind in "iu":
        return arr.astype(np.float32).reshape(-1) / 32768.0
    if arr.dtype.kind != "f":
        raise TypeError(f"not audio: {arr.dtype}")
    return np.nan_to_num(arr.astype(np.float32, copy=False).reshape(-1), nan=0.0, posinf=0.0, neginf=0.0)


class StreamDenoiser:
    """16 kHz mono audio in, the same audio with the noise taken down out. ``process`` and ``flush`` never raise.

    ``engine`` is ``dpdfnet2`` or ``gtcrn``; any other name (``off`` included) is a passthrough. A passthrough returns
    the input as it came (the samples are delayed by nothing). ``graph`` injects a graph for tests."""

    def __init__(
        self,
        engine: str = "dpdfnet2",
        *,
        model_path: Path | None = None,
        graph: Graph | None = None,
        clock: Callable[[], float] = time.perf_counter,
    ) -> None:
        self.engine = engine
        self._clock = clock
        self._loop: FrameLoop | None = None
        self.reason = ""
        self._busy_s = 0.0
        self._audio = 0
        self._in_sq = 0.0
        self._out_sq = 0.0
        spec = ENGINES.get(engine)
        if spec is None:
            self.reason = "off" if engine == "off" else f"no streaming engine named {engine}"
            return
        self.spec = spec
        try:
            if graph is None:
                path = model_path or find_model(spec)
                if path is None:
                    raise DenoiseUnavailable("the model is not on disk (or is not the pinned size)")
                graph = open_graph(spec, path)
            self._loop = FrameLoop(graph, spec)
        except DenoiseUnavailable as exc:
            self.reason = str(exc)
        except Exception as exc:  # noqa: BLE001 — a denoiser that cannot start is a passthrough, never a crash
            self.reason = f"{type(exc).__name__}: {exc}"[:300]

    @property
    def active(self) -> bool:
        return self._loop is not None

    def reset(self) -> None:
        if self._loop is not None:
            try:
                self._loop.reset()
            except Exception as exc:  # noqa: BLE001
                self._fail(exc)
        self._busy_s, self._audio, self._in_sq, self._out_sq = 0.0, 0, 0.0, 0.0

    def _fail(self, exc: BaseException) -> Any:
        """Drop to passthrough. The audio owed is what the frames committed before the failure plus the raw samples
        still waiting in the frame (the ones not yet committed), so the stream has no gap and no repeat."""
        loop, self._loop = self._loop, None
        self.reason = f"runtime error: {type(exc).__name__}: {exc}"[:300]
        if loop is None:
            return np.zeros(0, dtype=np.float32)
        return np.concatenate([loop.salvage, loop.pending])

    def process(self, pcm: Any) -> Any:
        try:
            x = _as_float(pcm)
        except Exception:  # noqa: BLE001 — an unreadable chunk is dropped as empty, not raised
            return np.zeros(0, dtype=np.float32)
        loop = self._loop
        if loop is None:
            return x
        started = self._clock()
        try:
            got = loop.process(x)
        except Exception as exc:  # noqa: BLE001
            return self._fail(exc)
        self._busy_s += max(0.0, self._clock() - started)
        self._audio += int(x.size)
        self._in_sq += float(np.dot(x, x))
        self._out_sq += float(np.dot(got, got))
        return got

    def flush(self) -> Any:
        loop = self._loop
        if loop is None:
            return np.zeros(0, dtype=np.float32)
        owed = loop.fed - loop.emitted
        try:
            return loop.flush()
        except Exception as exc:  # noqa: BLE001
            self._fail(exc)
            real = max(0, loop.fed - loop.emitted)  # raw samples the padding had not yet reached
            return np.concatenate([loop.salvage[: max(0, owed)], loop.pending[:real]])[: max(0, owed)]

    def run_clip(self, pcm: Any) -> Any:
        """A whole clip from a fresh state, aligned with the input: same length, no lag (the offline A/B uses it).
        A denoiser that is a passthrough, or that fails part-way, gives the clip back as it came."""
        self.reset()
        x = _as_float(pcm)
        if not self.active:
            return x
        delay = self.spec.delay
        head = self.process(np.concatenate([x, np.zeros(delay, dtype=np.float32)]))
        tail = self.flush()
        out = np.concatenate([head, tail]) if tail.size else head
        if not self.active or out.size < x.size + delay:
            return x
        return out[delay : delay + x.size]

    def status(self) -> dict:
        """What the Doctor row reads: the engine, whether it runs, why not, the speed and the share of sound kept."""
        audio_s = self._audio / RATE
        rtf = round(self._busy_s / audio_s, 4) if audio_s > 0 else None
        keep = round((self._out_sq / self._in_sq) ** 0.5, 4) if self._in_sq > 0 else None
        return {
            "engine": self.engine if self.active else "passthrough",
            "wanted": self.engine,
            "active": self.active,
            "reason": self.reason,
            "latencyMs": self.spec.latency_ms if self.active else 0.0,
            "frames": self._loop.frames if self._loop is not None else 0,
            "rtf": rtf,
            "keepRatio": keep,
        }


def build_denoiser(engine: str, *, model_path: Path | None = None) -> StreamDenoiser:
    return StreamDenoiser(engine, model_path=model_path)
