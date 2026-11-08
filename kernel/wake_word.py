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
    except Exception:  # noqa: BLE001,S110 — read-only disk is reported by the caller
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


def decode_pcm16(path: str) -> list[int] | None:
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
        logit = sum(float(w) * float(x) for w, x in zip(weights, feats, strict=False)) + float(bias or 0)
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


LEGACY_LINEAR_MAX_BYTES = 16 * 1024  # the bundled linear scorer is a few hundred bytes; a real model is far larger


def read_manifest(path: Path) -> dict | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None
    return payload if isinstance(payload, dict) else None


def engine_for_path(model_path: str | None) -> str | None:
    """Which scorer a model file belongs to, from what the model says it is, never from its name.

    1. A `<stem>.wake.json` sidecar naming `"engine"` ("openwakeword" or "friday-linear") decides.
    2. The bundled linear scorer: `friday-wake.json` of kind `friday-linear-v1` beside the file, and either the
       manifest's `modelSha256` equals the file's hash, or (an older manifest with no hash) the file is tiny.
    3. Anything else is an openWakeWord model, so a real model that happens to be called friday.onnx is scored as one.
    """
    if not model_path:
        return None
    path = Path(model_path)
    sidecar = read_manifest(path.with_name(f"{path.stem}.wake.json"))
    if sidecar and sidecar.get("engine") in {"openwakeword", "friday-linear"}:
        return str(sidecar["engine"])
    if path.suffix.lower() == ".json":
        manifest = read_manifest(path)
        return "friday-linear" if manifest and manifest.get("kind") == "friday-linear-v1" else None
    manifest = read_manifest(path.with_name("friday-wake.json"))
    if manifest and manifest.get("kind") == "friday-linear-v1" and path.is_file():
        recorded = manifest.get("modelSha256")
        if recorded:
            import hashlib

            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            return "friday-linear" if digest == recorded else "openwakeword"
        return "friday-linear" if path.stat().st_size <= LEGACY_LINEAR_MAX_BYTES else "openwakeword"
    return "openwakeword"


FRAME_SAMPLES = 1280  # 80 ms at 16 kHz, the frame openWakeWord scores
FRAME_MS = 80


class WakeFrameScorer:
    """Continuous wake scoring over a stream of 16 kHz mono PCM16, fed in any chunk size.

    The microphone is not opened here: the caller feeds frames from the one shared capture. Samples are cut into
    80 ms frames and each is scored by `predict` (the model's own streaming state lives in the predictor).
    A trigger needs `min_frames` consecutive frames at or above the threshold. After a trigger the scorer is
    latched until the score falls below `release_ratio * threshold` for `release_frames` frames AND `cooldown_ms`
    has passed, so one spoken phrase fires once.
    """

    def __init__(
        self,
        predict,
        threshold: float = 0.5,
        min_frames: int = 2,
        release_ratio: float = 0.6,
        release_frames: int = 2,
        cooldown_ms: int = 1500,
    ) -> None:
        self.predict = predict
        self.threshold = threshold
        self.min_frames = max(1, min_frames)
        self.release_level = threshold * release_ratio
        self.release_frames = max(1, release_frames)
        self.cooldown_frames = max(0, int(cooldown_ms / FRAME_MS))
        self.pending: list[int] = []
        self.hot = 0
        self.cool = 0
        self.latched = False
        self.frames = 0
        self.best = 0.0

    def reset(self) -> None:
        self.pending = []
        self.hot = 0
        self.cool = 0
        self.latched = False
        self.best = 0.0

    def feed(self, samples) -> dict:
        """Add samples; returns {detected, score, frames} for what was scored in this call."""
        self.pending.extend(int(v) for v in samples)
        detected = False
        scored = 0
        top = 0.0
        while len(self.pending) >= FRAME_SAMPLES:
            frame = self.pending[:FRAME_SAMPLES]
            del self.pending[:FRAME_SAMPLES]
            score = float(self.predict(frame))
            scored += 1
            self.frames += 1
            top = max(top, score)
            if self.latched:
                self.cool = max(0, self.cool - 1)
                self.hot = self.hot + 1 if score < self.release_level else 0
                if self.hot >= self.release_frames and self.cool == 0:
                    self.latched = False
                    self.hot = 0
                continue
            self.hot = self.hot + 1 if score >= self.threshold else 0
            if self.hot >= self.min_frames:
                detected = True
                self.latched = True
                self.cool = self.cooldown_frames
                self.hot = 0
        self.best = max(self.best, top) if scored else self.best
        return {"detected": detected, "score": round(top, 4), "frames": scored}


_frame_scorers: dict[str, WakeFrameScorer] = {}
MAX_FRAME_SESSIONS = 2


def _oww_predictor(model_path: str):
    from openwakeword.model import Model  # type: ignore

    model = Model(wakeword_models=[model_path])
    import numpy as np  # type: ignore

    def predict(frame: list[int]) -> float:
        scores = model.predict(np.asarray(frame, dtype=np.int16))
        return max((float(v) for v in scores.values()), default=0.0)

    return predict


def frame_op(req: dict, wake_word: str, explicit: str | None, threshold: float, make_predictor=None) -> dict:
    """Score a chunk of live PCM16 (little endian, base64) for the session `session`. Resets with `reset: true`."""
    import array
    import base64

    session = str(req.get("session") or "default")[:64]
    if req.get("reset") is True:
        _frame_scorers.pop(session, None)
        if not req.get("pcm"):
            return {"ok": True, "detected": False, "score": 0.0, "frames": 0}
    scorer = _frame_scorers.get(session)
    if scorer is None:
        model_path = pick_model(wake_word, explicit)
        if not model_path:
            return {"ok": False, "reason": "no-model", "error": missing_model_error(wake_word)}
        if engine_for_path(model_path) != "openwakeword":
            return {
                "ok": False,
                "reason": "frame-unsupported",
                "error": "the bundled linear scorer scores whole clips; live frames need an openWakeWord model",
            }
        if len(_frame_scorers) >= MAX_FRAME_SESSIONS:
            return {"ok": False, "reason": "too-many-sessions", "error": "too many live wake sessions"}
        try:
            predict = (make_predictor or _oww_predictor)(model_path)
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "reason": "missing-dependency", "error": str(exc)[-300:]}
        scorer = _frame_scorers[session] = WakeFrameScorer(
            predict,
            threshold=threshold,
            min_frames=int(req.get("minFrames") or 2),
            cooldown_ms=int(req.get("cooldownMs") or 1500),
        )
    try:
        raw = base64.b64decode(str(req.get("pcm") or ""), validate=True)
    except Exception:  # noqa: BLE001
        return {"ok": False, "reason": "bad-request", "error": "the audio was not valid base64"}
    if len(raw) > 64_000 or len(raw) % 2:
        return {"ok": False, "reason": "bad-request", "error": "send whole 16-bit samples, at most 2 seconds"}
    samples = array.array("h")
    samples.frombytes(raw)
    if sys.byteorder == "big":
        samples.byteswap()
    out = scorer.feed(samples)
    return {"ok": True, **out, "threshold": scorer.threshold, "engine": "openwakeword"}


def missing_model_error(wake_word: str) -> str:
    wanted = normalise(wake_word or "friday")
    extra = " or let FRIDAY copy the bundled friday.onnx there" if wanted == "friday" else ""
    return f"No wake model for “{wake_word}”. Drop a trained {wanted}.onnx into {wake_model_dir()}{extra}."


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
    if engine_for_path(model_path) == "friday-linear":
        linear = score_linear(pcm, model_path, threshold)
        if linear is not None:
            linear["loadCount"] = _load_count
            return linear
        return {"ok": False, "reason": "detect-failed", "error": "the linear wake model could not be read"}
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
    if op == "frame":
        return frame_op(req, wake_word, explicit, threshold)
    if op == "shutdown":
        return {"ok": True, "op": "shutdown", "loadCount": _load_count}
    return {"ok": False, "reason": "unknown-op", "error": f"unknown op {op!r}"}


def serve() -> int:
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
