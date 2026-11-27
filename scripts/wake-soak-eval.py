"""Soak-test the FRIDAY wake scorer on a long recording of the owner's own room.

    python scripts/wake-soak-eval.py --bed BED.wav --model models/wake/friday-wake.json
    python scripts/wake-soak-eval.py --bed BED.wav --model MODEL --wake take1.wav take2.wav ... --snr 20 10 5 \\
        [--repeat 3] [--threshold 0.9] [--out report.json]

The bed is 16 kHz mono 16-bit PCM WAV, an hour or more of ordinary room audio without the wake word (TV, talk,
music, silence). It is streamed in 80 ms frames straight from disk with the `wave` module and numpy, so peak
memory is a few megabytes whatever the length (a Python list of one hour of samples would need about 2 GB). The
bed is only read: no audio is copied, written or kept, and the report holds no path.

With `--wake` the given wake-word recordings are mixed into the bed in memory, frame by frame, evenly spread, at
the listed SNRs (dB of the sample's RMS over the bed's RMS, cycled in order; `--repeat` reuses the list). A
positive counts as found when the scorer triggers between its start and its end plus `--tail-sec`.

The scorer is the live one: `wake_word.WakeFrameScorer` at `wake_word.live_threshold` (the manifest's evaluated
level, never below 0.5, or `--threshold`), with the live defaults for consecutive frames (`LIVE_MIN_FRAMES`) and
cooldown (`LIVE_COOLDOWN_MS`). SCOPE: scorer-only. The transcript matcher and WakeGuard run in the renderer and
are NOT in these numbers, so the real false accepts are at most what is reported here.

The report is JSON: bedHours, falseAccepts, falseAcceptsPerHour, upper95PerHour (95 % upper limit: the rule of
three, 3 / hours, for zero events, the exact Poisson limit otherwise), triggerTimesSec, positives, misses,
missRate, missUpper95 (Clopper-Pearson), thresholdUsed, scope and meetsTargets. meetsTargets is true only for a
bed of at least 6 hours, at least 60 positives, an upper limit of at most 0.5 false accepts per hour and an upper
miss limit of at most 5 %. Anything less proves nothing, so it stays false.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "kernel"))

import wake_word  # noqa: E402

RATE = 16000
FRAME = wake_word.FRAME_SAMPLES
SAMPLES_PER_HOUR = RATE * 3600
CHUNK_FRAMES = 100  # 8 s of audio per read: about 256 KB
MIN_BED_HOURS = 6.0
MIN_POSITIVES = 60
MAX_FA_PER_HOUR = 0.5
MAX_MISS_RATE = 0.05
SCOPE = "scorer-only"
SCOPE_NOTE = (
    "scorer only: the transcript matcher and WakeGuard run in the renderer and are not included; "
    "real false accepts are at most these"
)
GAP_FRAMES = 38  # about 3 s of bed kept between a positive's end and the next one's start


def poisson_upper95(events: int, hours: float) -> float:
    """95 % upper limit of the rate (per hour) after `events` in `hours`: 3 / hours for none, exact Poisson else."""
    if hours <= 0:
        return math.inf
    if events <= 0:
        return 3.0 / hours  # the rule of three

    def cdf(lam: float) -> float:
        logs = [-lam + i * math.log(lam) - math.lgamma(i + 1) for i in range(events + 1)]
        top = max(logs)
        return math.exp(top) * sum(math.exp(v - top) for v in logs)

    low, high = float(events), events + 10 * math.sqrt(events) + 10
    for _ in range(200):
        mid = (low + high) / 2
        if cdf(mid) > 0.05:
            low = mid
        else:
            high = mid
    return high / hours


def binomial_upper95(misses: int, total: int) -> float | None:
    """Clopper-Pearson 95 % one-sided upper limit of the miss rate; None when there are no positives."""
    if total <= 0:
        return None
    if misses >= total:
        return 1.0
    if misses == 0:
        return 1.0 - 0.05 ** (1.0 / total)

    def cdf(p: float) -> float:
        logs = [
            math.lgamma(total + 1)
            - math.lgamma(i + 1)
            - math.lgamma(total - i + 1)
            + i * math.log(p)
            + (total - i) * math.log1p(-p)
            for i in range(misses + 1)
        ]
        top = max(logs)
        return math.exp(top) * sum(math.exp(v - top) for v in logs)

    low, high = misses / total, 1.0
    for _ in range(200):
        mid = (low + high) / 2
        if mid <= 0.0 or mid >= 1.0:
            break
        if cdf(mid) > 0.05:
            low = mid
        else:
            high = mid
    return high


def summarize(
    bed_samples: int,
    all_trigger_times: list[float],
    false_accept_times: list[float],
    positives: int,
    misses: int,
    threshold: float,
    params: dict | None = None,
) -> dict:
    hours = bed_samples / SAMPLES_PER_HOUR
    false_accepts = len(false_accept_times)
    fa_upper = poisson_upper95(false_accepts, hours)
    miss_upper = binomial_upper95(misses, positives)
    meets = bool(
        hours >= MIN_BED_HOURS
        and positives >= MIN_POSITIVES
        and fa_upper <= MAX_FA_PER_HOUR
        and miss_upper is not None
        and miss_upper <= MAX_MISS_RATE
    )
    fa_set = set(false_accept_times)
    return {
        "bedHours": round(hours, 6),
        "falseAccepts": false_accepts,
        "falseAcceptsPerHour": round(false_accepts / hours, 4) if hours > 0 else None,
        "upper95PerHour": round(fa_upper, 4) if math.isfinite(fa_upper) else None,
        "triggerTimesSec": list(all_trigger_times),
        "falseAcceptTimesSec": list(false_accept_times),
        "hitTimesSec": [t for t in all_trigger_times if t not in fa_set],
        "positives": positives,
        "misses": misses,
        "missRate": round(misses / positives, 4) if positives else None,
        "missUpper95": round(miss_upper, 4) if miss_upper is not None else None,
        "thresholdUsed": threshold,
        "scope": SCOPE,
        "scopeNote": SCOPE_NOTE,
        "targets": {
            "minBedHours": MIN_BED_HOURS,
            "minPositives": MIN_POSITIVES,
            "maxFalseAcceptsPerHourUpper95": MAX_FA_PER_HOUR,
            "maxMissRateUpper95": MAX_MISS_RATE,
        },
        "meetsTargets": meets,
        **(params or {}),
    }


def open_bed(path: str) -> wave.Wave_read:
    try:
        wav = wave.open(path, "rb")
    except (OSError, EOFError, wave.Error) as exc:
        raise ValueError(f"the bed could not be read as a WAV file ({type(exc).__name__})") from exc
    if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or wav.getframerate() != RATE:
        wav.close()
        raise ValueError("the bed must be 16 kHz mono 16-bit PCM WAV; convert it first, this tool never resamples")
    return wav


def read_chunks(wav: wave.Wave_read, samples: int):
    """Yield (offset, int16 array) of whole 80 ms frames, `CHUNK_FRAMES` at a time, up to `samples` samples."""
    offset = 0
    while offset < samples:
        want = min(CHUNK_FRAMES * FRAME, samples - offset)
        raw = wav.readframes(want)
        got = len(raw) // 2
        if got < want:
            break  # the header promised more than the file holds: score what is there
        yield offset, np.frombuffer(raw, dtype="<i2")
        offset += got


def bed_rms(path: str) -> float:
    wav = open_bed(path)
    try:
        samples = wav.getnframes() // FRAME * FRAME
        total = 0.0
        for _, chunk in read_chunks(wav, samples):
            values = chunk.astype(np.float64)
            total += float(np.dot(values, values))
    finally:
        wav.close()
    return math.sqrt(total / samples) if samples else 0.0


def load_clip(path: str) -> np.ndarray:
    wav = open_bed(path)  # the same format rule: a sample must be 16 kHz mono 16-bit
    try:
        return np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").copy()
    finally:
        wav.close()


def plan_positives(path: str, total_frames: int, wake_paths, snrs_db, repeat: int) -> list[dict]:
    """Evenly spread, frame-aligned positives with their gained samples. Nothing is written anywhere."""
    paths = list(wake_paths) * max(1, repeat)
    if not paths:
        return []
    clips = {p: load_clip(p) for p in set(paths)}
    snrs = list(snrs_db) or [10.0]
    level = bed_rms(path)
    slot = total_frames // len(paths)
    plan: list[dict] = []
    for i, clip_path in enumerate(paths):
        clip = clips[clip_path]
        rms = math.sqrt(float(np.mean(clip.astype(np.float64) ** 2))) if len(clip) else 0.0
        if rms == 0.0:
            raise ValueError("a wake sample is silent")
        clip_frames = -(-len(clip) // FRAME)
        if slot < clip_frames + GAP_FRAMES:
            raise ValueError("the bed is too short for that many wake samples: lengthen it or use fewer")
        snr = snrs[i % len(snrs)]
        gain = max(level, 1.0) * 10 ** (snr / 20.0) / rms
        start_frame = i * slot + (slot - clip_frames) // 2
        start = start_frame * FRAME
        plan.append(
            {
                "start": start,
                "end": start + len(clip),
                "samples": np.rint(clip.astype(np.float64) * gain).astype(np.int32),
                "snr": snr,
            }
        )
    return plan


def mix_into(chunk: np.ndarray, base: int, plan: list[dict]) -> np.ndarray:
    end = base + len(chunk)
    hits = [p for p in plan if p["start"] < end and p["end"] > base]
    if not hits:
        return chunk
    mixed = chunk.astype(np.int32)
    for p in hits:
        lo, hi = max(p["start"], base), min(p["end"], end)
        mixed[lo - base : hi - base] += p["samples"][lo - p["start"] : hi - p["start"]]
    return np.clip(mixed, -32768, 32767).astype(np.int16)


def soak_eval(
    bed_path: str,
    predict,
    *,
    threshold: float,
    wake_paths=(),
    snrs_db=(10.0,),
    repeat: int = 1,
    min_frames: int = wake_word.LIVE_MIN_FRAMES,
    cooldown_ms: int = wake_word.LIVE_COOLDOWN_MS,
    tail_sec: float = 1.5,
) -> dict:
    """Stream the bed through a fresh live scorer; returns the report dict (see the module text)."""
    wav = open_bed(bed_path)
    try:
        samples = wav.getnframes() // FRAME * FRAME
    finally:
        wav.close()
    plan = plan_positives(bed_path, samples // FRAME, wake_paths, snrs_db, repeat)
    scorer = wake_word.WakeFrameScorer(predict, threshold=threshold, min_frames=min_frames, cooldown_ms=cooldown_ms)
    triggers: list[float] = []
    wav = open_bed(bed_path)
    try:
        for base, chunk in read_chunks(wav, samples):
            if plan:
                chunk = mix_into(chunk, base, plan)
            for at in range(0, len(chunk), FRAME):
                if scorer.feed(chunk[at : at + FRAME])["detected"]:
                    triggers.append(round(scorer.frames * wake_word.FRAME_MS / 1000.0, 3))
    finally:
        wav.close()
    windows = [(p["start"] / RATE, p["end"] / RATE + tail_sec) for p in plan]
    found = [False] * len(windows)
    false_accepts: list[float] = []
    for t in triggers:
        spot = next((i for i, (a, b) in enumerate(windows) if a <= t <= b), None)
        if spot is None:
            false_accepts.append(t)
        else:
            found[spot] = True
    params = {
        "minFrames": min_frames,
        "cooldownMs": cooldown_ms,
        "tailSec": tail_sec,
        "snrDb": list(snrs_db) if plan else [],
    }
    return summarize(samples, triggers, false_accepts, len(plan), found.count(False), threshold, params)


def table(report: dict) -> str:
    def cell(value) -> str:
        return "n/a" if value is None else str(value)

    rows = [
        ("scope", f"{report['scope']} ({report['scopeNote']})"),
        ("bed hours", cell(report["bedHours"])),
        ("threshold used", cell(report["thresholdUsed"])),
        ("false accepts", f"{report['falseAccepts']} ({cell(report['falseAcceptsPerHour'])}/h)"),
        ("false accept upper 95%/h", cell(report["upper95PerHour"])),
        ("positives / misses", f"{report['positives']} / {report['misses']}"),
        ("miss rate (upper 95%)", f"{cell(report['missRate'])} ({cell(report['missUpper95'])})"),
        ("meetsTargets", str(report["meetsTargets"]).lower()),
    ]
    width = max(len(name) for name, _ in rows)
    return "\n".join(f"{name.ljust(width)}  {value}" for name, value in rows)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Soak-test the FRIDAY wake scorer on a long bed (scorer-only).")
    parser.add_argument("--bed", required=True, help="16 kHz mono 16-bit WAV of room audio without the wake word")
    parser.add_argument("--model", help="wake model or manifest path (default: the configured wake word's model)")
    parser.add_argument("--wake-word", default="friday")
    parser.add_argument("--wake", nargs="*", default=[], help="wake-word sample WAVs to mix into the bed")
    parser.add_argument("--snr", nargs="+", type=float, default=[10.0], help="SNRs in dB, cycled over the samples")
    parser.add_argument("--repeat", type=int, default=1, help="use the sample list this many times")
    parser.add_argument("--threshold", type=float, help="override the live threshold")
    parser.add_argument("--min-frames", type=int, default=wake_word.LIVE_MIN_FRAMES)
    parser.add_argument("--cooldown-ms", type=int, default=wake_word.LIVE_COOLDOWN_MS)
    parser.add_argument("--tail-sec", type=float, default=1.5, help="a trigger this long after a sample still counts")
    parser.add_argument("--out", help="write the JSON report here")
    return parser


def resolve_predictor(args) -> tuple:
    """(predict, threshold) from the model on disk, with the live path's own gates; raises ValueError."""
    model_path = wake_word.pick_model(args.wake_word, args.model)
    if not model_path:
        raise ValueError(wake_word.missing_model_error(args.wake_word))
    engine = wake_word.engine_for_path(model_path)
    if engine not in {"openwakeword", wake_word.EMBED_ENGINE}:
        raise ValueError("a soak needs a friday-embed or openWakeWord model (frame scoring)")
    if engine == wake_word.EMBED_ENGINE:
        allowed, why_not = wake_word.production_status(model_path)
        if not allowed:
            raise ValueError(why_not)
    try:
        predict = wake_word._predictor_for(model_path)
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"the model could not be loaded: {str(exc)[-300:]}") from exc
    return predict, wake_word.live_threshold(model_path, args.threshold)


def main(argv: list[str] | None = None, predict=None) -> int:
    """`predict` replaces the model (tests only): a callable from one 1280-sample frame to a score."""
    args = build_parser().parse_args(argv)
    try:
        if predict is None:
            predict, threshold = resolve_predictor(args)
        else:
            threshold = args.threshold if args.threshold is not None else wake_word.LIVE_THRESHOLD_DEFAULT
        report = soak_eval(
            args.bed,
            predict,
            threshold=threshold,
            wake_paths=args.wake,
            snrs_db=args.snr,
            repeat=args.repeat,
            min_frames=args.min_frames,
            cooldown_ms=args.cooldown_ms,
            tail_sec=args.tail_sec,
        )
    except (ValueError, OSError) as exc:
        print(f"wake soak: {exc}", file=sys.stderr)
        return 2
    if args.out:
        Path(args.out).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(table(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
