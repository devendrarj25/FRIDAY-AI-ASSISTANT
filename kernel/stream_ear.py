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
* ``TransducerEngine`` wires ``transducer_loop.NemotronStream`` to ``EnergyVad``, ``endpointer.Endpointer`` and
  ``stream_commit.PartialStabiliser``. Audio is processed in 20 ms slices on the audio clock (no wall clock), so a
  run repeats exactly. ``endpoint`` events follow ``endpointer`` (StartOfTurn, EagerEndOfTurn, TurnResumed,
  EndOfTurn); the engine never ends a turn by itself: the caller calls ``finalize``.
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
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from endpointer import EndpointConfig, Endpointer, Observation
from stream_commit import LocalAgreementCommitter, PartialStabiliser, join_words

ENGINE_NAME = "stream-ear-nemotron"
SETTING_KEY = "voice.streamEngine"
STREAM_OPS = frozenset({"stream-open", "stream-feed", "stream-close"})
SLICE_MS = 20
MAX_FEED_BYTES = 1_048_576
MAX_ID_CHARS = 64
MAX_HOTWORDS = 200
MAX_HOTWORD_CHARS = 80
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
    reason: str  # ok, off, unknown-engine, runtime-missing, pin-missing, locale-unsupported
    model_dir: Path | None = None


def _wants(setting: Any, spec: EngineSpec) -> bool:
    key = str(setting).strip().lower()
    return key == "auto" or key == spec.name.lower() or key in {a.lower() for a in spec.aliases}


def choose_tier(
    setting: Any,
    locale: str = "",
    *,
    root: Path | None = None,
    find_spec: Callable[[str], Any] = importlib.util.find_spec,
) -> TierChoice:
    """The engine to use, or None with the reason. Never an engine whose pin is missing or whose setting is not on."""
    key = "" if setting is None or setting is False else str(setting).strip().lower()
    if key in OFF_VALUES:
        return TierChoice(None, "off")
    candidates = [s for s in map(_REGISTRY.get, engine_names()) if s is not None and _wants(key, s)]
    if not candidates:
        return TierChoice(None, "unknown-engine")
    reason = "pin-missing"
    for spec in candidates:
        if not runtime_ready(spec, find_spec):
            reason = "runtime-missing"
            continue
        folder = pin_dir(spec, root)
        if folder is None:
            reason = "pin-missing"
            continue
        if locale and spec.languages is not None and not _locale_ok(spec.languages(folder), locale):
            reason = "locale-unsupported"
            continue
        return TierChoice(spec.name, "ok", folder)
    return TierChoice(None, reason)


def _locale_ok(known: set[str], locale: str) -> bool:
    raw = locale.strip().replace("_", "-").lower()
    if not raw or raw == "auto":
        return "auto" in known
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


def _words(text: str) -> list[str]:
    return text.split()


@dataclass
class _Turn:
    audio_ms: int = 0
    last_token_ms: int = 0
    last_text: str = ""
    decision: dict[str, Any] = field(default_factory=lambda: {"event": None, "requiredWaitMs": 0, "reason": "idle"})


class TransducerEngine:
    """``SttEngine`` over ``transducer_loop.NemotronStream``."""

    name = ENGINE_NAME

    def __init__(self, stream: Any = None, *, endpoint_config: EndpointConfig | None = None) -> None:
        self._stream = stream
        self._endpoint_config = endpoint_config or EndpointConfig()
        self._vad = EnergyVad()
        self._endpointer = Endpointer(self._endpoint_config)
        self._stabiliser = PartialStabiliser(LocalAgreementCommitter())
        self._turn = _Turn()
        self._carry = bytearray()
        self._model_dir = ""
        self._providers_key: tuple[str, ...] = ()
        self._partial: dict[str, Any] = self._partial_dict(self._stabiliser.update([]), 0)

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
        overrides = options.get("endpoint")
        if isinstance(overrides, Mapping):
            allowed = EndpointConfig.__dataclass_fields__
            self._endpoint_config = EndpointConfig(**{k: v for k, v in overrides.items() if k in allowed})
        self._endpointer = Endpointer(self._endpoint_config)
        key = tuple(providers) if isinstance(providers, (list, tuple)) else ()
        if self._stream is None:
            from transducer_loop import NemotronStream

            self._stream = NemotronStream()
        info: dict[str, Any]
        if self.loaded and self._model_dir == str(model_dir) and self._providers_key == key:
            self._stream.configure(locale, hotwords)
            info = {"providers": list(self._stream.active_providers), "chunkMs": self._stream.chunk_ms, "loadMs": 0}
        else:
            info = self._stream.open(model_dir, providers, locale, hotwords)
            self._model_dir, self._providers_key = str(model_dir), key
        self._clear()
        return {**info, "engine": self.name, "locale": locale, "hotwords": self._stream.hotword_count}

    def _clear(self) -> None:
        self._vad.reset()
        self._endpointer.reset()
        self._stabiliser.reset()
        self._turn = _Turn()
        self._carry = bytearray()
        self._partial = self._partial_dict(self._stabiliser.update([]), 0)

    def reset(self) -> None:
        if self._stream is not None and self.loaded:
            self._stream.reset()
        self._clear()

    def close(self) -> None:
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
            for event in stream.feed(piece):
                if event.text != self._turn.last_text:
                    self._turn.last_text = event.text
                    self._turn.last_token_ms = self._turn.audio_ms
                    partial = self._stabiliser.update(_words(event.text))
                    self._partial = self._partial_dict(partial, self._turn.audio_ms)
                    events.append({"type": "partial", **self._partial, "tokens": event.tokens})
            events += self._step_endpoint()
        return events

    def _step_endpoint(self) -> list[dict[str, Any]]:
        t = self._turn
        decision = self._endpointer.step(
            Observation(
                vad_probability=self._vad.probability,
                trailing_silence_ms=self._vad.silence_ms,
                token_age_ms=max(0, t.audio_ms - t.last_token_ms),
                text=t.last_text,
            )
        )
        t.decision = {
            "event": str(decision.event) if decision.event is not None else None,
            "requiredWaitMs": decision.required_wait_ms,
            "reason": decision.reason,
        }
        if decision.event is None:
            return []
        return [{"type": "endpoint", **t.decision, "audioMs": t.audio_ms, "silenceMs": self._vad.silence_ms}]

    def partial(self) -> dict[str, Any]:
        return dict(self._partial)

    def committed(self) -> str:
        return join_words(self._stabiliser.committer.all_committed)

    def endpoint(self) -> dict[str, Any]:
        return {**self._turn.decision, "inTurn": self._endpointer.in_turn, "audioMs": self._turn.audio_ms}

    def finalize(self) -> dict[str, Any]:
        stream = self._need()
        result = stream.finalize()
        self._stabiliser.update(_words(result.text))
        final = self._stabiliser.finalize()
        audio_ms = max(1, result.audio_ms)
        return {
            "text": result.text,
            "committed": join_words(final.committed),
            "words": [
                {"text": w.text, **({} if w.start_ms is None else {"startMs": w.start_ms, "endMs": w.end_ms})}
                for w in result.words
            ],
            "audioMs": result.audio_ms,
            "chunks": result.chunks,
            "computeMs": round(result.compute_ms, 1),
            "rtf": round(result.compute_ms / audio_ms, 3),
            "engine": self.name,
            "locale": stream.locale,
            "providers": list(stream.active_providers),
        }


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

    def loaded_name(self) -> list[str]:
        engine = self._engine
        return [engine.name] if engine is not None and getattr(engine, "loaded", False) else []

    def unload(self) -> list[str]:
        names = self.loaded_name()
        if self._engine is not None:
            self._engine.close()
        self._engine, self._spec, self.active = None, None, None
        return names

    def status(self) -> dict[str, Any]:
        return {
            "engines": engine_names(),
            "pinReady": any(pin_dir(spec) is not None for spec in map(_REGISTRY.get, engine_names()) if spec),
            "loaded": bool(self.loaded_name()),
            "active": self.active,
        }

    def handle(self, req: dict[str, Any]) -> dict[str, Any]:
        """Ops. Every reply is ``{"ok": bool, "op": ..., "streamId": ...}``; a refusal is ``ok: false`` with a reason.

        ``stream-open``  {streamEngine|engine, locale, hotwords?, providers?, endpoint?, streamId?}
                         -> {engine, locale, providers, chunkMs, loadMs, hotwords, replaced?}
        ``stream-feed``  {streamId?, pcm: base64 of int16 little-endian 16 kHz mono}
                         -> {events: [partial | endpoint], text, committed, audioMs, endpoint}
        ``stream-close`` {streamId?, finalize?: true} -> {final: true, text, words, audioMs, rtf, ...}
                         (finalize false drops the audio and returns {final: false}).
        """
        op = str(req.get("op") or "")
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
            return {"ok": False, "op": op, "reason": kind, "error": f"{type(exc).__name__}: {exc}"[-400:]}
        return {"ok": False, "op": op, "reason": "unknown-op", "error": f"unknown op {op!r}"}

    def _open(self, req: dict[str, Any]) -> dict[str, Any]:
        sid = _clean_id(req.get("streamId"))
        locale = str(req.get("locale") or req.get("language") or "")
        choice = choose_tier(req.get("streamEngine", req.get("engine")), locale)
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
                "error": f"{type(exc).__name__}: {exc}"[-400:],
                "fallback": True,
            }
        self.active = sid
        reply: dict[str, Any] = {"ok": True, "op": "stream-open", "streamId": sid, **info}
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
        return {
            "ok": True,
            "op": "stream-feed",
            "streamId": sid,
            "events": events,
            "text": snap["text"],
            "committed": snap["committed"],
            "audioMs": snap["audioMs"],
            "endpoint": engine.endpoint(),
        }

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
        return {"ok": True, "op": "stream-close", "streamId": sid, "final": True, **result}


HOST = StreamHost()
