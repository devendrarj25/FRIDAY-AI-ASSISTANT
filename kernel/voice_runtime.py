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
import os
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


def speaker_status() -> dict:
    return {
        "ready": False,
        "engine": "none",
        "reason": "not-ready",
        "gate": False,
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

        session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
        state = np.zeros((2, 1, 128), dtype=np.float32)
        audio = np.asarray(window, dtype=np.float32).reshape(1, 512)
        sr = np.array(16000, dtype=np.int64)
        out, _state = session.run(None, {"input": audio, "state": state, "sr": sr})
        probability = float(out[0][0])
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


def denoise_pcm(samples, sample_rate: int = 16000):
    """RNNoise when the wheel is installed. The same samples come back otherwise."""
    try:
        import numpy as np  # type: ignore
        from pyrnnoise import RNNoise  # type: ignore
    except Exception:
        return samples
    audio = np.asarray(samples, dtype=np.float32)
    if audio.size == 0:
        return audio
    mono = audio.reshape(-1)
    try:
        denoiser = RNNoise(sample_rate)
        pieces = []
        for _prob, frame in denoiser.denoise_chunk(mono[None, :], partial=True):
            pieces.append(np.asarray(frame, dtype=np.float32).reshape(-1))
        if not pieces:
            return mono
        return np.concatenate(pieces)
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
        session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
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


def _download_checked(url: str, dest: Path, sha256: str, need_bytes: int) -> None:
    """Save one file only when the hash matches. A network failure stays offline."""
    import hashlib
    import urllib.request

    dest.parent.mkdir(parents=True, exist_ok=True)
    room = disk_room(dest.parent, need_bytes)
    if not room["ok"]:
        raise RuntimeError(room["reason"] or "disk full")
    tmp = dest.with_suffix(dest.suffix + ".part")
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "FRIDAY"})
        with urllib.request.urlopen(request, timeout=120) as response, tmp.open("wb") as handle:
            while True:
                chunk = response.read(1024 * 256)
                if not chunk:
                    break
                handle.write(chunk)
        digest = hashlib.sha256(tmp.read_bytes()).hexdigest()
        if digest != sha256:
            raise RuntimeError("checksum mismatch")
        tmp.replace(dest)
    except Exception as exc:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        text = str(exc)
        if "checksum" in text or "disk" in text:
            raise
        raise RuntimeError(f"offline: {text[:200]}") from exc


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

    dest = root / SUPERTONIC_DIR
    try:
        if supertonic_dir() is None:
            from supertonic.loader import download_model  # type: ignore

            download_model(dest, "supertonic-3")
        results.append({"id": "supertonic-3", "ok": supertonic_dir() is not None})
    except Exception as exc:  # noqa: BLE001
        results.append({"id": "supertonic-3", "ok": False, "reason": str(exc)[:300]})

    try:
        if smart_turn_path() is None:
            _download_checked(
                "https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.2-cpu.onnx",
                root / "smart-turn" / SMART_TURN_NAME,
                SMART_TURN_SHA256,
                SMART_TURN_BYTES,
            )
        results.append({"id": "smart-turn", "ok": smart_turn_path() is not None})
    except Exception as exc:  # noqa: BLE001
        results.append({"id": "smart-turn", "ok": False, "reason": str(exc)[:300]})

    moon = root / "moonshine-en"
    try:
        from moonshine_voice import ModelArch, get_model_for_language  # type: ignore

        path, _arch = get_model_for_language(
            "en",
            ModelArch.TINY_STREAMING,
            cache_root=moon,
        )
        results.append({"id": "moonshine-en", "ok": bool(path)})
    except Exception as exc:  # noqa: BLE001
        results.append({"id": "moonshine-en", "ok": False, "reason": str(exc)[:300]})

    return {"ok": any(item.get("ok") for item in results), "results": results}


def check_lines() -> list[str]:
    lines = ["PASS boot"]
    tts = tts_status()
    if tts["ready"]:
        lines.append(f"PASS local-tts engine={tts['engine']} voice={tts['voice']}")
    else:
        lines.append(f"FAIL local-tts {tts['reason']}")
    silero = score_vad([0.0] * 512)
    if silero.get("engine") == "silero-onnx" and silero.get("ready"):
        lines.append(f"PASS vad-silero probability={silero.get('probability')}")
    else:
        lines.append(f"FAIL vad-silero {silero.get('reason') or 'energy fallback'}")
    lines.append("PASS vad-energy desktop energy VAD remains the fallback")
    if smart_turn_path() is None:
        lines.append("FAIL smart-turn file absent")
    else:
        lines.append("PASS smart-turn file present")
    noise = noise_status()
    if noise["ready"]:
        lines.append("PASS rnnoise")
    else:
        lines.append(f"FAIL rnnoise {noise['reason']}")
    lines.append("FAIL speaker not-ready")
    providers = execution_providers()
    lines.append(
        f"PASS cpu-fallback selected={providers['selected']} gpu={providers['gpuDetected']}"
    )
    room = disk_room(voice_root(), SILERO_BYTES)
    if room["measured"] and room["ok"]:
        lines.append(f"PASS disk free={room['free']}")
    elif room["measured"]:
        lines.append(f"FAIL disk {room['reason']} free={room['free']}")
    else:
        lines.append("FAIL disk unmeasured")
    return lines


def load_pcm(path: str):
    """16 kHz mono PCM, or None when the file cannot be decoded."""
    if not path or not os.path.exists(path):
        return None
    try:
        from faster_whisper.audio import decode_audio  # type: ignore

        return decode_audio(path, sampling_rate=16000)
    except Exception:
        return None


def serve() -> int:
    """Keep Supertonic loaded across speak calls. One JSON object per line."""
    import sys

    try:
        sys.stdin.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
        sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)  # type: ignore[attr-defined]
    except Exception:
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
