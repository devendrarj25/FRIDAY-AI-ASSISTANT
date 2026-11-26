"""FRIDAY · wake-word features and clip scoring shared by the trainer and the runtime.

One definition of the features means a model is scored in the app exactly as it was trained. numpy only (the
kernel already needs it); no torch, no extra download. The model is a small linear scorer over a pooled log-mel
spectrogram of a one-second window, trained on real recordings by scripts/train-friday-wake.py.

A clip is scored by sliding the window over it (hop 100 ms) and taking the best window, which is how a short
utterance containing the wake word is scored whatever the word's position in it.

The second half of this file is the streaming embedding pipeline of the `friday-embed` engine: 80 ms chunks of
audio become a 32-band log-mel stream (numpy, exact to the shipped mel front end), every 76 mel frames an
embedding model (onnxruntime, installed on demand) turns into 96 numbers, and a small head trained by
scripts/train-friday-wake.py scores the last 16 embeddings. The streaming state is deterministic and does not
depend on how the caller chunks its audio.
"""

from __future__ import annotations

import base64
import math
from collections.abc import Callable, Iterator, Sequence
from typing import Any

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


# ------------------------------------------------------------------------------------ embedding pipeline

CHUNK = 1280  # 80 ms: one step of the stream and one embedding
CHUNK_CONTEXT = 480  # samples kept from the last chunk so every step yields whole frames
EMBED_FFT = 512
EMBED_STRIDE = 160  # 10 ms
EMBED_HANN = 400  # 25 ms, centred in the 512-point frame
EMBED_BANDS = 32
EMBED_FMIN = 60.0
EMBED_FMAX = 3800.0
EMBED_FLOOR_DB = 80.0  # the dynamic range kept below the loudest cell of a step
EMBED_POWER_FLOOR = 1e-10
EMBED_FRAMES = 76  # mel frames in one embedding window
EMBED_DIM = 96
HEAD_WINDOW = 16  # embeddings the head scores (about 1.3 s)
PRIME_CHUNKS = 10  # chunks before the first embedding
MIN_CLIP_CHUNKS = 27  # a clip long enough for the first head window and two more
TAIL_CHUNKS = 4

_embed_cache: dict[str, np.ndarray] = {}

Embedder = Callable[[np.ndarray], np.ndarray]


def _slaney_mel(hz) -> np.ndarray:
    hz = np.asarray(hz, dtype=np.float64)
    step = math.log(6.4) / 27.0
    return np.where(hz >= 1000.0, 15.0 + np.log(np.maximum(hz, 1e-9) / 1000.0) / step, hz / (200.0 / 3.0))


def _slaney_hz(mel) -> np.ndarray:
    mel = np.asarray(mel, dtype=np.float64)
    step = math.log(6.4) / 27.0
    return np.where(mel >= 15.0, 1000.0 * np.exp(step * (mel - 15.0)), mel * (200.0 / 3.0))


def embed_filterbank() -> np.ndarray:
    """(257, 32) triangular mel weights, Slaney scale and area normalisation, 60 to 3800 Hz."""
    cached = _embed_cache.get("bank")
    if cached is not None:
        return cached
    freqs = np.arange(EMBED_FFT // 2 + 1) * RATE / EMBED_FFT
    edges = _slaney_hz(np.linspace(_slaney_mel(EMBED_FMIN), _slaney_mel(EMBED_FMAX), EMBED_BANDS + 2))
    bank = np.zeros((freqs.size, EMBED_BANDS))
    for band in range(EMBED_BANDS):
        low, centre, high = edges[band], edges[band + 1], edges[band + 2]
        rising = (freqs - low) / (centre - low)
        falling = (high - freqs) / (high - centre)
        bank[:, band] = np.maximum(0.0, np.minimum(rising, falling)) * 2.0 / (high - low)
    _embed_cache["bank"] = bank
    return bank


def embed_window() -> np.ndarray:
    """The 512-point analysis window: a 400-point periodic Hann with its zero first sample, centred."""
    cached = _embed_cache.get("window")
    if cached is not None:
        return cached
    window = np.zeros(EMBED_FFT)
    start = (EMBED_FFT - EMBED_HANN) // 2
    ramp = np.arange(1, EMBED_HANN)
    window[start + 1 : start + EMBED_HANN] = 0.5 - 0.5 * np.cos(2.0 * np.pi * ramp / EMBED_HANN)
    _embed_cache["window"] = window
    return window


def as_pcm_scale(samples) -> np.ndarray:
    """Any sequence of 16-bit-scale samples as a flat float64 array (the embedding front end works in int16 units)."""
    return np.clip(np.asarray(samples, dtype=np.float64).reshape(-1), -32768.0, 32767.0)


def embed_melspec(samples) -> np.ndarray:
    """Log-mel frames (dB) of one step of audio, shape (frames, 32), before the model's x / 10 + 2 scaling.

    Frame count is 1 + (n - 512) // 160. The loudest cell of the call sets the floor, 80 dB below it, exactly as
    the reference front end does per call, so a step must always be computed from the same span the model saw.
    """
    x = as_pcm_scale(samples)
    if x.size < EMBED_FFT:
        return np.zeros((0, EMBED_BANDS), dtype=np.float32)
    frames = 1 + (x.size - EMBED_FFT) // EMBED_STRIDE
    index = np.arange(EMBED_FFT)[None, :] + EMBED_STRIDE * np.arange(frames)[:, None]
    power = np.abs(np.fft.rfft(x[index] * embed_window(), axis=1)) ** 2
    mel = np.maximum(power @ embed_filterbank(), EMBED_POWER_FLOOR)
    db = 10.0 * np.log10(mel)
    return np.maximum(db, db.max() - EMBED_FLOOR_DB).astype(np.float32)


def scaled_melspec(samples) -> np.ndarray:
    """The mel frames as the embedding model wants them: dB / 10 + 2."""
    return embed_melspec(samples) / 10.0 + 2.0


def _step_mel(tail: np.ndarray, chunk: np.ndarray) -> np.ndarray:
    return scaled_melspec(np.concatenate([tail, chunk]))


def _chunks(x: np.ndarray) -> Iterator[np.ndarray]:
    for start in range(0, x.size - CHUNK + 1, CHUNK):
        yield x[start : start + CHUNK]


def mel_windows(samples) -> np.ndarray:
    """Every 76-frame mel window a clip yields (one per 80 ms step once primed), shape (n, 76, 32)."""
    x = as_pcm_scale(samples)
    tail = np.zeros(CHUNK_CONTEXT)
    mel = np.zeros((0, EMBED_BANDS), dtype=np.float32)
    out: list[np.ndarray] = []
    for chunk in _chunks(x):
        mel = np.vstack([mel, _step_mel(tail, chunk)])[-EMBED_FRAMES:]
        tail = chunk[-CHUNK_CONTEXT:]
        if mel.shape[0] >= EMBED_FRAMES:
            out.append(mel)
    return np.stack(out) if out else np.zeros((0, EMBED_FRAMES, EMBED_BANDS), dtype=np.float32)


def embed_clip(samples, embed: Embedder, batch: int = 128) -> np.ndarray:
    """Embeddings of a whole clip, shape (n, dim); the same numbers the stream produces for the same audio."""
    windows = mel_windows(samples)
    if windows.shape[0] == 0:
        return np.zeros((0, EMBED_DIM), dtype=np.float32)
    parts = [np.asarray(embed(windows[i : i + batch]), dtype=np.float32) for i in range(0, windows.shape[0], batch)]
    return np.vstack([p.reshape(p.shape[0], -1) for p in parts])


class EmbeddingStream:
    """Live 16 kHz PCM16 in any chunk size; one embedding per 80 ms once 76 mel frames exist.

    Nothing random: the first embedding appears after `PRIME_CHUNKS` steps, `window()` answers None until
    `HEAD_WINDOW` embeddings exist, and `reset()` returns the stream to that state.
    """

    def __init__(self, embed: Embedder, history: int = 64) -> None:
        self.embed = embed
        self.history = max(HEAD_WINDOW, history)
        self.reset()

    def reset(self) -> None:
        self._pending = np.zeros(0)
        self._tail = np.zeros(CHUNK_CONTEXT)
        self._mel = np.zeros((0, EMBED_BANDS), dtype=np.float32)
        self._emb: np.ndarray | None = None
        self.steps = 0

    def feed(self, samples) -> int:
        """Add samples; returns how many new embeddings were produced."""
        self._pending = np.concatenate([self._pending, as_pcm_scale(samples)])
        made = 0
        while self._pending.size >= CHUNK:
            chunk, self._pending = self._pending[:CHUNK], self._pending[CHUNK:]
            self._mel = np.vstack([self._mel, _step_mel(self._tail, chunk)])[-EMBED_FRAMES:]
            self._tail = chunk[-CHUNK_CONTEXT:]
            self.steps += 1
            if self._mel.shape[0] < EMBED_FRAMES:
                continue
            vector = np.asarray(self.embed(self._mel[None, :, :]), dtype=np.float32).reshape(1, -1)
            self._emb = vector if self._emb is None else np.vstack([self._emb, vector])[-self.history :]
            made += 1
        return made

    @property
    def embeddings(self) -> int:
        return 0 if self._emb is None else int(self._emb.shape[0])

    def window(self, count: int = HEAD_WINDOW) -> np.ndarray | None:
        if self._emb is None or self._emb.shape[0] < count:
            return None
        return self._emb[-count:]


# ------------------------------------------------------------------------------------ the head


def encode_tensor(array) -> dict:
    """A float32 array as plain JSON: shape and base64 bytes (a head stays one readable file)."""
    data = np.ascontiguousarray(np.asarray(array, dtype="<f4"))
    return {"shape": list(data.shape), "b64": base64.b64encode(data.tobytes()).decode("ascii")}


def decode_tensor(blob: dict) -> np.ndarray:
    shape = tuple(int(v) for v in blob["shape"])
    data = np.frombuffer(base64.b64decode(blob["b64"]), dtype="<f4")
    if data.size != int(np.prod(shape)):
        raise ValueError("a head tensor does not match its shape")
    return data.reshape(shape).astype(np.float32)


def load_head(manifest: dict) -> dict:
    """Decoded head of a friday-embed manifest: per-dimension mean and std, then dense layers (the last 1 wide)."""
    head = manifest["head"]
    layers = [(decode_tensor(layer["w"]), decode_tensor(layer["b"])) for layer in head["layers"]]
    if not layers or layers[-1][0].shape[1] != 1:
        raise ValueError("a head must end in one output")
    mean, std = decode_tensor(head["mean"]), decode_tensor(head["std"])
    window = int(head.get("window", HEAD_WINDOW))
    if layers[0][0].shape[0] != mean.size * window:
        raise ValueError("the head does not match its window")
    return {"mean": mean, "std": std, "layers": layers, "window": window}


def head_inputs(windows: np.ndarray, head: dict) -> np.ndarray:
    """(n, window, dim) embeddings standardised per dimension and flattened to (n, window * dim)."""
    z = (np.asarray(windows, dtype=np.float32) - head["mean"]) / np.maximum(head["std"], 1e-6)
    return z.reshape(z.shape[0], -1)


def head_scores(windows: np.ndarray, head: dict) -> np.ndarray:
    """Wake probability of each window, shape (n,)."""
    h = head_inputs(windows, head)
    layers = head["layers"]
    for weight, bias in layers[:-1]:
        h = np.maximum(h @ weight + bias, 0.0)
    weight, bias = layers[-1]
    logit = np.clip((h @ weight + bias).reshape(-1), -60.0, 60.0)
    return (1.0 / (1.0 + np.exp(-logit))).astype(np.float32)


def sliding_windows(embeddings: np.ndarray, size: int = HEAD_WINDOW, stride: int = 1) -> np.ndarray:
    """(n, size, dim) windows over a (frames, dim) embedding sequence; empty when it is too short."""
    dim = embeddings.shape[1] if embeddings.ndim == 2 else EMBED_DIM
    count = embeddings.shape[0] - size + 1
    if count <= 0:
        return np.zeros((0, size, dim), dtype=np.float32)
    return np.stack([embeddings[i : i + size] for i in range(0, count, stride)])


def pad_clip(samples, tail_chunks: int = TAIL_CHUNKS, min_chunks: int = MIN_CLIP_CHUNKS, seed: int = 11) -> np.ndarray:
    """A clip long enough for the stream: room-level noise before it (so it ends near the end) and after it.

    The noise has the clip's own floor (its quietest tenth of 10 ms frames), seeded so a clip is always padded the
    same way. The trainer and the runtime pad identically, which is what keeps them scoring the same thing.
    """
    x = as_pcm_scale(samples)
    whole = x[: x.size // EMBED_STRIDE * EMBED_STRIDE]
    frames = whole.reshape(-1, EMBED_STRIDE) if whole.size else x[None, :]
    floor = float(np.percentile(np.sqrt(np.mean(frames * frames, axis=1)), 10)) if frames.size else 0.0
    sigma = max(floor, 1.0)
    rng = np.random.default_rng(seed)
    tail = rng.normal(0.0, sigma, tail_chunks * CHUNK)
    lead = rng.normal(0.0, sigma, max(0, min_chunks * CHUNK - x.size - tail.size))
    return np.clip(np.concatenate([lead, x, tail]), -32768.0, 32767.0)


def clip_scores(samples, embed: Embedder, head: dict) -> np.ndarray:
    """Head score of every window of a clip as the stream would see it, in 80 ms steps (padded as `pad_clip`)."""
    windows = sliding_windows(embed_clip(pad_clip(samples), embed), head["window"])
    return head_scores(windows, head) if windows.shape[0] else np.zeros(0, dtype=np.float32)


def score_embed_clip(samples, embed: Embedder, head: dict) -> float:
    """The best window score of a clip."""
    scores = clip_scores(samples, embed, head)
    return float(scores.max()) if scores.size else 0.0


def count_triggers(
    scores: Any,
    threshold: float,
    min_frames: int = 2,
    release_ratio: float = 0.6,
    release_frames: int = 2,
    cooldown_frames: int = 18,
) -> list[int]:
    """Indexes at which a score series triggers: the same latch and cooldown as the live wake frame scorer."""
    release = threshold * release_ratio
    hot = cool = 0
    latched = False
    out: list[int] = []
    for index, score in enumerate(scores):
        if latched:
            cool = max(0, cool - 1)
            hot = hot + 1 if score < release else 0
            if hot >= release_frames and cool == 0:
                latched, hot = False, 0
            continue
        hot = hot + 1 if score >= threshold else 0
        if hot >= max(1, min_frames):
            out.append(index)
            latched, hot, cool = True, 0, cooldown_frames
    return out


def embed_report(
    positive_series: Sequence[Any],
    negative_series: Sequence[Any],
    negative_seconds: float,
    threshold: float,
    min_frames: int = 2,
) -> dict:
    """False rejection rate and false accepts per hour from already computed score series (one per clip)."""
    missed = sum(1 for series in positive_series if not count_triggers(series, threshold, min_frames))
    false_accepts = sum(len(count_triggers(series, threshold, min_frames)) for series in negative_series)
    hours = negative_seconds / 3600.0
    frr = missed / len(positive_series) if positive_series else None
    fa = false_accepts / hours if hours > 0 else None
    return {
        "positives": len(positive_series),
        "negatives": len(negative_series),
        "falseRejectionRate": None if frr is None else round(frr, 4),
        "falseAcceptsPerHour": None if fa is None else round(fa, 3),
        "negativeHours": round(hours, 4),
        "threshold": threshold,
    }


def evaluate_embed_clips(positives: list, negatives: list, embed: Embedder, head: dict, threshold: float) -> dict:
    """Held-out numbers for a friday-embed head, scored the way the live stream scores (see `embed_report`)."""
    positive_series = [clip_scores(clip, embed, head) for clip in positives]
    negative_series = [clip_scores(clip, embed, head) for clip in negatives]
    seconds = sum(len(clip) for clip in negatives) / RATE
    return embed_report(positive_series, negative_series, seconds, threshold)


def load_embedder(path: str) -> Embedder:
    """The embedding model through onnxruntime on one CPU thread: (n, 76, 32) mel windows in, (n, 96) out."""
    import onnxruntime as ort  # type: ignore

    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(str(path), sess_options=options, providers=["CPUExecutionProvider"])
    name = session.get_inputs()[0].name

    def embed(windows: np.ndarray) -> np.ndarray:
        batch = np.asarray(windows, dtype=np.float32)[..., None]
        out = np.asarray(session.run(None, {name: batch})[0], dtype=np.float32)
        return out.reshape(batch.shape[0], -1)

    return embed
