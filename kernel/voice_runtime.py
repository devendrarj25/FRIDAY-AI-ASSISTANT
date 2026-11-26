"""FRIDAY local voice runtime.

The FastAPI process does not import this module at startup. Missing files
and missing packages are a not-ready status, never a crash. ``status`` and
``--check`` never download.

Listening: when ``silero_vad.onnx`` is on disk, it is scored with the
onnxruntime FRIDAY already installs. Otherwise the desktop energy VAD
remains the listener. The Silero pip package is not used; it requires torch.
Smart Turn, when its ONNX file is present, can only lengthen a pause. Noise
suppression is pyrnnoise on PCM when that wheel imports. FRIDAY Echo
(echo_canceller.py, pyaec) is optional: the live microphone path cleans with the renderer's own canceller
(`audio-aec.ts`, setting `voice.echoReference`); this module only measures it (`echo-shadow`, levels, never a gate).

Speaking: FRIDAY Voice (``friday_voice``, own runner of the Supertonic 3 graphs; code MIT, weights OpenRAIL-M) with
the FRIDAY persona (``voice_persona``: a blend of the open voice presets plus the finishing chain of ``voice_fx``),
when ``models/supertonic-3`` is on disk. A request is cut into clauses (``tts_frontend``), its delivery tags are read
by ``tts_delivery`` (only for text the caller marks ``trusted``), and each clause is made, trimmed and finished in
turn so the first one can play at once. When the own engine is absent or fails, the ``supertonic`` package speaks
exactly as before. No automatic download on a speak call. System voices remain the offline speaker until then.
Cloud speech is decided by the desktop, not here.

Speaker verification stays not-ready. A missing verifier is not a match and
never approves an action.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import queue
import re
import shutil
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import echo_canceller
import language_segmenter
import tts_hindi_light

SILERO_NAME = "silero_vad.onnx"
SILERO_SHA256 = "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3"
SILERO_BYTES = 2327524


def voice_root() -> Path:
    root = os.environ.get("FRIDAY_ROOT", "").strip()
    base = Path(root) if root else Path.home() / ".friday"
    return base / "models"


def find_named(name: str) -> Path | None:
    root = voice_root()
    candidates = [
        root / name,
        root / "voice" / name,
        root / "silero-vad" / name,
        root / "kokoro-v1" / name,
        root / "smart-turn" / name,
    ]
    for path in candidates:
        try:
            if path.is_file() and path.stat().st_size > 0:
                return path
        except OSError:
            continue
    return None


def disk_room(path: Path, need_bytes: int) -> dict:
    """True when the volume can hold ``need_bytes``. Unmeasured is not a pass."""
    try:
        usage = shutil.disk_usage(path if path.exists() else path.parent)
    except OSError as exc:
        return {"ok": False, "measured": False, "free": None, "reason": str(exc)}
    free = int(usage.free)
    if need_bytes <= 0:
        return {"ok": True, "measured": True, "free": free, "reason": ""}
    if free < need_bytes:
        return {"ok": False, "measured": True, "free": free, "reason": "disk full"}
    return {"ok": True, "measured": True, "free": free, "reason": ""}


def memory_status() -> dict:
    """Total and free physical memory in GB, from the one reader in stt.py (ctypes on Windows, /proc on Linux).

    The voice budget itself (which speech size this PC carries) is chosen in electron/voice-weights.cjs ``budgetFor``;
    this only reports what the kernel sees, so the check and the Doctor show the same machine.
    """
    try:
        import stt

        reading = stt.read_memory_mb()
    except Exception:  # noqa: BLE001 - an unreadable machine is unknown, never an error
        reading = None
    if not reading:
        return {"known": False, "totalGb": None, "freeGb": None}
    available_mb, total_mb = reading
    return {"known": True, "totalGb": round(total_mb / 1024, 1), "freeGb": round(available_mb / 1024, 1)}


def execution_providers() -> dict:
    available: list[str] = []
    try:
        import onnxruntime as ort  # type: ignore

        available = list(ort.get_available_providers())
    except Exception:  # noqa: BLE001 — missing runtime is a CPU fallback
        available = []
    selected = "CPUExecutionProvider"
    if "CUDAExecutionProvider" in available:
        selected = "CUDAExecutionProvider"
    elif "DmlExecutionProvider" in available:
        selected = "DmlExecutionProvider"
    return {
        "available": available or ["CPUExecutionProvider"],
        "selected": selected if available else "CPUExecutionProvider",
        "cpuFallback": True,
        "gpuDetected": bool(available) and selected != "CPUExecutionProvider",
    }


def session_providers(use_directml: bool = False) -> list[str]:
    """CPU stays on the list. DirectML is an extra provider, never the only one."""
    cpu = "CPUExecutionProvider"
    if use_directml:
        return ["DmlExecutionProvider", cpu]
    return [cpu]


SUPERTONIC_DIR = "supertonic-3"
SUPERTONIC_VOICE = "F2"
SMART_TURN_NAME = "smart-turn-v3.2-cpu.onnx"
SMART_TURN_SHA256 = "2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f"
SMART_TURN_BYTES = 8679182
LOCAL_TTS_REASON = (
    "Local neural voice is not on disk yet. Install Manager downloads "
    "Supertonic 3 (code MIT, weights OpenRAIL-M). Until then the system voice speaks."
)
_tts = None
_tts_dir = ""
# The own engine (one per model folder, shared by every request), how often it failed in a row, and the last error.
_engine: Any = None
_engine_dir = ""
_engine_failures = 0
_engine_error = ""
ENGINE_MAX_FAILURES = 3
# Half-open breaker: after ENGINE_MAX_FAILURES in a row the own engine is off for ENGINE_COOL_SECONDS, then one clause
# is tried (the probe). A good probe closes the breaker; a failed one opens it again for ENGINE_RECOOL_SECONDS.
ENGINE_COOL_SECONDS = 60.0
ENGINE_RECOOL_SECONDS = 300.0
_engine_off_until = 0.0


def _clock() -> float:
    return time.monotonic()


def _breaker_open() -> bool:
    """True while the own engine is switched off (three failures, cool-down not over). Half-open is not open."""
    return _engine_failures >= ENGINE_MAX_FAILURES and _clock() < _engine_off_until


def _retry_in_seconds() -> int:
    """Whole seconds until the next probe while the breaker is open, else 0."""
    if not _breaker_open():
        return 0
    return max(1, math.ceil(_engine_off_until - _clock()))


# Quiet between two language spans of one reply, in seconds.
SPAN_GAP_SECONDS = 0.08


def supertonic_dir() -> Path | None:
    root = voice_root()
    candidates = [root / SUPERTONIC_DIR, root / "voice" / SUPERTONIC_DIR]
    marker = Path("onnx") / "vocoder.onnx"
    for path in candidates:
        try:
            if (path / marker).is_file():
                return path
        except OSError:
            continue
    return None


def smart_turn_path() -> Path | None:
    found = find_named(SMART_TURN_NAME)
    return found


def _tts_facts(directory: Path | None) -> tuple[bool, int, str, int]:
    """(own engine can run, its sample rate, default voice id, recipe version). Opens no model and never raises."""
    if directory is None or _breaker_open():
        return False, 0, SUPERTONIC_VOICE, 0
    try:
        import importlib.util

        import friday_voice
        import voice_persona

        held = _engine if _engine_dir == str(directory) else None
        opened = held is not None  # an open engine needs no file check
        if not opened and (not friday_voice.complete(directory) or importlib.util.find_spec("onnxruntime") is None):
            return False, 0, SUPERTONIC_VOICE, 0
        rate = 0
        if opened:
            rate = int(held.sample_rate)
        else:
            try:
                rate = int(
                    json.loads((directory / "onnx" / "tts.json").read_text(encoding="utf-8"))["ae"]["sample_rate"]
                )
            except (OSError, ValueError, KeyError, TypeError):
                rate = 0
        return True, rate, voice_persona.DEFAULT_ID, int(voice_persona.RECIPE_VERSION)
    except Exception:  # noqa: BLE001 - a status call reports what it can, it never fails
        return False, 0, SUPERTONIC_VOICE, 0


_PATH_LIKE = re.compile(r"(?:[A-Za-z]:)?[\\/][^\s'\"),;]*")
_SECRET_LIKE = re.compile(r"\b[A-Za-z0-9_-]{24,}\b")
ERROR_CHARS = 120


def _safe_error(exc: BaseException) -> str:
    """A short, shareable line for an engine error: the class and a message with paths and long tokens blanked."""
    message = _SECRET_LIKE.sub("<redacted>", _PATH_LIKE.sub("<path>", str(exc)))
    return f"{type(exc).__name__}: {message[:ERROR_CHARS]}".strip()


def _engine_state(directory: Path | None) -> str:
    """``stopped`` while the breaker is open, ``ready`` while the own engine is open here, ``failing`` between (a
    waiting probe too), else ``idle`` (not opened yet). A cold process only ever knows ``idle``."""
    if _breaker_open():
        return "stopped"
    if _engine is not None and directory is not None and _engine_dir == str(directory):
        return "failing" if _engine_failures else "ready"
    return "failing" if _engine_failures else "idle"


def tts_status(live: bool = False) -> dict:
    """The voice section of the status. ``live`` is true only when the running worker answers: its failure count,
    engine state and last error are then the real ones; a fresh ``--status`` process says ``live: false``."""
    directory = supertonic_dir()
    ready = directory is not None
    own, rate, voice_id, recipe = _tts_facts(directory)
    last = f" Last error: {_engine_error}" if _engine_error else ""
    if not ready:
        reason = LOCAL_TTS_REASON
    elif not own and _breaker_open():
        reason = (
            f"The FRIDAY voice engine stopped after {ENGINE_MAX_FAILURES} failures; "
            f"the Supertonic package speaks, next try in {_retry_in_seconds()} s.{last}"
        )
    elif _engine_failures and _engine_error:
        reason = f"The FRIDAY voice engine failed ({_engine_failures} in a row). {_engine_error}"
    else:
        reason = ""
    return {
        "live": live,
        "failures": _engine_failures,
        "engineState": _engine_state(directory),
        "retryInS": _retry_in_seconds(),
        "ready": ready,
        "engine": "friday-voice" if own else ("supertonic-3" if ready else "none"),
        "own": own,
        "voice": voice_id,
        "voiceId": voice_id,
        "sampleRate": rate,
        "recipeVersion": recipe,
        "reason": reason,
        "offlineFallback": "sapi",
        "cloud": "opt-in",
        "license": "MIT code, OpenRAIL-M weights",
    }


SPEAKER_FILE = "wespeaker-ecapa.onnx"
# The file the optional pin (electron/voice-pins.cjs, WeSpeaker ResNet34-LM int8) downloads.
SPEAKER_PINNED = ("speaker-wespeaker", "onnx", "model_int8.onnx")
SPEAKER_LICENSE = "CC-BY-4.0"
SPEAKER_ATTRIBUTION = "WeSpeaker. CC-BY-4.0. Not bundled. Not downloaded here."


def speaker_engine() -> str:
    """The speaker model on disk: the pinned download, then a hand-placed legacy file; "none" without one."""
    pinned = voice_root().joinpath(*SPEAKER_PINNED)
    try:
        if pinned.is_file() and pinned.stat().st_size > 0:
            return "wespeaker-resnet34-lm"
    except OSError:
        pass
    return "wespeaker-ecapa" if find_named(SPEAKER_FILE) is not None else "none"


def speaker_status() -> dict:
    engine = speaker_engine()
    present = engine != "none"
    return {
        "ready": present,
        "engine": engine,
        "reason": "" if present else "optional - not installed",
        "optional": True,
        "gate": False,
        "license": SPEAKER_LICENSE,
        "attribution": SPEAKER_ATTRIBUTION,
        "bundled": False,
        "threshold": 0.75,
    }


def noise_status() -> dict:
    try:
        import pyrnnoise  # type: ignore  # noqa: F401

        return {"ready": True, "engine": "pyrnnoise", "reason": ""}
    except Exception:
        return {"ready": False, "engine": "none", "reason": "pyrnnoise is not installed"}


def score_vad(samples: list[float] | None = None, sample_rate: int = 16000) -> dict:
    """Score one 512-sample window when the MIT Silero file is present."""
    path = find_named(SILERO_NAME)
    if path is None:
        return {
            "ok": True,
            "engine": "energy",
            "ready": False,
            "probability": None,
            "reason": "silero file absent",
        }
    if sample_rate != 16000:
        return {
            "ok": True,
            "engine": "energy",
            "ready": False,
            "probability": None,
            "reason": "silero scorer expects 16000 Hz",
        }
    window = list(samples or [])
    if len(window) != 512:
        return {
            "ok": True,
            "engine": "energy",
            "ready": False,
            "probability": None,
            "reason": "silero scorer expects 512 samples",
        }
    try:
        import vad_onnx

        probability = vad_onnx.score_window(path, window)
    except Exception as exc:  # noqa: BLE001 — missing runtime falls back to energy VAD
        return {
            "ok": True,
            "engine": "energy",
            "ready": False,
            "probability": None,
            "reason": str(exc)[:200],
        }
    return {
        "ok": True,
        "engine": "silero-onnx",
        "ready": True,
        "probability": probability,
        "reason": "",
        "speech": probability >= 0.5,
    }


def status(live: bool = False) -> dict:
    silero = find_named(SILERO_NAME)
    vad = {
        "engine": "silero-onnx" if silero else "energy",
        "ready": silero is not None,
        "fallback": "energy",
        "file": str(silero) if silero else "",
    }
    turn = smart_turn_path()
    echo = echo_canceller.echo_status()
    return {
        "ok": True,
        "boot": "ready",
        "tts": tts_status(live),
        "vad": vad,
        "turn": {
            "ready": turn is not None,
            "engine": "smart-turn-v3.2" if turn else "none",
            "file": str(turn) if turn else "",
        },
        "noise": noise_status(),
        "echo": echo,
        "echoCancellerReady": bool(echo["ready"]),
        "speaker": speaker_status(),
        "providers": execution_providers(),
        "hindiLight": tts_hindi_light.status(),
        "memory": memory_status(),
    }


def speech_lang(text: str, requested: str = "") -> str:
    """Supertonic language for one piece of text.

    Mixed Devanagari and Latin text is not a separate "unsupported" language:
    the script with more letters decides, and ``speak_wav_bytes`` reads each
    script span in its own language (see ``language_segmenter``).
    """
    return language_segmenter.dominant_lang(text, requested)


_STYLE = re.compile(r"^[FM][1-5]$")


def voice_style_name(requested: str = "") -> str:
    """The voice style asked for, or the default. Only F1..F5 and M1..M5 are ever passed on."""
    name = (requested or "").strip().upper()
    return name if _STYLE.match(name) else SUPERTONIC_VOICE


def persona_name(requested: object = "") -> str:
    """The FRIDAY voice asked for as a known id: a recipe id (``friday``, ``friday-bright``...) or a preset (``F1``..).

    Case does not matter. Only the whitelist of ``voice_persona`` passes: an empty, unknown, path-like or
    over-long id is the default ``friday``. ``voice_style_name`` stays the preset-only rule of the ``supertonic``
    package path, which cannot read a recipe.
    """
    try:
        import voice_persona

        return voice_persona.resolve_id(requested)
    except Exception:  # noqa: BLE001 - without the engine modules the default id is still the answer
        return "friday"


# ---- per-utterance cancel -------------------------------------------------------------------------------------
# The renderer tags every ``speak-pcm`` clause with an utterance id (``utt``, 1 to 64 characters of A-Z a-z 0-9 _ -).
# A ``cancel`` line for that id marks it dead. The worker is never killed: the line is read by a reader thread while a
# clause is being made, the synthesis checks between language spans, and a clause of a dead utterance (running,
# queued, or arriving late) answers ``{ok: false, reason: "cancelled"}`` with no audio. A request without an id is
# never tracked, so every older caller behaves exactly as before.
UTTERANCE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
CANCELLED_KEEP = 512
_cancelled: OrderedDict[str, None] = OrderedDict()
_cancel_lock = threading.Lock()


class SpeechCancelled(Exception):
    """Raised between synthesis steps when the utterance being made was cancelled."""


def utterance_id(value) -> str:
    """The utterance id of a request, or '' when it carries none or a malformed one (then it is not tracked)."""
    return value if isinstance(value, str) and UTTERANCE_ID.match(value) else ""


def cancel_utterance(utt: str) -> bool:
    """Mark one utterance dead. Keeps the newest ``CANCELLED_KEEP`` ids. False for a malformed id."""
    if not utterance_id(utt):
        return False
    with _cancel_lock:
        _cancelled.pop(utt, None)
        _cancelled[utt] = None
        while len(_cancelled) > CANCELLED_KEEP:
            _cancelled.popitem(last=False)
    return True


def is_cancelled(utt: str) -> bool:
    if not utt:
        return False
    with _cancel_lock:
        return utt in _cancelled


def reset_cancelled() -> None:
    with _cancel_lock:
        _cancelled.clear()


def _check(stop) -> None:
    if stop is not None and stop():
        raise SpeechCancelled()


def _synth_array(spoken: str, rate: float, lang: str, style: str = ""):
    """One Supertonic call. Returns a float32 mono array."""
    import numpy as np  # type: ignore

    if _tts is None:
        raise RuntimeError("the speech model is not loaded")
    try:
        voice_style = _tts.get_voice_style(voice_style_name(style))
    except Exception:
        # A style this model does not have is the default voice, never a failed reply.
        voice_style = _tts.get_voice_style(SUPERTONIC_VOICE)
    wav, _duration = _tts.synthesize(
        spoken[:500],
        voice_style=voice_style,
        total_steps=5,
        speed=rate,
        lang=lang,
        silence_duration=0.12,
    )
    return np.asarray(wav, dtype=np.float32).reshape(-1)


@dataclass(frozen=True)
class SpeakOptions:
    """What a ``speak-pcm`` request adds to plain text: its utterance, whether its tags are trusted, whether it opens
    the reply (fewer steps, first clause short) and the silence to leave after it. All default to "not asked"."""

    utt: str = ""
    trusted: bool = False
    first: bool = False
    pause_ms: int = 0


FIRST_CLAUSE_STEPS = 4  # measured: 4, 5 and 8 steps are equally intelligible; 2 is not, 3 is hissier
MAX_SPEAK_CHARS = 500  # the cap of every speak call
PARSE_INPUT_CHARS = 2000  # what the tag reader looks at, before the cap on spoken characters
MAX_PAUSE_MS = 1200
UTTERANCE_KEEP = 64
EDGE_FADE_MS = 4.0


class _RenderNote(threading.local):
    """What the last FRIDAY Voice render of this thread put in its clip: (silence in ms, estimated word times).
    None when it made none (another engine spoke, or nothing yet), so a reply never carries the wrong clip's data."""

    info: tuple[int, list[dict]] | None = None
    engine = ""  # which engine made the last clip: friday-voice or supertonic-3
    fallback = ""  # why it was the fallback (a short token), or ""


class VoiceEngineFailed(Exception):
    """FRIDAY Voice could not make a clause of an utterance it already speaks in. The voice must not change in the
    middle of a reply, so the clause fails and the renderer's own fallback speaks the rest. ``str`` is the error."""


_render_note = _RenderNote()
_personas: dict[str, tuple[Any, Any]] = {}


class _Utterance:
    """The finishing chains of one utterance: filter state carries over from one clause to the next."""

    def __init__(self) -> None:
        self.chains: dict[tuple[str, tuple[tuple[str, float], ...]], Any] = {}
        self.active: Any = None  # the chain that made the last clause: its state moves to the next one
        self.fallback = ""  # why the package speaks it, when it does
        self.voice = ""  # "friday" once FRIDAY Voice spoke a clause of it, "package" once the package had to


_utterances: OrderedDict[str, _Utterance] = OrderedDict()


def reset_speech_state() -> None:
    """Forget the engine, the personas and every utterance (tests, and a model swap)."""
    global _engine, _engine_dir, _engine_failures, _engine_error, _engine_off_until
    _engine, _engine_dir, _engine_failures, _engine_error, _engine_off_until = None, "", 0, "", 0.0
    _personas.clear()
    _utterances.clear()


def _voice_threads() -> int:
    """Intra-op threads of the engine: half the cores, at most three (all cores but one was the slowest under load)."""
    return max(1, min(3, (os.cpu_count() or 2) // 2))


def _friday_engine() -> Any:
    """The one FRIDAY Voice engine for the model folder, or None when it cannot run here (or is cooling down)."""
    global _engine, _engine_dir
    if _breaker_open():
        return None
    directory = supertonic_dir()
    if directory is None:
        return None
    if _engine is not None and _engine_dir == str(directory):
        return _engine
    try:
        import friday_voice

        found = friday_voice.open_voice(directory, threads=_voice_threads())
    except Exception:  # noqa: BLE001 - the engine not opening is the fallback, not a failure
        return None
    if found is None:
        return None
    _engine, _engine_dir = found, str(directory)
    return found


def _persona(engine: Any, requested: object) -> Any:
    """The resolved persona for a request, made once per recipe (its cache key) and engine."""
    import voice_persona

    pid = voice_persona.resolve_id(requested)
    key = voice_persona.cache_key(pid)
    hit = _personas.get(key)
    if hit is not None and hit[0] is engine:
        return hit[1]
    resolved = voice_persona.resolve(pid, engine)
    _personas[key] = (engine, resolved)
    return resolved


def _utterance_state(utt: str) -> _Utterance:
    """The chain state of an utterance id; a new id starts fresh, no id is a fresh state for this request only."""
    if not utt:
        return _Utterance()
    state = _utterances.get(utt)
    if state is None:
        state = _utterances[utt] = _Utterance()
        while len(_utterances) > UTTERANCE_KEEP:
            _utterances.popitem(last=False)
    else:
        _utterances.move_to_end(utt)
    return state


_BIQUAD_STATE = ("x1", "x2", "y1", "y2")
_GAIN_STATE = ("pos", "energy", "smooth", "gain_before", "gain_after")


def _sections(chain: Any) -> list[tuple[tuple, Any, tuple[str, ...]]]:
    """The stateful sections of a finishing chain as (what they are, the section, its state names). Two sections
    with the same signature are the same filter or gain, wherever they sit in the chain."""
    found: list[tuple[tuple, Any, tuple[str, ...]]] = []
    biquads = list(chain._filters)  # noqa: SLF001 - the chain has no public view of its sections
    if chain._ess_band is not None:  # noqa: SLF001
        biquads.append(chain._ess_band)  # noqa: SLF001
    for stage in biquads:
        found.append((("biquad", stage.b.tobytes(), stage.a.tobytes()), stage, _BIQUAD_STATE))
    for name, gain in (("comp", chain._comp), ("ess", chain._ess)):  # noqa: SLF001
        if gain is not None:
            sig = (name, gain.hop, gain.attack, gain.release, gain.threshold_db, gain.ratio, gain.knee_db)
            found.append(((*sig, gain.max_reduction_db), gain, _GAIN_STATE))
    return found


def _carry_state(source: Any, target: Any) -> None:
    """Hand the state of every section of ``source`` that ``target`` also has to ``target``; a section only the target
    has (a new tone band) starts clean. This is what keeps a clause that adds or drops a mood band seamless."""
    pool = _sections(source)
    for sig, stage, names in _sections(target):
        for index, (old_sig, old, _names) in enumerate(pool):
            if old_sig == sig:
                for name in names:
                    setattr(stage, name, getattr(old, name))
                del pool[index]
                break


def _chain_for(state: _Utterance, persona: Any, fx_delta: dict[str, float], rate: int) -> Any:
    """The chain for this clause's tone bands. A change of bands is a different chain, and it takes over the state of
    the sections it shares with the chain that spoke last, so nothing restarts at the seam."""
    chain = _chain_made(state, persona, fx_delta, rate)
    previous = state.active
    if previous is not None and previous is not chain and previous.sample_rate == chain.sample_rate:
        _carry_state(previous, chain)
    state.active = chain
    return chain


def _chain_made(state: _Utterance, persona: Any, fx_delta: dict[str, float], rate: int) -> Any:
    import copy

    import voice_fx

    key = (str(persona.cache_key), tuple(sorted(fx_delta.items())))
    chain = state.chains.get(key)
    if chain is None:
        spec = copy.deepcopy(persona.fx_spec)
        if fx_delta:
            bands = list(spec.get("eq") or [])
            for name, gain in sorted(fx_delta.items()):
                kind, _, hz = name.partition(":")
                bands.append({"type": kind, "hz": float(hz), "gain_db": float(gain), "q": 0.7})
            spec["eq"] = bands
        chain = state.chains[key] = voice_fx.FxChain(rate, spec)
    return chain


def _clauses_for(text: str, lang: str, indexer: Any, keep_split: bool) -> list:
    """One piece of text as clauses. A long first sentence is cut short only for the opening piece of a reply; for
    any other the cut is joined back, so a clause of a longer reply is not split twice."""
    import dataclasses

    import tts_frontend

    made = tts_frontend.prepare(text, lang, 5, indexer=indexer)
    if (
        keep_split
        or len(made) < 2
        or not (made[0].first and made[0].text.endswith(",") and made[0].lang == made[1].lang)
    ):
        return made
    joined = f"{made[0].text} {made[1].text}"
    if len(joined) > tts_frontend.CLAUSE_SOFT_CHARS:
        return made
    return [dataclasses.replace(made[1], text=joined, first=True, spans=()), *made[2:]]


def _render_friday(engine: Any, spoken: str, speed: float, lang: str, style: str, stop: Any, opts: SpeakOptions):
    """The whole request as (float32 mono array, rate): delivery tags, clauses, one synthesis per clause with its
    silence trimmed, the utterance's finishing chain, soft edges and the pauses between them."""
    import numpy as np
    import tts_delivery
    import voice_fx

    persona = _persona(engine, style)
    rate = int(engine.sample_rate)
    asked = min(2.0, max(0.7, float(speed or 1.0)))
    base = min(2.0, max(0.7, asked * float(persona.speed_scale)))
    indexer = getattr(engine, "_indexer", None)
    state = _utterance_state(opts.utt)
    parts: list = []
    pending_ms = 0.0
    clause_count = 0
    budget = MAX_SPEAK_CHARS
    _render_note.info = None
    position = 0  # samples laid down so far
    paused = 0  # of those, the samples of silence put in on purpose
    spoken_spans: list[tuple[str, int, int]] = []

    def add(audio: Any, words: str = "") -> None:
        nonlocal pending_ms, position, paused
        if parts and pending_ms >= 1.0:
            gap = np.zeros(int(rate * pending_ms / 1000.0), dtype=np.float32)
            parts.append(gap)
            position += gap.size
            paused += gap.size
        pending_ms = 0.0
        parts.append(audio)
        if words:
            spoken_spans.append((words, position, position + int(audio.size)))
        position += int(audio.size)

    for piece in tts_delivery.parse(spoken[:PARSE_INPUT_CHARS], trusted=opts.trusted):
        _check(stop)
        if budget <= 0:
            break
        ctl = tts_delivery.controls_for(piece, base)
        pending_ms = max(pending_ms, float(ctl.pause_before_ms))
        if ctl.noise_ms > 0:
            add(tts_delivery.fallback_noise(rate, ctl.noise_ms, ctl.noise_db))
        text = ctl.text[:budget]
        if not text.strip():
            pending_ms = max(pending_ms, float(ctl.pause_after_ms))
            continue
        budget -= len(text)
        if ctl.engine_tag:  # an enabled expression tag is sent alone, never inside a sentence
            import tts_frontend

            planned = [tts_frontend.Clause(text, "na", 0)]
        else:
            planned = _clauses_for(text, lang, indexer, opts.first and clause_count == 0)
        for index, clause in enumerate(planned):
            opening = opts.first and clause_count == 0
            steps = min(FIRST_CLAUSE_STEPS, int(persona.steps)) if opening else int(persona.steps)
            if ctl.steps is not None:
                steps = max(steps, int(ctl.steps))
            _check(stop)
            wav = engine.synth(clause.text, clause.lang, persona.style, steps=steps, speed=ctl.speed)
            _check(stop)
            clause_count += 1
            wav = voice_fx.trim_silence(wav, rate)
            if wav.size == 0:
                continue
            if ctl.gain_db:
                wav = wav * np.float32(10.0 ** (ctl.gain_db / 20.0))
            wav = _chain_for(state, persona, ctl.fx_delta, rate).process(wav)
            add(voice_fx.fade_edges(wav, rate, EDGE_FADE_MS), clause.text)
            last = index == len(planned) - 1
            pending_ms = (
                float(ctl.pause_after_ms) if last and ctl.pause_after_ms > 0 else clause.pause_ms * ctl.pause_mul
            )
    if parts and opts.pause_ms > 0:
        tail = np.zeros(int(rate * min(MAX_PAUSE_MS, opts.pause_ms) / 1000.0), dtype=np.float32)
        parts.append(tail)
        paused += tail.size
    if not parts:
        return np.zeros(0, dtype=np.float32), rate
    import tts_timing

    ms = 1000.0 / rate
    _render_note.info = (
        round(paused * ms),
        tts_timing.clip_word_times([(words, a * ms, b * ms) for words, a, b in spoken_spans]),
    )
    return np.concatenate(parts).astype(np.float32), rate


def _speak_friday(spoken: str, speed: float, lang: str, style: str, stop: Any, opts: SpeakOptions):
    """FRIDAY Voice's answer: (array, rate), or None when the engine is absent or raised (the caller decides).

    A request of an utterance gets one more try on the engine before it counts as failed: a hiccup of one clause
    must not change the voice of the reply. The reason it gave up is left in ``_render_note.fallback``."""
    global _engine_failures, _engine_error, _engine_off_until
    engine = _friday_engine()
    if engine is None:
        _render_note.fallback = "friday-voice-unavailable"
        return None
    for _attempt in range(2 if opts.utt else 1):
        try:
            made = _render_friday(engine, spoken, speed, lang, style, stop, opts)
        except SpeechCancelled:
            raise
        except Exception as exc:  # noqa: BLE001 - any engine error is the caller's decision
            probe = _engine_failures >= ENGINE_MAX_FAILURES  # half-open: this clause was the one probe
            _engine_failures += 1
            _engine_error = _safe_error(exc)
            _render_note.fallback = "engine-failed"
            if probe:
                _engine_off_until = _clock() + ENGINE_RECOOL_SECONDS
                break
            if _engine_failures >= ENGINE_MAX_FAILURES:
                _engine_off_until = _clock() + ENGINE_COOL_SECONDS
                break
            continue
        _engine_failures = 0
        _engine_error = ""
        _engine_off_until = 0.0
        _render_note.engine, _render_note.fallback = "friday-voice", ""
        if opts.utt:
            _utterance_state(opts.utt).voice = "friday"
        return made
    return None


def _speak_supertonic(spoken: str, speed: float, lang: str, style: str, stop: Any):
    """The ``supertonic`` package path, as it always was: the fallback when FRIDAY Voice cannot speak."""
    _render_note.info = None
    directory = supertonic_dir()
    if directory is None:
        return None
    try:
        import numpy as np  # type: ignore
        from supertonic import TTS  # type: ignore
    except Exception:
        return None
    global _tts, _tts_dir
    try:
        if _tts is None or _tts_dir != str(directory):
            _tts = TTS(model="supertonic-3", model_dir=str(directory), auto_download=False)
            _tts_dir = str(directory)
        rate = min(2.0, max(0.7, float(speed or 1.0)))
        spans = language_segmenter.segment(spoken[:500], lang)
        if not spans:
            return None
        pieces = []
        for span in spans:
            _check(stop)
            pieces.append(_synth_array(span.text, rate, span.lang, style))
        _check(stop)
        gap = np.zeros(int(int(_tts.sample_rate) * SPAN_GAP_SECONDS), dtype=np.float32)
        parts = []
        for index, piece in enumerate(pieces):
            if index:
                parts.append(gap)
            parts.append(piece)
        return np.concatenate(parts), int(_tts.sample_rate)
    except SpeechCancelled:
        raise
    except Exception:
        return None


def _speak_array(
    text: str, speed: float = 1.0, lang: str = "", style: str = "", stop=None, opts: SpeakOptions | None = None
):
    """The one synthesis path. (float32 mono array, sample rate), or None when no engine can speak.

    FRIDAY Voice speaks when the model folder is complete and onnxruntime is there; otherwise, or when it raises,
    the ``supertonic`` package speaks the same text as it always did. ``stop`` is an optional callable checked
    before and after every clause; when it answers true the call raises ``SpeechCancelled`` (the only exception
    that leaves this function).
    """
    spoken = (text or "").strip()
    _render_note.engine, _render_note.fallback = "", ""
    if not spoken:
        return None
    if supertonic_dir() is None:
        return None
    options = opts or SpeakOptions()
    held = _utterances.get(options.utt) if options.utt else None
    voice = held.voice if held is not None else ""
    if voice != "package":
        made = _speak_friday(spoken, speed, lang, style, stop, options)
        if made is not None:
            return made if made[0].size else None
        if voice == "friday":  # this reply already speaks in FRIDAY Voice: the voice never changes inside it
            raise VoiceEngineFailed(_engine_error or "engine unavailable")
    elif held is not None:
        _render_note.fallback = held.fallback
    if options.utt:  # one voice for the whole utterance: every later clause of it uses the package too
        chosen = _utterance_state(options.utt)
        chosen.voice, chosen.fallback = "package", _render_note.fallback
    # The package reads the words only: it would speak the tag names of a tagged text.
    import tts_delivery

    made = _speak_supertonic(tts_delivery.strip(spoken), speed, lang, style, stop)
    if made is not None:
        _render_note.engine = "supertonic-3"
    return made


def speak_wav_bytes(text: str, speed: float = 1.0, lang: str = "", style: str = "") -> bytes | None:
    """Local Supertonic speech as WAV bytes. None when the model or package is absent."""
    made = _speak_array(text, speed, lang, style)
    if made is None:
        return None
    try:
        import io

        import soundfile as sf  # type: ignore

        audio, rate = made
        buf = io.BytesIO()
        sf.write(buf, audio, rate, format="WAV")
        data = buf.getvalue()
    except Exception:
        return None
    return data or None


def _int16_pcm(audio) -> bytes:
    """The float to int16 step of ``speak_pcm16``: scale by 32768, floor, clip."""
    import numpy as np  # type: ignore

    return np.clip(np.floor(audio * np.float32(32768.0)), -32768, 32767).astype("<i2").tobytes()


def speak_pcm16(
    text: str, speed: float = 1.0, lang: str = "", style: str = "", stop=None, opts: SpeakOptions | None = None
) -> tuple[bytes, int] | None:
    """The same samples as ``speak_wav_bytes`` as raw little-endian int16 mono, plus the sample rate.

    Nothing is written to disk. The float to int16 step matches what libsndfile
    writes for a PCM_16 WAV (scale by 32768, floor, clip), so the samples agree
    with the WAV path to within one sample on any libsndfile. ``stop`` is the cooperative cancel check of
    ``_speak_array``.
    """
    extra: dict = {}
    if stop is not None:
        extra["stop"] = stop
    if opts is not None:
        extra["opts"] = opts
    made = _speak_array(text, speed, lang, style, **extra)
    if made is None:
        return None
    try:
        audio, rate = made
        data = _int16_pcm(audio)
    except Exception:
        return None
    return (data, rate) if data else None


# Speech quieter than this is silence. A denoised clip that loses this much
# energy against a speech-level original is not used.
SILENCE_FLOOR_DBFS = -50.0
SPEECH_FLOOR_DBFS = -45.0
DENOISE_KEEP_RATIO = 0.25
# A cleaned clip more than this many times louder than the original is a
# scale fault, not denoising. Together with DENOISE_KEEP_RATIO it is one 4x band.
DENOISE_LOUD_RATIO = 4.0
CLIP_LEVEL = 0.999
# The single no-speech threshold. The kernel returns it with every transcript
# and the renderer reads it from there. Text is dropped only when the average
# no-speech probability is at or above it AND the average log-probability is at
# or below LOW_CONFIDENCE_LOGPROB.
NO_SPEECH_THRESHOLD = 0.7
LOW_CONFIDENCE_LOGPROB = -1.0
# Every dropped utterance carries exactly one of these codes.
DROP_CODES = (
    "too-short",
    "no-frames",
    "denoise-skipped",
    "no-speech",
    "low-confidence",
    "empty",
    "stt-fault",
)


def pcm_levels(samples, sample_rate: int = 16000) -> dict:
    """Duration plus RMS and peak in dBFS. Full scale is 1.0."""
    try:
        import numpy as np  # type: ignore
    except Exception:
        return {
            "durationMs": 0,
            "rms": 0.0,
            "peak": 0.0,
            "rmsDbfs": None,
            "peakDbfs": None,
        }
    audio = np.asarray(samples, dtype=np.float64).reshape(-1)
    count = int(audio.size)
    duration_ms = int(round(count * 1000 / sample_rate)) if sample_rate and count else 0
    if count == 0:
        return {
            "durationMs": 0,
            "rms": 0.0,
            "peak": 0.0,
            "rmsDbfs": -120.0,
            "peakDbfs": -120.0,
        }
    rms = float(np.sqrt(np.mean(audio * audio)))
    peak = float(np.max(np.abs(audio)))

    def db(value: float) -> float:
        if value <= 1e-12:
            return -120.0
        return round(20.0 * math.log10(value), 1)

    return {
        "durationMs": duration_ms,
        "rms": rms,
        "peak": peak,
        "rmsDbfs": db(rms),
        "peakDbfs": db(peak),
    }


# Automatic gain before denoise and VAD. A laptop array often delivers speech
# near -45 dBFS; RNNoise and Silero VAD both treat that as background, so the
# clip is lifted toward a normal speaking level. Silence is never amplified and
# the peak never passes GAIN_PEAK_CEILING.
GAIN_TARGET_DBFS = -22.0
GAIN_MAX_DB = 30.0
GAIN_MIN_INPUT_DBFS = -62.0
GAIN_PEAK_CEILING = 0.89


def normalize_gain(samples, target_dbfs: float = GAIN_TARGET_DBFS, max_gain_db: float = GAIN_MAX_DB):
    """Return ``(samples, gain_db)``. Only quiet speech is boosted; nothing is attenuated."""
    try:
        import numpy as np  # type: ignore
    except Exception:
        return samples, 0.0
    audio = np.asarray(samples, dtype=np.float32).reshape(-1)
    if audio.size == 0:
        return audio, 0.0
    levels = pcm_levels(audio)
    rms_db = levels["rmsDbfs"]
    peak = float(levels["peak"])
    if rms_db is None or rms_db <= GAIN_MIN_INPUT_DBFS or rms_db >= target_dbfs or peak <= 0:
        return audio, 0.0
    gain_db = min(float(max_gain_db), float(target_dbfs) - float(rms_db))
    ceiling_db = 20.0 * math.log10(GAIN_PEAK_CEILING / peak)
    gain_db = min(gain_db, ceiling_db)
    if gain_db < 1.0:
        return audio, 0.0
    boosted = (audio * float(10.0 ** (gain_db / 20.0))).astype(np.float32)
    return np.clip(boosted, -1.0, 1.0), round(gain_db, 1)


def guard_denoised(original, cleaned, ratio: float = DENOISE_KEEP_RATIO):
    """Keep the original when denoise changed the loudness by more than 4x or clipped.

    Import and decode failures never reach here: denoise_pcm returns the
    original samples in that case. This guard is for a successful call whose
    samples no longer match the speech. The note is empty when the cleaned clip
    is kept, else ``denoise-skipped: <reason>``.
    """
    try:
        import numpy as np  # type: ignore
    except Exception:
        return original, ""
    source = np.asarray(original, dtype=np.float32).reshape(-1)
    result = np.asarray(cleaned, dtype=np.float32).reshape(-1)
    if result.size == 0:
        return source, "denoise-skipped: no samples came back"
    before = pcm_levels(source)
    after = pcm_levels(result)
    speech = before["rmsDbfs"] is not None and before["rmsDbfs"] >= SPEECH_FLOOR_DBFS
    if speech and before["rms"] > 0 and after["rms"] < before["rms"] * ratio:
        return source, "denoise-skipped: removed the signal"
    if before["rms"] > 0 and after["rms"] > before["rms"] * DENOISE_LOUD_RATIO:
        return source, "denoise-skipped: louder than the original"
    if before["peak"] < CLIP_LEVEL and after["peak"] >= CLIP_LEVEL:
        return source, "denoise-skipped: clipped"
    return result, ""


def denoise_pcm(samples, sample_rate: int = 16000):
    """RNNoise when the wheel is installed. The same samples come back otherwise.

    pyrnnoise 0.4.5 ``denoise_chunk`` yields int16 frames whatever the input
    (a 0.2 peak sine came back at 7116). This is the one place that scales them,
    so every caller gets float32 in [-1, 1]. A failed import or a failed decode
    returns the original array.
    """
    try:
        import numpy as np  # type: ignore
        from pyrnnoise import RNNoise  # type: ignore
    except Exception:
        return samples
    mono = np.asarray(samples, dtype=np.float32).reshape(-1)
    if mono.size == 0:
        return mono
    peak = float(np.max(np.abs(mono)))
    if peak <= 1.5:
        pcm = np.clip(np.round(mono * 32768.0), -32768, 32767).astype(np.int16)
    else:
        pcm = np.clip(np.round(mono), -32768, 32767).astype(np.int16)
    try:
        denoiser = RNNoise(sample_rate)
        pieces = []
        for _prob, frame in denoiser.denoise_chunk(pcm[None, :], partial=True):
            frame = np.asarray(frame).reshape(-1)
            if frame.size == 0:
                continue
            values = frame.astype(np.float32)
            if np.issubdtype(frame.dtype, np.integer) or float(np.max(np.abs(values))) > 1.5:
                values = values / 32768.0
            pieces.append(values)
        if not pieces:
            return mono
        return np.clip(np.concatenate(pieces), -1.0, 1.0).astype(np.float32)
    except Exception:
        return mono


# The smart-turn session and its feature extractor are opened once per process. Opening them per call cost about
# 90 ms of session set-up on top of the 100 ms run, and the one-shot ``--score`` process also paid the imports.
_turn_model: dict = {}


def _turn_session(path: Path):
    """``(session, extractor)`` for the smart-turn file, kept for the life of this process. A failure is not kept."""
    key = str(path)
    held = _turn_model.get(key)
    if held is not None:
        return held
    import onnxruntime as ort  # type: ignore
    from turn_features import TurnFeatures

    session = ort.InferenceSession(key, providers=session_providers(False))
    extractor = TurnFeatures(feature_size=80, chunk_length=8)
    _turn_model.clear()
    _turn_model[key] = (session, extractor)
    return session, extractor


def _turn_features_with_fallback(audio, extractor):
    """The model input from FRIDAY's own extractor; the older package extractor only if that one fails."""
    from turn_features import turn_input

    try:
        return turn_input(audio, extractor)
    except Exception:  # noqa: BLE001
        from faster_whisper.feature_extractor import FeatureExtractor  # type: ignore

        return turn_input(audio, FeatureExtractor(feature_size=80, chunk_length=8))


def score_turn(samples, sample_rate: int = 16000) -> dict:
    """Semantic end-of-turn. Missing file or a bad feature is not a cut-off."""
    path = smart_turn_path()
    if path is None:
        return {"ok": True, "ready": False, "probability": None, "reason": "smart-turn file absent"}
    if sample_rate != 16000:
        return {"ok": True, "ready": False, "probability": None, "reason": "smart-turn expects 16000 Hz"}
    try:
        import numpy as np  # type: ignore

        audio = np.asarray(samples, dtype=np.float32).reshape(-1)
        if audio.size < 1600:
            return {"ok": True, "ready": False, "probability": None, "reason": "audio too short"}
        session, extractor = _turn_session(path)
        feat = _turn_features_with_fallback(audio, extractor)
        out = session.run(None, {"input_features": feat})[0]
        probability = float(np.asarray(out).reshape(-1)[0])
    except Exception as exc:  # noqa: BLE001
        return {"ok": True, "ready": False, "probability": None, "reason": str(exc)[:200]}
    return {
        "ok": True,
        "ready": True,
        "probability": probability,
        "complete": probability >= 0.5,
        "reason": "",
    }


# An utterance is capped at 20 s of 16 kHz 16-bit mono (about 640 kB); anything far larger is not a turn clip.
MAX_SCORE_BYTES = 8 * 1024 * 1024


def score_turn_payload(req: dict) -> dict:
    """Worker op ``score-turn``: the end-of-turn probability of the clip at ``audio``. Never raises, whatever arrives.

    The same answer as ``--score``, from a process that already holds the model, so a turn is scored in about
    a tenth of a second instead of a fresh interpreter start.
    """
    audio = req.get("audio") if isinstance(req, dict) else None
    if not isinstance(audio, str) or not audio or len(audio) > 1024 or "\x00" in audio:
        return {"ok": True, "ready": False, "probability": None, "reason": "no audio"}
    try:
        if not os.path.isfile(audio) or os.path.getsize(audio) > MAX_SCORE_BYTES:
            return {"ok": True, "ready": False, "probability": None, "reason": "no audio"}
    except OSError:
        return {"ok": True, "ready": False, "probability": None, "reason": "no audio"}
    samples = load_pcm(audio)
    if samples is None:
        return {"ok": True, "ready": False, "probability": None, "reason": "no audio"}
    return score_turn(samples, 16000)


def speaker_decision(similarity: float | None, enrolled: bool, sensitive: bool) -> dict:
    """Extra signal only. A missing voiceprint does not block ordinary speech."""
    if not sensitive:
        return {"allow": True, "execute": False, "reason": "ordinary"}
    if not enrolled or similarity is None:
        return {"allow": True, "execute": False, "reason": "no-voiceprint"}
    if similarity < 0.75:
        return {"allow": False, "execute": False, "reason": "speaker-mismatch"}
    return {"allow": True, "execute": False, "reason": "speaker-match"}


def _cosine(left: list[float] | None, right: list[float] | None) -> float | None:
    if not left or not right or len(left) != len(right):
        return None
    dot = 0.0
    left_sq = 0.0
    right_sq = 0.0
    for raw_left, raw_right in zip(left, right, strict=True):
        x = float(raw_left)
        y = float(raw_right)
        dot += x * y
        left_sq += x * x
        right_sq += y * y
    if left_sq <= 0 or right_sq <= 0:
        return None
    return dot / ((left_sq**0.5) * (right_sq**0.5))


def score_speaker(
    probe: list[float] | None,
    enrolled: list[float] | None,
    threshold: float = 0.75,
    model_present: bool = False,
) -> dict:
    """Score only. A match never executes, and a missing file is not a match."""
    if not model_present:
        return {
            "ok": True,
            "ready": False,
            "score": None,
            "match": False,
            "execute": False,
            "reason": "model-not-on-disk",
            "license": SPEAKER_LICENSE,
            "attribution": SPEAKER_ATTRIBUTION,
        }
    score = _cosine(probe, enrolled)
    if score is None:
        return {
            "ok": False,
            "ready": True,
            "score": None,
            "match": False,
            "execute": False,
            "reason": "voiceprint needs a numeric embedding",
            "license": SPEAKER_LICENSE,
        }
    match = score >= float(threshold)
    return {
        "ok": True,
        "ready": True,
        "score": score,
        "match": match,
        "execute": False,
        "reason": "speaker-match" if match else "speaker-mismatch",
        "license": SPEAKER_LICENSE,
    }


def first_audio_latency(started_ms: int, heard_ms: int, budget_ms: int = 1000) -> dict:
    elapsed = int(heard_ms) - int(started_ms)
    return {"elapsedMs": elapsed, "budgetMs": int(budget_ms), "within": 0 <= elapsed <= int(budget_ms)}


_SECRET_TEXT = re.compile(
    r"(?:password|passwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*\S+",
    re.I,
)


def redact_voice_text(text: str) -> str:
    return _SECRET_TEXT.sub("[redacted]", str(text or ""))


def voice_context(asked: bool, perception: dict | None) -> dict:
    """Camera or screen text joins a voice turn only when the owner asked."""
    if not asked:
        return {"used": False, "text": "", "untrusted": True, "instruction": False, "reason": "not-asked"}
    seen = perception or {}
    if seen.get("handoff"):
        return {
            "used": False,
            "text": "",
            "untrusted": True,
            "instruction": False,
            "handoff": seen.get("handoff"),
            "reason": "handoff",
        }
    return {
        "used": True,
        "text": redact_voice_text(str(seen.get("text") or "")),
        "untrusted": True,
        "instruction": False,
        "reason": "data",
    }


def fetch_models() -> dict:
    """On-demand weights. Called only from ``--fetch``, never from status."""
    root = voice_root()
    try:
        root.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        return {"ok": False, "reason": str(exc), "results": []}
    room = disk_room(root, 600 * 1024 * 1024)
    if not room["ok"]:
        return {"ok": False, "reason": room["reason"] or "disk full", "results": []}
    results: list[dict] = []

    if supertonic_dir() is None:
        results.append(
            {
                "id": "supertonic-3",
                "ok": False,
                "reason": "weights are fetched by the app downloader",
            }
        )
    else:
        results.append({"id": "supertonic-3", "ok": True})

    results.append(
        {
            "id": "smart-turn",
            "ok": smart_turn_path() is not None,
            "reason": None if smart_turn_path() is not None else "weights are fetched by the app downloader",
        }
    )

    moon = root / "moonshine-en"
    ready = moon.is_dir() and any(moon.rglob("*.onnx"))
    results.append(
        {
            "id": "moonshine-en",
            "ok": ready,
            "reason": None if ready else "weights are fetched by the app downloader",
        }
    )

    return {"ok": any(item.get("ok") for item in results), "results": results}


def _hindi_ear_line() -> str:
    """FRIDAY's Hindi ear (optional): the weights on disk and the package that runs them."""
    import importlib.util

    import hindi_ear

    if not hindi_ear.ready():
        return "OPTIONAL hindi-ear optional - not installed"
    missing = [m for m in ("numpy", "onnxruntime") if importlib.util.find_spec(m) is None]
    if missing:
        return f"FAIL hindi-ear the weights are on disk but {' and '.join(missing)} is not installed"
    if importlib.util.find_spec("onnx_asr") is None:
        return "PASS hindi-ear int8 weights present (own runner)"
    return "PASS hindi-ear int8 weights present"


def _hindi_punct_line() -> str:
    """The optional Hindi punctuation model: the weights on disk and the two packages that run them."""
    import importlib.util

    import hindi_punct

    if not hindi_punct.ready():
        return "OPTIONAL hindi-punct optional - not installed"
    missing = [name for name in ("sentencepiece", "onnxruntime") if importlib.util.find_spec(name) is None]
    if missing:
        return f"FAIL hindi-punct the weights are on disk but the {' and '.join(missing)} package is not installed"
    return "PASS hindi-punct pinned weights present"


def _hindi_light_line() -> str:
    """The optional light Hindi voice: the weights on disk and the two packages that run them."""
    import importlib.util

    if not tts_hindi_light.ready():
        return f"OPTIONAL {tts_hindi_light.MODEL_DIR} optional - not installed"
    missing = [name for name in ("onnxruntime", "numpy") if importlib.util.find_spec(name) is None]
    if missing:
        names = " and ".join(missing)
        return f"FAIL {tts_hindi_light.MODEL_DIR} the weights are on disk but the {names} package is not installed"
    return f"PASS {tts_hindi_light.MODEL_DIR} pinned weights present"


def _whisper_ear_lines() -> list[str]:
    """The two optional faster-whisper ears: weights on disk and the package that runs them (faster-whisper)."""
    import importlib.util

    import whisper_ears

    lines = []
    for ear_id, ready in (
        (whisper_ears.HINGLISH_ID, whisper_ears.hinglish_ready()),
        (whisper_ears.HINDI_FALLBACK_ID, whisper_ears.hindi_fallback_ready()),
    ):
        if not ready:
            lines.append(f"OPTIONAL {ear_id} optional - not installed")
        elif importlib.util.find_spec("faster_whisper") is None:
            lines.append(f"FAIL {ear_id} the weights are on disk but the faster-whisper package is not installed")
        else:
            lines.append(f"PASS {ear_id} pinned weights present")
    return lines


def check_lines() -> list[str]:
    lines = ["PASS boot"]
    tts = tts_status()
    if tts["ready"]:
        lines.append(f"PASS local-tts engine={tts['engine']} voice={tts['voice']}")
    else:
        lines.append("OPTIONAL local-tts optional - not installed")
    silero = score_vad([0.0] * 512)
    if silero.get("engine") == "silero-onnx" and silero.get("ready"):
        lines.append(f"PASS vad-silero probability={silero.get('probability')}")
    elif "absent" in str(silero.get("reason") or ""):
        lines.append("OPTIONAL vad-silero optional - not installed")
    else:
        lines.append(f"FAIL vad-silero {silero.get('reason') or 'energy fallback'}")
    lines.append("PASS vad-energy desktop energy VAD remains the fallback")
    if smart_turn_path() is None:
        lines.append("OPTIONAL smart-turn optional - not installed")
    else:
        lines.append("PASS smart-turn file present")
    noise = noise_status()
    if noise["ready"]:
        lines.append("PASS rnnoise")
    else:
        lines.append(f"FAIL rnnoise {noise['reason']}")
    echo = echo_canceller.echo_status()
    if echo["ready"]:
        lines.append(
            "PASS echo-canceller pyaec available (measure-only in the kernel; "
            "live reference behind voice.echoReference)"
        )
    else:
        lines.append(f"OPTIONAL echo-canceller {echo['reason']}")
    speaker = speaker_status()
    if speaker["ready"]:
        lines.append(f"PASS speaker {speaker['engine']}")
    else:
        lines.append(f"OPTIONAL speaker {speaker['reason']}")
    lines.append(_hindi_ear_line())
    lines.append(_hindi_punct_line())
    lines.append(_hindi_light_line())
    lines.extend(_whisper_ear_lines())
    providers = execution_providers()
    lines.append(f"PASS cpu-fallback selected={providers['selected']} gpu={providers['gpuDetected']}")
    memory = memory_status()
    if memory["known"]:
        lines.append(f"PASS memory total={memory['totalGb']}GB free={memory['freeGb']}GB")
    else:
        lines.append("OPTIONAL memory unmeasured on this system")
    room = disk_room(voice_root(), SILERO_BYTES)
    if room["measured"] and room["ok"]:
        lines.append(f"PASS disk free={room['free']}")
    elif room["measured"]:
        lines.append(f"FAIL disk {room['reason']} free={room['free']}")
    else:
        lines.append("FAIL disk unmeasured")
    return lines


def load_pcm(path: str):
    """16 kHz mono PCM via the one STT reader, or None when it cannot be read."""
    if not path or not os.path.exists(path):
        return None
    try:
        import stt

        return stt.load_audio_array(path)
    except Exception:
        return None


HINDI_LIGHT_ENGINE = "hindi-light"
DEFAULT_ENGINE = "supertonic-3"


def _hindi_light_pcm16(text: str, speed: float, lang: str, style: str) -> tuple[tuple[bytes, int] | None, str]:
    """The light Hindi voice as (int16 PCM, rate), or (None, why it did not speak). Never raises."""
    if not tts_hindi_light.ready():
        return None, "hindi-light-not-installed"
    if speech_lang(text, lang) != "hi":
        return None, "hindi-light-needs-hindi"
    if not tts_hindi_light.speakable(text):
        return None, "hindi-light-needs-devanagari-only"
    made = tts_hindi_light.synthesize(text, speed, style)
    if made is None:
        return None, "hindi-light-failed"
    try:
        audio, rate = made
        data = _int16_pcm(audio)
    except Exception:  # noqa: BLE001
        return None, "hindi-light-failed"
    return ((data, rate), "") if data else (None, "hindi-light-failed")


def _speak_options(req: dict, utt: str) -> SpeakOptions | None:
    """The optional fields of a ``speak-pcm`` request, or None when it carries none (the plain, older request).

    ``trusted: true`` lets the model's delivery tags act (the renderer sets it only for FRIDAY's own words; text from a
    tool, page or person stays untrusted and its tags are removed). ``first: true`` marks the opening clause of a
    reply (fewer steps, a long first sentence cut short). ``pauseMs`` is silence left after this request, 0 to 1200.
    """
    trusted = req.get("trusted") is True
    first = req.get("first") is True
    raw = req.get("pauseMs")
    pause = 0
    if isinstance(raw, int | float) and not isinstance(raw, bool) and math.isfinite(raw):
        pause = int(min(MAX_PAUSE_MS, max(0, raw)))
    if not (utt or trusted or first or pause):
        return None
    return SpeakOptions(utt=utt, trusted=trusted, first=first, pause_ms=pause)


def _voice_facts(engine: str, style: str) -> dict:
    """The stable identity fields of a ``speak-pcm`` reply: which engine spoke, whether it is FRIDAY's own, the voice
    id and the recipe version (0 for an engine without a recipe). The Electron side reads these names."""
    own = engine == "friday-voice"
    recipe = 0
    if own:
        try:
            import voice_persona

            recipe = int(voice_persona.RECIPE_VERSION)
        except Exception:  # noqa: BLE001 - an identity field never fails a reply
            recipe = 0
    return {
        "engine": engine,
        "own": own,
        "voiceId": persona_name(style) if own else voice_style_name(style),
        "recipeVersion": recipe,
    }


def speak_pcm_payload(req: dict) -> dict:
    """Reply body of the ``speak-pcm`` worker op: base64 int16 PCM, nothing on disk, no cache.

    Every reply says which ``engine`` spoke (``friday-voice``, ``supertonic-3`` or ``hindi-light``), whether it is
    FRIDAY's ``own`` voice, its ``voiceId`` and ``recipeVersion``, and carries ``fallback`` (a short reason token)
    only when it came from a fallback path. A request with an utterance id never changes voice in the middle of a
    reply: a clause FRIDAY Voice cannot make fails with ``engine-failed`` (and ``detail``), and the renderer's own
    fallback speaks the rest. A request without an id falls back whole to the package and the reply says so.
    ``engine`` in the request is optional: ``hindi-light`` asks for the light Hindi voice; it speaks only when
    installed, for Devanagari-only Hindi, and otherwise Supertonic or FRIDAY Voice speaks the same text.
    """
    import base64
    import time

    text = req.get("text")
    if not isinstance(text, str) or not text.strip():
        return {"ok": False, "reason": "empty-text"}
    utt = utterance_id(req.get("utt"))
    tag: dict = {"utt": utt} if utt else {}
    if isinstance(req.get("seq"), int) and not isinstance(req.get("seq"), bool):
        tag["seq"] = req["seq"]

    def stop() -> bool:
        return is_cancelled(utt)

    if stop():
        return {"ok": False, "reason": "cancelled", **tag}
    try:
        speed = float(req.get("speed") or 1)
    except (TypeError, ValueError):
        speed = 1.0
    started = time.perf_counter()
    _render_note.info = None
    _render_note.engine, _render_note.fallback = "", ""
    lang = str(req.get("lang") or "")
    style = str(req.get("style") or "")
    asked = str(req.get("engine") or "").strip().lower()
    extra: dict = {}
    made = None
    try:
        if asked == HINDI_LIGHT_ENGINE:
            made, why = _hindi_light_pcm16(text, speed, lang, style)
            extra = {"engine": HINDI_LIGHT_ENGINE} if made else {"engine": DEFAULT_ENGINE, "fallback": why}
            # The light voice cannot be interrupted mid-clause: a cancel that landed meanwhile drops its result.
            if made is not None and stop():
                return {"ok": False, "reason": "cancelled", **tag}
        elif asked and asked not in ("supertonic", DEFAULT_ENGINE):
            extra = {"engine": DEFAULT_ENGINE, "fallback": "unknown-engine"}
        if made is None:
            # A request with no utterance id and no new field is made exactly as it always was (no check to pass).
            kwargs: dict = {"stop": stop} if utt else {}
            options = _speak_options(req, utt)
            if options is not None:
                kwargs["opts"] = options
            made = speak_pcm16(text, speed, lang, style, **kwargs)
        if stop():
            return {"ok": False, "reason": "cancelled", **tag}
    except SpeechCancelled:
        return {"ok": False, "reason": "cancelled", **tag}
    except VoiceEngineFailed as exc:
        return {
            "ok": False,
            "reason": "engine-failed",
            "detail": str(exc),
            **_voice_facts("friday-voice", style),
            **tag,
        }
    if made is None:
        return {"ok": False, "reason": LOCAL_TTS_REASON}
    data, rate = made
    light = extra.get("engine") == HINDI_LIGHT_ENGINE
    # Only FRIDAY Voice knows what silence it put in and where its words are; any other engine reports none.
    note = None if light else _render_note.info
    spoke = HINDI_LIGHT_ENGINE if light else (_render_note.engine or DEFAULT_ENGINE)
    fallback = "" if light else str(extra.get("fallback") or _render_note.fallback)
    _render_note.info = None
    timing: dict = {"pausedMs": note[0] if note else 0}
    if note and note[1]:
        timing["wordTimes"] = note[1]
    return {
        "ok": True,
        "sampleRate": rate,
        "pcm16": base64.b64encode(data).decode("ascii"),
        "ms": round((time.perf_counter() - started) * 1000),
        **timing,
        **_voice_facts(spoke, style),
        **({"fallback": fallback} if fallback else {}),
        **tag,
    }


def warm_up_payload(req: dict) -> dict:
    """Reply body of the ``warm-up`` op: open the engine, run one tiny synthesis, then one short clause through the
    whole path (persona, trim, chain), so the first spoken reply does not pay for the graphs, the voice blend or the
    filters. Without the own engine the ``supertonic`` package is loaded the same way. Nothing is stored."""
    import time

    started = time.perf_counter()
    style = str(req.get("style") or "")
    engine = _friday_engine()
    if engine is not None:
        try:
            engine.warm_up()
            made = _render_friday(engine, "Ready.", 1.0, "en", style, None, SpeakOptions(first=True))
        except Exception as exc:  # noqa: BLE001 - a failed warm-up is a report, never a crash
            return {"ok": False, "reason": f"warm-up-failed: {type(exc).__name__}"}
        return {
            "ok": True,
            "engine": "friday-voice",
            "voiceId": persona_name(style),
            "sampleRate": int(made[1]),
            "ms": round((time.perf_counter() - started) * 1000),
        }
    if _speak_supertonic("Ready.", 1.0, "en", style, None) is None:
        return {"ok": False, "reason": LOCAL_TTS_REASON}
    return {"ok": True, "engine": "supertonic-3", "ms": round((time.perf_counter() - started) * 1000)}


# One 160 ms microphone chunk at 16 kHz is 2560 samples; a caller may send up to one second.
ECHO_SHADOW_MAX_SAMPLES = 16000
_echo_shadow: echo_canceller.EchoCanceller | None = None


def echo_shadow_payload(req: dict) -> dict:
    """Reply body of the ``echo-shadow`` worker op: measure the echo canceller, never gate anything.

    ``mic`` and ``ref`` are base64 little-endian int16 mono at 16 kHz, the same length (the reference is what
    played during the microphone chunk, on the microphone clock). The canceller runs on a private instance that
    keeps its delay estimate between calls; ``reset`` true starts it over. The reply carries levels only, never
    audio: the loudness of the chunk and of what is left, in dBFS, and their difference when the canceller really
    worked on this chunk (``cancelled``). Nothing here feeds a decision.
    """
    import base64

    global _echo_shadow
    try:
        import numpy as np  # type: ignore
    except Exception:
        return {"ok": False, "reason": "numpy-missing"}
    body: dict = {"ok": False}
    if isinstance(req.get("seq"), int) and not isinstance(req.get("seq"), bool):
        body["seq"] = req["seq"]
    try:
        mic_raw = base64.b64decode(str(req.get("mic") or ""), validate=True)
        ref_raw = base64.b64decode(str(req.get("ref") or ""), validate=True) if req.get("ref") else b""
    except Exception:
        return {**body, "reason": "bad-audio"}
    if len(mic_raw) < 2 or len(mic_raw) % 2 or len(ref_raw) % 2:
        return {**body, "reason": "bad-audio"}
    if len(mic_raw) // 2 > ECHO_SHADOW_MAX_SAMPLES:
        return {**body, "reason": "too-long"}
    if ref_raw and len(ref_raw) != len(mic_raw):
        return {**body, "reason": "length-mismatch"}
    if _echo_shadow is None or req.get("reset") is True:
        if _echo_shadow is None:
            _echo_shadow = echo_canceller.EchoCanceller()
        else:
            _echo_shadow.reset()
    canceller = _echo_shadow
    if not canceller.ready:
        return {**body, "reason": canceller.status().get("reason") or "echo-canceller-unavailable", "ready": False}
    mic = np.frombuffer(mic_raw, dtype="<i2").astype(np.int16)
    ref = np.frombuffer(ref_raw, dtype="<i2").astype(np.int16) if ref_raw else None
    before = canceller.status()["cancelledFrames"]
    cleaned = canceller.process(mic, ref)
    after = canceller.status()
    cancelled = after["cancelledFrames"] > before

    def level(samples) -> float:
        power = float(np.mean(np.square(samples.astype(np.float64)))) / (32768.0 * 32768.0)
        return round(10.0 * math.log10(power), 1) if power > 1e-12 else -120.0

    mic_db = level(mic)
    residual_db = level(cleaned)
    playing = ref is not None and int(np.max(np.abs(ref.astype(np.int32)))) >= echo_canceller.SILENT_PEAK
    return {
        **body,
        "ok": True,
        "ready": True,
        "playing": bool(playing),
        "cancelled": bool(cancelled),
        "micDb": mic_db,
        "residualDb": residual_db,
        "reductionDb": round(mic_db - residual_db, 1) if cancelled else None,
        "delayMs": after["delayMs"],
        "confidence": after["confidence"],
        "gate": False,
    }


def _cancel_payload(req: dict) -> dict:
    """Reply body of the ``cancel`` op: mark one utterance dead. Runs on the reader thread, never behind a clause."""
    utt = utterance_id(req.get("utt"))
    if not utt:
        return {"ok": False, "reason": "bad-request"}
    cancel_utterance(utt)
    return {"ok": True, "utt": utt}


def _handle(req: dict) -> tuple[dict, bool]:
    """One worker op as (reply body, stop serving)."""
    op = str(req.get("op") or "")
    if op == "shutdown":
        return {"ok": True}, True
    if op == "status":
        return status(live=True), False
    if op == "speak":
        out = str(req.get("out") or "")
        try:
            speed = float(req.get("speed") or 1)
        except (TypeError, ValueError):
            speed = 1.0
        audio = speak_wav_bytes(
            str(req.get("text") or ""),
            speed,
            str(req.get("lang") or ""),
            str(req.get("style") or ""),
        )
        if audio and out:
            dest = Path(out)
            try:
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(audio)
            except (OSError, ValueError) as exc:  # a path that cannot be written never stops the worker
                return {"ok": False, "reason": "cannot-write-output", "error": str(exc)[:200]}, False
            return {"ok": True, "path": str(dest), "mime": "audio/wav", "bytes": len(audio)}, False
        return {"ok": False, "reason": LOCAL_TTS_REASON if not audio else "no output path"}, False
    if op == "speak-pcm":
        return speak_pcm_payload(req), False
    if op == "warm-up":
        return warm_up_payload(req), False
    if op == "echo-shadow":
        return echo_shadow_payload(req), False
    return {"ok": False, "reason": "unknown-op"}, False


def _utf8_streams() -> None:
    """stdout and stderr as UTF-8 that never raises (a Windows code page cannot hold a Devanagari path)."""
    import sys

    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")  # type: ignore[attr-defined]
        except Exception:  # noqa: S110 - a stream that cannot be reconfigured is still written to
            pass


def _dispatch(req: dict) -> tuple[dict, bool]:
    """``_handle`` with a net under it: one request that raises is answered with an error envelope and the loop goes
    on. The old fields stay (``ok``, ``reason``); ``error`` carries a short code and message, no paths or secrets."""
    try:
        return _handle(req)
    except Exception as exc:  # noqa: BLE001 - a bad request must never end the speak worker
        message = _safe_error(exc)
        return {
            "ok": False,
            "reason": "internal-error",
            "error": {"code": "internal-error", "message": message},
        }, False


def serve() -> int:
    """Keep Supertonic loaded across speak calls. One JSON object per line.

    A reader thread takes the lines. ``cancel`` is answered there at once (it must not wait behind the clause the
    worker is making); every other line goes in order to this thread, so replies keep the order of the requests.
    """
    import sys

    try:
        sys.stdin.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
        sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace", line_buffering=True)  # type: ignore[attr-defined]
    except Exception:  # noqa: S110 — a console that cannot be reconfigured still reads lines
        pass
    _utf8_streams()
    stdin = sys.stdin
    out_lock = threading.Lock()

    def emit(payload: dict) -> None:
        with out_lock:
            print(json.dumps(payload), flush=True)

    inbox: queue.Queue[object] = queue.Queue()

    def read() -> None:
        try:
            for raw in stdin:
                line = raw.strip()
                if not line:
                    continue
                try:
                    req = json.loads(line)
                except Exception as exc:  # noqa: BLE001
                    inbox.put({"_bad": {"ok": False, "reason": "bad-request", "error": str(exc)[:200]}})
                    continue
                if not isinstance(req, dict):
                    inbox.put({"_bad": {"ok": False, "reason": "bad-request"}})
                    continue
                if req.get("op") == "cancel":
                    reply = _cancel_payload(req)
                    if req.get("id") is not None:
                        emit({"id": req["id"], **reply})
                    continue
                inbox.put(req)
        finally:
            inbox.put(None)

    threading.Thread(target=read, name="voice-reader", daemon=True).start()
    while True:
        req = inbox.get()
        if not isinstance(req, dict):
            return 0
        if "_bad" in req:
            emit(req["_bad"])
            continue
        rid = req.get("id")
        payload, stop = _dispatch(req)
        if rid is not None:
            payload = {"id": rid, **payload}
        emit(payload)
        if stop:
            return 0


def main() -> int:
    _utf8_streams()
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--status", action="store_true")
    parser.add_argument("--speak", action="store_true")
    parser.add_argument("--serve", action="store_true")
    parser.add_argument("--fetch", action="store_true")
    parser.add_argument("--score", action="store_true")
    parser.add_argument("--text", default="")
    parser.add_argument("--lang", default="")
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--out", default="")
    parser.add_argument("--audio", default="")
    args = parser.parse_args()
    if args.serve:
        return serve()
    if args.check:
        for line in check_lines():
            print(line)
        return 0
    if args.fetch:
        print(json.dumps(fetch_models()))
        return 0
    if args.score:
        samples = load_pcm(args.audio)
        if samples is None:
            print(json.dumps({"ok": True, "ready": False, "probability": None, "reason": "no audio"}))
        else:
            print(json.dumps(score_turn(samples, 16000)))
        return 0
    if args.speak:
        audio = speak_wav_bytes(args.text, args.speed, args.lang)
        if audio and args.out:
            dest = Path(args.out)
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(audio)
            print(json.dumps({"ok": True, "path": str(dest), "mime": "audio/wav", "bytes": len(audio)}))
        else:
            print(json.dumps({"ok": False, "reason": LOCAL_TTS_REASON, "bytes": len(audio or b"")}))
        return 0
    print(json.dumps(status()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


# Voice tone, measured from the samples. Words say what the owner wants; the
# tone says how they feel about it. Pitch, loudness, and how much of the clip is
# voiced are classic paralinguistic cues. These are cues, not a diagnosis: the
# renderer compares them with the owner's own running baseline.
PROSODY_FRAME = 0.03
PITCH_MIN_HZ = 70.0
PITCH_MAX_HZ = 400.0


def voice_prosody(samples, sample_rate: int = 16000) -> dict:
    """Median pitch, pitch spread, loudness, and voiced share of one utterance."""
    try:
        import numpy as np  # type: ignore
    except Exception:
        return {"ok": False, "reason": "numpy missing"}
    audio = np.asarray(samples, dtype=np.float32).reshape(-1)
    frame = int(sample_rate * PROSODY_FRAME)
    if audio.size < frame * 4:
        return {"ok": False, "reason": "too short"}
    peak = float(np.max(np.abs(audio))) or 1.0
    audio = audio / peak
    lag_min = int(sample_rate / PITCH_MAX_HZ)
    lag_max = int(sample_rate / PITCH_MIN_HZ)
    pitches: list[float] = []
    energies: list[float] = []
    voiced = 0
    total = 0
    for start in range(0, audio.size - frame * 2, frame):
        chunk = audio[start : start + frame * 2]
        rms = float(np.sqrt(np.mean(chunk.astype(np.float64) ** 2)))
        total += 1
        if rms < 0.02:
            continue
        energies.append(rms)
        chunk = chunk - float(chunk.mean())
        corr = np.correlate(chunk, chunk, mode="full")[chunk.size - 1 :]
        if corr[0] <= 0:
            continue
        window = corr[lag_min : min(lag_max, corr.size - 1)]
        if window.size == 0:
            continue
        lag = int(np.argmax(window)) + lag_min
        strength = float(corr[lag] / corr[0])
        if strength < 0.5:
            continue
        voiced += 1
        pitches.append(sample_rate / lag)
    if not pitches:
        return {"ok": False, "reason": "no voiced frames", "voicedShare": 0.0}
    hz = np.asarray(pitches)
    median = float(np.median(hz))
    spread = float(np.std(np.log2(hz))) * 12.0  # semitones
    loud = float(20 * math.log10(max(float(np.mean(energies)) * peak, 1e-6)))
    return {
        "ok": True,
        "pitchHz": round(median, 1),
        "pitchSpreadSemitones": round(spread, 2),
        "energyDbfs": round(loud, 1),
        "voicedShare": round(voiced / max(1, total), 3),
    }
