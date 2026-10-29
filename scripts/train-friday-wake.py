"""Train a tiny FRIDAY keyword scorer and write resources/wake/friday.onnx.

The openWakeWord package has no pretrained "friday" model. This script
synthesises short 16 kHz clips (a pulsed "FRIDAY" envelope vs noise / other
tones / silence), fits a cosine-similarity template on L2-normalised chunk
energy, and exports ONNX plus a JSON sidecar so kernel/wake_word.py can score
without inventing a hit. This is not a crowdsourced speech corpus — transcript
matching stays the fallback when the bundled files are not copied into
<FRIDAY_ROOT>/models/wake.
"""

from __future__ import annotations

import json
import math
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "resources" / "wake"
RATE = 16000
N_BANDS = 32
FEATURE_DIM = N_BANDS
MIN_NORM = 1e-4


def band_features(pcm: np.ndarray) -> np.ndarray:
    x = np.abs(np.asarray(pcm, dtype=np.float32).reshape(-1))
    if x.size < N_BANDS:
        x = np.pad(x, (0, N_BANDS - int(x.size)))
    chunk = max(1, int(x.size) // N_BANDS)
    means = np.empty(N_BANDS, dtype=np.float32)
    for i in range(N_BANDS):
        part = x[i * chunk : (i + 1) * chunk]
        means[i] = float(part.mean()) if part.size else 0.0
    return means


def l2_normalize(feat: np.ndarray) -> np.ndarray:
    feat = np.asarray(feat, dtype=np.float32)
    norm = float(np.linalg.norm(feat))
    if norm < MIN_NORM:
        return np.zeros(FEATURE_DIM, dtype=np.float32)
    return feat / norm


def synth_word(seed: int, kind: str) -> np.ndarray:
    rng = np.random.default_rng(seed)
    t = np.arange(RATE, dtype=np.float32) / RATE
    if kind == "friday":
        env = np.zeros(RATE, dtype=np.float32)
        pulses = [(0.05, 0.12), (0.22, 0.10), (0.38, 0.14), (0.58, 0.10), (0.74, 0.16)]
        freqs = [780, 1250, 680, 430, 280]
        tone = np.zeros(RATE, dtype=np.float32)
        for (start, dur), freq in zip(pulses, freqs):
            a = int(start * RATE)
            b = min(RATE, a + int(dur * RATE))
            n = b - a
            window = np.hanning(n)
            env[a:b] = np.maximum(env[a:b], window)
            tone[a:b] += window * np.sin(2 * np.pi * freq * t[a:b])
        noise = 0.015 * rng.normal(size=RATE)
        gain = float(rng.uniform(0.7, 1.3))
        return np.clip((0.35 * tone + noise) * gain, -1, 1).astype(np.float32)
    if kind == "other":
        f0 = rng.uniform(180, 1400)
        tone = 0.22 * np.sin(2 * np.pi * f0 * t + rng.uniform(0, 3))
        return (tone + 0.04 * rng.normal(size=RATE)).astype(np.float32)
    if kind == "silence":
        return (0.0004 * rng.normal(size=RATE)).astype(np.float32)
    return (rng.uniform(0.04, 0.22) * rng.normal(size=RATE)).astype(np.float32)


def write_onnx(path: Path, weights: np.ndarray, intercept: float) -> None:
    try:
        from onnx import TensorProto, helper, numpy_helper, save
    except ImportError as exc:  # pragma: no cover — generated at landing time
        raise SystemExit(f"pip install onnx to export friday.onnx ({exc})") from exc

    w = weights.reshape(FEATURE_DIM, 1)
    b = np.asarray([intercept], dtype=np.float32)
    gemm = helper.make_node("Gemm", ["features", "W", "B"], ["logits"], alpha=1.0, beta=1.0, transB=0)
    sig = helper.make_node("Sigmoid", ["logits"], ["score"])
    graph = helper.make_graph(
        [gemm, sig],
        "friday_wake",
        [
            helper.make_tensor_value_info("features", TensorProto.FLOAT, [1, FEATURE_DIM]),
        ],
        [helper.make_tensor_value_info("score", TensorProto.FLOAT, [1, 1])],
        [numpy_helper.from_array(w, "W"), numpy_helper.from_array(b, "B")],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)], ir_version=8)
    model.graph.doc_string = "FRIDAY keyword cosine template; features are L2 chunk energy"
    save(model, str(path))


def write_wav(path: Path, pcm: np.ndarray) -> None:
    samples = (np.clip(pcm, -1, 1) * 32767).astype(np.int16)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(RATE)
        wav.writeframes(samples.tobytes())


def main() -> int:
    positives = [l2_normalize(band_features(synth_word(i, "friday"))) for i in range(200)]
    negatives = []
    for i in range(240):
        kind = "noise" if i % 3 == 0 else "other" if i % 3 == 1 else "silence"
        negatives.append(l2_normalize(band_features(synth_word(2000 + i, kind))))
    xs = np.stack(positives + negatives)
    ys = np.concatenate([np.ones(len(positives)), np.zeros(len(negatives))]).astype(np.float32)

    template = positives[0].copy()
    for row in positives[1:]:
        template += row
    template /= float(len(positives))
    tnorm = float(np.linalg.norm(template))
    if tnorm < MIN_NORM:
        raise SystemExit("wake trainer template collapsed")
    template = template / tnorm

    pos_dot = xs[: len(positives)] @ template
    neg_dot = xs[len(positives) :] @ template
    best_acc = -1.0
    best_thresh = 0.7
    for thresh in np.linspace(0.55, 0.95, 81):
        acc = float((((pos_dot >= thresh).mean() + (neg_dot < thresh).mean()) / 2))
        if acc > best_acc:
            best_acc = acc
            best_thresh = float(thresh)

    scale = 12.0
    weights = (scale * template).astype(np.float32)
    intercept = float(-scale * best_thresh)

    def score_one(feat: np.ndarray) -> float:
        if float(np.linalg.norm(feat)) < MIN_NORM:
            return 0.0
        logit = float(feat @ weights + intercept)
        return 1.0 / (1.0 + math.exp(-logit))

    scores = np.array([score_one(row) for row in xs], dtype=np.float32)
    pred = (scores >= 0.5).astype(np.float32)
    acc = float((pred == ys).mean())
    if acc < 0.90:
        raise SystemExit(f"wake trainer accuracy {acc:.3f} is too low to ship")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    sidecar = {
        "kind": "friday-linear-v1",
        "rate": RATE,
        "bands": N_BANDS,
        "dim": FEATURE_DIM,
        "normalize": "l2",
        "minNorm": MIN_NORM,
        "threshold": 0.5,
        "weights": weights.tolist(),
        "bias": intercept,
        "accuracy": acc,
        "dotThreshold": best_thresh,
    }
    (OUT_DIR / "friday-wake.json").write_text(json.dumps(sidecar), encoding="utf-8")
    write_onnx(OUT_DIR / "friday.onnx", weights, intercept)
    write_wav(OUT_DIR / "friday-demo.wav", synth_word(0, "friday"))
    write_wav(OUT_DIR / "noise-demo.wav", synth_word(99, "noise"))
    print(f"wrote {OUT_DIR / 'friday.onnx'} acc={acc:.3f} thresh={best_thresh:.3f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
