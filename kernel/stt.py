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
import json
import math
import os
import struct
import sys
import tempfile
import wave
from pathlib import Path

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
_whisper_error: str | None = None


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


def owner_model(size: str, requested: str) -> str:
    """An owner-chosen size wins. Auto tiering stays for the auto setting."""
    locked = (size or "").strip().lower()
    known = {"tiny", "base", "small", "medium", "large-v3"}
    if locked in known:
        return select_model(0.0, False, False, False, locked)
    return resolve_model_name(requested)


def cuda_runtime_ready() -> bool:
    """CUDA only when the owner GPU flag is set and both CUDA 12 libraries are visible.

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
    found: set[str] = set()
    for root in roots:
        for name in names:
            try:
                if (root / name).is_file():
                    found.add(name)
            except OSError:
                continue
    return len(found) == len(names)


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


def plan_partials(duration_s: float, window_s: float = 2.0, hop_s: float = 1.0) -> list[dict]:
    """Chunk plan for this same worker. Not a second speech engine."""
    if duration_s <= 0 or window_s <= 0 or hop_s <= 0:
        return []
    if duration_s <= window_s:
        return [{"start": 0.0, "end": round(float(duration_s), 3), "final": True}]
    out: list[dict] = []
    start = 0.0
    while start < duration_s - 1e-6:
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


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
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


def get_model(name: str, model_path: str | None = None):
    """Load WhisperModel once per worker. `local_files_only` blocks a silent download."""
    global _model, _model_name, _load_count
    cls = _import_whisper()
    if cls is None:
        raise RuntimeError(_whisper_error or "faster-whisper is not installed.")
    spec = model_load_kwargs(name, model_path or os.environ.get("FRIDAY_STT_MODEL_PATH"))
    wanted = spec["target"]
    if _model is not None and _model_name == wanted:
        return _model
    _model, _used = open_whisper(cls, wanted, spec)
    if _used != spec["device"]:
        spec["reason"] = "CPU int8 — CUDA load failed"
    _model_name = wanted
    _load_count += 1
    return _model


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
    return str(max(parents, key=parents.get))


AV_REQUIREMENT = "av>=17.0.0,<19"
AV_FIX = 'python -m pip install "av>=17.0.0,<19"'
STT_CLASSES = (
    "dependency-incompatible",
    "model-missing",
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


def prepare_audio(audio_path: str) -> tuple[str, object | None, str | None]:
    """Denoise the array. The whisper call receives the array, not a PyAV path."""
    samples = load_audio_array(audio_path)
    try:
        import numpy as np  # type: ignore
        import voice_runtime

        original = np.asarray(samples, dtype=np.float32).reshape(-1)
        cleaned = np.asarray(voice_runtime.denoise_pcm(original, PROBE_RATE), dtype=np.float32).reshape(-1)
    except Exception:
        return audio_path, samples, None
    if cleaned.size == 0:
        return audio_path, original, None
    return audio_path, cleaned, None


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


def transcribe_file(
    audio: str,
    model_name: str,
    language: str,
    initial_prompt: str,
    on_partial=None,
    speech_pref: str = "",
    owner_size: str = "",
    model_path: str = "",
) -> dict:
    prepared, samples, cleanup = prepare_audio(audio)
    try:
        return _transcribe_prepared(
            prepared,
            samples,
            model_name,
            language,
            initial_prompt,
            on_partial,
            speech_pref,
            owner_size,
            model_path,
        )
    finally:
        if cleanup and os.path.exists(cleanup):
            try:
                os.remove(cleanup)
            except OSError:
                pass


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
) -> dict:
    engine = "faster-whisper"
    moon_text = None
    if wants_english_stream(language, speech_pref) and samples is not None:
        moon_dir = moonshine_model_dir()
        if moon_dir:
            moon_text = transcribe_moonshine(samples, moon_dir, on_partial)
            if moon_text:
                engine = "moonshine-en"
    turn_probability = None
    if samples is not None:
        try:
            import voice_runtime

            scored = voice_runtime.score_turn(samples, 16000)
            if isinstance(scored.get("probability"), (int, float)):
                turn_probability = float(scored["probability"])
        except Exception:
            turn_probability = None
    if moon_text:
        return {
            "ok": True,
            "text": moon_text,
            "language": "en",
            "durationMs": 0,
            "model": "moonshine-tiny-streaming",
            "noSpeechProb": 0.0,
            "loadCount": _load_count,
            "engine": engine,
            "turnProbability": turn_probability,
        }
    try:
        model = get_model(owner_model(owner_size, model_name), model_path or None)
    except Exception:
        windows_text = transcribe_windows(audio)
        if not windows_text:
            raise
        return {
            "ok": True,
            "text": windows_text,
            "language": "",
            "durationMs": 0,
            "model": "windows-speech",
            "noSpeechProb": 0.0,
            "loadCount": _load_count,
            "engine": "windows-speech",
            "turnProbability": turn_probability,
        }
    lang = resolve_language(language)
    hint = (initial_prompt or "").strip()
    if lang is None and not hint:
        hint = DEFAULT_HINT
    kwargs: dict = {
        "language": lang,
        "vad_filter": True,
        "beam_size": 1,
        "condition_on_previous_text": False,
    }
    if hint:
        kwargs["initial_prompt"] = hint[:800]
    payload = samples if samples is not None else audio
    try:
        segments, info = model.transcribe(payload, **kwargs)
    except Exception as exc:  # noqa: BLE001 — classified, then the ladder may speak
        fault = classify_stt_exception(exc)
        windows_text = None
        if fault.kind in {"oom", "timeout", "dependency-incompatible"} and isinstance(audio, str):
            windows_text = transcribe_windows(audio)
        if not windows_text:
            raise fault from exc
        return {
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
        }
    parts: list[str] = []
    no_speech: list[float] = []
    partials = 0
    for seg in segments:
        text = (getattr(seg, "text", "") or "").strip()
        if text:
            parts.append(text)
            partials += 1
            if on_partial and partials <= 12:
                on_partial(" ".join(parts))
        prob = getattr(seg, "no_speech_prob", None)
        if isinstance(prob, (int, float)):
            no_speech.append(float(prob))
    text = " ".join(parts).strip()
    avg_ns = sum(no_speech) / len(no_speech) if no_speech else 0.0
    if avg_ns >= 0.7:
        text = ""
    return {
        "ok": True,
        "text": text,
        "language": getattr(info, "language", lang or ""),
        "durationMs": int(float(getattr(info, "duration", 0.0)) * 1000),
        "model": _model_name or model_name,
        "noSpeechProb": round(avg_ns, 4),
        "loadCount": _load_count,
        "engine": engine,
        "turnProbability": turn_probability,
    }


WINDOWS_SPEECH_PROBE = (
    "Add-Type -AssemblyName System.Speech; "
    "$r = New-Object System.Speech.Recognition.SpeechRecognizer; "
    "if ($r) { 'installed' } else { 'missing' }"
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
    device = choose_stt_device(cuda_runtime_ready())
    return {
        "ok": True,
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
        "windowsSpeech": windows_speech_ready(),
        "av": av_guard(),
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


def handle_request(req: dict) -> dict:
    op = str(req.get("op") or "")
    if op in {"status", "probe"}:
        return status_payload()
    if op == "self-test":
        return run_speech_self_test()
    if op == "load":
        import time

        started = time.time()
        try:
            get_model(str(req.get("model") or DEFAULT_MODEL), str(req.get("model_path") or "") or None)
            return {
                "ok": True,
                "model": _model_name,
                "cache": cache_dir(),
                "elapsedMs": int((time.time() - started) * 1000),
                "loadCount": _load_count,
                "inference": "verified",
            }
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "reason": "model-load-failed", "error": str(exc)[-600:], "loadCount": _load_count}
    if op == "partial-plan":
        try:
            duration = float(req.get("duration") or 0)
        except (TypeError, ValueError):
            duration = 0.0
        return {"ok": True, "windows": plan_partials(duration), "engine": "faster-whisper"}
    if op == "transcribe":
        audio = str(req.get("audio") or "")
        if not audio or not os.path.exists(audio):
            return {"ok": False, "reason": "no-audio", "error": "No audio file was supplied."}
        rid = req.get("id")

        def on_partial(text: str) -> None:
            if rid is None or not text:
                return
            emit({"id": rid, "stream": True, "text": text, "engine": "faster-whisper"})

        try:
            return transcribe_file(
                audio,
                str(req.get("model") or DEFAULT_MODEL),
                str(req.get("language") or ""),
                str(req.get("initial_prompt") or req.get("initialPrompt") or ""),
                on_partial if rid is not None else None,
                str(req.get("speech_pref") or req.get("speechPref") or ""),
                str(req.get("sttSize") or req.get("stt_size") or ""),
                str(req.get("model_path") or ""),
            )
        except Exception as exc:  # noqa: BLE001
            fault = classify_stt_exception(exc)
            if _whisper_cls is None and fault.kind != "dependency-incompatible":
                fault = SttFault("model-missing", str(fault), fault.fix)
            return {
                "ok": False,
                "reason": fault.kind,
                "sttClass": fault.kind,
                "error": str(fault)[-600:],
                "fix": fault.fix,
                "loadCount": _load_count,
            }
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
        rid = req.get("id")
        result = handle_request(req)
        if rid is not None:
            result = {"id": rid, **result}
        emit(result)
        if str(req.get("op") or "") == "shutdown":
            return 0
    return 0


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
    args = ap.parse_args()

    if args.serve:
        return serve()

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
