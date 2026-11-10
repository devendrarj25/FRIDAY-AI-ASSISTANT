"""FRIDAY · wake-word features and clip scoring shared by the trainer and the runtime.

One definition of the features means a model is scored in the app exactly as it was trained. numpy only (the
kernel already needs it); no torch, no extra download. The model is a small linear scorer over a pooled log-mel
spectrogram of a one-second window, trained on real recordings by scripts/train-friday-wake.py.

A clip is scored by sliding the window over it (hop 100 ms) and taking the best window, which is how a short
utterance containing the wake word is scored whatever the word's position in it.
"""

from __future__ import annotations

import math

import numpy as np

RATE = 16000
WINDOW = RATE  # one second
HOP_WINDOW = RATE // 10  # slide by 100 ms
N_FFT = 512
FRAME = 400  # 25 ms
HOP = 160  # 10 ms
N_MELS = 40
TIME_BINS = 16
FEATURE_DIM = N_MELS * TIME_BINS
MIN_RMS = 1e-4

_mel_cache: dict[tuple, np.ndarray] = {}


def _hz_to_mel(hz):
    return 2595.0 * np.log10(1.0 + np.asarray(hz, dtype=np.float64) / 700.0)


def _mel_to_hz(mel):
    return 700.0 * (10.0 ** (np.asarray(mel, dtype=np.float64) / 2595.0) - 1.0)


def mel_filterbank(n_mels: int = N_MELS, n_fft: int = N_FFT, rate: int = RATE) -> np.ndarray:
    key = (n_mels, n_fft, rate)
    cached = _mel_cache.get(key)
    if cached is not None:
        return cached
    low, high = _hz_to_mel(60.0), _hz_to_mel(rate / 2.0 - 100.0)
    points = _mel_to_hz(np.linspace(low, high, n_mels + 2))
    bins = np.floor((n_fft + 1) * points / rate).astype(int)
    bank = np.zeros((n_mels, n_fft // 2 + 1), dtype=np.float32)
    for m in range(1, n_mels + 1):
        left, centre, right = bins[m - 1], bins[m], bins[m + 1]
        centre = max(centre, left + 1)
        right = max(right, centre + 1)
        for k in range(left, min(centre, bank.shape[1])):
            bank[m - 1, k] = (k - left) / (centre - left)
        for k in range(centre, min(right, bank.shape[1])):
            bank[m - 1, k] = (right - k) / (right - centre)
    _mel_cache[key] = bank
    return bank


def to_float(pcm) -> np.ndarray:
    """int16 samples (any sequence) to float32 in [-1, 1]."""
    arr = np.asarray(pcm)
    if arr.dtype.kind in "iu":
        return arr.astype(np.float32) / 32768.0
    return arr.astype(np.float32)


def window_features(window: np.ndarray) -> np.ndarray | None:
    """Pooled log-mel features of exactly one window, or None for silence (nothing to score)."""
    x = np.asarray(window, dtype=np.float32).reshape(-1)
    if x.size < WINDOW:
        x = np.pad(x, (0, WINDOW - x.size))
    x = x[:WINDOW]
    if float(np.sqrt(np.mean(x * x))) < MIN_RMS:
        return None
    n_frames = 1 + (x.size - FRAME) // HOP
    index = np.arange(FRAME)[None, :] + HOP * np.arange(n_frames)[:, None]
    frames = x[index] * np.hanning(FRAME).astype(np.float32)
    spectrum = np.abs(np.fft.rfft(frames, n=N_FFT, axis=1)) ** 2
    mel = np.log(spectrum @ mel_filterbank().T + 1e-8)
    per_bin = n_frames // TIME_BINS
    pooled = mel[: per_bin * TIME_BINS].reshape(TIME_BINS, per_bin, N_MELS).mean(axis=1)
    return pooled.reshape(-1).astype(np.float32)


def clip_windows(pcm, hop: int = HOP_WINDOW) -> list[np.ndarray]:
    """The one-second windows of a clip, 100 ms apart (a short clip is one padded window)."""
    x = to_float(pcm)
    if x.size <= WINDOW:
        return [x]
    return [x[start : start + WINDOW] for start in range(0, x.size - WINDOW + 1, hop)]


def standardise(features: np.ndarray, mean, std) -> np.ndarray:
    return (features - np.asarray(mean, dtype=np.float32)) / np.maximum(np.asarray(std, dtype=np.float32), 1e-6)


def sigmoid(value: float) -> float:
    return 1.0 / (1.0 + math.exp(-max(-60.0, min(60.0, value))))


def score_window(window: np.ndarray, model: dict) -> float:
    feats = window_features(window)
    if feats is None:
        return 0.0
    z = standardise(feats, model["mean"], model["std"])
    return sigmoid(float(z @ np.asarray(model["weights"], dtype=np.float32) + float(model["bias"])))


def score_clip(pcm, model: dict) -> float:
    """The best window score of a clip."""
    return max((score_window(w, model) for w in clip_windows(pcm)), default=0.0)


def detections(pcm, model: dict, threshold: float, cooldown_s: float = 1.5) -> list[float]:
    """Times (seconds) at which a stream triggers: a window at or above the threshold, then a cooldown."""
    x = to_float(pcm)
    out: list[float] = []
    last = -1e9
    for start in range(0, max(1, x.size - WINDOW + 1), HOP_WINDOW):
        at = start / RATE
        if at - last < cooldown_s:
            continue
        if score_window(x[start : start + WINDOW], model) >= threshold:
            out.append(round(at, 3))
            last = at
    return out


def evaluate_clips(positives: list, negatives: list, model: dict, threshold: float) -> dict:
    """Held-out numbers on recorded clips: false rejection rate, false accepts per hour, trigger counts.

    Only meaningful for audio the model was not trained on; the caller keeps a held-out set apart.
    """
    missed = sum(1 for clip in positives if score_clip(clip, model) < threshold)
    false_accepts = 0
    seconds = 0.0
    for clip in negatives:
        n = len(clip)
        seconds += n / RATE
        false_accepts += len(detections(clip, model, threshold))
    hours = seconds / 3600.0
    frr = missed / len(positives) if positives else None
    fa = false_accepts / hours if hours > 0 else None
    return {
        "positives": len(positives),
        "negatives": len(negatives),
        "falseRejectionRate": None if frr is None else round(frr, 4),
        "falseAcceptsPerHour": None if fa is None else round(fa, 3),
        "negativeHours": round(hours, 4),
        "threshold": threshold,
    }
