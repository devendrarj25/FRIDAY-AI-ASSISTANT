"""Train and evaluate the FRIDAY wake word on REAL speech.

    python scripts/train-friday-wake.py validate  --dataset DIR
    python scripts/train-friday-wake.py record    --dataset DIR --speaker NAME [--takes 30]
    python scripts/train-friday-wake.py train     --dataset DIR --out DIR
    python scripts/train-friday-wake.py evaluate  --dataset DIR --model DIR
    python scripts/train-friday-wake.py fixture   --out DIR          (plumbing tests only, never production)

Dataset layout (16 kHz mono WAV is best; other WAV rates are resampled):

    DIR/positives/<speaker>/<take>.wav        real recordings of someone saying "Friday", about 1-2 s each
    DIR/negatives/<source>/<clip>.wav         everything that is not the wake word: other speech, TV, music,
                                              room noise, a minute or more per clip is fine
    DIR/negatives/near-miss/<speaker>/*.wav   words that sound alike: "Fry-day", "Thursday", "Freddy", "Hey Siri"

The model is a small linear scorer over pooled log-mel features (kernel/wake_features.py, the same code the app
scores with). It is trained with the speakers and sources held apart in three groups: train, validation (the
threshold is chosen here) and test (the numbers that are reported). A model is marked `production` only when the
held-out numbers meet the targets on enough real audio from enough different speakers; otherwise it is written
as a candidate (`production: false`) and the app ignores it. Nothing here synthesises speech: a synthetic tone
detector is not a wake word, and `fixture` writes one only into a test folder, labelled as such.

Targets: false rejection <= 5 %, false accepts <= 0.5 per hour, measured on held-out real audio.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
import wave
from datetime import UTC, datetime
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "kernel"))

import wake_features as wf  # noqa: E402

PRODUCTION_DIR = ROOT / "resources" / "wake"
FIXTURE_DIR = ROOT / "testing" / "wake-fixture"
TARGET_FRR = 0.05
TARGET_FA_PER_HOUR = 0.5
MIN_POSITIVES = 60
MIN_SPEAKERS = 3
MIN_NEGATIVE_MINUTES = 20.0
MIN_NEAR_MISS = 10
MIN_HELD_OUT_NEGATIVE_HOURS = 0.1
ATTESTATION = "PROVENANCE.json"


# ---------------------------------------------------------------------------------------------- audio


def read_wav(path: Path) -> np.ndarray | None:
    """A WAV as int16 mono at 16 kHz, or None when it cannot be read."""
    try:
        with wave.open(str(path), "rb") as handle:
            width, channels, rate = handle.getsampwidth(), handle.getnchannels(), handle.getframerate()
            raw = handle.readframes(handle.getnframes())
    except (wave.Error, OSError, EOFError):
        return None
    if width != 2:
        return None
    pcm = np.frombuffer(raw, dtype="<i2").astype(np.float32)
    if channels > 1:
        pcm = pcm[: pcm.size // channels * channels].reshape(-1, channels).mean(axis=1)
    if rate != wf.RATE and pcm.size:
        target = int(round(pcm.size * wf.RATE / rate))
        pcm = np.interp(np.linspace(0, pcm.size - 1, target), np.arange(pcm.size), pcm)
    return np.clip(pcm, -32768, 32767).astype(np.int16)


def write_wav(path: Path, pcm: np.ndarray) -> None:
    samples = (np.clip(pcm, -1, 1) * 32767).astype(np.int16) if pcm.dtype.kind == "f" else pcm
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(wf.RATE)
        handle.writeframes(samples.astype("<i2").tobytes())


# ---------------------------------------------------------------------------------------------- dataset


def load_group(folder: Path, kind: str) -> dict[str, list[tuple[str, np.ndarray]]]:
    """{group: [(file, pcm)]}: the group is the speaker (positives) or the source (negatives)."""
    groups: dict[str, list[tuple[str, np.ndarray]]] = {}
    base = folder / kind
    if not base.is_dir():
        return groups
    for path in sorted(base.rglob("*.wav")):
        relative = path.relative_to(base)
        group = relative.parts[0] if len(relative.parts) > 1 else "_root"
        if kind == "negatives" and group == "near-miss":
            group = "near-miss/" + (relative.parts[1] if len(relative.parts) > 2 else "_root")
        pcm = read_wav(path)
        if pcm is None or pcm.size < wf.RATE // 4:
            continue
        groups.setdefault(group, []).append((relative.as_posix(), pcm))
    return groups


def attested_real_speech(dataset: Path) -> tuple[bool, str]:
    """The owner's written statement that the recordings are real people speaking (DIR/PROVENANCE.json).

    {"realSpeech": true, "recordedBy": "who", "notes": "how and where"}. A statement is not proof, so the trainer
    also refuses audio that is plainly tonal (see `tonal_fraction`); together they keep a synthetic set from
    being shipped as a real detector.
    """
    try:
        data = json.loads((dataset / ATTESTATION).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False, f"{ATTESTATION} is missing: state that the recordings are real speech (see --help)"
    if data.get("realSpeech") is not True or not str(data.get("recordedBy", "")).strip():
        return False, f'{ATTESTATION} must say "realSpeech": true and name who recorded it'
    return True, ""


def tonal_fraction(clips: list[np.ndarray]) -> float:
    """Share of clips whose energy sits in a few spectral lines, as a synthesised tone does and speech never does."""
    if not clips:
        return 0.0
    tonal = 0
    for pcm in clips:
        window = positive_window(pcm)
        power = np.abs(np.fft.rfft(window * np.hanning(window.size))) ** 2
        total = float(power.sum())
        if total > 0 and float(np.sort(power)[-6:].sum()) / total > 0.6:
            tonal += 1
    return tonal / len(clips)


def summary(dataset: Path) -> dict:
    positives = load_group(dataset, "positives")
    negatives = load_group(dataset, "negatives")
    near = {k: v for k, v in negatives.items() if k.startswith("near-miss/")}
    negative_seconds = sum(len(pcm) for clips in negatives.values() for _, pcm in clips) / wf.RATE
    return {
        "positives": sum(len(v) for v in positives.values()),
        "speakers": len(positives),
        "negativeClips": sum(len(v) for v in negatives.values()),
        "negativeSources": len(negatives),
        "negativeMinutes": round(negative_seconds / 60.0, 2),
        "nearMissClips": sum(len(v) for v in near.values()),
    }


def split_groups(names: list[str]) -> dict[str, str]:
    """Hold whole speakers/sources apart: every fourth is test, the one after it validation, the rest train."""
    ordered = sorted(names, key=lambda n: hashlib.sha256(n.encode()).hexdigest())
    plan: dict[str, str] = {}
    for index, name in enumerate(ordered):
        slot = index % 4
        plan[name] = "test" if slot == 0 else "validation" if slot == 1 and len(ordered) >= 3 else "train"
    return plan


def positive_window(pcm: np.ndarray) -> np.ndarray:
    """The loudest one-second window of a clip: where the word was said."""
    x = wf.to_float(pcm)
    if x.size <= wf.WINDOW:
        return np.pad(x, (0, wf.WINDOW - x.size))
    energy = np.convolve(x * x, np.ones(wf.RATE // 4), mode="valid")
    centre = int(np.argmax(energy)) + wf.RATE // 8
    start = int(np.clip(centre - wf.WINDOW // 2, 0, x.size - wf.WINDOW))
    return x[start : start + wf.WINDOW]


def augment(window: np.ndarray, rng: np.random.Generator) -> list[np.ndarray]:
    """The window itself, two shifts of +-80 ms and a gain change: the same word said a little differently."""
    out = [window]
    for shift in (-wf.RATE * 8 // 100, wf.RATE * 8 // 100):
        out.append(np.roll(window, shift))
    out.append(np.clip(window * float(rng.uniform(0.6, 1.4)), -1, 1))
    return out


def features_of(windows: list[np.ndarray]) -> np.ndarray:
    rows = [wf.window_features(w) for w in windows]
    return (
        np.stack([r for r in rows if r is not None])
        if any(r is not None for r in rows)
        else np.zeros((0, wf.FEATURE_DIM), np.float32)
    )


# ---------------------------------------------------------------------------------------------- training


def fit_logistic(
    x: np.ndarray, y: np.ndarray, steps: int = 800, lr: float = 0.05, l2: float = 1e-2
) -> tuple[np.ndarray, float]:
    """Class-balanced L2 logistic regression by Adam on the whole set (numpy only)."""
    n, d = x.shape
    w = np.zeros(d, dtype=np.float64)
    b = 0.0
    pos = max(1.0, float(y.sum()))
    neg = max(1.0, float(n - y.sum()))
    weight = np.where(y > 0.5, 0.5 * n / pos, 0.5 * n / neg)
    m_w, v_w, m_b, v_b = np.zeros(d), np.zeros(d), 0.0, 0.0
    for t in range(1, steps + 1):
        z = x @ w + b
        p = 1.0 / (1.0 + np.exp(-np.clip(z, -60, 60)))
        err = (p - y) * weight / n
        g_w = x.T @ err + l2 * w
        g_b = float(err.sum())
        m_w = 0.9 * m_w + 0.1 * g_w
        v_w = 0.999 * v_w + 0.001 * g_w * g_w
        m_b = 0.9 * m_b + 0.1 * g_b
        v_b = 0.999 * v_b + 0.001 * g_b * g_b
        w -= lr * (m_w / (1 - 0.9**t)) / (np.sqrt(v_w / (1 - 0.999**t)) + 1e-8)
        b -= lr * (m_b / (1 - 0.9**t)) / (math.sqrt(v_b / (1 - 0.999**t)) + 1e-8)
    return w.astype(np.float32), float(b)


def pick_threshold(positives: list, negatives: list, model: dict) -> float:
    """The lowest threshold (so the fewest misses) whose false accepts on the validation audio stay on target."""
    best = 0.9
    for threshold in np.linspace(0.5, 0.995, 100):
        report = wf.evaluate_clips(positives, negatives, model, float(threshold))
        fa = report["falseAcceptsPerHour"]
        if fa is not None and fa <= TARGET_FA_PER_HOUR * 0.5:
            return float(threshold)
        best = float(threshold)
    return best


def train(dataset: Path, out: Path, seed: int = 7) -> int:
    rng = np.random.default_rng(seed)
    stats = summary(dataset)
    positives = load_group(dataset, "positives")
    negatives = load_group(dataset, "negatives")
    if not positives or not negatives:
        print("need both positives/ and negatives/ with readable WAV files; run `validate` first", file=sys.stderr)
        return 1
    pos_plan = split_groups(list(positives))
    neg_plan = split_groups(list(negatives))
    independent = (
        len(positives) >= MIN_SPEAKERS
        and len(negatives) >= MIN_SPEAKERS
        and "validation" in pos_plan.values()
        and "test" in pos_plan.values()
        and "validation" in neg_plan.values()
        and "test" in neg_plan.values()
    )

    def clips(groups: dict, plan: dict, part: str) -> list[np.ndarray]:
        return [pcm for name, rows in groups.items() if plan[name] == part for _, pcm in rows]

    train_pos = clips(positives, pos_plan, "train")
    train_neg = clips(negatives, neg_plan, "train")
    if not independent:
        # Too few speakers or sources to keep any apart: train on everything, report that nothing was held out.
        train_pos = [pcm for rows in positives.values() for _, pcm in rows]
        train_neg = [pcm for rows in negatives.values() for _, pcm in rows]

    pos_windows = [a for pcm in train_pos for a in augment(positive_window(pcm), rng)]
    neg_windows = [w for pcm in train_neg for w in wf.clip_windows(pcm, hop=wf.RATE // 4) if w.size >= wf.WINDOW // 2]
    xp, xn = features_of(pos_windows), features_of(neg_windows)
    if len(xp) < 10 or len(xn) < 10:
        print("not enough usable audio to train (silent or too-short clips)", file=sys.stderr)
        return 1
    x = np.vstack([xp, xn])
    y = np.concatenate([np.ones(len(xp)), np.zeros(len(xn))])
    mean = x.mean(axis=0)
    std = np.maximum(x.std(axis=0), 1e-3)
    weights, bias = fit_logistic((x - mean) / std, y)
    model = {"mean": mean, "std": std, "weights": weights, "bias": bias}

    threshold = 0.9
    held = {"validation": ([], []), "test": ([], [])}
    if independent:
        for part in held:
            held[part] = (clips(positives, pos_plan, part), clips(negatives, neg_plan, part))
        threshold = pick_threshold(held["validation"][0], held["validation"][1], model)
        evaluation = wf.evaluate_clips(held["test"][0], held["test"][1], model, threshold)
    else:
        evaluation = wf.evaluate_clips(
            [pcm for rows in positives.values() for _, pcm in rows],
            [pcm for rows in negatives.values() for _, pcm in rows],
            model,
            threshold,
        )
    evaluation["independent"] = independent
    evaluation["heldOutSpeakers"] = sum(1 for v in pos_plan.values() if v == "test") if independent else 0
    evaluation["heldOutSources"] = sum(1 for v in neg_plan.values() if v == "test") if independent else 0

    reasons: list[str] = []
    attested, why_not = attested_real_speech(dataset)
    if not attested:
        reasons.append(why_not)
    tonal = tonal_fraction([pcm for rows in positives.values() for _, pcm in rows])
    if tonal > 0.3:
        reasons.append(f"{tonal:.0%} of the positive takes are pure tones, not speech")
    if not independent:
        reasons.append(f"fewer than {MIN_SPEAKERS} speakers or negative sources: nothing could be held apart")
    if stats["positives"] < MIN_POSITIVES:
        reasons.append(f"{stats['positives']} positive takes, need {MIN_POSITIVES}")
    if stats["speakers"] < MIN_SPEAKERS:
        reasons.append(f"{stats['speakers']} speakers, need {MIN_SPEAKERS}")
    if stats["negativeMinutes"] < MIN_NEGATIVE_MINUTES:
        reasons.append(f"{stats['negativeMinutes']} min of negatives, need {MIN_NEGATIVE_MINUTES}")
    if stats["nearMissClips"] < MIN_NEAR_MISS:
        reasons.append(f"{stats['nearMissClips']} near-miss clips, need {MIN_NEAR_MISS}")
    if (evaluation["negativeHours"] or 0) < MIN_HELD_OUT_NEGATIVE_HOURS:
        reasons.append(f"{evaluation['negativeHours']} h of held-out negatives, need {MIN_HELD_OUT_NEGATIVE_HOURS}")
    frr, fa = evaluation["falseRejectionRate"], evaluation["falseAcceptsPerHour"]
    if frr is None or frr > TARGET_FRR:
        reasons.append(f"false rejection {frr} is above {TARGET_FRR}")
    if fa is None or fa > TARGET_FA_PER_HOUR:
        reasons.append(f"false accepts {fa} per hour is above {TARGET_FA_PER_HOUR}")
    production = not reasons
    evaluation["meetsTargets"] = production

    if out.resolve() == PRODUCTION_DIR.resolve() and not production:
        print(
            "refusing to write a candidate into resources/wake: it ships only a model that meets the targets",
            file=sys.stderr,
        )
        for reason in reasons:
            print(f"  - {reason}", file=sys.stderr)
        return 3
    manifest = {
        "kind": "friday-linear-v2",
        "provenance": "real-speech",
        "production": production,
        "trainedAt": datetime.now(UTC).isoformat(timespec="seconds"),
        "features": {
            "rate": wf.RATE,
            "window": wf.WINDOW,
            "frame": wf.FRAME,
            "hop": wf.HOP,
            "nFft": wf.N_FFT,
            "mels": wf.N_MELS,
            "timeBins": wf.TIME_BINS,
        },
        "mean": [float(v) for v in mean],
        "std": [float(v) for v in std],
        "weights": [float(v) for v in weights],
        "bias": bias,
        "threshold": threshold,
        "dataset": stats,
        "evaluation": evaluation,
        "notProductionBecause": reasons,
    }
    out.mkdir(parents=True, exist_ok=True)
    (out / "friday-wake.json").write_text(json.dumps(manifest), encoding="utf-8")
    (out / "friday-wake.report.json").write_text(
        json.dumps(
            {
                k: manifest[k]
                for k in ("trainedAt", "dataset", "evaluation", "notProductionBecause", "threshold", "production")
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    export_onnx(out / "friday.onnx", weights, bias, mean, std)
    print(f"model written to {out} (production: {production})")
    print(json.dumps(evaluation))
    for reason in reasons:
        print(f"  not production: {reason}")
    return 0 if production else 2


def export_onnx(path: Path, weights: np.ndarray, bias: float, mean: np.ndarray, std: np.ndarray) -> None:
    """Optional: the same scorer as an ONNX Gemm+Sigmoid, standardisation folded in. Needs `pip install onnx`."""
    try:
        from onnx import TensorProto, helper, numpy_helper, save
    except ImportError:
        print("onnx is not installed: wrote friday-wake.json only (the app scores from it)")
        return
    folded_w = (weights / std).astype(np.float32).reshape(wf.FEATURE_DIM, 1)
    folded_b = np.asarray([bias - float(np.sum(weights * mean / std))], dtype=np.float32)
    nodes = [
        helper.make_node("Gemm", ["features", "W", "B"], ["logits"], alpha=1.0, beta=1.0),
        helper.make_node("Sigmoid", ["logits"], ["score"]),
    ]
    graph = helper.make_graph(
        nodes,
        "friday_wake_v2",
        [helper.make_tensor_value_info("features", TensorProto.FLOAT, [1, wf.FEATURE_DIM])],
        [helper.make_tensor_value_info("score", TensorProto.FLOAT, [1, 1])],
        [numpy_helper.from_array(folded_w, "W"), numpy_helper.from_array(folded_b, "B")],
    )
    save(helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)], ir_version=8), str(path))


# ---------------------------------------------------------------------------------------------- commands


def validate(dataset: Path) -> int:
    stats = summary(dataset)
    print(json.dumps(stats, indent=2))
    gaps = []
    if stats["positives"] < MIN_POSITIVES:
        gaps.append(f"record at least {MIN_POSITIVES} takes of 'Friday' (now {stats['positives']})")
    if stats["speakers"] < MIN_SPEAKERS:
        gaps.append(
            f"use at least {MIN_SPEAKERS} different speakers (now {stats['speakers']}), so some can be held apart"
        )
    if stats["negativeMinutes"] < MIN_NEGATIVE_MINUTES:
        gaps.append(
            f"add negatives: {MIN_NEGATIVE_MINUTES} min of speech, TV, music and room noise "
            f"(now {stats['negativeMinutes']})"
        )
    if stats["nearMissClips"] < MIN_NEAR_MISS:
        gaps.append(f"add {MIN_NEAR_MISS} near-miss clips under negatives/near-miss/ (now {stats['nearMissClips']})")
    for gap in gaps:
        print(f"  needed: {gap}")
    print("ready to train for production" if not gaps else "can train a candidate; it will not be marked production")
    return 0 if not gaps else 2


def record(dataset: Path, speaker: str, takes: int) -> int:
    """Record takes of the owner saying 'Friday' from the default microphone (needs `pip install sounddevice`)."""
    try:
        import sounddevice as sd  # type: ignore
    except ImportError:
        print("pip install sounddevice to record here, or save 16 kHz mono WAV files under positives/<speaker>/")
        return 1
    folder = dataset / "positives" / speaker
    existing = len(list(folder.glob("*.wav"))) if folder.is_dir() else 0
    for index in range(takes):
        input(f"take {index + 1}/{takes}: press Enter, then say 'Friday' naturally ")
        audio = sd.rec(int(1.5 * wf.RATE), samplerate=wf.RATE, channels=1, dtype="int16")
        sd.wait()
        write_wav(folder / f"take-{existing + index + 1:03d}.wav", audio.reshape(-1))
    print(f"saved {takes} takes in {folder}; vary distance, tone and room between sessions")
    return 0


def evaluate(dataset: Path, model_dir: Path, threshold: float | None) -> int:
    """Score a trained model on audio it never saw: every file in the dataset counts as held out."""
    manifest = json.loads((model_dir / "friday-wake.json").read_text(encoding="utf-8"))
    if manifest.get("kind") != "friday-linear-v2":
        print("only a friday-linear-v2 model can be evaluated here", file=sys.stderr)
        return 1
    positives = [pcm for rows in load_group(dataset, "positives").values() for _, pcm in rows]
    negatives = [pcm for rows in load_group(dataset, "negatives").values() for _, pcm in rows]
    report = wf.evaluate_clips(positives, negatives, manifest, threshold or float(manifest["threshold"]))
    report["meetsTargets"] = bool(
        report["falseRejectionRate"] is not None
        and report["falseRejectionRate"] <= TARGET_FRR
        and report["falseAcceptsPerHour"] is not None
        and report["falseAcceptsPerHour"] <= TARGET_FA_PER_HOUR
        and report["negativeHours"] >= MIN_HELD_OUT_NEGATIVE_HOURS
    )
    print(json.dumps(report, indent=2))
    return 0 if report["meetsTargets"] else 2


def synth_word(seed: int, kind: str) -> np.ndarray:
    """A pulsed tone burst, or noise. It is NOT speech and is used only to exercise the plumbing in tests."""
    rng = np.random.default_rng(seed)
    t = np.arange(wf.RATE, dtype=np.float32) / wf.RATE
    if kind == "friday":
        tone = np.zeros(wf.RATE, dtype=np.float32)
        for (start, dur), freq in zip(
            [(0.05, 0.12), (0.22, 0.10), (0.38, 0.14), (0.58, 0.10), (0.74, 0.16)],
            [780, 1250, 680, 430, 280],
            strict=True,
        ):
            a = int(start * wf.RATE)
            b = min(wf.RATE, a + int(dur * wf.RATE))
            tone[a:b] += np.hanning(b - a) * np.sin(2 * np.pi * freq * t[a:b])
        return np.clip((0.35 * tone + 0.015 * rng.normal(size=wf.RATE)) * float(rng.uniform(0.7, 1.3)), -1, 1).astype(
            np.float32
        )
    return (rng.uniform(0.04, 0.22) * rng.normal(size=wf.RATE)).astype(np.float32)


def fixture(out: Path) -> int:
    """Write a synthetic scorer plus two demo clips for the plumbing tests. It is labelled and never production."""
    if out.resolve() == PRODUCTION_DIR.resolve() or PRODUCTION_DIR.resolve() in out.resolve().parents:
        print("a synthetic fixture is never written into resources/wake", file=sys.stderr)
        return 3
    positives = np.stack([wf.window_features(synth_word(i, "friday")) for i in range(120)])
    negatives = np.stack([wf.window_features(synth_word(3000 + i, "noise")) for i in range(120)])
    both = np.concatenate([positives, negatives])
    mean = both.mean(axis=0)
    std = np.maximum(both.std(axis=0), 1e-3)
    z_pos, z_neg = wf.standardise(positives, mean, std), wf.standardise(negatives, mean, std)
    direction = z_pos.mean(axis=0) - z_neg.mean(axis=0)
    weights = (direction * (6.0 / max(1e-6, float(np.linalg.norm(direction))))).astype(np.float32)
    midpoint = 0.5 * (float(z_pos.mean(axis=0) @ weights) + float(z_neg.mean(axis=0) @ weights))
    model = {"mean": mean, "std": std, "weights": weights, "bias": -midpoint}
    out.mkdir(parents=True, exist_ok=True)
    manifest = {
        "kind": "friday-linear-v2",
        "provenance": "synthetic-fixture",
        "production": False,
        "warning": "synthetic tones, not speech: for tests of the plumbing only",
        "features": {"rate": wf.RATE, "window": wf.WINDOW, "mels": wf.N_MELS, "timeBins": wf.TIME_BINS},
        "mean": [float(v) for v in mean],
        "std": [float(v) for v in std],
        "weights": [float(v) for v in model["weights"]],
        "bias": float(model["bias"]),
        "threshold": 0.5,
    }
    (out / "friday-wake.json").write_text(json.dumps(manifest), encoding="utf-8")
    write_wav(out / "friday-demo.wav", synth_word(0, "friday"))
    write_wav(out / "noise-demo.wav", synth_word(99, "noise"))
    print(f"synthetic fixture written to {out} (production: false)")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("validate", "record", "train", "evaluate"):
        p = sub.add_parser(name)
        p.add_argument("--dataset", type=Path, required=True)
        if name == "record":
            p.add_argument("--speaker", required=True)
            p.add_argument("--takes", type=int, default=30)
        if name == "train":
            p.add_argument("--out", type=Path, default=ROOT / "temporary" / "wake-train")
        if name == "evaluate":
            p.add_argument("--model", type=Path, required=True)
            p.add_argument("--threshold", type=float)
    sub.add_parser("fixture").add_argument("--out", type=Path, default=FIXTURE_DIR)
    args = parser.parse_args()
    if args.command == "validate":
        return validate(args.dataset)
    if args.command == "record":
        return record(args.dataset, args.speaker, args.takes)
    if args.command == "train":
        return train(args.dataset, args.out)
    if args.command == "evaluate":
        return evaluate(args.dataset, args.model, args.threshold)
    return fixture(args.out)


if __name__ == "__main__":
    raise SystemExit(main())
