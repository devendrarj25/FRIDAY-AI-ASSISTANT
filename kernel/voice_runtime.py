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

Speaking: Supertonic 3 (code MIT, weights OpenRAIL-M), voice F2, when
``models/supertonic-3`` is on disk. No automatic download on a speak call.
System voices remain the offline speaker until then. Cloud speech is decided
by the desktop, not here.

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
from collections import OrderedDict
from pathlib import Path

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


def tts_status() -> dict:
    ready = supertonic_dir() is not None
    return {
        "ready": ready,
        "engine": "supertonic-3" if ready else "none",
        "voice": SUPERTONIC_VOICE,
        "reason": "" if ready else LOCAL_TTS_REASON,
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
        import numpy as np  # type: ignore
        import onnxruntime as ort  # type: ignore

        session = ort.InferenceSession(str(path), providers=session_providers(False))
        state = np.zeros((2, 1, 128), dtype=np.float32)
        audio = np.asarray(window, dtype=np.float32).reshape(1, 512)
        sr = np.array(16000, dtype=np.int64)
        outputs = session.run(None, {"input": audio, "state": state, "sr": sr})
        first = outputs[0] if isinstance(outputs, (list, tuple)) else outputs
        if not isinstance(first, np.ndarray):
            raise TypeError("silero output was not an array")
        probability = float(first.reshape(-1)[0])
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


def status() -> dict:
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
        "tts": tts_status(),
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


def _speak_array(text: str, speed: float = 1.0, lang: str = "", style: str = "", stop=None):
    """The one synthesis path. (float32 mono array, sample rate), or None when the model or package is absent.

    ``stop`` is an optional callable checked before every span and once more before the pieces are joined; when it
    answers true the call raises ``SpeechCancelled`` (the only exception that leaves this function).

    Text in one script is one call. Mixed Hindi and English is cut into a few
    phrase-sized spans (never one call per word); each is read in its own
    language with the same voice and the pieces join in written order.
    """
    spoken = (text or "").strip()
    if not spoken:
        return None
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


def speak_pcm16(text: str, speed: float = 1.0, lang: str = "", style: str = "", stop=None) -> tuple[bytes, int] | None:
    """The same samples as ``speak_wav_bytes`` as raw little-endian int16 mono, plus the sample rate.

    Nothing is written to disk. The float to int16 step matches what libsndfile
    writes for a PCM_16 WAV (scale by 32768, floor, clip), so the samples agree
    with the WAV path to within one sample on any libsndfile. ``stop`` is the cooperative cancel check of
    ``_speak_array``.
    """
    made = _speak_array(text, speed, lang, style) if stop is None else _speak_array(text, speed, lang, style, stop)
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
    from faster_whisper.feature_extractor import FeatureExtractor  # type: ignore

    session = ort.InferenceSession(key, providers=session_providers(False))
    extractor = FeatureExtractor(feature_size=80, chunk_length=8)
    _turn_model.clear()
    _turn_model[key] = (session, extractor)
    return session, extractor


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
        if audio.size < extractor.n_samples:
            real = (audio - audio.mean()) / np.sqrt(float(audio.var()) + 1e-7)
            audio = np.pad(real, (extractor.n_samples - real.size, 0))
        else:
            audio = audio[-extractor.n_samples :]
            audio = (audio - audio.mean()) / np.sqrt(float(audio.var()) + 1e-7)
        feat = extractor(audio, padding=0)
        if feat.shape[1] > 800:
            feat = feat[:, :800]
        elif feat.shape[1] < 800:
            feat = np.pad(feat, ((0, 0), (0, 800 - feat.shape[1])), constant_values=-1.5)
        out = session.run(None, {"input_features": feat[None].astype(np.float32)})[0]
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
    if importlib.util.find_spec("onnx_asr") is None:
        return "FAIL hindi-ear the weights are on disk but the onnx-asr package is not installed"
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


def speak_pcm_payload(req: dict) -> dict:
    """Reply body of the ``speak-pcm`` worker op: base64 int16 PCM, nothing on disk, no cache.

    ``engine`` is optional. Without it, or with ``supertonic``, the reply is exactly what it always was.
    ``hindi-light`` asks for the light Hindi voice; it speaks only when installed, for Devanagari-only Hindi, and
    otherwise (or when it fails) Supertonic speaks the same text and the reply says which engine did and why.
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
            # A request with no utterance id is made exactly as it always was (no check to pass).
            made = speak_pcm16(text, speed, lang, style, stop=stop) if utt else speak_pcm16(text, speed, lang, style)
        if stop():
            return {"ok": False, "reason": "cancelled", **tag}
    except SpeechCancelled:
        return {"ok": False, "reason": "cancelled", **tag}
    if made is None:
        return {"ok": False, "reason": LOCAL_TTS_REASON}
    data, rate = made
    return {
        "ok": True,
        "sampleRate": rate,
        "pcm16": base64.b64encode(data).decode("ascii"),
        "ms": round((time.perf_counter() - started) * 1000),
        **extra,
        **tag,
    }


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
        return status(), False
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
    if op == "echo-shadow":
        return echo_shadow_payload(req), False
    return {"ok": False, "reason": "unknown-op"}, False


def serve() -> int:
    """Keep Supertonic loaded across speak calls. One JSON object per line.

    A reader thread takes the lines. ``cancel`` is answered there at once (it must not wait behind the clause the
    worker is making); every other line goes in order to this thread, so replies keep the order of the requests.
    """
    import sys

    try:
        sys.stdin.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
        sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)  # type: ignore[attr-defined]
    except Exception:  # noqa: S110 — a console that cannot be reconfigured still reads lines
        pass
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
        payload, stop = _handle(req)
        if rid is not None:
            payload = {"id": rid, **payload}
        emit(payload)
        if stop:
            return 0


def main() -> int:
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
