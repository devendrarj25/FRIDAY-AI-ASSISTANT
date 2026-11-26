"""FRIDAY · local speech-to-text (faster-whisper).

On-device transcriber so the desktop app never depends on Chromium's online
Web Speech service. electron/stt.cjs prefers a persistent worker:

    python kernel/stt.py --serve

JSON lines on stdin, one JSON object per line on stdout. WhisperModel is
loaded once per worker and reused for every utterance. `--audio` one-shot
mode remains for probes and tests.

Nothing is faked: when the model or the dependency is missing it says so
instead of returning empty text. The model cache lives under the selected
FRIDAY root (cache/stt). One request is still one utterance file. Partial
text is emitted on this same worker as whisper segments arrive. English
Moonshine streaming runs inside this worker only when that MIT model is
already on disk and the owner preference is English. Hindi and Hinglish
stay on faster-whisper.
"""

from __future__ import annotations

import argparse
import ctypes
import gc
import json
import math
import os
import queue
import re
import struct
import sys
import tempfile
import threading
import time
import unicodedata
import wave
from collections import deque
from pathlib import Path
from typing import Any

# The packaged self-check and the speech worker run this file with the bundled
# embeddable Python. Its ._pth file means the script folder is not on sys.path,
# so the sibling voice_runtime module must be added explicitly.
_KERNEL_DIR = str(Path(__file__).resolve().parent)
if _KERNEL_DIR not in sys.path:
    sys.path.insert(0, _KERNEL_DIR)

import hindi_ear  # noqa: E402
import stream_ear  # noqa: E402
import voice_runtime  # noqa: E402
import whisper_ears  # noqa: E402
from la2_partials import (  # noqa: E402
    RATE,
    TurnLanguage,
    apply_rescore,
    plan_rescore,
    segments_from_words,
    snap_hotwords,
    turn_mode,
    with_ctc_bias,
)
from stream_commit import Word, words_from_text  # noqa: E402

# Small is the best quality/latency trade-off on a normal Windows laptop and
# handles Hindi + Indian English well. int8 keeps it CPU-friendly.
DEFAULT_MODEL = os.environ.get("FRIDAY_STT_MODEL", "small")
DEFAULT_HINT = (
    "Hinglish mixed Hindi and English in one sentence. "
    "Examples: Chrome open karo; GitHub ka latest status check karo; ye file analyze karo. "
    "Preserve filenames, paths, code identifiers, application names, project names, "
    "commands, FRIDAY, and technical English terms. "
    "Do not translate those into Hindi or replace them with similar everyday words."
)

_model = None
_model_name: str | None = None
_load_count = 0
_whisper_cls = None
_now = time.time  # one clock for idle time and load time; tests replace it
_last_used: float | None = None
_idle_limit_s = 600.0
_load_ms: dict[str, int] = {}
_fallbacks: dict[str, int] = {}
_unloads = 0
_cache_lock = threading.RLock()  # held for a whole request, so the idle watch never unloads a model mid-decode
_whisper_error: str | None = None
_device_name = "cpu"
_compute_type = "int8"


def resolve_language(raw: str) -> str | None:
    """Lock Whisper only when the owner asked for a non English/Hindi language.

    hi / en / hi-IN / en-IN stay auto-detect so mixed Hinglish is not forced
    into one script.
    """
    value = (raw or "").strip().lower().replace("_", "-")
    if not value or value in {"auto", "mixed"}:
        return None
    if value.startswith("hi") or value.startswith("en"):
        return None
    iso = value[:2]
    return iso if len(iso) == 2 and iso.isalpha() else None


def select_model(ram_gb: float, gpu: bool, battery: bool, auto: bool, requested: str = "small") -> str:
    """Same thresholds as applySttTier in src/lib/friday/voice-session.ts.

    Auto tiering changes the model only when it is requested and RAM was
    measured. Otherwise the caller's model (small, unless set) stays.
    """
    name = (requested or "small").strip() or "small"
    if not auto or not (ram_gb > 0):
        return name
    tier = "small"
    if ram_gb < 4:
        tier = "tiny"
    elif ram_gb < 8:
        tier = "base"
    elif gpu and ram_gb >= 16:
        tier = "large-v3"
    elif ram_gb >= 16:
        tier = "medium"
    if battery and tier in {"medium", "large-v3"}:
        tier = "small"
    return tier


OWNER_SIZES = frozenset({"tiny", "base", "small", "medium", "large-v3-turbo", "large-v3"})


def owner_model(size: str, requested: str) -> str:
    """An owner-chosen size wins. Auto tiering stays for the auto setting."""
    locked = (size or "").strip().lower()
    if locked in OWNER_SIZES:
        return select_model(0.0, False, False, False, locked)
    return resolve_model_name(requested)


_CUDA_DLL_HANDLES: list = []


def nvidia_pip_dirs() -> list[Path]:
    """Folders of the CUDA 12 libraries that pip installs (nvidia-cublas-cu12, nvidia-cudnn-cu12).

    Windows has no system cuBLAS 12 / cuDNN 9 unless the owner installed them by hand, and a CUDA 13 toolkit
    provides neither, so speech stayed on the CPU. Setup installs these two wheels on an NVIDIA PC; this finds them.
    """
    found: list[Path] = []
    sub = "bin" if os.name == "nt" else "lib"
    try:
        import importlib.util

        for module in ("nvidia.cublas", "nvidia.cudnn"):
            try:
                spec = importlib.util.find_spec(module)
            except (ImportError, ValueError):
                spec = None
            for location in (spec.submodule_search_locations or []) if spec else []:
                folder = Path(location) / sub
                if folder.is_dir():
                    found.append(folder)
    except Exception:  # noqa: BLE001 - a missing wheel only means the CPU path
        return []
    return found


def expose_cuda_dirs(folders: list[Path]) -> None:
    """Let the loader find those libraries: the DLL search path on Windows, PATH for the rest."""
    for folder in folders:
        text = str(folder)
        if os.name == "nt" and hasattr(os, "add_dll_directory"):
            try:
                _CUDA_DLL_HANDLES.append(os.add_dll_directory(text))
            except OSError:
                pass
        if text not in os.environ.get("PATH", "").split(os.pathsep):
            os.environ["PATH"] = text + os.pathsep + os.environ.get("PATH", "")


def cuda_runtime_ready() -> bool:
    """CUDA only when the GPU flag is set (the app sets it on a usable NVIDIA card) and both CUDA 12
    libraries are visible.

    faster-whisper's GPU path needs cuBLAS for CUDA 12 and cuDNN 9 on PATH.
    A missing library stays on CPU int8. That is not a dead microphone.
    """
    gpu = os.environ.get("FRIDAY_GPU", "").strip().lower() in {"1", "true", "yes", "on"}
    asked = os.environ.get("FRIDAY_STT_CUDA", "").strip().lower() in {"1", "true", "yes", "on"}
    if not gpu and not asked:
        return False
    names = ("cublas64_12.dll", "cudnn64_9.dll") if os.name == "nt" else ("libcublas.so.12", "libcudnn.so.9")
    roots: list[Path] = []
    for key in ("PATH", "LD_LIBRARY_PATH"):
        for part in os.environ.get(key, "").split(os.pathsep):
            if part:
                roots.append(Path(part))
    cuda = os.environ.get("CUDA_PATH", "").strip()
    if cuda:
        roots.append(Path(cuda) / "bin")
        roots.append(Path(cuda) / "lib64")
    pip_dirs = nvidia_pip_dirs()
    roots.extend(pip_dirs)
    found: set[str] = set()
    for root in roots:
        for name in names:
            try:
                if (root / name).is_file():
                    found.add(name)
            except OSError:
                continue
    ready = len(found) == len(names)
    if ready and pip_dirs:
        expose_cuda_dirs(pip_dirs)
    return ready


def choose_stt_device(cuda_ready: bool) -> dict:
    if cuda_ready:
        return {
            "device": "cuda",
            "compute_type": "float16",
            "reason": "CUDA 12 libraries are on PATH",
        }
    return {
        "device": "cpu",
        "compute_type": "int8",
        "reason": "CPU int8 — CUDA libraries were not both present",
    }


def cpu_threads() -> int:
    """Threads for the CPU engine. CTranslate2 uses 4 unless told otherwise, which leaves most of a modern PC idle.

    `FRIDAY_STT_THREADS` sets it; otherwise about half the logical processors (the physical cores on most PCs),
    never fewer than 4 or more than 8, since a larger count stops helping one short utterance.
    """
    raw = os.environ.get("FRIDAY_STT_THREADS", "").strip()
    if raw.isdigit() and 1 <= int(raw) <= 64:
        return int(raw)
    return max(4, min(8, (os.cpu_count() or 4) // 2))


def model_load_kwargs(name: str, model_path: str | None = None) -> dict:
    """The worker opens a local folder. It does not download weights."""
    target = (model_path or "").strip() or (name or DEFAULT_MODEL)
    device = choose_stt_device(cuda_runtime_ready())
    return {
        "target": target,
        "device": device["device"],
        "compute_type": device["compute_type"],
        "reason": device["reason"],
        "download_root": cache_dir(),
        "local_files_only": True,
        "cpu_threads": cpu_threads(),
    }


def open_whisper(cls, wanted: str, spec: dict):
    """Load CUDA when the plan says so. A failed CUDA load retries on CPU int8."""
    try:
        return cls(
            wanted,
            device=spec["device"],
            compute_type=spec["compute_type"],
            download_root=spec["download_root"],
            local_files_only=spec["local_files_only"],
            # Only the CPU engine takes the thread count; the GPU path keeps its defaults.
            **({"cpu_threads": spec.get("cpu_threads", 0)} if spec["device"] == "cpu" else {}),
        ), spec["device"]
    except Exception:  # noqa: BLE001 — a failed CUDA load must fall back to CPU
        if spec["device"] == "cpu":
            raise
        return cls(
            wanted,
            device="cpu",
            compute_type="int8",
            download_root=spec["download_root"],
            local_files_only=spec["local_files_only"],
            cpu_threads=spec.get("cpu_threads", 0),
        ), "cpu"


def resolve_model_name(requested: str) -> str:
    auto = os.environ.get("FRIDAY_STT_TIER", "").strip().lower() == "auto"
    try:
        ram = float(os.environ.get("FRIDAY_RAM_GB", "") or 0)
    except ValueError:
        ram = 0.0
    gpu = os.environ.get("FRIDAY_GPU", "").strip().lower() in {"1", "true", "yes", "on"}
    battery = os.environ.get("FRIDAY_ON_BATTERY", "").strip().lower() in {"1", "true", "yes", "on"}
    return select_model(ram, gpu, battery, auto, requested or DEFAULT_MODEL)


# faster-whisper 1.2.1 skips a silent stretch longer than this when it suspects a hallucination; it needs word timings.
HALLUCINATION_SILENCE_S = 2.0
MAX_HOTWORDS_CHARS = 200


def clean_hotwords(raw) -> str:
    """The owner's own words (names, project terms) as one short line for faster-whisper's `hotwords`, or "" (off)."""
    if isinstance(raw, (list, tuple)):
        raw = ", ".join(str(item) for item in raw)
    words: list[str] = []
    seen: set[str] = set()
    for part in re.split(r"[,\n;]+", str(raw or "")):
        word = " ".join(part.split())
        if word and word.lower() not in seen:
            seen.add(word.lower())
            words.append(word)
    return ", ".join(words)[:MAX_HOTWORDS_CHARS].strip(" ,")


def hotword_list(raw) -> list[str]:
    """The owner's words as a list (the same cleaning and cap as ``clean_hotwords``)."""
    return [word for word in clean_hotwords(raw).split(", ") if word]


def snap_text(text: str, hotwords: list[str]) -> str:
    """A transcript with words close to the owner's words in their spelling (the ear that gives only text)."""
    if not hotwords or not text:
        return text
    return " ".join(w.text for w in snap_hotwords(words_from_text(text), hotwords))


def decode_options(extras: dict | None, language_locked: bool) -> dict:
    """Extra faster-whisper 1.2.1 options from the owner's settings. Everything is off unless it is asked for.

    * ``hotwords``: the owner's dictionary; nothing is passed when it is empty.
    * ``multilingual``: a language guess on every segment, only when the owner turned it on and no language is locked.
    * ``hallucination_silence_threshold``: only together with word timings (``word_timestamps``), which the library
      requires; word timings are off unless the request or ``FRIDAY_STT_WORD_TIMESTAMPS`` asks for them.
    """
    extras = extras or {}
    out: dict = {}
    hot = clean_hotwords(extras.get("hotwords"))
    if hot:
        out["hotwords"] = hot
    if extras.get("multilingual") is True and not language_locked:
        out["multilingual"] = True
    env_words = os.environ.get("FRIDAY_STT_WORD_TIMESTAMPS", "").strip().lower() in {"1", "true", "yes", "on"}
    if extras.get("word_timestamps") is True or env_words:
        out["word_timestamps"] = True
        out["hallucination_silence_threshold"] = HALLUCINATION_SILENCE_S
    return out


# One utterance never runs this long; a longer (or endless) duration is cut here so a plan cannot fill memory.
MAX_PARTIAL_WINDOWS = 600


def plan_partials(duration_s: float, window_s: float = 2.0, hop_s: float = 1.0) -> list[dict]:
    """Chunk plan for this same worker. Not a second speech engine. At most ``MAX_PARTIAL_WINDOWS`` windows."""
    if not (duration_s > 0 and window_s > 0 and hop_s > 0) or not math.isfinite(duration_s):
        return []
    if duration_s <= window_s:
        return [{"start": 0.0, "end": round(float(duration_s), 3), "final": True}]
    out: list[dict] = []
    start = 0.0
    while start < duration_s - 1e-6 and len(out) < MAX_PARTIAL_WINDOWS:
        end = min(duration_s, start + window_s)
        out.append({"start": round(start, 3), "end": round(end, 3), "final": end >= duration_s - 1e-6})
        if end >= duration_s - 1e-6:
            break
        start += hop_s
    return out


def cache_dir() -> str:
    root = os.environ.get("FRIDAY_ROOT")
    base = Path(root) / "cache" / "stt" if root else Path.home() / ".friday" / "cache" / "stt"
    base.mkdir(parents=True, exist_ok=True)
    return str(base)


_emit_lock = threading.Lock()  # the reader thread answers a cancel while the main thread streams a decode


def emit(payload: dict) -> None:
    line = json.dumps(payload, ensure_ascii=False) + "\n"
    with _emit_lock:
        sys.stdout.write(line)
        sys.stdout.flush()


def _import_whisper():
    global _whisper_cls, _whisper_error
    if _whisper_cls is not None:
        return _whisper_cls
    if _whisper_error:
        return None
    try:
        from faster_whisper import WhisperModel  # type: ignore

        _whisper_cls = WhisperModel
        return _whisper_cls
    except Exception as exc:  # noqa: BLE001 — surfaced to the UI verbatim
        _whisper_error = f"faster-whisper is not installed ({exc})."
        return None


# --- the model cache: idle unload, memory pressure, load time ------------------------------------------------------
# A resident model costs RAM for as long as it sits there. A 16 GB CPU-only PC keeps the engine only while the owner is
# talking, never loads a bigger one while memory is short, and reports what it holds so the app can show it.

IDLE_UNLOAD_S = 600.0
IDLE_UNLOAD_MIN_S = 1.0
IDLE_UNLOAD_MAX_S = 86_400.0
IDLE_WATCH_S = 30.0
HINDI_EAR_NAME = "indicconformer-hi-int8"
# Windows reports a little under the installed size, so "16 GB" machines read 15.4 to 16.0 GiB.
LOW_MEMORY_TOTAL_MB = 16 * 1024 + 512
# Free memory below a share of the whole is pressure, kept between a floor and a ceiling so 4 GB and 64 GB PCs both
# read sensibly: high from 15% (2 to 3 GB), critical from 7% (1 to 1.5 GB).
PRESSURE_HIGH = (0.15, 2048, 3072)
PRESSURE_CRITICAL = (0.07, 1024, 1536)
# Substring order matters: "large-v3-turbo" must read as turbo before it reads as large.
_MODEL_RANKS = (("tiny", 1), ("base", 2), ("small", 3), ("medium", 4), ("turbo", 5), ("large", 6))
HEAVY_RANK = 4
USE_OPS = frozenset({"load", "transcribe", "flush", "self-test", "hearing-self-test", "stream-open", "stream-feed"})


class MemoryStatusEx(ctypes.Structure):
    """The Windows MEMORYSTATUSEX record (64 bytes) that GlobalMemoryStatusEx fills."""

    _fields_ = [
        ("dwLength", ctypes.c_uint32),
        ("dwMemoryLoad", ctypes.c_uint32),
        ("ullTotalPhys", ctypes.c_ulonglong),
        ("ullAvailPhys", ctypes.c_ulonglong),
        ("ullTotalPageFile", ctypes.c_ulonglong),
        ("ullAvailPageFile", ctypes.c_ulonglong),
        ("ullTotalVirtual", ctypes.c_ulonglong),
        ("ullAvailVirtual", ctypes.c_ulonglong),
        ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
    ]


def _windows_memory_mb() -> tuple[float, float] | None:
    """``(available, total)`` physical memory in MB from GlobalMemoryStatusEx, or None when the call fails."""
    if sys.platform != "win32":
        return None
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    status = MemoryStatusEx()
    status.dwLength = ctypes.sizeof(MemoryStatusEx)
    kernel32.GlobalMemoryStatusEx.argtypes = [ctypes.POINTER(MemoryStatusEx)]
    kernel32.GlobalMemoryStatusEx.restype = ctypes.c_int
    if not kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
        return None
    return status.ullAvailPhys / 1048576, status.ullTotalPhys / 1048576


def parse_meminfo(text: str) -> tuple[float, float] | None:
    """``(available, total)`` in MB from the text of /proc/meminfo, or None when it cannot be read."""
    kb: dict[str, float] = {}
    for line in text.splitlines():
        key, _sep, rest = line.partition(":")
        parts = rest.split()
        if parts and parts[0].isdigit():
            kb[key.strip()] = float(parts[0])
    total = kb.get("MemTotal", 0.0)
    if total <= 0:
        return None
    available = kb.get("MemAvailable")
    if available is None:
        if "MemFree" not in kb:
            return None
        available = kb["MemFree"] + kb.get("Buffers", 0.0) + kb.get("Cached", 0.0)
    return available / 1024, total / 1024


def _linux_memory_mb(path: str = "/proc/meminfo") -> tuple[float, float] | None:
    try:
        with open(path, encoding="utf-8") as handle:
            return parse_meminfo(handle.read())
    except OSError:
        return None


def read_memory_mb() -> tuple[float, float] | None:
    """The machine's ``(available, total)`` physical memory in MB: ctypes on Windows, /proc on Linux, no package."""
    if sys.platform == "win32":
        return _windows_memory_mb()
    if sys.platform.startswith("linux"):
        return _linux_memory_mb()
    return None


def _pressure_line(total_mb: float, rule: tuple[float, int, int]) -> float:
    share, floor, ceiling = rule
    return min(ceiling, max(floor, total_mb * share))


def memory_pressure(reader=None) -> dict:
    """``level`` ok, high or critical from the free memory. A machine that cannot be read is ok with ``known`` false."""
    try:
        reading = (reader or read_memory_mb)()
    except Exception:  # noqa: BLE001 — an unreadable machine never stops speech
        reading = None
    if not reading:
        return {"level": "ok", "availableMb": None, "totalMb": None, "known": False}
    available, total = float(reading[0]), float(reading[1])
    level = "ok"
    if available < _pressure_line(total, PRESSURE_CRITICAL):
        level = "critical"
    elif available < _pressure_line(total, PRESSURE_HIGH):
        level = "high"
    return {"level": level, "availableMb": int(available), "totalMb": int(total), "known": True}


def model_rank(name: str | None) -> int | None:
    """Size order of a model id or folder (tiny 1 ... large 6), or None when the name says nothing about its size."""
    leaf = re.split(r"[\\/]", (name or "").strip().lower())[-1]
    for word, rank in _MODEL_RANKS:
        if word in leaf:
            return rank
    return None


def is_heavy_model(name: str | None) -> bool:
    rank = model_rank(name)
    return rank is not None and rank >= HEAVY_RANK


def is_auto_pick(owner_size: str) -> bool:
    """True when the tier setting chose the model, not the owner's locked size."""
    if (owner_size or "").strip().lower() in OWNER_SIZES:
        return False
    return os.environ.get("FRIDAY_STT_TIER", "").strip().lower() == "auto"


def auto_flag(owner_size: str) -> dict:
    """The ``auto`` keyword for get_model, only when the tier setting picked the size (an owner's size sends none)."""
    return {"auto": True} if is_auto_pick(owner_size) else {}


def note_fallback(kind: str) -> None:
    """Count one time the worker answered with something other than what was asked for."""
    _fallbacks[kind] = _fallbacks.get(kind, 0) + 1


def touch() -> None:
    global _last_used
    _last_used = _now()


def _ear_loaded() -> bool:
    return hindi_ear.loaded()


def loaded_names() -> list[str]:
    names = [_model_name] if _model is not None and _model_name else []
    return names + ([HINDI_EAR_NAME] if _ear_loaded() else []) + stream_ear.HOST.loaded_name()


def unload_models() -> list[str]:
    """Drop every resident model and give the memory back. Returns what was open."""
    global _model, _model_name, _unloads
    names = loaded_names()
    _model, _model_name = None, None
    hindi_ear.unload()
    stream_ear.HOST.unload()
    if names:
        _unloads += 1
        gc.collect()
    return names


def idle_seconds() -> float | None:
    """Seconds since a model was last used; None while nothing is loaded."""
    if _last_used is None or not loaded_names():
        return None
    return max(0.0, _now() - _last_used)


def unload_idle() -> list[str]:
    """Unload the models when they have sat unused for the idle time (0 turns this off)."""
    idle = idle_seconds()
    if idle is None or _idle_limit_s <= 0 or idle < _idle_limit_s:
        return []
    return unload_models()


def configure_idle(req: dict) -> None:
    """A request may set the idle time in seconds: 0 turns the unload off, other values stay within the limits."""
    raw = req.get("idleUnloadSec", req.get("idle_unload_sec"))
    if isinstance(raw, bool) or not isinstance(raw, (int, float)) or raw < 0:
        return
    try:
        if not math.isfinite(raw):
            return
        seconds = float(raw)
    except OverflowError:
        # An integer past the float range (10**400) is "as long as allowed", never an exception in the request loop.
        seconds = IDLE_UNLOAD_MAX_S
    global _idle_limit_s
    _idle_limit_s = 0.0 if raw == 0 else min(IDLE_UNLOAD_MAX_S, max(IDLE_UNLOAD_MIN_S, seconds))


def start_idle_watch(interval_s: float = IDLE_WATCH_S, stop: threading.Event | None = None) -> threading.Thread:
    """A daemon thread that unloads idle models between requests, so memory returns while the owner is silent."""
    halt = stop or threading.Event()

    def watch() -> None:
        while not halt.wait(interval_s):
            try:
                with _cache_lock:
                    unload_idle()
            except Exception as error:  # one failed tick must not end idle unloading for the rest of the session
                print(f"stt idle watch: {error}", file=sys.stderr, flush=True)

    thread = threading.Thread(target=watch, name="stt-idle-watch", daemon=True)
    thread.start()
    return thread


def cache_status() -> dict:
    """What the worker holds and how it got there: loaded models, load times, idle time, fallbacks and memory."""
    idle = idle_seconds()
    loaded = [
        {
            "name": name,
            "engine": "hindi-ear" if name == HINDI_EAR_NAME else "faster-whisper",
            "loadMs": _load_ms.get(name),
        }
        for name in loaded_names()
    ]
    return {
        "loadedModels": loaded,
        "loadMs": dict(_load_ms),
        "idleSec": None if idle is None else round(idle, 1),
        "lastUsed": _last_used if loaded else None,
        "idleUnloadSec": int(_idle_limit_s),
        "unloadCount": _unloads,
        "fallbacks": {"total": sum(_fallbacks.values()), "byKind": dict(_fallbacks)},
        "memory": memory_pressure(),
    }


def admit_load(wanted: str, auto: bool) -> str:
    """``load``, ``reuse`` (the resident model answers) or ``evict`` (drop the resident one first), by memory pressure.

    Under pressure a model larger than the resident one is never opened, and an automatic pick of medium or larger on a
    16 GB PC is refused with the low-memory fault.
    """
    pressure = memory_pressure()
    if pressure["level"] == "ok":
        return "load"
    rank, resident = model_rank(wanted), model_rank(_model_name)
    if _model is not None and rank is not None and resident is not None and rank > resident:
        return "reuse"
    total = pressure["totalMb"]
    if auto and is_heavy_model(wanted) and total is not None and total <= LOW_MEMORY_TOTAL_MB:
        note_fallback("low-memory-refused")
        raise SttFault(
            "low-memory",
            f"low-memory: {wanted} needs more free memory than this PC has right now "
            f"({pressure['availableMb']} MB of {total} MB free)",
            "Close other apps, or pick the small speech size in Settings.",
        )
    return "evict" if _model is not None else "load"


def get_model(name: str, model_path: str | None = None, auto: bool = False):
    """Load WhisperModel once per worker. `local_files_only` blocks a silent download.

    `auto` marks a size the tier setting picked (not the owner), which memory pressure may refuse.
    """
    global _model, _model_name, _load_count, _device_name, _compute_type
    cls = _import_whisper()
    if cls is None:
        raise RuntimeError(_whisper_error or "faster-whisper is not installed.")
    spec = model_load_kwargs(name, model_path or os.environ.get("FRIDAY_STT_MODEL_PATH"))
    wanted = spec["target"]
    if _model is not None and _model_name == wanted:
        touch()
        return _model
    verdict = admit_load(wanted, auto)
    if verdict == "reuse":
        note_fallback("low-memory-resident")
        touch()
        return _model
    if verdict == "evict":
        _model, _model_name = None, None
        gc.collect()
    started = _now()
    _model, _used = open_whisper(cls, wanted, spec)
    if _used != spec["device"]:
        note_fallback("cuda-to-cpu")
        spec["reason"] = "CPU int8 — CUDA load failed"
        spec["device"] = "cpu"
        spec["compute_type"] = "int8"
    _device_name = spec["device"]
    _compute_type = spec["compute_type"]
    _model_name = wanted
    _load_count += 1
    _load_ms[wanted] = int((_now() - started) * 1000)
    touch()
    return _model


def warm_model(model) -> int:
    """Two short decodes of quiet noise, so the first spoken turn does not pay the engine's first-run set-up.

    A silent clip is stopped by the voice filter before the model runs at all (so a warm-up with silence warmed only the
    filter). The first pass loads the filter; the second runs the encoder and decoder once with the filter off. Words
    it may invent from noise are thrown away. Returns the milliseconds it took, or -1 when it could not run: a failed
    warm-up never stops a load.
    """
    import time

    started = time.time()
    try:
        import numpy as np  # type: ignore

        noise = (np.random.default_rng(7).standard_normal(16000) * 0.01).astype(np.float32)
        segments, _info = model.transcribe(noise, language="en", beam_size=1, vad_filter=True)
        list(segments)
        segments, _info = model.transcribe(
            noise, language="en", beam_size=1, vad_filter=False, without_timestamps=True, max_new_tokens=8
        )
        list(segments)
    except Exception:  # noqa: BLE001 — the real turn loads whatever this did not
        return -1
    return int((time.time() - started) * 1000)


def wants_english_stream(language: str, speech_pref: str) -> bool:
    """Moonshine English weights only. Hindi, Hinglish, and auto stay on whisper."""
    raw = (speech_pref or "").strip().lower().replace("_", "-")
    if not raw:
        raw = (language or "").strip().lower().replace("_", "-")
    if not raw or raw in {"auto", "mixed"} or raw.startswith("hi"):
        return False
    return raw.startswith("en")


def moonshine_model_dir() -> str | None:
    """English streaming weights already on disk. This does not download."""
    root = os.environ.get("FRIDAY_ROOT", "").strip()
    base = Path(root) if root else Path.home() / ".friday"
    folder = base / "models" / "moonshine-en"
    if not folder.is_dir():
        return None
    parents: dict[Path, int] = {}
    try:
        for path in folder.rglob("*"):
            if not path.is_file():
                continue
            if path.suffix.lower() not in {".onnx", ".ort"}:
                continue
            if path.stat().st_size < 100_000:
                continue
            parents[path.parent] = parents.get(path.parent, 0) + 1
    except OSError:
        return None
    if not parents:
        return None
    return str(max(parents, key=lambda path: parents[path]))


AV_REQUIREMENT = "av>=17.0.0,<19"
AV_FIX = 'python -m pip install "av>=17.0.0,<19"'
STT_CLASSES = (
    "dependency-incompatible",
    "model-missing",
    "low-memory",
    "oom",
    "timeout",
    "audio-invalid",
)
PROBE_SECONDS = 1.5
PROBE_RATE = 16000


class SttFault(RuntimeError):
    """One classified transcription failure. The text is the status line."""

    def __init__(self, kind: str, message: str, fix: str = ""):
        self.kind = kind if kind in STT_CLASSES else "audio-invalid"
        self.fix = fix
        super().__init__(message)


def version_tuple(text: str) -> tuple[int, int, int]:
    parts: list[int] = []
    for piece in str(text or "").replace("-", ".").split("."):
        digits = ""
        for char in piece:
            if char.isdigit():
                digits += char
            else:
                break
        if digits:
            parts.append(int(digits))
        if len(parts) == 3:
            break
    while len(parts) < 3:
        parts.append(0)
    return parts[0], parts[1], parts[2]


def av_in_range(version: str) -> bool:
    """True for av 17 and 18. PyAV 19 removed metadata_errors."""
    major, minor, patch = version_tuple(version)
    return (major, minor, patch) >= (17, 0, 0) and major < 19


def installed_av_version() -> str | None:
    try:
        from importlib.metadata import PackageNotFoundError, version
    except Exception:
        return None
    try:
        return version("av")
    except PackageNotFoundError:
        return None
    except Exception:
        return None


def av_guard() -> dict:
    """Missing av is a visible skip. An installed av outside the range fails."""
    found = installed_av_version()
    if not found:
        return {
            "installed": False,
            "ok": True,
            "skipped": True,
            "version": None,
            "requirement": AV_REQUIREMENT,
            "fix": AV_FIX,
            "reason": "av is not installed; skipped",
        }
    ok = av_in_range(found)
    reason = "" if ok else f"dependency-incompatible: av {found} with faster-whisper"
    return {
        "installed": True,
        "ok": ok,
        "skipped": False,
        "version": found,
        "requirement": AV_REQUIREMENT,
        "fix": "" if ok else AV_FIX,
        "reason": reason,
    }


def classify_stt_exception(exc: BaseException) -> SttFault:
    if isinstance(exc, SttFault):
        return exc
    text = str(exc)
    low = text.lower()
    if isinstance(exc, (TypeError, ImportError)) and ("metadata_errors" in low or "unexpected keyword argument" in low):
        guard = av_guard()
        ver = guard.get("version") or "unknown"
        return SttFault(
            "dependency-incompatible",
            f"dependency-incompatible: av {ver} with faster-whisper",
            AV_FIX,
        )
    if (
        isinstance(exc, ImportError)
        or "faster-whisper is not installed" in low
        or "no module named" in low
        or ("not found" in low and "model" in low)
        or "local_files_only" in low
    ):
        return SttFault(
            "model-missing",
            f"model-missing: {text[-400:]}",
            'python -m pip install "faster-whisper>=1.2.1"',
        )
    if "out of memory" in low or "outofmemory" in low or ("cuda" in low and "memory" in low):
        return SttFault("oom", f"oom: {text[-400:]}")
    if isinstance(exc, TimeoutError) or "timed out" in low or "timeout" in low:
        return SttFault("timeout", f"timeout: {text[-400:]}")
    return SttFault("audio-invalid", f"audio-invalid: {text[-400:]}")


def read_pcm16_wav(path: str):
    """16 kHz mono PCM16 WAV to a float32 array. None for any other file.

    This is the hot path for segments FRIDAY recorded. It does not import PyAV.
    """
    try:
        with wave.open(path, "rb") as handle:
            channels = handle.getnchannels()
            rate = handle.getframerate()
            width = handle.getsampwidth()
            frames = handle.readframes(handle.getnframes())
    except (wave.Error, EOFError, OSError):
        return None
    if channels != 1 or rate != PROBE_RATE or width != 2 or not frames:
        return None
    try:
        import numpy as np  # type: ignore
    except Exception:
        return None
    audio = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    return np.ascontiguousarray(audio)


def write_probe_wav(path: str, seconds: float = PROBE_SECONDS) -> str:
    """1.5 s of 440 Hz then silence. Tone plus silence, no speech claim."""
    count = int(PROBE_RATE * seconds)
    tone = int(PROBE_RATE * 0.4)
    frames = bytearray()
    for index in range(count):
        sample = 0
        if index < tone:
            sample = int(0.2 * 32767 * math.sin(2 * math.pi * 440 * index / PROBE_RATE))
        frames += struct.pack("<h", sample)
    with wave.open(path, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(PROBE_RATE)
        handle.writeframes(frames)
    return path


def decode_foreign(path: str):
    """PyAV only for files that are not FRIDAY's own 16 kHz mono PCM WAV."""
    guard = av_guard()
    if guard["installed"] and not guard["ok"]:
        raise SttFault("dependency-incompatible", str(guard["reason"]), AV_FIX)
    try:
        from faster_whisper.audio import decode_audio  # type: ignore
    except ImportError as exc:
        raise SttFault(
            "model-missing",
            "model-missing: faster-whisper is not installed",
            'python -m pip install "faster-whisper>=1.2.1"',
        ) from exc
    try:
        return decode_audio(path, sampling_rate=PROBE_RATE)
    except Exception as exc:  # noqa: BLE001 — typed for the voice status line
        raise classify_stt_exception(exc) from exc


def load_audio_array(path: str):
    """One audio-to-array path. Native WAV first, foreign formats second."""
    native = read_pcm16_wav(path)
    if native is not None:
        return native
    return decode_foreign(path)


# What Whisper "hears" in room noise, a fan, a TV or silence: the sign-offs and credits of the
# videos it was trained on. Said alone, short, and with weak evidence of speech, they are noise.
_NOISE_PHRASES = {
    "thank you",
    "thanks",
    "thanks for watching",
    "thank you for watching",
    "thank you so much for watching",
    "please subscribe",
    "like and subscribe",
    "bye",
    "bye bye",
    "you",
    "okay",
    "ok",
    "subtitles by the amara org community",
    "धन्यवाद",
    "शुक्रिया",
    "नमस्कार दोस्तों",
    "सब्सक्राइब करें",
}
NOISE_PHRASE_MAX_SECONDS = 2.5
NOISE_PHRASE_NO_SPEECH = 0.25
NOISE_PHRASE_LOGPROB = -0.7


def is_noise_hallucination(
    text: str, avg_ns: float, avg_logprob: float | None = None, duration_s: float | None = None
) -> bool:
    """True for a stock sign-off that came out of noise rather than out of the owner.

    The same words from a clear, longer recording are kept: someone may really say "thank you".
    """
    # Only punctuation and symbols go: a Devanagari vowel sign is not a word character to \w.
    bare = "".join(" " if unicodedata.category(ch)[0] in "PS" else ch for ch in (text or "").lower())
    bare = " ".join(bare.split())
    if bare not in _NOISE_PHRASES:
        return False
    weak = (
        avg_ns >= NOISE_PHRASE_NO_SPEECH
        or (avg_logprob is not None and avg_logprob <= NOISE_PHRASE_LOGPROB)
        or (duration_s is not None and duration_s < NOISE_PHRASE_MAX_SECONDS)
    )
    return weak


# Scripts this owner does not speak. A clip heard in room noise that comes back as Japanese,
# Korean, Thai, Arabic or Cyrillic with weak evidence is the model inventing text.
_FOREIGN_SCRIPT_NAMES = ("CJK", "HIRAGANA", "KATAKANA", "HANGUL", "THAI", "ARABIC", "CYRILLIC", "HEBREW")


def is_foreign_script(text: str) -> bool:
    letters = [ch for ch in (text or "") if unicodedata.category(ch)[0] == "L"]
    if len(letters) < 3:
        return False
    foreign = sum(1 for ch in letters if any(name in unicodedata.name(ch, "") for name in _FOREIGN_SCRIPT_NAMES))
    return foreign * 2 > len(letters)


def is_repetition_loop(text: str) -> bool:
    """The same word or phrase repeated three or more times in a row ("1.5kg 1.5kg 1.5kg")."""
    words = (text or "").lower().split()
    if len(words) < 3:
        return False
    for size in (1, 2, 3):
        if len(words) < size * 3:
            continue
        for start in range(0, len(words) - size * 3 + 1):
            chunk = words[start : start + size]
            if words[start + size : start + size * 2] == chunk and words[start + size * 2 : start + size * 3] == chunk:
                return True
    return False


def is_invented_noise(
    text: str, avg_ns: float, avg_logprob: float | None = None, duration_s: float | None = None
) -> bool:
    """A loop or a script the owner does not speak, said with weak evidence of speech."""
    if not (is_repetition_loop(text) or is_foreign_script(text)):
        return False
    return (
        avg_ns >= NOISE_PHRASE_NO_SPEECH
        or (avg_logprob is not None and avg_logprob <= NOISE_PHRASE_LOGPROB)
        or (duration_s is not None and duration_s < NOISE_PHRASE_MAX_SECONDS + 1.5)
    )


def apply_no_speech_policy(
    text: str, avg_ns: float, avg_logprob: float | None = None, duration_s: float | None = None
) -> tuple[str, str, str]:
    """Returns (text, note, drop code).

    Text that Whisper produced is kept unless BOTH the average no-speech
    probability is at the one threshold or above AND the average log-probability
    is at the low-confidence mark or below. A stock sign-off such as "thank you" that came
    from a short or doubtful recording is dropped as noise. Empty text is dropped with the
    code that says why.
    """
    body = (text or "").strip()
    high = avg_ns >= voice_runtime.NO_SPEECH_THRESHOLD
    unsure = avg_logprob is not None and avg_logprob <= voice_runtime.LOW_CONFIDENCE_LOGPROB
    if body:
        if high and unsure:
            return "", f"no_speech {avg_ns:.2f} and avg_logprob {avg_logprob:.2f}", "low-confidence"
        if is_noise_hallucination(body, avg_ns, avg_logprob, duration_s):
            return "", f"noise phrase {body!r}; no_speech {avg_ns:.2f}", "no-speech"
        if is_invented_noise(body, avg_ns, avg_logprob, duration_s):
            return "", f"invented text {body[:40]!r}; no_speech {avg_ns:.2f}", "no-speech"
        if high:
            return body, f"kept segment text; no_speech {avg_ns:.2f}", ""
        return body, "", ""
    if high:
        return "", f"no_speech {avg_ns:.2f}", "no-speech"
    return "", "", "empty"


def _words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9']+", (text or "").lower())


def _instruction_part(hint: str) -> str:
    """The fixed instruction sentences of a prompt.

    Example commands, the owner's current work, and the names list are left
    out: the owner may really say those, and they must never be dropped.
    """
    body = re.sub(r"(?i)examples?:[^.]*\.", " ", hint or "")
    body = re.sub(r"(?i)current work:[^.]*\.", " ", body)
    body = re.sub(r"(?i)names and apps:[^.]*\.?", " ", body)
    return body


def prompt_echo(text: str, hint: str) -> bool:
    """True when the transcript is the instruction prompt, not the utterance.

    Whisper on silence or a clipped segment can return a sentence of its
    prompt, sometimes with a word changed ("Indian language" for "Indian
    English"). A transcript of five or more words that sits inside the
    instruction text, or whose words are nearly all instruction words, is an
    echo.
    """
    said = _words(text)
    seed = _words(_instruction_part(hint))
    if len(said) < 5 or len(seed) < 5:
        return False
    joined_said = " ".join(said)
    if joined_said in " ".join(seed):
        return True
    vocab = set(seed)
    inside = sum(1 for word in said if word in vocab)
    return inside / len(said) >= 0.85


HEARING_ORIGINAL = "original-audio"
HEARING_NO_VAD = "no-vad-no-prompt"


def hearing_passes(text: str, rms_dbfs: float | None, floor: float = -50.0) -> list[str]:
    """Extra passes when the first result is empty and the clip is not silence."""
    if (text or "").strip():
        return []
    if rms_dbfs is None or float(rms_dbfs) <= floor:
        return []
    return [HEARING_NO_VAD, HEARING_ORIGINAL]


def run_hearing_ladder(first: dict, hearing: dict | None, hint: str, transcribe) -> tuple[dict, list[str]]:
    """Retry once without VAD and the prompt, then once on the original audio.

    ``transcribe`` is ``(kind) -> pass dict`` with kind ``no-vad-no-prompt`` or
    ``original-audio``. The single-flight worker stays the caller.
    """
    passes = ["vad"]
    text = (first.get("text") or "").strip()
    chosen = first
    if prompt_echo(text, hint):
        text = ""
        chosen = {**first, "text": ""}
    rms = (hearing or {}).get("rmsDbfs")
    if not hearing_passes(text, rms):
        return chosen, passes
    try:
        second = transcribe(HEARING_NO_VAD)
        passes.append(HEARING_NO_VAD)
        if (second.get("text") or "").strip() and not prompt_echo(second.get("text") or "", hint):
            return second, passes
    except Exception:
        passes.append(f"{HEARING_NO_VAD}-failed")
    if (hearing or {}).get("usedOriginal"):
        return chosen, passes
    try:
        third = transcribe(HEARING_ORIGINAL)
        passes.append(HEARING_ORIGINAL)
        if (third.get("text") or "").strip() and not prompt_echo(third.get("text") or "", hint):
            return third, passes
    except Exception:
        passes.append(f"{HEARING_ORIGINAL}-failed")
    return chosen, passes


def empty_transcript_reason(
    text: str,
    rms_dbfs: float | None,
    *,
    denoise_note: str = "",
    used_collapsed: bool = False,
    vad_ms: int | None = None,
    no_speech: float | None = None,
    echoed_prompt: bool = False,
) -> str:
    """One plain reason. A real transcript has none."""
    if (text or "").strip() and not echoed_prompt:
        return ""
    if rms_dbfs is not None and float(rms_dbfs) <= -50.0:
        return f"silent input (rms {float(rms_dbfs):.0f} dBFS)"
    if used_collapsed and denoise_note:
        return denoise_note
    if vad_ms is not None and vad_ms <= 0:
        return "vad kept 0 ms"
    if echoed_prompt:
        return "prompt only"
    if no_speech is not None and no_speech >= 0.7:
        return f"no_speech {no_speech:.2f}"
    return "empty transcript"


def prepare_audio(audio_path: str) -> tuple[str, object | None, str | None, dict]:
    """Denoise the array. The whisper call receives the array, not a PyAV path.

    A failed import or decode keeps the original array. A denoise result that
    drops speech-level energy is discarded for that original array too.
    """
    samples = load_audio_array(audio_path)
    hearing = {
        "durationMs": 0,
        "rmsDbfs": None,
        "peakDbfs": None,
        "denoisedRmsDbfs": None,
        "denoisedPeakDbfs": None,
        "denoiseNote": "",
        "usedOriginal": True,
        "gainDb": 0.0,
    }
    try:
        import numpy as np  # type: ignore

        raw = np.asarray(samples, dtype=np.float32).reshape(-1)
        before = voice_runtime.pcm_levels(raw, PROBE_RATE)
        # Quiet microphones: lift speech to a normal level before denoise and VAD.
        original, gain_db = voice_runtime.normalize_gain(raw)
        original = np.asarray(original, dtype=np.float32).reshape(-1)
        hearing["gainDb"] = gain_db
        cleaned = np.asarray(voice_runtime.denoise_pcm(original, PROBE_RATE), dtype=np.float32).reshape(-1)
        after = voice_runtime.pcm_levels(cleaned, PROBE_RATE)
        chosen, note = voice_runtime.guard_denoised(original, cleaned)
        chosen = np.asarray(chosen, dtype=np.float32).reshape(-1)
        hearing["prosody"] = voice_runtime.voice_prosody(raw, PROBE_RATE)
        hearing.update(
            {
                "durationMs": before["durationMs"],
                "rmsDbfs": before["rmsDbfs"],
                "peakDbfs": before["peakDbfs"],
                "denoisedRmsDbfs": after["rmsDbfs"],
                "denoisedPeakDbfs": after["peakDbfs"],
                "denoiseNote": note,
                "usedOriginal": bool(note) or chosen.size == 0,
            }
        )
    except Exception:
        return audio_path, samples, None, hearing
    if chosen.size == 0:
        return audio_path, original, None, hearing
    return audio_path, chosen, None, hearing


def transcribe_moonshine(samples, model_dir: str, on_partial) -> str | None:
    """English stream inside this worker. None sends the file to faster-whisper."""
    try:
        import numpy as np  # type: ignore
        from moonshine_voice import ModelArch, Transcriber  # type: ignore
    except Exception:
        return None
    audio = np.asarray(samples, dtype=np.float32).reshape(-1)
    if audio.size < 1600:
        return None
    if audio.size > 16000 * 30:
        audio = audio[: 16000 * 30]
    try:
        transcriber = Transcriber(model_dir, model_arch=ModelArch.TINY_STREAMING)
        stream = transcriber.create_stream(update_interval=0.5)
        stream.start()
        step = 16000
        for start in range(0, audio.size, step):
            stream.add_audio(audio[start : start + step].tolist(), 16000)
        result = stream.stop()
        lines = getattr(result, "lines", None) or []
        text = " ".join(
            (getattr(line, "text", "") or "").strip() for line in lines if (getattr(line, "text", "") or "").strip()
        ).strip()
    except Exception:
        return None
    if text and on_partial:
        on_partial(text)
    return text or None


# True only while a provisional (not-final) pass runs: it is neither counted nor recorded.
_provisional_pass = False


class DecodeCancelled(BaseException):  # noqa: N818 — not an error, and a BaseException so no `except Exception` swallows it
    """Raised at a segment or pass boundary when the owner's speech resumed and a provisional decode is not wanted."""


# A cancel is cooperative: it sets a flag that the decode reads between segments and passes (a decode that is inside
# one model call finishes that call first). Only a provisional decode can be cancelled; a final one never is.
_cancel_lock = threading.Lock()
_active_decode: dict = {"key": "", "event": None}
_cancelled_keys: deque = deque(maxlen=32)  # cancels that arrived before their decode began (bounded)


def begin_decode(key: str, provisional: bool) -> None:
    """Open the cancel window of one decode. A cancel that arrived first ends it before any work."""
    key = (key or "")[:64]
    with _cancel_lock:
        if not provisional:
            _active_decode["key"], _active_decode["event"] = "", None
            return
        early = bool(key) and key in _cancelled_keys
        if early:
            _cancelled_keys.remove(key)
        event = threading.Event()
        if early:
            event.set()
        _active_decode["key"], _active_decode["event"] = key, event
    check_cancel()


def end_decode() -> None:
    with _cancel_lock:
        _active_decode["key"], _active_decode["event"] = "", None


def check_cancel() -> None:
    """Raise DecodeCancelled when this decode was cancelled. Cheap: called between segments and passes."""
    event = _active_decode["event"]
    if event is not None and event.is_set():
        raise DecodeCancelled()


def request_cancel(key: str = "") -> dict:
    """Cancel the running provisional decode (this key, or any when the key is empty), or remember the key for one
    that has not begun. Called from the reader thread; never takes the model lock, so it answers during a decode."""
    key = str(key or "")[:64]
    with _cancel_lock:
        event = _active_decode["event"]
        if event is not None and (not key or _active_decode["key"] == key):
            event.set()
            return {"ok": True, "cancelled": True, "queued": False, "utteranceId": _active_decode["key"]}
        if key and key not in _cancelled_keys:
            _cancelled_keys.append(key)
        return {"ok": True, "cancelled": False, "queued": bool(key), "utteranceId": key}


def cancelled_reply(req: dict) -> dict:
    """What a cancelled decode answers: not ok, never final, never counted as heard, never a fault."""
    reply = {"ok": False, "reason": "cancelled", "cancelled": True, "final": False}
    uid = req.get("utteranceId")
    if isinstance(uid, str) and uid.strip():
        reply["utteranceId"] = uid.strip()[:64]
    return reply


def transcribe_file(
    audio: str,
    model_name: str,
    language: str,
    initial_prompt: str,
    on_partial=None,
    speech_pref: str = "",
    owner_size: str = "",
    model_path: str = "",
    keep_wav: bool = False,
    extras: dict | None = None,
    provisional: bool = False,
    utterance_id: str = "",
    live: bool = False,
) -> dict:
    """One utterance file to text. A provisional pass runs every gate but is never counted or recorded, and it alone
    can be cancelled (``request_cancel``): that raises DecodeCancelled out of here, with nothing counted. A live pass
    (a provisional one that asks for timed words) takes the lean path ``transcribe_live`` instead."""
    global _provisional_pass
    _provisional_pass = bool(provisional)
    try:
        begin_decode(utterance_id, bool(provisional))
        if live and provisional:
            return transcribe_live(audio, language, speech_pref, extras)
        return _transcribe_file(
            audio,
            model_name,
            language,
            initial_prompt,
            on_partial,
            speech_pref,
            owner_size,
            model_path,
            keep_wav,
            extras,
            provisional,
        )
    finally:
        end_decode()
        _provisional_pass = False


def _transcribe_file(
    audio: str,
    model_name: str,
    language: str,
    initial_prompt: str,
    on_partial,
    speech_pref: str,
    owner_size: str,
    model_path: str,
    keep_wav: bool,
    extras: dict | None,
    provisional: bool,
) -> dict:
    prepared, samples, cleanup, hearing = prepare_audio(audio)
    original = None
    try:
        import numpy as np  # type: ignore

        loaded = load_audio_array(audio)
        original = np.asarray(loaded, dtype=np.float32).reshape(-1)
    except Exception:
        original = samples
    try:
        result = _transcribe_prepared(
            prepared,
            samples,
            model_name,
            language,
            initial_prompt,
            on_partial,
            speech_pref,
            owner_size,
            model_path,
            hearing,
            original,
            extras,
        )
        if not provisional:
            _record_hearing(result.get("audio") or hearing, original, samples, keep_wav)
        return result
    finally:
        if cleanup and os.path.exists(cleanup):
            try:
                os.remove(cleanup)
            except OSError:
                pass


# ---- Live words: one lean pass over the audio spoken so far -------------------------------------------------------

LIVE_MAX_S = 30.0  # the renderer keeps its buffer to about this; a longer clip loses its oldest audio
LIVE_MIN_S = 0.2
LIVE_NOISE_NO_SPEECH = 0.6
LIVE_NOISE_LOGPROB = -1.0
LIVE_PAD_S = 0.1  # a Roman Hindi phrase is cut this much wider before the Hindi ear re-reads it


def _live_empty(seconds: float) -> dict:
    return {"ok": True, "text": "", "words": [], "segments": [], "language": "", "languageProbability": None,
            "engine": "faster-whisper", "durationMs": int(seconds * 1000)}  # fmt: skip


def live_segment_is_noise(text: str, no_speech, logprob) -> bool:
    """A segment that is a loop, a stock sign-off from noise, or silence the model made words for."""
    if is_repetition_loop(text):
        return True
    ns = float(no_speech) if isinstance(no_speech, (int, float)) else 0.0
    lp = float(logprob) if isinstance(logprob, (int, float)) else None
    if lp is not None and ns >= LIVE_NOISE_NO_SPEECH and lp <= LIVE_NOISE_LOGPROB:
        return True
    return is_noise_hallucination(text, ns, lp)


def _shifted(words: list[dict], by: float) -> list[dict]:
    return [{"text": w["text"], "start": round(w["start"] + by, 3), "end": round(w["end"] + by, 3)} for w in words]


def _snap_rows(rows: list[dict], hotwords: list[str]) -> list[dict]:
    if not hotwords:
        return rows
    words = [Word(r["text"], float(r["start"]), float(r["end"])) for r in rows]
    return [{"text": w.text, "start": w.start, "end": w.end} for w in snap_hotwords(words, hotwords)]


def _live_script(words: list[dict]) -> str:
    """``hi`` (all Devanagari), ``latin`` (all Latin), ``mixed`` or "" (no letters)."""
    text = " ".join(w["text"] for w in words)
    deva = bool(re.search("[\u0900-\u097f]", text))
    latin = bool(re.search("[A-Za-z]", text))
    return "mixed" if deva and latin else "hi" if deva else "latin" if latin else ""


def transcribe_live(audio: str, language: str, speech_pref: str, extras: dict | None = None) -> dict:
    """Timed words for the audio so far, by the fastest engine that fits, never counted, recorded or loaded for.

    * The Hindi ear reads first when Hindi is chosen or nothing is (auto) and keeps the line by its own score, exactly
      as the final decode does, so a partial and its final agree on who hears it.
    * Otherwise the faster-whisper model that is already resident reads it with word times (English locked to ``en``,
      Hindi to ``hi``, auto left to detect). A model that is not loaded, or a model of medium size or more on the
      processor, is not asked: a guess is never worth a model load or a slow pass (the renderer skips the pass).
    * In auto, a Roman Hindi phrase of a mixed reading is re-read by the Hindi ear alone, so Hindi words come out in
      Devanagari and English words stay Latin, by phrase. Nothing else is routed.
    """
    import numpy as np  # type: ignore

    loaded = load_audio_array(audio)
    clip = np.asarray(loaded, dtype=np.float32).reshape(-1)
    rate = float(PROBE_RATE)
    total = len(clip) / rate
    if total < LIVE_MIN_S:
        return _live_empty(total)
    shift = 0.0
    if total > LIVE_MAX_S:
        shift = total - LIVE_MAX_S
        clip = clip[-int(LIVE_MAX_S * rate) :]
    duration_ms = int(total * 1000)
    check_cancel()
    mode = hindi_ear.listen_mode(language, speech_pref)
    if mode in {"hi", "auto"} and hindi_ear.ready():
        heard = hindi_ear.transcribe_words(clip)
        if _ear_loaded():
            touch()
        check_cancel()
        if heard and hindi_ear.confident(mode, heard.get("confidence")):
            words = _shifted(_snap_rows(heard["words"], hotword_list((extras or {}).get("hotwords"))), shift)
            return {
                "ok": True,
                "text": " ".join(w["text"] for w in words),
                "words": words,
                "segments": [{"start": words[0]["start"], "end": words[-1]["end"]}],
                "language": "hi",
                "languageProbability": None,
                "engine": "hindi-ear",
                "durationMs": duration_ms,
            }
    alt = whisper_ears.choose(language, speech_pref, hindi_ear.ready(), hindi_ear.wants_hindi(language, speech_pref))
    if _model is None or (alt is not None and _model_name != alt["path"]):
        return {
            "ok": False,
            "reason": "not-ready",
            "error": "The speech model for this listening mode is not loaded yet.",
        }
    if is_heavy_model(_model_name) and _device_name == "cpu":
        return {
            "ok": False,
            "reason": "live-too-heavy",
            "error": "This model is too slow on the processor for live words.",
        }
    if alt is not None:
        lang = alt["decode"]
    elif mode in {"en", "hi"}:
        lang = mode
    elif mode == "other":
        lang = resolve_language(speech_pref or language)
    else:
        lang = None
    kwargs: dict = {
        "language": lang,
        "vad_filter": True,
        "vad_parameters": dict(VAD_PARAMETERS),
        "beam_size": 1,
        "condition_on_previous_text": False,
        "temperature": 0.0,
        **decode_options({**(extras or {}), "word_timestamps": True}, lang is not None),
    }
    hint = DEFAULT_HINT if lang is None else ""
    if hint:
        kwargs["initial_prompt"] = hint[:800]
    check_cancel()
    segments, info = _model.transcribe(clip, **kwargs)
    rows: list[dict] = []  # {"start", "end", "text", "words"} per kept segment, in the clip's clock
    for seg in segments:
        check_cancel()
        text = (getattr(seg, "text", "") or "").strip()
        if not text or live_segment_is_noise(
            text, getattr(seg, "no_speech_prob", None), getattr(seg, "avg_logprob", None)
        ):
            continue
        if hint and prompt_echo(text, hint):
            continue
        begin, end = float(getattr(seg, "start", 0.0) or 0.0), float(getattr(seg, "end", 0.0) or 0.0)
        words = [
            {"text": str(getattr(w, "word", "") or "").strip(), "start": float(w.start), "end": float(w.end)}
            for w in (getattr(seg, "words", None) or [])
        ]
        words = [w for w in words if w["text"]]
        if not words:
            words = _shifted(hindi_ear.group_words(None, None, max(0.0, end - begin), text), begin)
        rows.append({"start": begin, "end": end, "text": text, "words": words})
    routed = False
    if mode == "auto" and alt is None and hindi_ear.ready():
        for row in rows:
            if not whisper_ears.roman_hindi_segment(row["text"]):
                continue
            lo = max(0.0, row["start"] - LIVE_PAD_S)
            hi = min(len(clip) / rate, row["end"] + LIVE_PAD_S)
            heard = hindi_ear.transcribe_words(clip[int(lo * rate) : int(hi * rate)])
            check_cancel()
            if heard and hindi_ear.confident("auto", heard.get("confidence")):
                row["words"] = _shifted(heard["words"], lo)
                routed = True
    words = _shifted([w for row in rows for w in row["words"]], shift)
    spans = [{"start": round(row["start"] + shift, 3), "end": round(row["end"] + shift, 3)} for row in rows]
    script = _live_script(words)
    if routed or script == "mixed":
        spoken, probability = "mixed", None
    else:
        spoken = alt["report"] if alt is not None else (getattr(info, "language", "") or lang or "")
        probability = _language_probability(info)
    return {
        "ok": True,
        "text": " ".join(w["text"] for w in words),
        "words": words,
        "segments": spans,
        "language": spoken,
        "languageProbability": probability,
        "engine": alt["engine"] if alt is not None else "faster-whisper",
        "durationMs": duration_ms,
        "model": _model_name or "",
    }


def _consume_whisper(model, payload, kwargs, on_partial) -> dict:
    """One whisper pass. Segment text is kept even when no-speech is high."""
    check_cancel()
    segments, info = model.transcribe(payload, **kwargs)
    parts: list[str] = []
    rows: list[dict] = []
    no_speech: list[float] = []
    logprobs: list[float] = []
    partials = 0
    for seg in segments:
        check_cancel()
        text = (getattr(seg, "text", "") or "").strip()
        if text:
            parts.append(text)
            begin, end = getattr(seg, "start", None), getattr(seg, "end", None)
            if isinstance(begin, (int, float)) and isinstance(end, (int, float)):
                rows.append({"text": text, "start": float(begin), "end": float(end)})
            partials += 1
            if on_partial and partials <= 12:
                on_partial(" ".join(parts))
        prob = getattr(seg, "no_speech_prob", None)
        if isinstance(prob, (int, float)):
            no_speech.append(float(prob))
        logprob = getattr(seg, "avg_logprob", None)
        if isinstance(logprob, (int, float)):
            logprobs.append(float(logprob))
    joined = " ".join(parts).strip()
    avg = sum(no_speech) / len(no_speech) if no_speech else 0.0
    avg_lp = sum(logprobs) / len(logprobs) if logprobs else None
    duration = getattr(info, "duration", None)
    kept, note, policy_code = apply_no_speech_policy(
        joined, avg, avg_lp, float(duration) if isinstance(duration, (int, float)) else None
    )
    vad = getattr(info, "duration_after_vad", None)
    vad_ms = int(float(vad) * 1000) if isinstance(vad, (int, float)) else 0
    return {
        "text": kept,
        "noSpeechProb": round(avg, 4),
        "noSpeechNote": note,
        "avgLogprob": round(avg_lp, 4) if avg_lp is not None else None,
        "policyCode": policy_code,
        "vadMs": vad_ms,
        "language": getattr(info, "language", "") or "",
        "languageProbability": _language_probability(info),
        "durationMs": int(float(getattr(info, "duration", 0.0) or 0.0) * 1000),
        "segments": rows if len(rows) == partials else [],
    }


def _language_probability(info) -> float | None:
    value = getattr(info, "language_probability", None)
    return round(float(value), 3) if isinstance(value, (int, float)) else None


# Whisper guesses the language from the first seconds. On a short Hinglish phrase the guess is often English with a low
# probability, and the English decode then makes up fluent English that was never said ("I'm going to get a car").
LANGUAGE_CONFIDENT = 0.85
# Languages Whisper tends to name when it hears Hindi mixed with English.
LANGUAGE_RECHECK = frozenset({"en", "hi", "ur", "ne", "mr", "bn", "pa", "gu", "sa"})
# A second reading must be this much more likely, per token, before it replaces the first.
LANGUAGE_LOGPROB_MARGIN = 0.08
# Only short clips are read twice: the second decode is the price of a better guess, so it must stay quick.
LANGUAGE_RECHECK_MAX_MS = 15_000


def should_recheck_language(first: dict, language_locked: bool) -> bool:
    """True when the language was guessed, the guess was weak, and there is something to read twice."""
    if language_locked:
        return False
    if not (first.get("text") or "").strip():
        return False
    probability = first.get("languageProbability")
    if not isinstance(probability, (int, float)) or probability >= LANGUAGE_CONFIDENT:
        return False
    # A long clip gives the language guess plenty to go on, and a second full decode would cost seconds.
    if int(first.get("durationMs") or 0) > LANGUAGE_RECHECK_MAX_MS:
        return False
    return (first.get("language") or "") in LANGUAGE_RECHECK


def choose_language_pass(first: dict, second: dict) -> tuple[dict, str]:
    """Keep the reading the model was more sure of, per token, and say which one won and why."""
    text = (second.get("text") or "").strip()
    if not text:
        return first, "kept the first reading: the second was empty"
    a, b = first.get("avgLogprob"), second.get("avgLogprob")
    if not isinstance(b, (int, float)):
        return first, "kept the first reading: the second had no confidence score"
    was = first.get("language") or "?"
    now = second.get("language") or "hi"
    if isinstance(a, (int, float)) and b <= a + LANGUAGE_LOGPROB_MARGIN:
        return first, f"kept the first reading ({was}): not clearly worse than Hindi"
    note = f"switched from {was} to {now}: the second reading was more certain"
    return {**second, "languageNote": note}, note


def rescore_segments(first: dict, samples, language: str, speech_pref: str, decode) -> tuple[dict, str]:
    """One forced-language look per segment whose language differs from the reading's (Hindi in Devanagari, English
    in Latin, Roman Hindi read as Hindi), so a Hinglish utterance is not written in one script. ``decode(clip, lang)``
    is one Whisper pass; a segment keeps its first text unless the new one is in the right script and length."""
    rows = first.get("segments") or []
    text = (first.get("text") or "").strip()
    if samples is None or not rows or not text or " ".join(r["text"] for r in rows).strip() != text:
        return first, ""
    mode = turn_mode(speech_pref or language)
    plans = plan_rescore(rows, first.get("language") or None, mode)
    if not plans:
        return first, ""

    def one(plan) -> dict:
        check_cancel()
        return decode(samples[int(plan.start * RATE) : int(plan.end * RATE)], plan.language)

    rows, changed = apply_rescore(rows, plans, one)
    if not changed:
        return first, ""
    note = f"read {changed} segment(s) again in their own language"
    return {**first, "text": " ".join(r["text"] for r in rows), "segments": rows, "rescored": changed}, note


TOO_SHORT_MS = 300
VAD_PARAMETERS = {"threshold": 0.35, "min_silence_duration_ms": 700, "speech_pad_ms": 400}

_counters: dict = {"heard": 0, "dropped": {}}


def note_outcome(code: str) -> None:
    """Count one utterance: heard when the code is empty, else dropped by that code."""
    if _provisional_pass:
        return
    if not code:
        _counters["heard"] += 1
        return
    dropped = _counters["dropped"]
    dropped[code] = int(dropped.get(code, 0)) + 1


def counters_payload() -> dict:
    dropped = {code: int(_counters["dropped"].get(code, 0)) for code in voice_runtime.DROP_CODES}
    return {"heard": int(_counters["heard"]), "dropped": dropped, "droppedTotal": sum(dropped.values())}


def drop_code(
    text: str,
    *,
    duration_ms: int | None = None,
    rms_dbfs: float | None = None,
    denoise_note: str = "",
    vad_ms: int | None = None,
    policy_code: str = "",
    echoed_prompt: bool = False,
) -> str:
    """One reason code for an utterance that produced no text. A real transcript has none."""
    if (text or "").strip() and not echoed_prompt:
        return ""
    if duration_ms is not None and duration_ms <= 0:
        return "no-frames"
    if duration_ms is not None and duration_ms < TOO_SHORT_MS:
        return "too-short"
    if denoise_note:
        return "denoise-skipped"
    if policy_code in {"low-confidence", "no-speech"}:
        return policy_code
    if rms_dbfs is not None and float(rms_dbfs) <= -50.0:
        return "no-speech"
    if vad_ms is not None and vad_ms <= 0:
        return "no-speech"
    return "empty"


def _finish_hearing(hearing: dict, pass_row: dict, hint: str, passes: list[str]) -> dict:
    text = (pass_row.get("text") or "").strip()
    echoed = prompt_echo(text, hint)
    if echoed:
        text = ""
    reason = empty_transcript_reason(
        text,
        hearing.get("rmsDbfs"),
        denoise_note=str(hearing.get("denoiseNote") or ""),
        used_collapsed=not hearing.get("usedOriginal"),
        vad_ms=pass_row.get("vadMs"),
        no_speech=pass_row.get("noSpeechProb"),
        echoed_prompt=echoed,
    )
    code = drop_code(
        text,
        duration_ms=hearing.get("durationMs"),
        rms_dbfs=hearing.get("rmsDbfs"),
        denoise_note=str(hearing.get("denoiseNote") or ""),
        vad_ms=pass_row.get("vadMs"),
        policy_code=str(pass_row.get("policyCode") or ""),
        echoed_prompt=echoed,
    )
    note_outcome(code)
    device = choose_stt_device(cuda_runtime_ready())
    hearing.update(
        {
            "dropCode": code,
            "avgLogprob": pass_row.get("avgLogprob"),
            "vadMs": pass_row.get("vadMs"),
            "noSpeechProb": pass_row.get("noSpeechProb"),
            "model": _model_name or "",
            "device": _device_name or device["device"],
            "compute": _compute_type or device["compute_type"],
            "language": pass_row.get("language") or "",
            "promptUsed": bool(hint) and HEARING_NO_VAD not in passes and HEARING_ORIGINAL not in passes,
            "emptyReason": reason,
            "passes": passes,
            "noSpeechNote": pass_row.get("noSpeechNote") or "",
        }
    )
    return hearing


def _record_hearing(hearing: dict, original, cleaned, keep_wav: bool) -> None:
    """One JSON line per utterance. WAVs stay off unless the owner asks."""
    root = os.environ.get("FRIDAY_ROOT", "").strip()
    if not root:
        return
    folder = Path(root) / "debug" / "reports"
    try:
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / "voice-hearing.jsonl"
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(hearing, ensure_ascii=False) + "\n")
        if path.stat().st_size > 200_000:
            lines = path.read_text(encoding="utf-8").splitlines()[-200:]
            path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        if keep_wav:
            _stash_utterance_wavs(folder / "utterances", original, cleaned)
    except OSError:
        return


def _stash_utterance_wavs(folder: Path, original, cleaned) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    existing = sorted(folder.glob("*.wav"))
    stamp = f"{len(existing):05d}"
    _write_float_wav(folder / f"{stamp}-raw.wav", original)
    _write_float_wav(folder / f"{stamp}-denoised.wav", cleaned if cleaned is not None else original)
    wavs = sorted(folder.glob("*.wav"))
    # Five utterances, raw and denoised.
    for old in wavs[:-10]:
        try:
            old.unlink()
        except OSError:
            continue


def _write_float_wav(path: Path, samples) -> None:
    import numpy as np  # type: ignore

    audio = np.asarray(samples if samples is not None else [], dtype=np.float32).reshape(-1)
    pcm = np.clip(np.round(audio * 32767.0), -32768, 32767).astype("<i2")
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(PROBE_RATE)
        handle.writeframes(pcm.tobytes())


def _transcribe_prepared(
    audio: str,
    samples,
    model_name: str,
    language: str,
    initial_prompt: str,
    on_partial,
    speech_pref: str,
    owner_size: str = "",
    model_path: str = "",
    hearing: dict | None = None,
    original=None,
    extras: dict | None = None,
) -> dict:
    engine = "faster-whisper"
    moon_text = None
    if wants_english_stream(language, speech_pref) and samples is not None:
        moon_dir = moonshine_model_dir()
        if moon_dir:
            moon_text = transcribe_moonshine(samples, moon_dir, on_partial)
            if moon_text:
                engine = "moonshine-en"
    hindi_text = None
    ear_note = ""
    if not moon_text and samples is not None and hindi_ear.tries_ear(language, speech_pref):
        # Hindi chosen, or no language chosen, and FRIDAY's Hindi ear on disk: it hears first and faster-whisper
        # answers if it cannot, or if the ear itself is unsure (English or mixed speech comes out as Devanagari
        # words that mean nothing, and its own token scores say so).
        ear_was_open, ear_started = _ear_loaded(), _now()
        hindi_text = hindi_ear.transcribe(samples)
        if _ear_loaded():
            if not ear_was_open:
                # The first reading opens the ear, so this time includes that one decode.
                _load_ms[HINDI_EAR_NAME] = int((_now() - ear_started) * 1000)
            touch()
        check_cancel()
        mode = hindi_ear.listen_mode(language, speech_pref)
        if hindi_text and not hindi_ear.confident(mode, hindi_ear.last_confidence()):
            hindi_text = None
            note_fallback("hindi-ear-to-whisper")
            ear_note = "the Hindi ear was unsure (English or mixed speech): faster-whisper heard it"
        if hindi_text:
            engine = "hindi-ear"
            hindi_text = snap_text(hindi_text, hotword_list((extras or {}).get("hotwords")))
    turn_probability = None
    # The end-of-turn score is informational here (the capture already closed the turn), so it is read only when asked
    # for: it used to run before every decode and add its own model run to the wait for the words.
    if samples is not None and (extras or {}).get("turn_score") is True:
        try:
            scored = voice_runtime.score_turn(samples, 16000)
            if isinstance(scored.get("probability"), (int, float)):
                turn_probability = float(scored["probability"])
        except Exception:
            turn_probability = None
    if moon_text:
        return _heard(
            {
                "ok": True,
                "text": moon_text,
                "language": "en",
                "durationMs": 0,
                "model": "moonshine-tiny-streaming",
                "noSpeechProb": 0.0,
                "loadCount": _load_count,
                "engine": engine,
                "turnProbability": turn_probability,
            },
            hearing,
            {"text": moon_text, "vadMs": None, "noSpeechProb": 0.0, "language": "en", "noSpeechNote": ""},
            "",
            ["moonshine"],
        )
    if hindi_text:
        return _heard(
            {
                "ok": True,
                "text": hindi_text,
                "language": "hi",
                "durationMs": 0,
                "model": "indicconformer-hi-int8",
                "noSpeechProb": 0.0,
                "loadCount": _load_count,
                "engine": engine,
                "turnProbability": turn_probability,
            },
            hearing,
            {"text": hindi_text, "vadMs": None, "noSpeechProb": 0.0, "language": "hi", "noSpeechNote": ""},
            "",
            ["hindi-ear"],
        )
    # An optional ear (Hinglish in Roman letters, or the Hindi fallback) listens only when its mode is chosen and its
    # pinned files are on disk; any load or decode failure is remembered and the engine of today hears the utterance.
    check_cancel()  # the ear is done and nothing was heard: do not open a model for a decode nobody wants
    alt = whisper_ears.choose(language, speech_pref, hindi_ear.ready(), hindi_ear.wants_hindi(language, speech_pref))
    model = None
    if alt is not None:
        try:
            model = get_model(alt["id"], alt["path"])
        except Exception:  # noqa: BLE001 — the generic model answers instead
            whisper_ears.mark_failed(alt["id"])
            note_fallback("ear-to-generic")
            alt = None
    try:
        if model is None:
            model = get_model(owner_model(owner_size, model_name), model_path or None, **auto_flag(owner_size))
    except Exception:
        windows_text = transcribe_windows(audio)
        if not windows_text:
            raise
        note_fallback("model-to-windows-speech")
        return _heard(
            {
                "ok": True,
                "text": windows_text,
                "language": "",
                "durationMs": 0,
                "model": "windows-speech",
                "noSpeechProb": 0.0,
                "loadCount": _load_count,
                "engine": "windows-speech",
                "turnProbability": turn_probability,
            },
            hearing,
            {"text": windows_text, "vadMs": None, "noSpeechProb": 0.0, "language": "", "noSpeechNote": ""},
            "",
            ["windows-speech"],
        )
    lang = alt["decode"] if alt is not None else resolve_language(language)
    if alt is not None:
        engine = alt["engine"]
    hint = (initial_prompt or "").strip()
    if lang is None and not hint:
        hint = DEFAULT_HINT
    kwargs: dict = {
        "language": lang,
        "vad_filter": True,
        # Silero's 0.5 default drops soft speech from laptop arrays; the
        # no-speech policy still removes a hallucinated line afterwards.
        "vad_parameters": dict(VAD_PARAMETERS),
        "beam_size": 1,
        "condition_on_previous_text": False,
        **decode_options(extras, lang is not None),
    }
    if hint:
        kwargs["initial_prompt"] = hint[:800]
    payload = samples if samples is not None else audio
    try:
        first = _consume_whisper(model, payload, kwargs, on_partial)
    except Exception as exc:  # noqa: BLE001 — classified, then the ladder may speak
        if alt is not None:
            # The optional ear could not decode: remember it and let the engine of today hear this utterance.
            whisper_ears.mark_failed(alt["id"])
            return _transcribe_prepared(
                audio, samples, model_name, language, initial_prompt, on_partial, speech_pref,
                owner_size, model_path, hearing, original, extras,
            )  # fmt: skip
        fault = classify_stt_exception(exc)
        windows_text = None
        if fault.kind in {"oom", "timeout", "dependency-incompatible"} and isinstance(audio, str):
            windows_text = transcribe_windows(audio)
        if not windows_text:
            raise fault from exc
        return _heard(
            {
                "ok": True,
                "text": windows_text,
                "language": "",
                "durationMs": 0,
                "model": "windows-speech",
                "noSpeechProb": 0.0,
                "loadCount": _load_count,
                "engine": "windows-speech",
                "turnProbability": turn_probability,
                "notice": str(fault),
                "sttClass": fault.kind,
                "fix": fault.fix,
            },
            hearing,
            {"text": windows_text, "vadMs": None, "noSpeechProb": 0.0, "language": "", "noSpeechNote": ""},
            "",
            ["windows-speech"],
        )
    language_note = ear_note
    check_cancel()
    if not ear_note and should_recheck_language(first, lang is not None):
        # (Not after the Hindi ear judged this audio: a second Hindi-locked decode would repeat that look at full cost.)
        try:
            again_hi = _consume_whisper(model, payload, {**kwargs, "language": "hi"}, None)
            first, language_note = choose_language_pass(first, again_hi)
        except Exception:  # the first reading stands; a failed second look must never lose the utterance
            language_note = "kept the first reading: the second look failed"
    bare = {key: value for key, value in kwargs.items() if key not in {"initial_prompt", "vad_parameters"}}
    bare["vad_filter"] = False
    if alt is None:
        plain = {k: v for k, v in bare.items() if k not in {"word_timestamps", "hallucination_silence_threshold"}}
        first, rescore_note = rescore_segments(
            first,
            samples,
            language,
            speech_pref,
            lambda clip, forced: _consume_whisper(model, clip, {**plain, "language": forced}, None),
        )
        language_note = "; ".join(n for n in (language_note, rescore_note) if n)

    def again(kind: str) -> dict:
        check_cancel()
        clip = original if kind == HEARING_ORIGINAL and original is not None else payload
        return _consume_whisper(model, clip, bare, on_partial)

    chosen, passes = run_hearing_ladder(first, hearing, hint, again)
    text = (chosen.get("text") or "").strip()
    return _heard(
        {
            "ok": True,
            "text": text,
            "language": alt["report"] if alt is not None else chosen.get("language") or lang or "",
            "languageProbability": chosen.get("languageProbability"),
            "languageNote": language_note
            or ("Hinglish ear: Roman letters" if alt is not None and alt["id"] == whisper_ears.HINGLISH_ID else ""),
            "avgLogprob": chosen.get("avgLogprob"),
            "durationMs": chosen.get("durationMs") or 0,
            "model": _model_name or model_name,
            "noSpeechProb": chosen.get("noSpeechProb") or 0.0,
            "loadCount": _load_count,
            "engine": engine,
            "turnProbability": turn_probability,
        },
        hearing,
        chosen,
        hint if HEARING_NO_VAD not in passes and HEARING_ORIGINAL not in passes else "",
        passes,
    )


def _heard(payload: dict, hearing: dict | None, pass_row: dict, hint: str, passes: list[str]) -> dict:
    facts = dict(hearing or {})
    _finish_hearing(facts, pass_row, hint, passes)
    if HEARING_NO_VAD in passes or HEARING_ORIGINAL in passes:
        facts["promptUsed"] = False
    elif hint:
        facts["promptUsed"] = True
    payload["audio"] = facts
    payload["emptyReason"] = facts.get("emptyReason") or ""
    payload["dropCode"] = facts.get("dropCode") or ""
    payload["noSpeechThreshold"] = voice_runtime.NO_SPEECH_THRESHOLD
    payload["counters"] = counters_payload()
    return payload


# Ask which recognisers are installed. Do NOT create System.Speech.Recognition.SpeechRecognizer here: that is the
# shared Windows recogniser, which starts sapisvr.exe and, on a PC where Speech Recognition was never set up, opens
# the "Set up Speech Recognition" wizard (SpeechUXWiz.exe) on the owner's desktop and leaves both running.
WINDOWS_SPEECH_PROBE = (
    "Add-Type -AssemblyName System.Speech; "
    "if ([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers().Count -gt 0) "
    "{ 'installed' } else { 'missing' }"
)

_windows_speech: bool | None = None


def windows_speech_ready() -> bool:
    """True only on Windows when the built-in recogniser assembly answers."""
    global _windows_speech
    if _windows_speech is not None:
        return _windows_speech
    if sys.platform != "win32":
        _windows_speech = False
        return False
    try:
        import subprocess

        done = subprocess.run(
            ["powershell", "-NoProfile", "-Command", WINDOWS_SPEECH_PROBE],
            capture_output=True,
            text=True,
            timeout=8,
            check=False,
            # Never inherit the program folder as the current directory: a child that stands there keeps it alive.
            cwd=tempfile.gettempdir(),
        )
        _windows_speech = "installed" in (done.stdout or "")
    except Exception:
        _windows_speech = False
    return bool(_windows_speech)


def transcribe_windows(audio: str) -> str | None:
    """Dictation from a wav through the installed Windows language pack. No download."""
    if sys.platform != "win32" or not audio or not os.path.exists(audio):
        return None
    if not str(audio).lower().endswith(".wav") or not windows_speech_ready():
        return None
    safe = str(audio).replace("'", "''")
    script = (
        "$ErrorActionPreference='Stop'; "
        "Add-Type -AssemblyName System.Speech; "
        "$e = New-Object System.Speech.Recognition.SpeechRecognitionEngine; "
        "$e.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar)); "
        f"$e.SetInputToWaveFile('{safe}'); "
        "$r = $e.Recognize(); "
        "if ($r) { $r.Text }"
    )
    try:
        import subprocess

        done = subprocess.run(
            ["powershell", "-NoProfile", "-Command", script],
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
            cwd=tempfile.gettempdir(),
        )
    except Exception:
        return None
    text = (done.stdout or "").strip()
    return text or None


def live_ladder(facts: dict | None) -> dict:
    """Pick the local engine. Privacy mode never leaves this PC. No download starts here."""
    row = facts or {}
    if row.get("whisperReady") and row.get("weightsReady"):
        size = str(row.get("size") or "base")
        return {
            "engine": "faster-whisper",
            "status": "ready",
            "reason": str(row.get("sizeReason") or f"faster-whisper {size}"),
            "local": True,
        }
    if row.get("downloading"):
        return {
            "engine": "faster-whisper",
            "status": "downloading",
            "reason": "downloading",
            "local": True,
        }
    blocked = None
    if row.get("blocked"):
        blocked = {
            "engine": "faster-whisper",
            "status": "blocked",
            "reason": str(row.get("blockReason") or "blocked"),
            "local": True,
        }
    if row.get("english") and row.get("moonshineReady"):
        return {
            "engine": "moonshine",
            "status": "ready",
            "reason": "Moonshine English weights are on disk",
            "local": True,
        }
    if row.get("windowsSpeech"):
        return {
            "engine": "windows-speech",
            "status": "ready",
            "reason": "Windows speech language pack is installed",
            "local": True,
        }
    if blocked:
        return blocked
    return {
        "engine": "none",
        "status": "missing",
        "reason": "Install a local speech model, or add a Windows speech language pack.",
        "local": True,
    }


def status_payload() -> dict:
    cls = _import_whisper()
    cuda_ready = cuda_runtime_ready()
    device = choose_stt_device(cuda_ready)
    return {
        "ok": True,
        "cudaRuntimeReady": cuda_ready,
        "available": cls is not None,
        "dependency": "ready" if cls is not None else "missing",
        "modelLoaded": _model is not None,
        "model": _model_name or DEFAULT_MODEL,
        "cache": cache_dir(),
        "loadCount": _load_count,
        "device": device["device"],
        "compute": device["compute_type"],
        "deviceReason": device["reason"],
        "inference": "verified" if _model is not None else "unverified",
        "error": None if cls is not None else _whisper_error,
        "moonshineReady": moonshine_model_dir() is not None,
        "hindiEarReady": hindi_ear.ready(),
        "streamEar": stream_ear.HOST.status(),
        "hinglishEarReady": whisper_ears.hinglish_ready(),
        "hindiFallbackReady": whisper_ears.hindi_fallback_ready(),
        "windowsSpeech": windows_speech_ready(),
        "av": av_guard(),
        **cache_status(),
        "counters": counters_payload(),
        "noSpeechThreshold": voice_runtime.NO_SPEECH_THRESHOLD,
        "local": True,
        "ladder": live_ladder(
            {
                "whisperReady": cls is not None,
                "weightsReady": _model is not None,
                "size": _model_name or DEFAULT_MODEL,
                "english": False,
                "moonshineReady": moonshine_model_dir() is not None,
                "windowsSpeech": windows_speech_ready(),
            }
        ),
    }


def run_speech_self_test(transcribe=None) -> dict:
    """Same path as live speech: 1.5 s PCM WAV, then the array, never a raw path.

    Empty text is success. A raised transcription fails. A missing wheel or a
    missing weight file is a visible skip. Nothing here leaves the machine.
    """
    import time

    folder = tempfile.mkdtemp(prefix="friday-stt-")
    wav = write_probe_wav(str(Path(folder) / "probe.wav"))
    started = time.perf_counter()
    try:
        samples = read_pcm16_wav(wav)
    except Exception as exc:  # noqa: BLE001
        fault = classify_stt_exception(exc)
        return {
            "ok": False,
            "skipped": False,
            "local": True,
            "sttClass": fault.kind,
            "error": str(fault),
            "fix": fault.fix,
            "engine": "faster-whisper",
            "model": DEFAULT_MODEL,
            "loadMs": 0,
            "transcribeMs": 0,
        }
    if samples is None:
        return {
            "ok": False,
            "skipped": False,
            "local": True,
            "sttClass": "audio-invalid",
            "error": "audio-invalid: the probe clip was not 16 kHz mono PCM",
            "fix": "",
            "engine": "faster-whisper",
            "model": DEFAULT_MODEL,
            "loadMs": 0,
            "transcribeMs": 0,
        }
    audio_ms = int((time.perf_counter() - started) * 1000)
    guard = av_guard()
    if transcribe is not None:
        t0 = time.perf_counter()
        try:
            text = transcribe(samples)
        except Exception as exc:  # noqa: BLE001
            fault = classify_stt_exception(exc)
            return {
                "ok": False,
                "skipped": False,
                "local": True,
                "sttClass": fault.kind,
                "error": str(fault),
                "fix": fault.fix,
                "engine": "faster-whisper",
                "model": DEFAULT_MODEL,
                "loadMs": audio_ms,
                "transcribeMs": int((time.perf_counter() - t0) * 1000),
                "av": guard,
            }
        return {
            "ok": True,
            "skipped": False,
            "local": True,
            "text": str(text or ""),
            "engine": "faster-whisper",
            "model": DEFAULT_MODEL,
            "loadMs": audio_ms,
            "transcribeMs": int((time.perf_counter() - t0) * 1000),
            "av": guard,
        }
    whisper = _import_whisper()
    if whisper is None:
        return {
            "ok": True,
            "skipped": True,
            "local": True,
            "reason": _whisper_error or "faster-whisper is not installed",
            "engine": "none",
            "model": DEFAULT_MODEL,
            "loadMs": 0,
            "transcribeMs": 0,
            "audioVerified": True,
            "av": guard,
        }
    load_started = time.perf_counter()
    try:
        get_model(DEFAULT_MODEL)
    except Exception as exc:  # noqa: BLE001
        fault = classify_stt_exception(exc)
        if fault.kind != "model-missing":
            return {
                "ok": False,
                "skipped": False,
                "local": True,
                "sttClass": fault.kind,
                "error": str(fault),
                "fix": fault.fix,
                "engine": "faster-whisper",
                "model": DEFAULT_MODEL,
                "loadMs": int((time.perf_counter() - load_started) * 1000),
                "transcribeMs": 0,
                "av": guard,
            }
        return {
            "ok": True,
            "skipped": True,
            "local": True,
            "reason": str(fault),
            "sttClass": fault.kind,
            "engine": "faster-whisper",
            "model": DEFAULT_MODEL,
            "loadMs": int((time.perf_counter() - load_started) * 1000),
            "transcribeMs": 0,
            "audioVerified": True,
            "av": guard,
        }
    load_ms = int((time.perf_counter() - load_started) * 1000)
    t0 = time.perf_counter()
    try:
        result = _transcribe_prepared(wav, samples, DEFAULT_MODEL, "", "", None, "", "", "")
    except Exception as exc:  # noqa: BLE001
        fault = classify_stt_exception(exc)
        return {
            "ok": False,
            "skipped": False,
            "local": True,
            "sttClass": fault.kind,
            "error": str(fault),
            "fix": fault.fix,
            "engine": "faster-whisper",
            "model": _model_name or DEFAULT_MODEL,
            "loadMs": load_ms,
            "transcribeMs": int((time.perf_counter() - t0) * 1000),
            "av": guard,
        }
    return {
        "ok": True,
        "skipped": False,
        "local": True,
        "text": result.get("text") or "",
        "engine": result.get("engine") or "faster-whisper",
        "model": result.get("model") or (_model_name or DEFAULT_MODEL),
        "loadMs": load_ms,
        "transcribeMs": int((time.perf_counter() - t0) * 1000),
        "audioVerified": True,
        "av": guard,
    }


HEARING_PHRASE = "Friday, what time is it"
HEARING_WORDS = ("friday", "what", "time")
HEARING_LEVELS = (0.5, 0.05, 0.008)


def synth_speech_clip(phrase: str = HEARING_PHRASE):
    """Float32 16 kHz speech from the first TTS that exists, else (None, reason).

    Order: espeak-ng, espeak, Windows SAPI, edge-tts. Nothing is downloaded here.
    """
    import shutil
    import subprocess

    folder = tempfile.mkdtemp(prefix="friday-hear-")
    raw = str(Path(folder) / "synth.wav")
    for exe in ("espeak-ng", "espeak"):
        found = shutil.which(exe)
        if not found:
            continue
        try:
            subprocess.run([found, "-w", raw, "-s", "150", phrase], check=True, capture_output=True, timeout=60)
            clip = decode_foreign(raw)
            if clip is not None and len(clip):
                return clip, exe
        except Exception:  # noqa: BLE001, S112 — try the next engine
            continue
    if os.name == "nt":
        script = (
            "Add-Type -AssemblyName System.Speech; "
            "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
            f"$s.SetOutputToWaveFile('{raw}'); $s.Speak('{phrase}'); $s.Dispose()"
        )
        try:
            subprocess.run(
                ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                check=True,
                capture_output=True,
                timeout=60,
                cwd=tempfile.gettempdir(),
            )
            clip = decode_foreign(raw)
            if clip is not None and len(clip):
                return clip, "windows-sapi"
        except Exception:  # noqa: BLE001, S110 — fall through to edge-tts
            pass
    try:
        import asyncio

        import edge_tts  # type: ignore

        mp3 = str(Path(folder) / "synth.mp3")
        asyncio.run(edge_tts.Communicate(phrase, "en-IN-NeerjaNeural").save(mp3))
        clip = decode_foreign(mp3)
        if clip is not None and len(clip):
            return clip, "edge-tts"
    except Exception:  # noqa: BLE001, S110 — no engine left
        pass
    return None, "no speech synthesiser (espeak-ng, Windows SAPI, edge-tts) is available here"


def words_heard(text: str, expected=HEARING_WORDS) -> list[str]:
    heard = {word.strip(".,!?;:'\"").lower() for word in (text or "").split()}
    return [word for word in expected if word in heard]


def run_hearing_self_test(levels=HEARING_LEVELS, synth=None, transcribe=None) -> dict:
    """Spoken clip -> WAV -> prepare_audio (denoise) -> Whisper, at three input levels.

    A level passes when the transcript holds at least two of the three expected
    words. No synthesiser or no speech model is a visible skip, never a pass.
    ``synth`` returns (float samples, engine) and ``transcribe`` takes a WAV
    path and returns the transcribe_file dict. Both exist so a test can stand
    in for the parts that are not on every machine.
    """
    import time

    import numpy as np  # type: ignore

    make = synth or synth_speech_clip
    clip, engine = make()
    if clip is None:
        return {"ok": True, "skipped": True, "reason": engine, "levels": [], "phrase": HEARING_PHRASE}
    clip = np.asarray(clip, dtype=np.float32).reshape(-1)
    top = float(np.max(np.abs(clip))) or 1.0
    run = transcribe or (lambda path: transcribe_file(path, DEFAULT_MODEL, "en", ""))
    rows = []
    folder = tempfile.mkdtemp(prefix="friday-hear-")
    for level in levels:
        scaled = np.clip(clip / top * float(level), -1.0, 1.0)
        wav = str(Path(folder) / f"level-{level}.wav")
        pcm = np.clip(np.round(scaled * 32767.0), -32768, 32767).astype("<i2")
        with wave.open(wav, "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(PROBE_RATE)
            handle.writeframes(pcm.tobytes())
        started = time.perf_counter()
        row: dict = {"level": level, "ms": 0}
        try:
            result = run(wav)
        except Exception as exc:  # noqa: BLE001
            fault = classify_stt_exception(exc)
            if fault.kind == "model-missing":
                return {
                    "ok": True,
                    "skipped": True,
                    "reason": str(fault),
                    "engine": engine,
                    "levels": rows,
                    "phrase": HEARING_PHRASE,
                }
            row.update({"ok": False, "text": "", "error": str(fault)[:200], "sttClass": fault.kind})
            rows.append(row)
            continue
        text = str(result.get("text") or "")
        hit = words_heard(text)
        audio = result.get("audio") or {}
        ok = len(hit) >= 2
        # Words came back but not the phrase: that is a mishearing, not silence.
        code = result.get("dropCode") or ("misheard" if text.strip() and not ok else "")
        row.update(
            {
                "ok": ok,
                "text": text,
                "wordsHeard": hit,
                "recogniser": result.get("engine") or "",
                "model": result.get("model") or "",
                "dropCode": code,
                "denoiseNote": audio.get("denoiseNote") or "",
                "ms": int((time.perf_counter() - started) * 1000),
            }
        )
        rows.append(row)
    return {
        "ok": all(row["ok"] for row in rows) and bool(rows),
        "skipped": False,
        "engine": engine,
        "phrase": HEARING_PHRASE,
        "levels": rows,
    }


def provisional_reply(result: dict, req: dict) -> dict:
    """A provisional answer says it is not final, how much audio it heard, and which utterance it belongs to."""
    if not result.get("ok"):
        return result
    audio = result.get("audio")
    facts: dict = audio if isinstance(audio, dict) else {}
    millis = result.get("durationMs") or facts.get("durationMs") or 0
    reply = {**result, "final": False, "audioMs": int(millis) if isinstance(millis, (int, float)) else 0}
    reply["engine"] = str(result.get("engine") or "faster-whisper")
    uid = req.get("utteranceId")
    if isinstance(uid, str) and uid.strip():
        reply["utteranceId"] = uid.strip()[:64]
    return reply


# ---- FRIDAY Ears: the re-decoding ears behind the stream ops (LocalAgreement-2 partials) -------------------------

STREAM_HINDI = "stream-ear-hindi"
STREAM_WHISPER = "stream-ear-whisper"


def _hindi_stream_reader(_folder: Path, _turn: TurnLanguage, hotwords: list[str]):
    """The Hindi ear over the window (always Hindi, Devanagari), with the owner's words snapped in."""

    def read(window, _prompt: str) -> list[Word]:
        heard = hindi_ear.transcribe_words(window)
        if not heard or not hindi_ear.confident("hi", heard.get("confidence")):
            return []
        touch()
        words = [Word(str(w["text"]), float(w["start"]), float(w["end"])) for w in heard["words"]]
        return snap_hotwords(words, hotwords)

    # With the owner's words in play, the ear's own CTC head is biased toward them while decoding; with none, or when
    # the head is not exposed, today's reader answers unchanged (``with_ctc_bias`` falls back by itself).
    return with_ctc_bias(read, hotwords) if hotwords else read


class WhisperStreamReader:
    """The resident faster-whisper model over the window: the turn's one language (never detected again mid-turn),
    the owner's words as ``hotwords``, the text that left the window as the prompt, word times on."""

    def __init__(self, turn: TurnLanguage, hotwords: list[str], model_ref=lambda: _model) -> None:
        self.turn, self.hotwords, self._model_ref = turn, hotwords, model_ref

    def _kwargs(self, language: str | None, words: bool) -> dict:
        extras = {"hotwords": self.hotwords, "word_timestamps": words}
        return {
            "language": language,
            "vad_filter": False,
            "beam_size": 1,
            "condition_on_previous_text": False,
            "temperature": 0.0,
            **decode_options(extras, language is not None),
        }

    def __call__(self, window, prompt: str) -> list[Word]:
        model = self._model_ref()
        if model is None:
            return []
        language = self.turn.decode_language()
        kwargs = self._kwargs(language, True)
        hint = prompt or (DEFAULT_HINT if language is None else "")
        if hint:
            kwargs["initial_prompt"] = hint[:800]
        segments, info = model.transcribe(window, **kwargs)
        words: list[Word] = []
        for seg in segments:
            text = (getattr(seg, "text", "") or "").strip()
            if not text or live_segment_is_noise(
                text, getattr(seg, "no_speech_prob", None), getattr(seg, "avg_logprob", None)
            ):
                continue
            if hint and prompt_echo(text, hint):
                continue
            for w in getattr(seg, "words", None) or []:
                said = str(getattr(w, "word", "") or "").strip()
                if said:
                    words.append(Word(said, float(w.start), float(w.end)))
        if language is None:
            self.turn.observe(getattr(info, "language", "") or "")
        return words

    def rescore(self, audio, words: list[Word], turn: TurnLanguage) -> tuple[str, int]:
        """The finished turn, one forced-language look per segment whose language differs from the turn's."""
        model = self._model_ref()
        rows = segments_from_words(words, turn.mode)
        plans = plan_rescore(rows, turn.decode_language(), turn.mode)
        if model is None or not plans:
            return "", 0

        def one(plan) -> dict:
            clip = audio[int(plan.start * RATE) : int(plan.end * RATE)]
            segments, _info = model.transcribe(clip, **self._kwargs(plan.language, False))
            return {"text": " ".join((getattr(seg, "text", "") or "").strip() for seg in segments).strip()}

        rows, changed = apply_rescore(rows, plans, one)
        return (" ".join(r["text"] for r in rows), changed) if changed else ("", 0)


def _whisper_stream_dir() -> Path | None:
    """The resident model, when there is one fast enough for live words (the same rule as ``transcribe_live``)."""
    if _model is None or (is_heavy_model(_model_name) and _device_name == "cpu"):
        return None
    return Path(cache_dir()) / (_model_name or "whisper")


def stream_hardware_tier() -> str | None:
    """small-cpu, mid or gpu for the stream speed gate; None (no gate) when the memory cannot be read."""
    memory = read_memory_mb()
    if memory is None:
        return None
    return stream_ear.hardware_tier(memory[1] / 1024, os.cpu_count() or 1, _device_name == "cuda")


stream_ear.register_engine(
    stream_ear.EngineSpec(
        name=STREAM_HINDI,
        folder=hindi_ear.MODEL_DIR,
        files={},
        factory=lambda: stream_ear.La2Engine(STREAM_HINDI, _hindi_stream_reader),
        aliases=("hindi-ear",),
        modules=("numpy", "onnx_asr"),
        languages=lambda _folder: {"hi"},
        priority=20,
        locate=hindi_ear.model_dir,
    )
)
stream_ear.register_engine(
    stream_ear.EngineSpec(
        name=STREAM_WHISPER,
        folder="whisper",
        files={},
        factory=lambda: stream_ear.La2Engine(
            STREAM_WHISPER, lambda _folder, turn, hotwords: WhisperStreamReader(turn, hotwords)
        ),
        aliases=("whisper",),
        modules=("numpy", "faster_whisper"),
        languages=lambda _folder: {"auto", "en", "hi", "hi-en", "en-hi", "hinglish", "mixed"},
        priority=30,
        locate=_whisper_stream_dir,
    )
)
stream_ear.HOST.hardware = stream_hardware_tier


def handle_request(req: dict) -> dict:
    """One request. A use of the models (load, transcribe) restarts the idle clock; a status question does not."""
    configure_idle(req)
    op = str(req.get("op") or "")
    if op in USE_OPS:
        unload_idle()
    result = _handle_op(req)
    if op in USE_OPS and loaded_names():
        touch()
    return result


def _handle_op(req: dict) -> dict:
    op = str(req.get("op") or "")
    if op in {"status", "probe"}:
        return status_payload()
    if op == "self-test":
        return run_speech_self_test()
    if op == "hearing-self-test":
        return run_hearing_self_test()
    if op == "load":
        import time

        started = time.time()
        try:
            before = _load_count
            model = get_model(
                str(req.get("model") or DEFAULT_MODEL),
                str(req.get("model_path") or "") or None,
                **auto_flag(str(req.get("sttSize") or req.get("stt_size") or "")),
            )
            loaded_ms = int((time.time() - started) * 1000)
            # Only a model this call opened is warmed; a request for the one already open costs nothing.
            warm_ms = warm_model(model) if _load_count != before else 0
            return {
                "ok": True,
                "model": _model_name,
                "cache": cache_dir(),
                "elapsedMs": loaded_ms,
                "loadMs": _load_ms.get(_model_name or ""),
                "warmMs": warm_ms,
                "loadCount": _load_count,
                "inference": "verified",
            }
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "reason": "model-load-failed", "error": str(exc)[-600:], "loadCount": _load_count}
    if op == "cancel":
        return request_cancel(str(req.get("utteranceId") or ""))
    if op == "score-turn":
        return voice_runtime.score_turn_payload(req)
    if op == "partial-plan":
        try:
            duration = float(req.get("duration") or 0)
        except (TypeError, ValueError):
            duration = 0.0
        return {"ok": True, "windows": plan_partials(duration), "engine": "faster-whisper"}
    if op in {"transcribe", "flush"}:
        # "flush" is a provisional pass by name; "transcribe" with provisional:true is the same thing.
        provisional = op == "flush" or req.get("provisional") is True
        audio = str(req.get("audio") or "")
        if not audio or not os.path.exists(audio):
            return {"ok": False, "reason": "no-audio", "error": "No audio file was supplied."}
        rid = req.get("id")

        def on_partial(text: str) -> None:
            if rid is None or not text:
                return
            emit({"id": rid, "stream": True, "text": text, "engine": "faster-whisper"})

        uid = req.get("utteranceId")
        # Only a provisional pass carries these (an older caller or test double never sees them).
        pass_kwargs: dict[str, Any] = {}
        if provisional:
            pass_kwargs["provisional"] = True
            pass_kwargs["utterance_id"] = uid if isinstance(uid, str) else ""
            if req.get("live") is True:
                pass_kwargs["live"] = True
        try:
            result = transcribe_file(
                audio,
                str(req.get("model") or DEFAULT_MODEL),
                str(req.get("language") or ""),
                str(req.get("initial_prompt") or req.get("initialPrompt") or ""),
                on_partial if rid is not None else None,
                str(req.get("speech_pref") or req.get("speechPref") or ""),
                str(req.get("sttSize") or req.get("stt_size") or ""),
                str(req.get("model_path") or ""),
                bool(req.get("keep_wav") or req.get("keepWav")),
                {
                    "hotwords": req.get("hotwords"),
                    "multilingual": req.get("multilingual") is True,
                    "word_timestamps": (req.get("word_timestamps") or req.get("wordTimestamps")) is True,
                },
                **pass_kwargs,
            )
            return provisional_reply(result, req) if provisional else result
        except DecodeCancelled:
            return cancelled_reply(req)
        except Exception as exc:  # noqa: BLE001
            fault = classify_stt_exception(exc)
            if _whisper_cls is None and fault.kind != "dependency-incompatible":
                fault = SttFault("model-missing", str(fault), fault.fix)
            note_outcome("stt-fault")
            return {
                "ok": False,
                "dropCode": "stt-fault",
                "reason": fault.kind,
                "sttClass": fault.kind,
                "error": str(fault)[-600:],
                "fix": fault.fix,
                "loadCount": _load_count,
            }
    if op in stream_ear.STREAM_OPS:
        # The own streaming ear: off unless voice.streamEngine asks for it AND its pinned weights are on disk.
        return stream_ear.HOST.handle(req)
    if op == "shutdown":
        return {"ok": True, "op": "shutdown", "loadCount": _load_count}
    return {"ok": False, "reason": "unknown-op", "error": f"unknown op {op!r}"}


def serve() -> int:
    """Persistent worker: one process, one WhisperModel, many utterances."""
    try:
        sys.stdin.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
        sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001,S110 — a console that cannot be reconfigured still reads lines
        pass
    start_idle_watch()
    # Input is read on its own thread, so a cancel is answered while a decode holds this one. Every other request
    # waits in order; only "cancel" jumps the line, and it only sets a flag.
    inbox: queue.Queue = queue.Queue()
    threading.Thread(target=_read_requests, args=(inbox,), name="stt-reader", daemon=True).start()
    while True:
        req = inbox.get()
        if req is None:
            return 0
        rid = req.get("id")
        try:
            with _cache_lock:
                result = handle_request(req)
        except Exception as exc:  # noqa: BLE001 — one bad request never stops the worker
            result = {"ok": False, "reason": "worker-error", "error": f"{type(exc).__name__}: {exc}"[-300:]}
        if rid is not None:
            result = {"id": rid, **result}
        emit(result)
        if str(req.get("op") or "") == "shutdown":
            return 0


def _read_requests(inbox: queue.Queue) -> None:
    try:
        for raw in sys.stdin:
            line = raw.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except Exception as exc:  # noqa: BLE001
                emit({"ok": False, "reason": "bad-request", "error": str(exc)[-200:]})
                continue
            if not isinstance(req, dict):
                emit({"ok": False, "reason": "bad-request", "error": "request must be an object"})
                continue
            if str(req.get("op") or "") == "cancel":
                answer = request_cancel(str(req.get("utteranceId") or ""))
                emit({"id": req["id"], **answer} if req.get("id") is not None else answer)
                continue
            inbox.put(req)
    finally:
        inbox.put(None)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio")
    ap.add_argument("--language", default="")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--initial-prompt", default="", dest="initial_prompt")
    ap.add_argument("--probe", action="store_true")
    ap.add_argument("--load-probe", dest="load_probe", action="store_true")
    ap.add_argument("--serve", action="store_true")
    ap.add_argument("--self-test", dest="self_test", action="store_true")
    ap.add_argument("--hearing-self-test", dest="hearing_self_test", action="store_true")
    args = ap.parse_args()

    if args.serve:
        code = serve()
        # The reader thread may still be blocked on stdin. Leaving through interpreter shutdown with it there can end
        # in "could not acquire lock for <stdin> at interpreter shutdown", so the worker leaves at once, flushed.
        try:
            sys.stdout.flush()
        finally:
            os._exit(code)

    if args.hearing_self_test:
        payload = run_hearing_self_test()
        emit(payload)
        return 0 if payload.get("ok") else 1

    if args.self_test:
        payload = run_speech_self_test()
        emit(payload)
        return 0 if payload.get("ok") else 1

    if args.probe:
        emit(status_payload())
        return 0

    if _import_whisper() is None:
        emit({"ok": False, "reason": "missing-dependency", "error": _whisper_error})
        return 0

    if args.load_probe:
        import time

        started = time.time()
        try:
            get_model(args.model)
            emit(
                {
                    "ok": True,
                    "model": args.model,
                    "cache": cache_dir(),
                    "elapsedMs": int((time.time() - started) * 1000),
                    "loadCount": _load_count,
                }
            )
        except Exception as exc:  # noqa: BLE001
            emit({"ok": False, "reason": "model-load-failed", "error": str(exc)[-600:]})
        return 0

    if not args.audio or not os.path.exists(args.audio):
        emit({"ok": False, "reason": "no-audio", "error": "No audio file was supplied."})
        return 0

    try:
        emit(transcribe_file(args.audio, args.model, args.language, args.initial_prompt))
    except Exception as exc:  # noqa: BLE001
        fault = classify_stt_exception(exc)
        emit(
            {
                "ok": False,
                "reason": fault.kind,
                "sttClass": fault.kind,
                "error": str(fault)[-600:],
                "fix": fault.fix,
            }
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
