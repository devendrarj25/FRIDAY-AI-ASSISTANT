"""FRIDAY Ears: the streaming engine layer. One protocol, a registry, the tier choice, and the glue.

Interface contract
------------------
* ``SttEngine`` is the protocol every streaming engine speaks: ``open``, ``feed``, ``partial``, ``committed``,
  ``endpoint``, ``finalize``, ``reset`` and ``close``. ``feed`` takes 16 kHz mono PCM and returns a list of event
  dicts (``partial`` and ``endpoint``); everything is plain JSON.
* ``register_engine(EngineSpec)`` adds an engine to the registry; ``nemotron`` (``stream-ear-nemotron``) is the one
  that ships. ``engine_names()`` lists them.
* ``choose_tier(setting, locale)`` is the ONLY way an engine gets picked, and it never picks one unless BOTH are
  true: ``voice.streamEngine`` asks for it (``auto`` or the engine's name; ``off``, empty and anything unknown mean
  no) AND every pinned file is on disk with its exact size under ``<FRIDAY_ROOT>/models/<folder>``. It also checks
  that numpy and onnxruntime import and that the locale is one of the model's languages. It returns a
  ``TierChoice`` with the engine name (or None) and a short ``reason`` so the caller can show why the old path runs.
* ``TransducerEngine`` wires ``transducer_loop.NemotronStream`` to a voice gate (``vad_onnx.SileroGate`` when the
  pinned Silero file is on disk and ``ears.vad`` is ``auto`` or ``silero``, else ``EnergyVad``),
  ``endpointer.Endpointer`` and ``stream_commit.PartialStabiliser``. Audio is processed in 20 ms slices on the
  audio clock (no wall clock), so a run repeats exactly. ``endpoint`` events follow ``endpointer``
  (StartOfTurn, EagerEndOfTurn, TurnResumed, EndOfTurn); the engine never ends a turn by itself: the
  caller calls ``finalize``.
* When the stream-open payload carries ``ears``, the engine also speaks the turn protocol: ``eagerness`` picks the
  endpointer preset (``endpointer.config_for_ears``); about 200 ms after the voice gate stops, the pinned Smart Turn
  model (``voice_runtime.score_turn``, the last 8 s, front-padded) scores the turn once, and again after speech
  resumes; a missing file or failure leaves the silence rules alone. ``take_turns`` hands the host the
  ``start``/``partial``/``eager``/``resumed``/``end``/``revised`` notes, which ``stream-feed`` returns as ``turn``
  (the last) and ``turns`` (all). ``eager`` is sent only when ``ears.eagerTurn`` is true. A final reading goes
  through ``transcript_gate.stream_text_dropped`` with the voiced time of the Silero gate. Without ``ears``
  none of this runs and the engine behaves as before.
* The room seam (``ear_scene``): with ``ears.scene == "score"`` every 1.5 s of audio is read for speech, music, tv or
  noise and the turn notes carry ``env {kind, score}``; while music or a tv holds (hysteresis) the voice gate start
  is raised to 0.6 and a final of fewer than 2 words is dropped (``scene-needs-words``). With ``ears.otherVoice``
  ``score`` or ``hold`` each window of speech is scored against ``ears.ownerEmbedding`` (the WeSpeaker int8 file) and
  the notes carry ``speaker {tag, score}`` (owner, other, unknown); ``hold`` adds ``needsWake`` (an other voice, or
  a tv) and the renderer decides. These are tags and stricter gates only: a speaker tag is never read by an approval
  and never lowers a threshold. Absent ``scene`` and ``otherVoice`` nothing of this runs.
* Under ``auto`` the chooser also gates on speed: ``hardware_tier`` names the PC (``small-cpu``, ``mid``, ``gpu``),
  ``RtfLedger`` keeps the real-time factor each engine measured on this PC per tier (``<models>/stream-ear-rtf.json``,
  written after every stream of a second or more), and an engine measured slower than ``RTF_LIMIT`` is skipped for
  the next one. An engine not measured yet is tried; an engine asked for by name is not gated.
* ``La2Engine`` is the same protocol over ``la2_partials.La2Partials`` for ears that re-decode a rolling window
  (LocalAgreement-2): the worker (``stt.py``) registers the Hindi ear (``stream-ear-hindi``, Hindi only) and the
  resident faster-whisper model (``stream-ear-whisper``, English, Hindi and Hinglish) behind ``locate`` pin checks.
  A Hinglish locale is never given to an ear that does not list it.
* The clean-up copy (``kernel/denoise_onnx.py``): only the copy handed to the speech engine can be denoised, and only
  when ``ears.denoise`` names ``dpdfnet2`` or ``gtcrn`` and its model file is on disk (the default is ``off``). The
  voice gate, the Smart Turn read, the room and speaker scorers and the transcript gate always read the raw audio. The
  denoiser's own delay is taken out (the copy has the raw audio's length and timing; it reaches the engine about
  ``latencyMs`` later), the tail is flushed before the final reading, and any failure turns the copy back into the raw
  audio with no gap and no repeat. ``denoise {engine, active, rtf, latencyMs, reason}`` is in the stream-open reply,
  the final reading and (while an engine is loaded) the worker status. ``off`` hands the engine the very same samples.
* ``HOST`` is the worker's single slot: one loaded engine (kept between utterances, dropped by ``unload``) and one
  active stream. ``HOST.handle(req)`` answers the ``stream-open``, ``stream-feed`` and ``stream-close`` ops of
  ``stt.py`` (shapes in ``handle``). Nothing here starts on its own: with the setting off the module costs nothing.

numpy and onnxruntime are imported only when an engine is built, so a missing one degrades instead of breaking boot.
"""

from __future__ import annotations

import base64
import binascii
import importlib.util
import json
import math
import os
import threading
import time
from collections import deque
from collections.abc import Callable, Mapping
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

import voice_budget
from endpointer import EndpointConfig, Endpointer, Observation, TurnTracker, config_for_ears
from la2_partials import RATE, La2Partials, TurnLanguage
from stream_commit import LocalAgreementCommitter, PartialStabiliser, Word, join_words
from transcript_gate import stream_text_dropped
from vad_onnx import build_gate, clamp_config

ENGINE_NAME = "stream-ear-nemotron"
SETTING_KEY = "voice.streamEngine"
STREAM_OPS = frozenset({"stream-open", "stream-feed", "stream-close"})
# Load the streaming model ahead of the first turn, with no stream opened. Not a stream op: the worker runs it on its
# own thread so a long first load never holds up a transcribe or a status.
WARM_OP = "stream-warm"
# How long a stream op or an unload waits for a running warm before it answers "warming" (or skips the unload).
HOST_WAIT_S = 0.25
SLICE_MS = 20
MAX_FEED_BYTES = 1_048_576
MAX_ID_CHARS = 64
MAX_HOTWORDS = 200
MAX_HOTWORD_CHARS = 80
HINGLISH_LOCALES = frozenset({"hi-en", "en-hi", "hinglish", "mixed"})
OFF_VALUES = frozenset({"", "off", "false", "no", "0", "none", "disabled", "default"})

# Exact sizes of the pinned files (electron/voice-pins.cjs, soniqo/Nemotron-3.5-ASR-Streaming-...-ONNX-INT8).
# A test keeps this table equal to the pin; a partial download can never pass the size check.
NEMOTRON_FILES: dict[str, int] = {
    "config.json": 602,
    "decoder.onnx": 4345,
    "decoder.onnx.data": 59_760_640,
    "encoder.onnx": 657_558_932,
    "joint.onnx": 2023,
    "joint.onnx.data": 37_822_592,
    "languages.json": 2020,
    "vocab.json": 236_127,
}


@runtime_checkable
class SttEngine(Protocol):
    name: str

    def open(self, model_dir: str | Path, **options: Any) -> dict[str, Any]: ...
    def feed(self, pcm: Any) -> list[dict[str, Any]]: ...
    def partial(self) -> dict[str, Any]: ...
    def committed(self) -> str: ...
    def endpoint(self) -> dict[str, Any]: ...
    def finalize(self) -> dict[str, Any]: ...
    def reset(self) -> None: ...
    def close(self) -> None: ...


@dataclass(frozen=True)
class EngineSpec:
    name: str
    folder: str  # under <FRIDAY_ROOT>/models
    files: Mapping[str, int]  # file name -> exact bytes
    factory: Callable[[], SttEngine]
    aliases: tuple[str, ...] = ()
    modules: tuple[str, ...] = ("numpy", "onnxruntime")
    languages: Callable[[Path], set[str]] | None = None  # the locales the files on disk can hear
    priority: int = 100  # lower runs first under "auto"
    locate: Callable[[], Path | None] | None = None  # an ear with its own pin check (its folder, or None)


# ---- registry and tier choice -------------------------------------------------------------------------------------

_REGISTRY: dict[str, EngineSpec] = {}


def register_engine(spec: EngineSpec) -> None:
    _REGISTRY[spec.name] = spec


def engine_names() -> list[str]:
    return sorted(_REGISTRY, key=lambda n: (_REGISTRY[n].priority, n))


def engine_spec(name: str) -> EngineSpec | None:
    return _REGISTRY.get(name)


def model_root() -> Path:
    root = os.environ.get("FRIDAY_ROOT", "").strip()
    return (Path(root) if root else Path.home() / ".friday") / "models"


def pin_dir(spec: EngineSpec, root: Path | None = None) -> Path | None:
    """The folder when every pinned file is there with its exact size, else None. Opens nothing, downloads nothing."""
    if spec.locate is not None:
        try:
            return spec.locate()
        except OSError:
            return None
    folder = (root or model_root()) / spec.folder
    try:
        for name, size in spec.files.items():
            if (folder / name).stat().st_size != size:
                return None
    except OSError:
        return None
    return folder


def runtime_ready(spec: EngineSpec, find_spec: Callable[[str], Any] = importlib.util.find_spec) -> bool:
    try:
        return all(find_spec(module) is not None for module in spec.modules)
    except (ImportError, ValueError):
        return False


@dataclass(frozen=True)
class TierChoice:
    engine: str | None
    reason: str  # ok, off, unknown-engine, runtime-missing, pin-missing, locale-unsupported, too-slow
    model_dir: Path | None = None
    tier: str | None = None  # small-cpu, mid or gpu when the speed gate ran
    rtf: float | None = None  # the measured real-time factor the gate used (None: not measured yet)


# ---- measured speed per hardware tier -----------------------------------------------------------------------------

TIERS = ("small-cpu", "mid", "gpu")
RTF_LIMIT = 0.6  # an engine measured slower than this on this tier is skipped under "auto" (it could not keep up)
RTF_MIN_AUDIO_MS = 1000  # a shorter stream says little about speed and is not recorded
RTF_FILE = "stream-ear-rtf.json"


def hardware_tier(ram_gb: float, cores: int, gpu: bool) -> str:
    """``gpu`` with a usable card, ``small-cpu`` under 12 GB or four cores, else ``mid``."""
    if gpu:
        return "gpu"
    return "small-cpu" if ram_gb < 12 or cores <= 4 else "mid"


class RtfLedger:
    """Real-time factor per engine and tier, measured on this PC (moving average), kept in ``<models>/{RTF_FILE}``."""

    def __init__(self, path: Path | None = None) -> None:
        self.path = path
        self._rows: dict[str, dict[str, float]] = {}
        self._loaded = False

    def _load(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        if self.path is None:
            return
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        if isinstance(data, dict):
            for key, row in data.items():
                if isinstance(row, dict) and all(isinstance(v, (int, float)) for v in row.values()):
                    self._rows[str(key)[:120]] = {str(t)[:16]: float(v) for t, v in row.items() if t in TIERS}

    def get(self, engine: str, tier: str) -> float | None:
        self._load()
        return self._rows.get(engine, {}).get(tier)

    def record(self, engine: str, tier: str, rtf: float, *, weight: float = 0.3) -> float | None:
        if tier not in TIERS or not math.isfinite(rtf) or rtf < 0:
            return None
        self._load()
        row = self._rows.setdefault(engine, {})
        old = row.get(tier)
        row[tier] = round(rtf if old is None else old + (rtf - old) * weight, 4)
        if self.path is not None:
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                temp = self.path.with_suffix(".tmp")
                temp.write_text(json.dumps(self._rows, sort_keys=True), encoding="utf-8")
                os.replace(temp, self.path)
            except OSError:
                pass  # a read-only folder costs the memory of the speed, never the stream
        return row[tier]


def _wants(setting: Any, spec: EngineSpec) -> bool:
    key = str(setting).strip().lower()
    return key == "auto" or key == spec.name.lower() or key in {a.lower() for a in spec.aliases}


def choose_tier(
    setting: Any,
    locale: str = "",
    *,
    root: Path | None = None,
    find_spec: Callable[[str], Any] = importlib.util.find_spec,
    tier: str | None = None,
    ledger: RtfLedger | None = None,
) -> TierChoice:
    """The engine to use, or None with the reason. Never an engine whose pin is missing or whose setting is not on.

    Under ``auto`` with a hardware ``tier`` and a ``ledger``, an engine MEASURED slower than ``RTF_LIMIT`` on this
    tier is skipped for the next one (an engine not measured yet is tried, and measured on that use). An engine asked
    for by name is the owner's choice and is not speed-gated. The reason is the one of the first candidate."""
    key = "" if setting is None or setting is False else str(setting).strip().lower()
    if key in OFF_VALUES:
        return TierChoice(None, "off")
    candidates = [s for s in map(_REGISTRY.get, engine_names()) if s is not None and _wants(key, s)]
    if not candidates:
        return TierChoice(None, "unknown-engine")
    gated = key == "auto" and tier in TIERS and ledger is not None
    reasons: list[str] = []
    for spec in candidates:
        if not runtime_ready(spec, find_spec):
            reasons.append("runtime-missing")
            continue
        folder = pin_dir(spec, root)
        if folder is None:
            reasons.append("pin-missing")
            continue
        if locale and spec.languages is not None and not _locale_ok(spec.languages(folder), locale):
            reasons.append("locale-unsupported")
            continue
        rtf = ledger.get(spec.name, tier) if gated and ledger is not None and tier is not None else None
        if rtf is not None and rtf > RTF_LIMIT:
            reasons.append("too-slow")
            continue
        return TierChoice(spec.name, "ok", folder, tier if gated else None, rtf)
    return TierChoice(None, reasons[0] if reasons else "pin-missing", None, tier if gated else None)


def _locale_ok(known: set[str], locale: str) -> bool:
    raw = locale.strip().replace("_", "-").lower()
    if not raw or raw == "auto":
        return "auto" in known
    if raw in HINGLISH_LOCALES:
        return bool(known & HINGLISH_LOCALES)  # Hinglish needs an ear that hears both, not a Hindi-only one
    return raw in known or raw.split("-")[0] in known


# ---- voice activity (energy), for the endpointer ------------------------------------------------------------------


class EnergyVad:
    """A small adaptive energy gate over 20 ms slices. It only feeds the endpointer; the model decides the words."""

    def __init__(self, *, margin_db: float = 12.0, floor_db: float = -50.0, window: int = 5) -> None:
        self.margin_db, self.min_db, self.window = margin_db, floor_db, window
        self.reset()

    def reset(self) -> None:
        self._noise = -60.0
        self._recent: list[bool] = []
        self.silence_ms = 0
        self.probability = 0.0

    def push(self, samples: Any, slice_ms: int = SLICE_MS) -> float:
        import numpy as np

        arr = np.asarray(samples, dtype=np.float32)
        rms = float(np.sqrt(np.mean(arr * arr))) if arr.size else 0.0
        db = 20.0 * math.log10(rms) if rms > 1e-9 else -120.0
        if db < self._noise:
            self._noise = db
        else:
            self._noise += (db - self._noise) * 0.002
        self._noise = max(-90.0, self._noise)
        loud = db > max(self._noise + self.margin_db, self.min_db)
        self._recent = [*self._recent, loud][-self.window :]
        self.probability = sum(self._recent) / self.window if len(self._recent) >= self.window else 0.0
        self.silence_ms = 0 if self.probability >= 0.5 else self.silence_ms + slice_ms
        return self.probability


# ---- the engine ---------------------------------------------------------------------------------------------------

TURN_WINDOW_S = 8  # Smart Turn reads the last 8 s of 16 kHz audio


def _smart_turn_scorer(samples: Any, rate: int) -> dict[str, Any]:
    """The pinned end-of-turn model of the voice runtime (resident session, front-pads a short clip)."""
    import voice_runtime

    return voice_runtime.score_turn(samples, rate)


_PRODUCTION_SCORER = _smart_turn_scorer


class _InlineExecutor:
    """Runs a job at once on the calling thread. Used for a stand-in scorer, so a test sees the verdict in the same
    feed call that asked for it."""

    def submit(self, fn: Callable[..., Any], *args: Any) -> Future[Any]:
        future: Future[Any] = Future()
        try:
            future.set_result(fn(*args))
        except BaseException as err:  # noqa: BLE001 — the job wrapper never raises; this is only a last net
            future.set_exception(err)
        return future

    def shutdown(self, wait: bool = True) -> None:
        return None


@dataclass(frozen=True)
class TurnVerdict:
    """One finished Smart Turn read. ``token`` names the pause it was asked for; ``answer`` is the scorer's reply or
    ``None`` when the scorer raised."""

    token: int
    answer: dict[str, Any] | None


class TurnScoreWorker:
    """Smart Turn on one background thread, so the audio feed loop never waits for the model (77 to 123 ms a call on
    four cores used to stall the voice gate and the stream every time the endpointer asked).

    ``submit`` never blocks: with a read running it keeps only the newest window (an older waiting one is dropped and
    counted in ``dropped``), so at most one read runs and one waits. ``poll`` hands back a finished verdict once and
    starts the waiting window. The thread is created on the first read and joined by ``close``; a later ``submit``
    makes a new one. This is the one thread of the audio slot of ``voice_budget`` (role ``turn``, one thread): it
    overlaps the voice gate for the length of one read per pause, which is the accepted cost of not stalling the feed.
    """

    def __init__(self, scorer: Callable[[Any, int], dict[str, Any]], executor: Any = None) -> None:
        self._scorer = scorer
        self._given = executor
        self._executor: Any = executor
        self._running: Future[TurnVerdict] | None = None
        self._pending: tuple[Any, int, int] | None = None
        self.dropped = 0

    @property
    def threaded(self) -> bool:
        return not isinstance(self._given, _InlineExecutor)

    def _job(self, samples: Any, rate: int, token: int) -> TurnVerdict:
        try:
            return TurnVerdict(token, self._scorer(samples, rate))
        except Exception:  # noqa: BLE001 — a failing model must not kill the worker
            return TurnVerdict(token, None)

    def _start(self, samples: Any, rate: int, token: int) -> None:
        if self._executor is None:
            self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="friday-turn")
        try:
            self._running = self._executor.submit(self._job, samples, rate, token)
        except RuntimeError:  # the pool was shut down under us: report it as a failed read
            self._running = Future()
            self._running.set_result(TurnVerdict(token, None))

    def submit(self, samples: Any, rate: int, token: int) -> None:
        if self._running is None:
            self._start(samples, rate, token)
            return
        if self._pending is not None:
            self.dropped += 1
        self._pending = (samples, rate, token)

    def poll(self) -> TurnVerdict | None:
        running = self._running
        if running is None or not running.done():
            return None
        self._running = None
        verdict = running.result()
        if self._pending is not None:
            samples, rate, token = self._pending
            self._pending = None
            self._start(samples, rate, token)
        return verdict

    def cancel(self) -> None:
        """Forget the waiting window. A read already running finishes and its verdict is judged by its token."""
        self._pending = None

    def close(self) -> None:
        self._pending = None
        self._running = None
        executor, self._executor = self._executor, self._given
        if self._given is None and executor is not None:
            executor.shutdown(wait=True)


def _language_of(locale: str) -> str | None:
    return (locale or "").split("-")[0].split("_")[0].lower() or None


def _words(text: str) -> list[str]:
    return text.split()


def _make_denoiser(name: str) -> Any:
    """The streaming denoiser of ``denoise_onnx`` (numpy and onnxruntime are imported only here, on demand)."""
    from denoise_onnx import build_denoiser

    return build_denoiser(name)


class AsrLane:
    """The audio on its way to the speech engine. ``feed`` returns what the engine should hear for the raw samples just
    given; with the clean-up off, missing or failed that is the same array, untouched. With a denoiser running it is
    the denoised copy with the model delay taken out, so sample ``i`` of the copy is sample ``i`` of the raw audio (it
    arrives ``latencyMs`` later, never earlier). It never raises."""

    def __init__(self, wanted: Any = "off") -> None:
        name = str(wanted or "off").strip().lower()
        self.wanted = name if name in ("rnnoise", "gtcrn", "dpdfnet2") else "off"
        self.reason = "off" if self.wanted == "off" else ""
        self._d: Any = None
        self._skip = 0
        self._raw: Any = None  # the raw samples the copy has not yet given back
        if self.wanted == "off":
            return
        try:
            made = _make_denoiser(self.wanted)
            if made.active:
                self._d = made
                self._skip = int(made.spec.delay)
            else:
                self.reason = str(made.reason or "the denoiser is not active")
        except Exception as exc:  # noqa: BLE001 - no numpy, no runtime, a bad file: the raw audio goes on
            self.reason = f"{type(exc).__name__}: {exc}"[:300]

    @property
    def active(self) -> bool:
        return self._d is not None and bool(self._d.active)

    def reset(self) -> None:
        """A new turn: the denoiser's state and the delay start again. A denoiser that failed stays out."""
        d = self._d
        if d is None:
            return
        try:
            d.reset()
            self._skip = int(d.spec.delay)
            self._raw = None
        except Exception as exc:  # noqa: BLE001
            self.reason = f"{type(exc).__name__}: {exc}"[:300]
            self._d = None

    def _owed(self) -> Any:
        import numpy as np

        return self._raw if self._raw is not None else np.zeros(0, dtype=np.float32)

    def _give_up(self) -> Any:
        """The denoiser failed: every raw sample the copy still owes goes out as it is, and the lane stays raw."""
        owed = self._owed()
        self.reason = str(self._d.reason or "the denoiser failed") if self._d is not None else self.reason
        self._raw = None
        return owed

    def feed(self, x: Any) -> Any:
        d = self._d
        if d is None or not d.active:
            return x
        try:
            import numpy as np

            self._raw = np.concatenate([self._owed(), x])
            out = d.process(x)
            if not d.active:
                return self._give_up()
            if self._skip:
                cut = min(self._skip, int(out.size))
                out, self._skip = out[cut:], self._skip - cut
            n = min(int(out.size), int(self._raw.size))
            self._raw = self._raw[n:]
            return out[:n]
        except Exception as exc:  # noqa: BLE001
            owed = self._owed()
            self.reason, self._d, self._raw = f"{type(exc).__name__}: {exc}"[:300], None, None
            return owed

    def flush(self) -> Any:
        """The samples the copy still owes at the end of the turn (None when it owes nothing)."""
        d = self._d
        if d is None or not d.active:
            return None
        try:
            import numpy as np

            owed = self._owed()
            want = int(owed.size)
            if want == 0:
                return None
            head = d.process(np.zeros(int(d.spec.delay), dtype=np.float32))
            tail = d.flush()
            if not d.active:
                return self._give_up()
            out = np.concatenate([head, tail])[self._skip :][:want]
            if out.size < want:
                out = np.concatenate([out, owed[out.size :]])
            self._skip, self._raw = 0, None
            return out
        except Exception as exc:  # noqa: BLE001
            owed = self._owed()
            self.reason, self._d, self._raw = f"{type(exc).__name__}: {exc}"[:300], None, None
            return owed

    def status(self) -> dict[str, Any]:
        d = self._d
        if d is None:
            return {"engine": self.wanted, "active": False, "rtf": None, "latencyMs": 0.0, "reason": self.reason}
        st = d.status()
        return {
            "engine": self.wanted,
            "active": bool(st["active"]),
            "rtf": st["rtf"],
            "latencyMs": float(st["latencyMs"]),
            "reason": str(st["reason"]),
        }


@dataclass
class _Turn:
    audio_ms: int = 0
    last_token_ms: int = 0
    last_text: str = ""
    decision: dict[str, Any] = field(default_factory=lambda: {"event": None, "requiredWaitMs": 0, "reason": "idle"})


class TransducerEngine:
    """``SttEngine`` over ``transducer_loop.NemotronStream``."""

    name = ENGINE_NAME

    def __init__(
        self,
        stream: Any = None,
        *,
        endpoint_config: EndpointConfig | None = None,
        turn_scorer: Callable[[Any, int], dict[str, Any]] | None = None,
        turn_executor: Any = None,
    ) -> None:
        self._stream = stream
        self._endpoint_config = endpoint_config or EndpointConfig()
        self._ctor_config = self._endpoint_config
        self._turn_scorer = turn_scorer or _smart_turn_scorer
        # The pinned Smart Turn model reads on a background thread. A stand-in scorer runs inline (a test sees its
        # verdict in the same feed call); ``turn_executor`` is ``"thread"`` or an executor to test the background path.
        if turn_executor == "thread":
            turn_executor = None
        elif turn_executor is None and self._turn_scorer is not _PRODUCTION_SCORER:
            turn_executor = _InlineExecutor()
        self._turn_worker = TurnScoreWorker(lambda samples, rate: self._turn_scorer(samples, rate), turn_executor)
        self._turn_gen = 0
        self.turn_state = "idle"  # idle | pending | scored | absent | turn-score-failed
        self._ears_on = False
        self._smart_turn = False
        self._scene: Any = None
        self._hold_other = False
        self._gate_base: tuple[Any, ...] | None = None
        self._lane = AsrLane()
        self._tracker = TurnTracker(self._endpoint_config)
        self._vad: Any = EnergyVad()
        self.vad_engine = "energy"
        self._endpointer = Endpointer(self._endpoint_config)
        self._stabiliser = PartialStabiliser(LocalAgreementCommitter())
        self._turn = _Turn()
        self._carry = bytearray()
        self._model_dir = ""
        self._providers_key: tuple[str, ...] = ()
        self._partial: dict[str, Any] = self._partial_dict(self._stabiliser.update([]), 0)
        self._reset_turn_state()

    @property
    def loaded(self) -> bool:
        return self._stream is not None and bool(getattr(self._stream, "is_open", False))

    def open(self, model_dir: str | Path, **options: Any) -> dict[str, Any]:
        """Load (or reuse) the model and start a fresh utterance. Options: providers, locale, hotwords, endpoint."""
        providers = options.get("providers")
        locale = str(options.get("locale") or "en-US")
        hotwords = [str(w)[:MAX_HOTWORD_CHARS] for w in (options.get("hotwords") or []) if str(w).strip()][
            :MAX_HOTWORDS
        ]
        self._open_endpoint(options.get("endpoint"), options.get("ears"))
        self._open_vad(options.get("ears"))
        key = tuple(providers) if isinstance(providers, (list, tuple)) else ()
        if self._stream is None:
            from transducer_loop import NemotronStream

            self._stream = NemotronStream(threads=voice_budget.steady("asr_stream"))
        info: dict[str, Any]
        if self.loaded and self._model_dir == str(model_dir) and self._providers_key == key:
            self._stream.configure(locale, hotwords)
            info = {"providers": list(self._stream.active_providers), "chunkMs": self._stream.chunk_ms, "loadMs": 0}
        else:
            info = self._stream.open(model_dir, providers, locale, hotwords)
            self._model_dir, self._providers_key = str(model_dir), key
        self._clear()
        return {
            **info,
            "engine": self.name,
            "locale": locale,
            "hotwords": self._stream.hotword_count,
            "vad": self.vad_engine,
            "denoise": self._lane.status(),
        }

    def _open_endpoint(self, overrides: Any, ears: Any) -> None:
        """The endpointer of this stream: the ``ears.eagerness`` preset (when ``ears`` names one), then the
        ``endpoint`` overrides on top. With neither, the constructor's config stands."""
        preset = config_for_ears(ears)
        self._ears_on = isinstance(ears, Mapping)
        if preset is not None or isinstance(overrides, Mapping):
            allowed = EndpointConfig.__dataclass_fields__
            picked = {k: v for k, v in overrides.items() if k in allowed} if isinstance(overrides, Mapping) else {}
            self._endpoint_config = EndpointConfig(**{**(preset or {}), **picked})
        else:
            self._endpoint_config = self._ctor_config
        self._endpointer = Endpointer(self._endpoint_config)
        self._tracker = TurnTracker(self._endpoint_config)
        self._smart_turn = self._ears_on

    def _reset_turn_state(self) -> None:
        self._tail: deque[Any] = deque()
        self._tail_samples = 0
        self._turn_p: float | None = None
        self._scored = False
        self._turn_gen += 1  # a verdict still on its way belongs to the old turn
        self._turn_worker.cancel()
        if self.turn_state != "absent":
            self.turn_state = "idle"
        self._voiced_ms = 0
        self._turn_voiced_ms = 0
        self._pending_turns: list[dict[str, Any]] = []
        self._tracker.reset()

    def _open_vad(self, ears: Any) -> None:
        """The voice gate of this stream: Silero when the pinned file is on disk and ``ears.vad`` allows it
        (``auto`` or ``silero``), otherwise the energy gate. ``ears`` is the clamped stream-open object."""
        self._vad, self.vad_engine = build_gate(
            clamp_config(ears if isinstance(ears, Mapping) else None),
            EnergyVad,
            threshold=self._endpoint_config.start_probability,
        )
        self._open_scene(ears)
        self._lane = AsrLane(ears.get("denoise") if isinstance(ears, Mapping) else None)

    def _open_scene(self, ears: Any) -> None:
        """The room reading of this stream (``ear_scene``): on only when ``ears.scene`` is ``score`` or
        ``ears.otherVoice`` is ``score`` or ``hold``; otherwise nothing is built and nothing is read."""
        self._scene, self._hold_other, self._gate_base = None, False, None
        if not isinstance(ears, Mapping):
            return
        scene = ears.get("scene") == "score"
        voice = ears.get("otherVoice") in ("score", "hold")
        if not (scene or voice):
            return
        try:
            from ear_scene import SceneTracker, SpeakerScorer

            speaker = SpeakerScorer(ears.get("ownerEmbedding")) if voice else None
            self._scene = SceneTracker(score_scene=scene, score_speaker=voice, speaker=speaker)
        except Exception:  # noqa: BLE001 — numpy missing: the room is simply not read
            self._scene = None
            return
        self._hold_other = ears.get("otherVoice") == "hold"

    def _apply_scene(self) -> None:
        """Make the voice gate stricter while music or a tv holds, and put it back when it clears. Only ever up:
        the Silero start becomes the larger of its own and 0.6; the energy margin gains 3 dB."""
        from ear_scene import GATE_START_RAISED

        raising = bool(self._scene is not None and self._scene.raising)
        if raising == (self._gate_base is not None):
            return
        gate = self._vad
        stream = getattr(gate, "_stream", None)
        if raising:
            if stream is not None and hasattr(stream, "start"):
                self._gate_base = ("silero", stream, float(stream.start))
                stream.start = max(float(stream.start), GATE_START_RAISED)
            elif hasattr(gate, "margin_db"):
                self._gate_base = ("energy", gate, float(gate.margin_db))
                gate.margin_db = float(gate.margin_db) + 3.0
            else:
                self._gate_base = ("none", None, 0.0)
            return
        self._restore_gate()

    def _restore_gate(self) -> None:
        base, self._gate_base = self._gate_base, None
        if base is None:
            return
        kind, target, value = base
        if kind == "silero":
            target.start = value
        elif kind == "energy":
            target.margin_db = value

    def _clear(self) -> None:
        self._restore_gate()
        if self._scene is not None:
            self._scene.reset()
        self._lane.reset()
        self._vad.reset()
        self._endpointer.reset()
        self._stabiliser.reset()
        self._turn = _Turn()
        self._carry = bytearray()
        self._partial = self._partial_dict(self._stabiliser.update([]), 0)
        self._reset_turn_state()

    def reset(self) -> None:
        if self._stream is not None and self.loaded:
            self._stream.reset()
        self._clear()

    def close(self) -> None:
        self._turn_worker.close()
        if self._stream is not None:
            self._stream.close()
        self._model_dir, self._providers_key = "", ()
        self._clear()

    def _need(self) -> Any:
        if not self.loaded:
            raise RuntimeError("the engine is not open")
        return self._stream

    @staticmethod
    def _partial_dict(partial: Any, audio_ms: int) -> dict[str, Any]:
        return {
            "text": partial.text,
            "committed": join_words(partial.committed),
            "stable": join_words(partial.stable),
            "volatile": join_words(partial.volatile),
            "newlyCommitted": join_words(partial.newly_committed),
            "revision": partial.revision,
            "audioMs": audio_ms,
        }

    def feed(self, pcm: Any) -> list[dict[str, Any]]:
        from transducer_loop import to_float_pcm

        stream = self._need()
        samples = to_float_pcm(pcm, self._carry)
        per_slice = stream.contract.sample_rate * SLICE_MS // 1000
        events: list[dict[str, Any]] = []
        for start in range(0, int(samples.size), per_slice):
            piece = samples[start : start + per_slice]
            self._vad.push(piece, int(piece.size * 1000 // stream.contract.sample_rate) or SLICE_MS)
            self._turn.audio_ms += int(piece.size * 1000 // stream.contract.sample_rate)
            self._hear(piece, int(piece.size * 1000 // stream.contract.sample_rate))
            heard = self._lane.feed(piece)  # the gate and the scorers read the raw piece; the engine gets this copy
            for event in stream.feed(heard) if heard.size else []:
                if event.text != self._turn.last_text:
                    self._turn.last_text = event.text
                    self._turn.last_token_ms = self._turn.audio_ms
                    partial = self._stabiliser.update(_words(event.text))
                    self._partial = self._partial_dict(partial, self._turn.audio_ms)
                    events.append({"type": "partial", **self._partial, "tokens": event.tokens})
            events += self._step_endpoint()
        return events

    def _hear(self, piece: Any, ms: int) -> None:
        """Keep the last 8 s of audio for Smart Turn and count the voiced time the gate heard."""
        if not self._ears_on:
            return
        if self._scene is not None:
            self._scene.push(piece)
            self._apply_scene()
        self._tail.append(piece)
        self._tail_samples += int(piece.size)
        keep = RATE * TURN_WINDOW_S
        while self._tail and self._tail_samples - int(self._tail[0].size) >= keep:
            self._tail_samples -= int(self._tail.popleft().size)
        if self._vad.probability >= self._endpoint_config.start_probability:
            self._voiced_ms += ms
            self._turn_voiced_ms += ms

    def _score_turn(self) -> None:
        """Ask Smart Turn once per pause, about ``vad_stop_ms`` after the voice gate stopped; speech clears it so
        the next pause is scored on the whole turn again. The read runs on the worker thread: this call returns at once
        and a verdict is applied on a later call. No answer is never waited for."""
        self._collect_verdict()
        if not self._smart_turn or not self._endpointer.in_turn:
            return
        if self._vad.probability >= self._endpoint_config.start_probability:
            if self._scored or self._turn_p is not None:
                self._turn_gen += 1  # the pause that was asked about is over
                self._turn_worker.cancel()
            self._turn_p, self._scored = None, False
            return
        if self._scored or self._vad.silence_ms < self._endpoint_config.vad_stop_ms or not self._tail:
            return
        self._scored = True
        import numpy as np

        self.turn_state = "pending"
        self._turn_worker.submit(np.concatenate(list(self._tail)), RATE, self._turn_gen)
        self._collect_verdict()  # an inline worker has already finished: the verdict counts in this very call

    def _collect_verdict(self) -> None:
        """Apply a finished Smart Turn read, once, when it still belongs to the pause being heard."""
        verdict = self._turn_worker.poll()
        if verdict is None or verdict.token != self._turn_gen or not self._endpointer.in_turn:
            return
        answer = verdict.answer
        if answer is None:  # a failing model leaves the silence rules alone for the rest of the stream
            self._smart_turn = False
            self.turn_state = "turn-score-failed"
            return
        probability = answer.get("probability") if answer.get("ready") else None
        if isinstance(probability, (int, float)) and 0.0 <= float(probability) <= 1.0:
            self._turn_p = float(probability)
            self.turn_state = "scored"
        elif "absent" in str(answer.get("reason") or ""):
            self._smart_turn = False  # no file on this PC: stop asking for the rest of the stream
            self.turn_state = "absent"
        else:
            self.turn_state = "idle"

    def _step_endpoint(self) -> list[dict[str, Any]]:
        t = self._turn
        self._score_turn()
        obs = Observation(
            vad_probability=self._vad.probability,
            trailing_silence_ms=self._vad.silence_ms,
            token_age_ms=max(0, t.audio_ms - t.last_token_ms),
            text=t.last_text,
            turn_probability=self._turn_p,
        )
        decision = self._endpointer.step(obs)
        t.decision = {
            "event": str(decision.event) if decision.event is not None else None,
            "requiredWaitMs": decision.required_wait_ms,
            "reason": decision.reason,
        }
        if self._ears_on:
            if t.decision["event"] == "StartOfTurn":
                self._turn_voiced_ms = 0
                if self._scene is not None:
                    self._scene.new_turn()
            for note in self._tracker.step(obs, decision):
                self._pending_turns.append(
                    {
                        "turnId": note.turn_id,
                        "event": note.event,
                        "text": note.text,
                        "vadP": round(float(self._vad.probability), 3),
                        "speechMs": self._turn_voiced_ms,
                        **self._scene_notes(),
                    }
                )
        if decision.event is None:
            return []
        return [{"type": "endpoint", **t.decision, "audioMs": t.audio_ms, "silenceMs": self._vad.silence_ms}]

    def _scene_notes(self) -> dict[str, Any]:
        """``env``, ``speaker`` and ``needsWake`` for a turn note: tags only, and only the ones switched on. Nothing an
        approval reads: ``speaker`` labels the turn and ``needsWake`` can only ask for MORE proof, never less."""
        scene = self._scene
        if scene is None:
            return {}
        out: dict[str, Any] = {}
        env = scene.env
        if env is not None:
            out["env"] = env
        who = scene.speaker_tag
        if who is not None:
            out["speaker"] = who
        if self._hold_other:
            tv = scene.raising and env is not None and env["kind"] == "tv"
            out["needsWake"] = bool(tv or (who is not None and who["tag"] == "other"))
        return out

    def take_turns(self) -> list[dict[str, Any]]:
        """The turn-protocol notes since the last call (empty without ``ears``)."""
        out, self._pending_turns = self._pending_turns, []
        return out

    def _gate_final(self, text: str, audio_ms: int, locale: str) -> str:
        """The reason a final reading is not trusted (``transcript_gate.stream_text_dropped``), or ''. The voiced time
        is the gate's own count when it is Silero; the energy gate gives no evidence, so only the text rules apply."""
        if not self._ears_on or not text.strip():
            return ""
        if self._scene is not None and self._scene.raising:
            from ear_scene import MIN_WORDS_RAISED

            if len(_words(text)) < MIN_WORDS_RAISED:
                return "scene-needs-words"
        voiced = float(self._voiced_ms) if self.vad_engine == "silero" else None
        fraction = voiced / audio_ms if voiced is not None and audio_ms > 0 else None
        return stream_text_dropped(
            text,
            duration_s=audio_ms / 1000.0,
            speech_fraction=fraction,
            voiced_ms=voiced,
            language=_language_of(locale),
        )

    def partial(self) -> dict[str, Any]:
        return dict(self._partial)

    def committed(self) -> str:
        return join_words(self._stabiliser.committer.all_committed)

    def endpoint(self) -> dict[str, Any]:
        return {**self._turn.decision, "inTurn": self._endpointer.in_turn, "audioMs": self._turn.audio_ms}

    def finalize(self) -> dict[str, Any]:
        stream = self._need()
        tail = self._lane.flush()  # the samples the clean-up copy still owes reach the engine before the final reading
        if tail is not None and tail.size:
            stream.feed(tail)
        result = stream.finalize()
        self._stabiliser.update(_words(result.text))
        final = self._stabiliser.finalize()
        audio_ms = max(1, result.audio_ms)
        dropped = self._gate_final(result.text, audio_ms, stream.locale)
        return {
            "text": "" if dropped else result.text,
            "committed": "" if dropped else join_words(final.committed),
            "words": []
            if dropped
            else [
                {"text": w.text, **({} if w.start_ms is None else {"startMs": w.start_ms, "endMs": w.end_ms})}
                for w in result.words
            ],
            **({"dropped": dropped} if dropped else {}),
            "audioMs": result.audio_ms,
            "chunks": result.chunks,
            "computeMs": round(result.compute_ms, 1),
            "rtf": round(result.compute_ms / audio_ms, 3),
            "engine": self.name,
            "locale": stream.locale,
            "providers": list(stream.active_providers),
            "denoise": self._lane.status(),
        }


def _clean_hotwords(raw: Any) -> list[str]:
    items = raw if isinstance(raw, (list, tuple)) else []
    return [str(w).strip()[:MAX_HOTWORD_CHARS] for w in items if str(w).strip()][:MAX_HOTWORDS]


class La2Engine(TransducerEngine):
    """``SttEngine`` over ``la2_partials.La2Partials``, for an ear that re-decodes a rolling window (the Hindi ear, a
    resident Whisper). ``make_reader(model_dir, turn, hotwords)`` builds the reader of one stream (``turn`` is its
    ``TurnLanguage``); a reader with ``rescore(turn_audio, words, turn) -> (text, changed)`` reads the finished turn
    once more, one forced language per segment. The voice gate, endpointer and stabiliser are the transducer's."""

    def __init__(
        self,
        name: str,
        make_reader: Callable[[Path, TurnLanguage, list[str]], Any],
        *,
        hop_s: float = 0.5,
        endpoint_config: EndpointConfig | None = None,
    ) -> None:
        super().__init__(None, endpoint_config=endpoint_config)
        self.name = name
        self._make_reader = make_reader
        self._hop_s = hop_s
        self._reader: Any = None
        self._la2: La2Partials | None = None
        self._lang = TurnLanguage("")
        self._locale = ""
        self._hotwords: list[str] = []

    @property
    def loaded(self) -> bool:
        return self._la2 is not None

    def open(self, model_dir: str | Path, **options: Any) -> dict[str, Any]:
        self._locale = str(options.get("locale") or "")
        self._hotwords = _clean_hotwords(options.get("hotwords"))
        self._open_endpoint(options.get("endpoint"), options.get("ears"))
        self._open_vad(options.get("ears"))
        started = time.perf_counter()
        self._model_dir = str(model_dir)
        self._lang = TurnLanguage(self._locale)
        self._reader = self._make_reader(Path(model_dir), self._lang, self._hotwords)
        self._la2 = La2Partials(self._reader, hop_s=self._hop_s, stabiliser=self._stabiliser)
        self._clear()
        return {
            "engine": self.name,
            "locale": self._locale,
            "language": self._lang.decode_language(),
            "providers": [],
            "chunkMs": int(self._hop_s * 1000),
            "loadMs": int((time.perf_counter() - started) * 1000),
            "hotwords": len(self._hotwords),
            "vad": self.vad_engine,
            "denoise": self._lane.status(),
        }

    def _clear(self) -> None:
        super()._clear()
        la2 = getattr(self, "_la2", None)
        if la2 is not None:
            la2.reset()

    def reset(self) -> None:
        """A new turn: a fresh language decision and a fresh reader, same model and hotwords."""
        if self._la2 is not None:
            self._lang = TurnLanguage(self._locale)
            self._reader = self._make_reader(Path(self._model_dir), self._lang, self._hotwords)
            self._la2.reader = self._reader
        self._clear()

    def close(self) -> None:
        self._reader, self._la2, self._model_dir = None, None, ""
        self._clear()

    def _need_la2(self) -> La2Partials:
        if self._la2 is None:
            raise RuntimeError("the engine is not open")
        return self._la2

    def feed(self, pcm: Any) -> list[dict[str, Any]]:
        from transducer_loop import to_float_pcm

        la2 = self._need_la2()
        samples = to_float_pcm(pcm, self._carry)
        per_slice = RATE * SLICE_MS // 1000
        for start in range(0, int(samples.size), per_slice):
            piece = samples[start : start + per_slice]
            ms = int(piece.size * 1000 // RATE)
            self._vad.push(piece, ms or SLICE_MS)
            self._turn.audio_ms += ms
            self._hear(piece, ms)
        events: list[dict[str, Any]] = []
        partial = la2.push(self._lane.feed(samples))  # the gate above read the raw samples; the ear gets the copy
        if partial is not None and partial.revision != self._partial.get("revision"):
            if partial.text != self._turn.last_text:
                self._turn.last_text = partial.text
                self._turn.last_token_ms = self._turn.audio_ms
            self._partial = self._partial_dict(partial, self._turn.audio_ms)
            events.append({"type": "partial", **self._partial, "language": self._lang.decode_language()})
        return events + self._step_endpoint()

    def finalize(self) -> dict[str, Any]:
        la2 = self._need_la2()
        tail = self._lane.flush()
        if tail is not None and tail.size:
            la2.push(tail)
        final = la2.finalize()
        words = list(final.committed)
        text = join_words(words)
        changed = 0
        compute_s = la2.compute_s
        rescore: Callable[..., tuple[str, int]] | None = getattr(self._reader, "rescore", None)
        if rescore is not None and words:
            started = time.perf_counter()
            try:
                base = la2.turn_start_s
                local = [
                    Word(w.text, None if w.start is None else w.start - base, None if w.end is None else w.end - base)
                    for w in words
                ]
                better, changed = rescore(la2.turn_audio(), local, self._lang)
                text = better or text
            except Exception:  # noqa: BLE001 — the agreed words stand when the second look fails
                changed = 0
            compute_s += time.perf_counter() - started
        audio_ms = int(la2.audio_s * 1000)
        dropped = self._gate_final(text, max(1, audio_ms), self._locale)
        return {
            "text": "" if dropped else text,
            "committed": "" if dropped else join_words(final.committed),
            "words": [] if dropped else [_word_row(w) for w in words],
            **({"dropped": dropped} if dropped else {}),
            "audioMs": audio_ms,
            "chunks": la2.readings,
            "computeMs": round(compute_s * 1000, 1),
            "rtf": round(compute_s * 1000 / max(1, audio_ms), 3),
            "engine": self.name,
            "locale": self._locale,
            "language": self._lang.decode_language(),
            "rescored": changed,
            "providers": [],
            "denoise": self._lane.status(),
        }


def _word_row(w: Any) -> dict[str, Any]:
    if w.start is None:
        return {"text": w.text}
    return {"text": w.text, "startMs": int(w.start * 1000), "endMs": int((w.end or w.start) * 1000)}


def _nemotron_languages(folder: Path) -> set[str]:
    try:
        table = json.loads((folder / "languages.json").read_text(encoding="utf-8")).get("promptDictionary") or {}
    except (OSError, ValueError):
        return set()
    return {str(k).lower() for k in table}


register_engine(
    EngineSpec(
        name=ENGINE_NAME,
        folder=ENGINE_NAME,
        files=NEMOTRON_FILES,
        factory=TransducerEngine,
        aliases=("nemotron",),
        languages=_nemotron_languages,
        priority=10,
    )
)


# ---- the worker's slot --------------------------------------------------------------------------------------------


def _error_text(exc: BaseException) -> str:
    """The class and a message with paths and long tokens blanked: a reply never carries a folder name."""
    try:
        from voice_runtime import _safe_error

        return _safe_error(exc)
    except Exception:  # noqa: BLE001 - without the scrubber only the class name leaves
        return type(exc).__name__


def _clean_id(raw: Any) -> str:
    text = str(raw).strip() if isinstance(raw, (str, int)) else ""
    return text[:MAX_ID_CHARS] or "default"


class StreamHost:
    """One loaded engine and one active stream for the STT worker. ``handle`` never raises."""

    def __init__(self, clock: Callable[[], float] = time.perf_counter) -> None:
        self._clock = clock
        self._engine: SttEngine | None = None
        self._spec: EngineSpec | None = None
        self.active: str | None = None
        self.hardware: Callable[[], str | None] = lambda: None  # the worker sets its probe (small-cpu, mid, gpu)
        self._tier: str | None = None
        self._tier_read = False
        self._ledger: RtfLedger | None = None
        # One writer of the slot at a time: a warm runs on the worker's warm thread, the stream ops on its main one.
        self._lock = threading.Lock()

    def tier(self) -> str | None:
        """The hardware tier, read once per worker. None means no speed gate (never a refused stream)."""
        if not self._tier_read:
            self._tier_read = True
            try:
                found = self.hardware()
            except Exception:  # noqa: BLE001
                found = None
            self._tier = found if found in TIERS else None
        return self._tier

    def ledger(self) -> RtfLedger:
        path = model_root() / RTF_FILE
        if self._ledger is None or self._ledger.path != path:
            self._ledger = RtfLedger(path)
        return self._ledger

    def loaded_name(self) -> list[str]:
        engine = self._engine
        return [engine.name] if engine is not None and getattr(engine, "loaded", False) else []

    def unload(self) -> list[str]:
        """Close the engine. While a warm is loading it, nothing is unloaded (the next idle tick tries again)."""
        if not self._lock.acquire(timeout=HOST_WAIT_S):
            return []
        try:
            names = self.loaded_name()
            if self._engine is not None:
                self._engine.close()
            self._engine, self._spec, self.active = None, None, None
            return names
        finally:
            self._lock.release()

    def warm(self, req: dict[str, Any]) -> dict[str, Any]:
        """``stream-warm`` {streamEngine|engine, locale?, providers?} -> {ok, op, engine, loadedMs, already}.

        Loads the model the next ``stream-open`` with the same engine and providers reuses, and opens no stream.
        Idempotent: a loaded engine answers ``already: true`` with ``loadedMs: 0``; a live stream is never touched."""
        started = self._clock()
        with self._lock:
            try:
                return self._warm(req, started)
            except Exception as exc:  # noqa: BLE001 - a failed warm never stops the worker
                if self._engine is not None and self.active is None:
                    self._engine.close()
                    self._engine, self._spec = None, None
                kind = str(getattr(exc, "kind", "") or "warm-failed")
                return {"ok": False, "op": WARM_OP, "reason": kind, "error": _error_text(exc), "fallback": True}

    def _warm(self, req: dict[str, Any], started: float) -> dict[str, Any]:
        locale = str(req.get("locale") or req.get("language") or "")
        choice = choose_tier(req.get("streamEngine", req.get("engine")), locale, tier=self.tier(), ledger=self.ledger())
        if choice.engine is None or choice.model_dir is None:
            reason = "stream-engine-off" if choice.reason == "off" else choice.reason
            return {"ok": False, "op": WARM_OP, "reason": reason, "fallback": True}
        spec = engine_spec(choice.engine)
        if spec is None:
            return {"ok": False, "op": WARM_OP, "reason": "unknown-engine", "fallback": True}
        if self._engine is not None and self._spec is spec and self.loaded_name():
            return {"ok": True, "op": WARM_OP, "engine": spec.name, "loadedMs": 0, "already": True}
        if self.active is not None:
            return {"ok": False, "op": WARM_OP, "reason": "stream-active", "fallback": True}
        if self._engine is not None:
            self._engine.close()
        self._engine, self._spec = spec.factory(), spec
        self._engine.open(choice.model_dir, locale=locale or "en-US", providers=req.get("providers"))
        self._engine.reset()
        loaded_ms = int((self._clock() - started) * 1000)
        return {"ok": True, "op": WARM_OP, "engine": spec.name, "loadedMs": loaded_ms, "already": False}

    def status(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "engines": engine_names(),
            "pinReady": any(pin_dir(spec) is not None for spec in map(_REGISTRY.get, engine_names()) if spec),
            "loaded": bool(self.loaded_name()),
            "active": self.active,
        }
        lane = getattr(self._engine, "_lane", None)
        if out["loaded"] and isinstance(lane, AsrLane):
            out["denoise"] = lane.status()  # the Doctor row: the engine, whether it runs, its speed and why not
        return out

    def handle(self, req: dict[str, Any]) -> dict[str, Any]:
        """Ops. Every reply is ``{"ok": bool, "op": ..., "streamId": ...}``; a refusal is ``ok: false`` with a reason.

        ``stream-open``  {streamEngine|engine, locale, hotwords?, providers?, endpoint?, ears?, streamId?}
                         -> {engine, locale, providers, chunkMs, loadMs, hotwords, vad, replaced?}
                         (``ears`` holds ``vad`` auto|silero|energy, ``vadStart``, ``vadEnd``, ``minSpeechMs``,
                         ``preRollMs``; clamped in ``vad_onnx.clamp_config``)
        ``stream-feed``  {streamId?, pcm: base64 of int16 little-endian 16 kHz mono}
                         -> {events: [partial | endpoint], text, committed, audioMs, endpoint, turn?, turns?}
        ``stream-close`` {streamId?, finalize?: true} -> {final: true, text, words, audioMs, rtf, ...}
                         (finalize false drops the audio and returns {final: false}).
        """
        op = str(req.get("op") or "")
        if not self._lock.acquire(timeout=HOST_WAIT_S):
            return {"ok": False, "op": op, "reason": "warming", "fallback": True}
        try:
            return self._handle(op, req)
        finally:
            self._lock.release()

    def _handle(self, op: str, req: dict[str, Any]) -> dict[str, Any]:
        try:
            if op == "stream-open":
                return self._open(req)
            if op == "stream-feed":
                return self._feed(req)
            if op == "stream-close":
                return self._close(req)
        except Exception as exc:  # noqa: BLE001 — a bad stream never stops the worker
            self.active = None
            kind = str(getattr(exc, "kind", "") or "stream-error")
            return {"ok": False, "op": op, "reason": kind, "error": _error_text(exc)}
        return {"ok": False, "op": op, "reason": "unknown-op", "error": f"unknown op {op!r}"}

    def _open(self, req: dict[str, Any]) -> dict[str, Any]:
        sid = _clean_id(req.get("streamId"))
        locale = str(req.get("locale") or req.get("language") or "")
        choice = choose_tier(req.get("streamEngine", req.get("engine")), locale, tier=self.tier(), ledger=self.ledger())
        if choice.engine is None or choice.model_dir is None:
            reason = "stream-engine-off" if choice.reason == "off" else choice.reason
            return {"ok": False, "op": "stream-open", "streamId": sid, "reason": reason, "fallback": True}
        spec = engine_spec(choice.engine)
        if spec is None:
            return {"ok": False, "op": "stream-open", "streamId": sid, "reason": "unknown-engine", "fallback": True}
        if self._engine is None or self._spec is not spec:
            if self._engine is not None:
                self._engine.close()
            self._engine, self._spec = spec.factory(), spec
        replaced = self.active
        options: dict[str, Any] = {
            "locale": locale or "en-US",
            "providers": req.get("providers"),
            "hotwords": req.get("hotwords"),
            "endpoint": req.get("endpoint"),
            "ears": req.get("ears"),
        }
        self.active = None
        started = self._clock()
        try:
            info = self._engine.open(choice.model_dir, **options)
        except Exception as exc:  # noqa: BLE001
            kind = str(getattr(exc, "kind", "") or "open-failed")
            reason = "locale-unsupported" if kind == "locale" else "open-failed"
            return {
                "ok": False,
                "op": "stream-open",
                "streamId": sid,
                "reason": reason,
                "error": _error_text(exc),
                "fallback": True,
            }
        self.active = sid
        reply: dict[str, Any] = {"ok": True, "op": "stream-open", "streamId": sid, **info}
        if choice.tier is not None:
            reply["tier"] = choice.tier
            if choice.rtf is not None:
                reply["measuredRtf"] = choice.rtf
        reply["elapsedMs"] = int((self._clock() - started) * 1000)
        if replaced is not None and replaced != sid:
            reply["replaced"] = replaced
        return reply

    def _live(self, req: dict[str, Any], op: str) -> tuple[SttEngine | None, str, dict[str, Any] | None]:
        sid = _clean_id(req.get("streamId")) if req.get("streamId") is not None else (self.active or "default")
        if self._engine is None or self.active is None or sid != self.active:
            return None, sid, {"ok": False, "op": op, "streamId": sid, "reason": "no-stream"}
        return self._engine, sid, None

    def _feed(self, req: dict[str, Any]) -> dict[str, Any]:
        engine, sid, refusal = self._live(req, "stream-feed")
        if engine is None:
            return refusal or {}
        raw = req.get("pcm") if req.get("pcm") is not None else req.get("pcm16")
        if not isinstance(raw, str):
            return {"ok": False, "op": "stream-feed", "streamId": sid, "reason": "bad-audio", "error": "pcm is missing"}
        if len(raw) > MAX_FEED_BYTES * 4 // 3 + 8:
            return {"ok": False, "op": "stream-feed", "streamId": sid, "reason": "too-large"}
        try:
            data = base64.b64decode(raw, validate=True)
        except (binascii.Error, ValueError):
            return {"ok": False, "op": "stream-feed", "streamId": sid, "reason": "bad-audio", "error": "not base64"}
        events = engine.feed(data)
        snap = engine.partial()
        reply: dict[str, Any] = {
            "ok": True,
            "op": "stream-feed",
            "streamId": sid,
            "events": events,
            "text": snap["text"],
            "committed": snap["committed"],
            "audioMs": snap["audioMs"],
            "endpoint": engine.endpoint(),
        }
        take_turns: Callable[[], list[dict[str, Any]]] | None = getattr(engine, "take_turns", None)
        turns = take_turns() if take_turns is not None else []
        if turns:
            reply["turn"], reply["turns"] = turns[-1], turns
        return reply

    def _close(self, req: dict[str, Any]) -> dict[str, Any]:
        engine, sid, refusal = self._live(req, "stream-close")
        if engine is None:
            return refusal or {}
        self.active = None
        if req.get("finalize") is False:
            engine.reset()
            return {"ok": True, "op": "stream-close", "streamId": sid, "final": False}
        result = engine.finalize()
        engine.reset()
        tier, rtf = self.tier(), result.get("rtf")
        if tier is not None and isinstance(rtf, (int, float)) and int(result.get("audioMs") or 0) >= RTF_MIN_AUDIO_MS:
            self.ledger().record(engine.name, tier, float(rtf))
        return {"ok": True, "op": "stream-close", "streamId": sid, "final": True, **result}


HOST = StreamHost()
