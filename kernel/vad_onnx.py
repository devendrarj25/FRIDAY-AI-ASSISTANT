"""FRIDAY Ears: the Silero voice-activity stream over the pinned ONNX file (no silero-vad pip package, no torch).

One ``SileroStream`` turns 16 kHz mono audio of any chunk size into the decisions the turn logic needs:

* the model reads 512-sample frames (32 ms) with the last 64 samples of the frame before as context, and a recurrent
  state of shape ``(2, 1, 128)``;
* hysteresis: speech starts at ``p >= start`` and is kept until ``p < end``, so a probability between the two never
  flips the state;
* onset: ``onset_frames`` frames in a row at or above ``start`` before speech is declared (3 frames is 96 ms), so one
  click or one loud frame is not a turn;
* min speech: a burst shorter than ``min_speech_ms`` ends as ``cancel`` instead of ``end``;
* pre-roll: the last ``pre_roll_ms`` of audio before the start (the withheld onset frames included) is returned with
  the ``start`` step, oldest first, so the first syllable is not lost.

The scorer is injectable (``scorer(frame) -> p`` plus ``reset()``), so every rule is tested with a made-up probability
stream and no model. ``SileroGate`` wraps a stream in the small interface ``stream_ear.EnergyVad`` has (``push``,
``probability``, ``silence_ms``, ``reset``) and drops to a fallback gate if the model ever fails mid-stream.
numpy and onnxruntime are imported only when the model is opened, so a missing one degrades instead of breaking boot.
"""

from __future__ import annotations

import math
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

RATE = 16000
FRAME = 512  # samples the model scores at a time (32 ms at 16 kHz)
CONTEXT = 64  # samples of the previous frame the model expects in front of each frame
FRAME_MS = FRAME * 1000 // RATE
SILERO_FILE = "silero_vad.onnx"
SILERO_BYTES = 2_327_524  # the pinned file (electron/voice-pins.cjs); a partial download is never opened

VAD_MODES = ("auto", "silero", "energy")
DEFAULT_START = 0.5
DEFAULT_END = 0.35
DEFAULT_ONSET_FRAMES = 3
DEFAULT_MIN_SPEECH_MS = 120
DEFAULT_PRE_ROLL_MS = 500


class VadUnavailable(RuntimeError):
    """The model file or its runtime is missing; the caller keeps the energy gate."""


class Scorer(Protocol):
    def __call__(self, frame: Any) -> float: ...

    def reset(self) -> None: ...


@dataclass(frozen=True)
class VadStep:
    """What one ``push`` saw. ``event`` is the last of ``events`` (``start``, ``end``, ``cancel``) or None.

    ``audio`` is the gated audio of this push: the pre-roll on ``start``, then every frame while speech lasts."""

    p: float
    speaking: bool
    event: str | None = None
    events: tuple[str, ...] = ()
    audio: Any = None
    speech_ms: int = 0


@dataclass(frozen=True)
class VadConfig:
    mode: str = "auto"
    start: float = DEFAULT_START
    end: float = DEFAULT_END
    min_speech_ms: int = DEFAULT_MIN_SPEECH_MS
    pre_roll_ms: int = DEFAULT_PRE_ROLL_MS
    onset_frames: int = DEFAULT_ONSET_FRAMES


def _number(value: Any, default: float, low: float, high: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    number = float(value)
    if not math.isfinite(number):
        return default
    return min(high, max(low, number))


def clamp_config(ears: Mapping[str, Any] | None) -> VadConfig:
    """The ``ears`` object of the stream-open payload, clamped. Anything missing or odd falls to the default."""
    raw: Mapping[str, Any] = ears if isinstance(ears, Mapping) else {}
    mode = str(raw.get("vad") or "auto").strip().lower()
    if mode not in VAD_MODES:
        mode = "auto"
    start = _number(raw.get("vadStart"), DEFAULT_START, 0.2, 0.9)
    end = _number(raw.get("vadEnd"), DEFAULT_END, 0.05, max(0.05, start - 0.05))
    return VadConfig(
        mode=mode,
        start=start,
        end=end,
        min_speech_ms=int(_number(raw.get("minSpeechMs"), DEFAULT_MIN_SPEECH_MS, 60, 400)),
        pre_roll_ms=int(_number(raw.get("preRollMs"), DEFAULT_PRE_ROLL_MS, 200, 1000)),
    )


def find_model() -> Path | None:
    """The pinned file under ``<FRIDAY_ROOT>/models`` (the same lookup the voice runtime uses), or None."""
    try:
        from voice_runtime import find_named

        path = find_named(SILERO_FILE)
    except Exception:  # noqa: BLE001 — no lookup means no model, and the energy gate stays
        return None
    if path is None:
        return None
    try:
        return path if path.stat().st_size == SILERO_BYTES else None
    except OSError:
        return None


_SESSIONS: dict[str, Any] = {}
_SESSIONS_LOCK = threading.Lock()


def _session(path: Path) -> Any:
    """One shared onnxruntime session per file (a session is thread-safe; each stream keeps its own state)."""
    key = str(path)
    with _SESSIONS_LOCK:
        cached = _SESSIONS.get(key)
        if cached is not None:
            return cached
        try:
            import onnxruntime as ort  # type: ignore

            options = ort.SessionOptions()
            options.intra_op_num_threads = 1
            options.inter_op_num_threads = 1
            made = ort.InferenceSession(str(path), sess_options=options, providers=["CPUExecutionProvider"])
        except Exception as exc:  # noqa: BLE001
            raise VadUnavailable(f"the silero model did not open: {type(exc).__name__}: {exc}"[:300]) from exc
        _SESSIONS[key] = made
        return made


def forget_sessions() -> None:
    with _SESSIONS_LOCK:
        _SESSIONS.clear()


class OnnxScorer:
    """Scores 512-sample frames with the recurrent state and the 64-sample context the model needs."""

    def __init__(self, path: Path) -> None:
        import numpy as np

        self._np = np
        self._session = _session(path)
        self._sr = np.array(RATE, dtype=np.int64)
        self.reset()

    def reset(self) -> None:
        np = self._np
        self._state = np.zeros((2, 1, 128), dtype=np.float32)
        self._context = np.zeros(CONTEXT, dtype=np.float32)

    def __call__(self, frame: Any) -> float:
        np = self._np
        samples = np.asarray(frame, dtype=np.float32).reshape(-1)
        if samples.size != FRAME:
            raise ValueError(f"the silero scorer reads {FRAME} samples, not {samples.size}")
        window = np.concatenate([self._context, samples]).reshape(1, -1)
        out = self._session.run(None, {"input": window, "state": self._state, "sr": self._sr})
        self._state = np.asarray(out[1], dtype=np.float32)
        self._context = samples[-CONTEXT:].copy()
        return float(np.asarray(out[0]).reshape(-1)[0])


def score_window(path: Path, window: Any) -> float:
    """One-shot probability of one 512-sample window from a fresh state (the voice runtime self-test)."""
    return OnnxScorer(path)(window)


def _as_float(pcm: Any) -> Any:
    import numpy as np

    if isinstance(pcm, (bytes, bytearray, memoryview)):
        return np.frombuffer(bytes(pcm), dtype="<i2").astype(np.float32) / 32768.0
    arr = np.asarray(pcm)
    if arr.dtype.kind in "iu":
        return arr.astype(np.float32).reshape(-1) / 32768.0
    return arr.astype(np.float32, copy=False).reshape(-1)


@dataclass
class _Ring:
    capacity: int
    frames: list[Any] = field(default_factory=list)

    def add(self, frame: Any) -> None:
        self.frames.append(frame)
        del self.frames[: -self.capacity]

    def drain(self) -> list[Any]:
        out, self.frames = self.frames, []
        return out


class SileroStream:
    """``push(pcm16k) -> VadStep``. See the module doc for the rules."""

    def __init__(
        self,
        start: float = DEFAULT_START,
        end: float = DEFAULT_END,
        onset_frames: int = DEFAULT_ONSET_FRAMES,
        min_speech_ms: int = DEFAULT_MIN_SPEECH_MS,
        pre_roll_ms: int = DEFAULT_PRE_ROLL_MS,
        *,
        scorer: Scorer | None = None,
        model_path: Path | None = None,
    ) -> None:
        if scorer is None:
            path = model_path or find_model()
            if path is None:
                raise VadUnavailable("the silero model is not on disk")
            try:
                scorer = OnnxScorer(path)
            except VadUnavailable:
                raise
            except Exception as exc:  # noqa: BLE001 — numpy or onnxruntime missing
                raise VadUnavailable(f"{type(exc).__name__}: {exc}"[:300]) from exc
        self.start = float(start)
        self.end = min(float(end), self.start)
        self.onset_frames = max(1, int(onset_frames))
        self.min_speech_ms = max(0, int(min_speech_ms))
        self.pre_roll_ms = max(0, int(pre_roll_ms))
        self._scorer = scorer
        self._ring = _Ring(capacity=max(self.onset_frames, math.ceil(self.pre_roll_ms / FRAME_MS)))
        self.reset()

    def reset(self) -> None:
        import numpy as np

        self._scorer.reset()
        self._ring.frames = []
        self._carry = np.zeros(0, dtype=np.float32)
        self._speaking = False
        self._onset = 0
        self._speech_frames = 0
        self._p = 0.0

    @property
    def speaking(self) -> bool:
        return self._speaking

    @property
    def p(self) -> float:
        return self._p

    def push(self, pcm16k: Any) -> VadStep:
        import numpy as np

        data = _as_float(pcm16k)
        if self._carry.size:
            data = np.concatenate([self._carry, data])
        whole = (data.size // FRAME) * FRAME
        self._carry = data[whole:].copy()
        events: list[str] = []
        audio: list[Any] = []
        for at in range(0, whole, FRAME):
            frame = data[at : at + FRAME]
            self._p = float(self._scorer(frame))
            self._frame(frame, events, audio)
        gated = np.concatenate(audio) if audio else np.zeros(0, dtype=np.float32)
        return VadStep(
            p=self._p,
            speaking=self._speaking,
            event=events[-1] if events else None,
            events=tuple(events),
            audio=gated,
            speech_ms=self._speech_frames * FRAME_MS if self._speaking else 0,
        )

    def _frame(self, frame: Any, events: list[str], audio: list[Any]) -> None:
        if not self._speaking:
            self._ring.add(frame)
            self._onset = self._onset + 1 if self._p >= self.start else 0
            if self._onset >= self.onset_frames:
                self._speaking = True
                self._speech_frames = self._onset
                self._onset = 0
                events.append("start")
                audio.extend(self._ring.drain())  # the withheld onset frames, oldest first
            return
        audio.append(frame)
        if self._p >= self.end:
            self._speech_frames += 1
            return
        self._speaking = False
        events.append("end" if self._speech_frames * FRAME_MS >= self.min_speech_ms else "cancel")
        self._speech_frames = 0


class SileroGate:
    """The ``EnergyVad`` interface over a ``SileroStream``: ``push(samples, slice_ms) -> probability``.

    ``probability`` is shaped for the endpointer, which compares it to ``threshold``: at or above it only while the
    stream is speaking (hysteresis and onset already applied), below it otherwise. ``silence_ms`` counts audio since
    speech last held. If the model fails mid-stream the gate hands over to ``fallback`` for good."""

    def __init__(self, stream: SileroStream, *, threshold: float = 0.5, fallback: Any = None) -> None:
        self._stream = stream
        self._threshold = threshold
        self._fallback = fallback
        self.engine = "silero"
        self.reset()

    def reset(self) -> None:
        self.silence_ms = 0
        self.probability = 0.0
        if self.engine == "silero":
            self._stream.reset()
        elif self._fallback is not None:
            self._fallback.reset()

    def push(self, samples: Any, slice_ms: int = 20) -> float:
        if self.engine != "silero":
            return self._fallback_push(samples, slice_ms)
        try:
            step = self._stream.push(samples)
        except Exception:  # noqa: BLE001 — one bad frame never stops the turn: the energy gate takes over
            if self._fallback is None:
                raise
            self.engine = "energy"
            return self._fallback_push(samples, slice_ms)
        up = self._threshold
        self.probability = max(step.p, up) if step.speaking else min(step.p, math.nextafter(up, 0.0))
        self.silence_ms = 0 if step.speaking else self.silence_ms + slice_ms
        return self.probability

    def _fallback_push(self, samples: Any, slice_ms: int) -> float:
        value = float(self._fallback.push(samples, slice_ms))
        self.probability, self.silence_ms = value, int(self._fallback.silence_ms)
        return value


def build_gate(
    config: VadConfig,
    fallback_factory: Callable[[], Any],
    *,
    threshold: float = 0.5,
    model_path: Path | None = None,
) -> tuple[Any, str]:
    """The gate for one stream and its name (``silero`` or ``energy``). ``energy`` mode, a missing file and a
    missing runtime all give the fallback; nothing here raises."""
    fallback = fallback_factory()
    if config.mode == "energy":
        return fallback, "energy"
    try:
        stream = SileroStream(
            config.start,
            config.end,
            config.onset_frames,
            config.min_speech_ms,
            config.pre_roll_ms,
            model_path=model_path,
        )
    except VadUnavailable:
        return fallback, "energy"
    return SileroGate(stream, threshold=threshold, fallback=fallback), "silero"
