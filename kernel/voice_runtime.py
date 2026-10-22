"""FRIDAY local voice runtime.

The FastAPI process does not import this module at startup. Missing files
and missing packages are a not-ready status, never a crash. ``status`` and
``--check`` never download.

Listening: when ``silero_vad.onnx`` is on disk, it is scored with the
onnxruntime FRIDAY already installs. Otherwise the desktop energy VAD
remains the listener. The Silero pip package is not used; it requires torch.
Smart Turn, when its ONNX file is present, can only lengthen a pause. Noise
suppression is pyrnnoise on PCM when that wheel imports.

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
import re
import shutil
from pathlib import Path

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
SPEAKER_LICENSE = "CC-BY-4.0"
SPEAKER_ATTRIBUTION = "WeSpeaker ECAPA. CC-BY-4.0. Not bundled. Not downloaded here."


def speaker_status() -> dict:
    present = find_named(SPEAKER_FILE) is not None
    return {
        "ready": present,
        "engine": "wespeaker-ecapa" if present else "none",
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
        "speaker": speaker_status(),
        "providers": execution_providers(),
    }


def speech_lang(text: str, requested: str = "") -> str:
    """Supertonic language. Mixed Hindi and English uses the na fallback."""
    raw = (requested or "").strip().lower().replace("_", "-")
    devanagari = any("\u0900" <= ch <= "\u097f" for ch in text)
    latin = any("a" <= ch.lower() <= "z" for ch in text)
    if devanagari and latin:
        return "na"
    if devanagari or raw.startswith("hi"):
        return "hi"
    if raw.startswith("en"):
        return "en"
    return "en" if latin else "na"


def speak_wav_bytes(text: str, speed: float = 1.0, lang: str = "") -> bytes | None:
    """Local Supertonic speech. None when the model or package is absent."""
    spoken = (text or "").strip()
    if not spoken:
        return None
    directory = supertonic_dir()
    if directory is None:
        return None
    try:
        import io

        import numpy as np  # type: ignore
        import soundfile as sf  # type: ignore
        from supertonic import TTS  # type: ignore
    except Exception:
        return None
    global _tts, _tts_dir
    try:
        if _tts is None or _tts_dir != str(directory):
            _tts = TTS(model="supertonic-3", model_dir=str(directory), auto_download=False)
            _tts_dir = str(directory)
        rate = min(2.0, max(0.7, float(speed or 1.0)))
        wav, _duration = _tts.synthesize(
            spoken[:500],
            voice_style=_tts.get_voice_style(SUPERTONIC_VOICE),
            total_steps=5,
            speed=rate,
            lang=speech_lang(spoken, lang),
            silence_duration=0.12,
        )
        audio = np.asarray(wav, dtype=np.float32).reshape(-1)
        buf = io.BytesIO()
        sf.write(buf, audio, int(_tts.sample_rate), format="WAV")
        data = buf.getvalue()
    except Exception:
        return None
    return data or None


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


def score_turn(samples, sample_rate: int = 16000) -> dict:
    """Semantic end-of-turn. Missing file or a bad feature is not a cut-off."""
    path = smart_turn_path()
    if path is None:
        return {"ok": True, "ready": False, "probability": None, "reason": "smart-turn file absent"}
    if sample_rate != 16000:
        return {"ok": True, "ready": False, "probability": None, "reason": "smart-turn expects 16000 Hz"}
    try:
        import numpy as np  # type: ignore
        import onnxruntime as ort  # type: ignore
        from faster_whisper.feature_extractor import FeatureExtractor  # type: ignore

        audio = np.asarray(samples, dtype=np.float32).reshape(-1)
        if audio.size < 1600:
            return {"ok": True, "ready": False, "probability": None, "reason": "audio too short"}
        extractor = FeatureExtractor(feature_size=80, chunk_length=8)
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
        session = ort.InferenceSession(str(path), providers=session_providers(False))
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
    speaker = speaker_status()
    if speaker["ready"]:
        lines.append("PASS speaker wespeaker-ecapa")
    else:
        lines.append(f"OPTIONAL speaker {speaker['reason']}")
    providers = execution_providers()
    lines.append(f"PASS cpu-fallback selected={providers['selected']} gpu={providers['gpuDetected']}")
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


def serve() -> int:
    """Keep Supertonic loaded across speak calls. One JSON object per line."""
    import sys

    try:
        sys.stdin.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
        sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)  # type: ignore[attr-defined]
    except Exception:  # noqa: S110 — a console that cannot be reconfigured still reads lines
        pass
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as exc:  # noqa: BLE001
            print(json.dumps({"ok": False, "reason": "bad-request", "error": str(exc)[:200]}), flush=True)
            continue
        if not isinstance(req, dict):
            print(json.dumps({"ok": False, "reason": "bad-request"}), flush=True)
            continue
        rid = req.get("id")
        op = str(req.get("op") or "")
        payload: dict
        if op == "shutdown":
            payload = {"ok": True}
        elif op == "status":
            payload = status()
        elif op == "speak":
            out = str(req.get("out") or "")
            try:
                speed = float(req.get("speed") or 1)
            except (TypeError, ValueError):
                speed = 1.0
            audio = speak_wav_bytes(str(req.get("text") or ""), speed, str(req.get("lang") or ""))
            if audio and out:
                dest = Path(out)
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(audio)
                payload = {"ok": True, "path": str(dest), "mime": "audio/wav", "bytes": len(audio)}
            else:
                payload = {"ok": False, "reason": LOCAL_TTS_REASON if not audio else "no output path"}
        else:
            payload = {"ok": False, "reason": "unknown-op"}
        if rid is not None:
            payload = {"id": rid, **payload}
        print(json.dumps(payload), flush=True)
        if op == "shutdown":
            return 0
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
