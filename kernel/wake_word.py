"""FRIDAY · wake-word detection.

Two real engines share this script:

  1. Bundled FRIDAY linear scorer (`friday.onnx` / `friday-wake.json`) trained
     by scripts/train-friday-wake.py on synthesised "FRIDAY" vs noise. Copied
     into <FRIDAY_ROOT>/models/wake by electron/wake-engine.cjs.
  2. openWakeWord, when the owner drops a compatible custom model.

electron/wake-engine.cjs prefers a persistent worker:

    python kernel/wake_word.py --serve

JSON lines on stdin. The detector/model is loaded once and reused. `--probe`
and `--audio` one-shot mode remain for tests.

This is NOT a live microphone tap. The renderer still captures utterances
through the shared VoiceGate and sends clips (or 80 ms PCM frames inside a
clip). The worker scores those without reconstructing the model each time.

It never fakes an answer: a missing model for the configured wake word is
reported as not-ready. friday.onnx is used only when the configured word is
"friday" — never as a silent fallback for "jarvis" or any other name.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from pathlib import Path


N_BANDS = 32
FEATURE_DIM = N_BANDS
MIN_NORM = 1e-4

_linear_session = None
_linear_path: str | None = None
_oww_model = None
_oww_path: str | None = None
_load_count = 0


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def wake_model_dir() -> Path:
    root = os.environ.get("FRIDAY_ROOT")
    base = Path(root) / "models" / "wake" if root else Path.home() / ".friday" / "models" / "wake"
    try:
        base.mkdir(parents=True, exist_ok=True)
    except Exception:  # noqa: BLE001 — read-only disk is reported by the caller
        pass
    return base


def custom_models() -> list[str]:
    found: list[str] = []
    directory = wake_model_dir()
    if directory.is_dir():
        for entry in sorted(directory.iterdir()):
            if entry.suffix.lower() in {".onnx", ".tflite", ".json"} and entry.name.startswith("friday"):
                found.append(str(entry))
            elif entry.suffix.lower() in {".onnx", ".tflite"}:
                found.append(str(entry))
    return found


def normalise(word: str) -> str:
    return "".join(ch for ch in word.lower() if ch.isalnum())


def pick_model(wake_word: str, explicit: str | None) -> str | None:
    """The model that really corresponds to the configured wake word.

    Never silently substitute friday.onnx (or friday-wake.json) when the
    configured word is something else. Missing jarvis.onnx → None.
    """
    if explicit:
        return explicit
    wanted = normalise(wake_word or "friday")
    if not wanted:
        wanted = "friday"
    directory = wake_model_dir()
    for name in (f"{wanted}.onnx", f"{wanted}-wake.json"):
        candidate = directory / name
        if candidate.is_file():
            return str(candidate)
    for path in custom_models():
        stem = normalise(Path(path).stem)
        if stem == wanted or stem == f"{wanted}wake":
            return path
    return None


def decode_pcm16(path: str) -> "list[int] | None":
    """Decode any container the recorder produced to 16 kHz mono int16."""
    try:
        import av  # type: ignore
        import numpy as np  # type: ignore
    except Exception:  # noqa: BLE001
        pcm = _decode_wav(path)
        return pcm
    try:
        import numpy as np  # type: ignore

        container = av.open(path)
        resampler = av.audio.resampler.AudioResampler(format="s16", layout="mono", rate=16000)
        samples: list = []
        for frame in container.decode(audio=0):
            for out in resampler.resample(frame) or []:
                samples.append(out.to_ndarray().reshape(-1))
        container.close()
        if not samples:
            return _decode_wav(path)
        return np.concatenate(samples).astype("int16")
    except Exception:  # noqa: BLE001
        return _decode_wav(path)


def _decode_wav(path: str):
    import array
    import wave

    try:
        with wave.open(path, "rb") as wav:
            frames = wav.readframes(wav.getnframes())
            width = wav.getsampwidth()
            if width != 2:
                return None
            pcm = array.array("h")
            pcm.frombytes(frames)
            channels = wav.getnchannels()
            if channels > 1:
                mono = []
                for i in range(0, len(pcm), channels):
                    mono.append(int(sum(pcm[i : i + channels]) / channels))
                return mono
            return list(pcm)
    except Exception:  # noqa: BLE001
        return None


def band_features(pcm) -> list[float]:
    samples = [abs(float(x) / 32768.0) for x in pcm]
    if len(samples) < N_BANDS:
        samples.extend([0.0] * (N_BANDS - len(samples)))
    chunk = max(1, len(samples) // N_BANDS)
    means: list[float] = []
    for i in range(N_BANDS):
        part = samples[i * chunk : (i + 1) * chunk] or [0.0]
        means.append(sum(part) / len(part))
    return means


def l2_normalize(feat: list[float]) -> list[float]:
    norm = math.sqrt(sum(v * v for v in feat))
    if norm < MIN_NORM:
        return [0.0] * len(feat)
    return [v / norm for v in feat]


def score_linear(pcm, model_path: str, threshold: float) -> dict | None:
    path = Path(model_path)
    json_path = path if path.suffix.lower() == ".json" else path.with_name("friday-wake.json")
    if path.suffix.lower() == ".onnx":
        sidecar = path.parent / "friday-wake.json"
        json_path = sidecar if sidecar.is_file() else json_path
    weights = None
    bias = None
    if json_path.is_file():
        try:
            payload = json.loads(json_path.read_text(encoding="utf-8"))
            if payload.get("kind") == "friday-linear-v1":
                weights = payload.get("weights")
                bias = payload.get("bias")
        except Exception:  # noqa: BLE001
            weights = None
    feats = l2_normalize(band_features(pcm))
    if all(v == 0.0 for v in feats):
        return {
            "ok": True,
            "detected": False,
            "score": 0.0,
            "threshold": threshold,
            "model": path.stem,
            "engine": "friday-linear",
        }
    if weights is None and path.suffix.lower() == ".onnx":
        try:
            import onnxruntime as ort  # type: ignore

            global _linear_session, _linear_path, _load_count
            if _linear_session is None or _linear_path != str(path):
                _linear_session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
                _linear_path = str(path)
                _load_count += 1
            name = _linear_session.get_inputs()[0].name
            score = float(_linear_session.run(None, {name: [feats]})[0][0][0])
            return {
                "ok": True,
                "detected": score >= threshold,
                "score": round(score, 4),
                "threshold": threshold,
                "model": path.stem,
                "engine": "friday-linear",
            }
        except Exception:  # noqa: BLE001
            return None
    if weights is None:
        return None
    try:
        logit = sum(float(w) * float(x) for w, x in zip(weights, feats)) + float(bias or 0)
        score = 1.0 / (1.0 + math.exp(-max(-60.0, min(60.0, logit))))
        return {
            "ok": True,
            "detected": score >= threshold,
            "score": round(score, 4),
            "threshold": threshold,
            "model": path.stem,
            "engine": "friday-linear",
        }
    except Exception:  # noqa: BLE001
        return None


def score_openwakeword(pcm, model_path: str, threshold: float) -> dict:
    from openwakeword.model import Model  # type: ignore

    global _oww_model, _oww_path, _load_count
    if _oww_model is None or _oww_path != model_path:
        _oww_model = Model(wakeword_models=[model_path])
        _oww_path = model_path
        _load_count += 1
    model = _oww_model
    best = 0.0
    label = Path(model_path).stem
    step = 1280  # 80 ms at 16 kHz — openWakeWord's native frame size
    for start in range(0, len(pcm) - step + 1, step):
        scores = model.predict(pcm[start : start + step])
        for name, score in scores.items():
            if float(score) > best:
                best = float(score)
                label = name
    return {
        "ok": True,
        "detected": best >= threshold,
        "score": round(best, 4),
        "threshold": threshold,
        "model": label,
        "engine": "openwakeword",
        "loadCount": _load_count,
    }


def engine_for_path(model_path: str | None) -> str | None:
    if not model_path:
        return None
    stem = Path(model_path).stem.lower()
    if "friday" in stem:
        return "friday-linear"
    return "openwakeword"


def missing_model_error(wake_word: str) -> str:
    wanted = normalise(wake_word or "friday")
    extra = " or let FRIDAY copy the bundled friday.onnx there" if wanted == "friday" else ""
    return (
        f"No wake model for “{wake_word}”. "
        f"Drop a trained {wanted}.onnx into {wake_model_dir()}{extra}."
    )


def probe_payload(wake_word: str, explicit: str | None = None) -> dict:
    model_path = pick_model(wake_word, explicit)
    oww_installed = False
    try:
        import openwakeword  # noqa: F401  # type: ignore

        oww_installed = True
    except Exception:  # noqa: BLE001
        oww_installed = False
    return {
        "ok": True,
        "installed": bool(model_path) or oww_installed,
        "modelDir": str(wake_model_dir()),
        "models": custom_models(),
        "model": model_path,
        "ready": bool(model_path),
        "engine": engine_for_path(model_path),
        "wakeWord": normalise(wake_word or "friday"),
        "loadCount": _load_count,
        "error": None if model_path else missing_model_error(wake_word),
    }


def detect_audio(audio: str, wake_word: str, explicit: str | None, threshold: float) -> dict:
    model_path = pick_model(wake_word, explicit)
    if not model_path:
        return {
            "ok": False,
            "reason": "no-model",
            "error": f"no wake model for “{wake_word}” in {wake_model_dir()}",
            "ready": False,
            "engine": "transcript",
        }
    if not audio or not os.path.exists(audio):
        return {"ok": False, "reason": "no-audio", "error": "No audio file was supplied."}
    pcm = decode_pcm16(audio)
    if pcm is None or len(pcm) == 0:
        return {"ok": False, "reason": "decode-failed", "error": "the clip could not be decoded"}
    linear = score_linear(pcm, model_path, threshold)
    if linear is not None:
        linear["loadCount"] = _load_count
        return linear
    try:
        result = score_openwakeword(pcm, model_path, threshold)
        result["loadCount"] = _load_count
        return result
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "reason": "detect-failed", "error": str(exc)[-600:]}


def handle_request(req: dict) -> dict:
    op = str(req.get("op") or "")
    wake_word = str(req.get("wakeWord") or req.get("wake_word") or "friday")
    explicit = str(req.get("model") or "") or None
    threshold = float(req.get("threshold") or 0.5)
    if op in {"status", "probe"}:
        return probe_payload(wake_word, explicit)
    if op == "detect":
        return detect_audio(str(req.get("audio") or ""), wake_word, explicit, threshold)
    if op == "shutdown":
        return {"ok": True, "op": "shutdown", "loadCount": _load_count}
    return {"ok": False, "reason": "unknown-op", "error": f"unknown op {op!r}"}


def serve() -> int:
    try:
        sys.stdin.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
        sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
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
    ap.add_argument("--probe", action="store_true")
    ap.add_argument("--serve", action="store_true")
    ap.add_argument("--wake-word", default="friday")
    ap.add_argument("--model", default="")
    ap.add_argument("--threshold", type=float, default=0.5)
    args = ap.parse_args()

    if args.serve:
        return serve()

    if args.probe:
        emit(probe_payload(args.wake_word, args.model or None))
        return 0

    emit(detect_audio(args.audio or "", args.wake_word, args.model or None, args.threshold))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
