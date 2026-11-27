"""FRIDAY Ears: the log-mel front end, numpy only.

Interface contract
------------------
* ``MelConfig`` describes one front end. ``nemo_config()`` is the 128-mel NeMo/Nemotron layout
  (n_fft 512, window 400, hop 160, pre-emphasis 0.97, natural log, 2**-24 guard) and ``whisper_config()`` is the
  80-mel Whisper-style layout (n_fft 400, hop 160, log10, no pre-emphasis).
* ``MelFrontend(config).extract(samples)`` returns the whole utterance as ``(frames, n_mels)`` float32.
* ``StreamingMel(config)`` takes audio in chunks of any size. ``push(samples)`` returns ``MelChunk``: the new frames
  and the same frames behind the last ``cache_frames`` (9) frames of earlier chunks, which is what a cache-aware
  streaming encoder reads. The frames are identical to ``extract`` over the whole signal, whatever the chunk sizes.
* Frame ``i`` covers samples ``[i * hop, i * hop + win_length)`` of the pre-emphasised signal (no centre padding), so
  a frame exists only once its last sample has arrived. Samples may be float in [-1, 1] or int16.
* ``normalize`` is ``"none"``, ``"fixed"`` (per-bin mean and std you pass in; streams), ``"per_feature"`` (mean and
  std over the utterance, NeMo style) or ``"whisper"`` (clamp to max - 8 then (x + 4) / 4). The last two need the
  whole utterance, so the streaming class refuses them; apply ``MelFrontend.normalize_utterance`` yourself.
* Dither is off. When turned on it is drawn from ``numpy.random.default_rng(dither_seed)``, so a run repeats.

The module has no import side effects. Import it inside the feature that needs it (numpy is optional at boot).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Literal

import numpy as np
import numpy.typing as npt

Array = npt.NDArray[np.float64]
Normalize = Literal["none", "fixed", "per_feature", "whisper"]
STREAMABLE_NORMALIZE = ("none", "fixed")
PRE_ENCODE_CACHE_FRAMES = 9
LOG_GUARD = 2.0**-24


@dataclass(frozen=True)
class MelConfig:
    sample_rate: int = 16000
    n_mels: int = 128
    n_fft: int = 512
    win_length: int = 400
    hop_length: int = 160
    preemph: float = 0.97
    fmin: float = 0.0
    fmax: float | None = None
    mel_scale: Literal["slaney", "htk"] = "slaney"
    mel_norm: Literal["slaney", "none"] = "slaney"
    log_base: Literal["ln", "log10"] = "ln"
    log_guard: float = LOG_GUARD
    dither: float = 0.0
    dither_seed: int = 0
    normalize: Normalize = "none"

    def __post_init__(self) -> None:
        if self.sample_rate <= 0 or self.n_mels <= 0 or self.hop_length <= 0:
            raise ValueError("sample_rate, n_mels and hop_length must be positive")
        if not 0 < self.win_length <= self.n_fft:
            raise ValueError("win_length must be in 1..n_fft")
        if self.n_fft % 2:
            raise ValueError("n_fft must be even")
        if not 0.0 <= self.preemph < 1.0:
            raise ValueError("preemph must be in [0, 1)")
        if self.dither < 0.0 or self.log_guard <= 0.0:
            raise ValueError("dither must be >= 0 and log_guard > 0")
        top = self.fmax if self.fmax is not None else self.sample_rate / 2
        if not 0.0 <= self.fmin < top <= self.sample_rate / 2:
            raise ValueError("need 0 <= fmin < fmax <= sample_rate / 2")


def nemo_config(**overrides: Any) -> MelConfig:
    """128-mel NeMo / Nemotron layout."""
    return MelConfig(**overrides)


def whisper_config(**overrides: Any) -> MelConfig:
    """80-mel Whisper-style layout (uncentred frames, so offline Whisper values differ at the edges)."""
    base: dict[str, Any] = {
        "n_mels": 80,
        "n_fft": 400,
        "win_length": 400,
        "preemph": 0.0,
        "log_base": "log10",
        "log_guard": 1e-10,
        "normalize": "whisper",
    }
    base.update(overrides)
    return MelConfig(**base)


# ---- mel scale and filterbank -------------------------------------------------------------------------------------

_F_SP = 200.0 / 3.0
_MIN_LOG_HZ = 1000.0
_MIN_LOG_MEL = _MIN_LOG_HZ / _F_SP
_LOG_STEP = math.log(6.4) / 27.0


def hz_to_mel(hz: float, scale: str = "slaney") -> float:
    if scale == "htk":
        return 2595.0 * math.log10(1.0 + hz / 700.0)
    if hz < _MIN_LOG_HZ:
        return hz / _F_SP
    return _MIN_LOG_MEL + math.log(hz / _MIN_LOG_HZ) / _LOG_STEP


def mel_to_hz(mel: float, scale: str = "slaney") -> float:
    if scale == "htk":
        return 700.0 * (10.0 ** (mel / 2595.0) - 1.0)
    if mel < _MIN_LOG_MEL:
        return mel * _F_SP
    return _MIN_LOG_HZ * math.exp(_LOG_STEP * (mel - _MIN_LOG_MEL))


def mel_filterbank(config: MelConfig) -> Array:
    """Triangular filters, shape ``(n_mels, n_fft // 2 + 1)``."""
    fmax = config.fmax if config.fmax is not None else config.sample_rate / 2
    lo = hz_to_mel(config.fmin, config.mel_scale)
    hi = hz_to_mel(fmax, config.mel_scale)
    edges = np.array(
        [mel_to_hz(lo + (hi - lo) * i / (config.n_mels + 1), config.mel_scale) for i in range(config.n_mels + 2)]
    )
    freqs = np.arange(config.n_fft // 2 + 1) * (config.sample_rate / config.n_fft)
    lower = (freqs[None, :] - edges[:-2, None]) / (edges[1:-1] - edges[:-2])[:, None]
    upper = (edges[2:, None] - freqs[None, :]) / (edges[2:] - edges[1:-1])[:, None]
    bank = np.maximum(0.0, np.minimum(lower, upper))
    if config.mel_norm == "slaney":
        bank = bank * (2.0 / (edges[2:] - edges[:-2]))[:, None]
    return bank


def hann_window(config: MelConfig) -> Array:
    """Periodic Hann of ``win_length``, centred in an ``n_fft`` frame (zero padded)."""
    n = config.win_length
    win = 0.5 - 0.5 * np.cos(2.0 * np.pi * np.arange(n) / n)
    full = np.zeros(config.n_fft)
    start = (config.n_fft - n) // 2
    full[start : start + n] = win
    return full


def preemphasis(samples: Array, coefficient: float, previous: float = 0.0) -> Array:
    """``y[t] = x[t] - a * x[t-1]`` with ``x[-1] = previous`` (0 at the start of an utterance)."""
    if samples.size == 0 or coefficient == 0.0:
        return samples.copy()
    shifted = np.concatenate(([previous], samples[:-1]))
    return samples - coefficient * shifted


def power_spectrum(frames: Array, window: Array, n_fft: int) -> Array:
    """``|rfft(frame * window)|**2`` for frames of length ``n_fft`` (shape ``(T, n_fft // 2 + 1)``)."""
    spec = np.fft.rfft(frames * window[None, :], n=n_fft, axis=1)
    return spec.real**2 + spec.imag**2


def _as_float(samples: npt.ArrayLike) -> Array:
    arr = np.asarray(samples)
    if arr.ndim != 1:
        raise ValueError("samples must be one-dimensional mono audio")
    if arr.dtype == np.int16:
        return arr.astype(np.float64) / 32768.0
    return arr.astype(np.float64)


class _Core:
    """Shared by the offline and the streaming path so both make the same frames."""

    def __init__(self, config: MelConfig, fixed_mean: npt.ArrayLike | None, fixed_std: npt.ArrayLike | None) -> None:
        self.config = config
        self.bank = mel_filterbank(config)
        self.window = hann_window(config)
        self.fixed_mean: Array | None = None
        self.fixed_std: Array | None = None
        if config.normalize == "fixed":
            if fixed_mean is None or fixed_std is None:
                raise ValueError('normalize="fixed" needs fixed_mean and fixed_std')
            self.fixed_mean = np.asarray(fixed_mean, dtype=np.float64).reshape(-1)
            self.fixed_std = np.asarray(fixed_std, dtype=np.float64).reshape(-1)
            if self.fixed_mean.size != config.n_mels or self.fixed_std.size != config.n_mels:
                raise ValueError("fixed_mean and fixed_std need n_mels values")
        self.reset()

    def reset(self) -> None:
        self._tail: Array = np.zeros(0)
        self._previous = 0.0
        self._rng = np.random.default_rng(self.config.dither_seed)

    def push(self, samples: npt.ArrayLike) -> Array:
        cfg = self.config
        x = _as_float(samples)
        if x.size:
            if cfg.dither > 0.0:
                x = x + cfg.dither * self._rng.standard_normal(x.size) / 32768.0
            pre = preemphasis(x, cfg.preemph, self._previous)
            self._previous = float(x[-1])
            self._tail = np.concatenate((self._tail, pre))
        count = 0 if self._tail.size < cfg.win_length else 1 + (self._tail.size - cfg.win_length) // cfg.hop_length
        if count == 0:
            return np.zeros((0, cfg.n_mels))
        index = np.arange(cfg.win_length)[None, :] + cfg.hop_length * np.arange(count)[:, None]
        framed = np.zeros((count, cfg.n_fft))
        offset = (cfg.n_fft - cfg.win_length) // 2
        framed[:, offset : offset + cfg.win_length] = self._tail[index]
        self._tail = self._tail[count * cfg.hop_length :]
        power = power_spectrum(framed, self.window, cfg.n_fft)
        mel = power @ self.bank.T
        logmel = np.log(mel + cfg.log_guard)
        if cfg.log_base == "log10":
            logmel = logmel / math.log(10.0)
        if self.fixed_mean is not None and self.fixed_std is not None:
            logmel = (logmel - self.fixed_mean[None, :]) / self.fixed_std[None, :]
        return logmel


class MelFrontend:
    """Offline extraction of a whole utterance."""

    def __init__(
        self,
        config: MelConfig,
        *,
        fixed_mean: npt.ArrayLike | None = None,
        fixed_std: npt.ArrayLike | None = None,
    ) -> None:
        self.config = config
        self._core = _Core(config, fixed_mean, fixed_std)

    def extract(self, samples: npt.ArrayLike) -> npt.NDArray[np.float32]:
        self._core.reset()
        frames = self._core.push(samples)
        return self.normalize_utterance(frames).astype(np.float32)

    def normalize_utterance(self, frames: Array) -> Array:
        """Apply the utterance-level options (``per_feature``, ``whisper``). Others are already applied."""
        mode = self.config.normalize
        if frames.shape[0] == 0 or mode in STREAMABLE_NORMALIZE:
            return frames
        if mode == "whisper":
            return (np.maximum(frames, frames.max() - 8.0) + 4.0) / 4.0
        mean = frames.mean(axis=0, keepdims=True)
        std = frames.std(axis=0, ddof=1, keepdims=True) if frames.shape[0] > 1 else np.ones_like(mean)
        return (frames - mean) / (std + 1e-5)


@dataclass(frozen=True)
class MelChunk:
    frames: npt.NDArray[np.float32]  # new frames only, (T, n_mels)
    encoder_input: npt.NDArray[np.float32]  # cache frames then the new frames, (cache + T, n_mels)
    cache_len: int  # how many leading rows of encoder_input come from the cache


class StreamingMel:
    """Chunk-at-a-time extraction with a ring buffer of the last ``cache_frames`` frames."""

    def __init__(
        self,
        config: MelConfig,
        *,
        cache_frames: int = PRE_ENCODE_CACHE_FRAMES,
        fixed_mean: npt.ArrayLike | None = None,
        fixed_std: npt.ArrayLike | None = None,
    ) -> None:
        if config.normalize not in STREAMABLE_NORMALIZE:
            raise ValueError(f'normalize="{config.normalize}" needs the whole utterance; use MelFrontend')
        if cache_frames < 0:
            raise ValueError("cache_frames must be >= 0")
        self.config = config
        self.cache_frames = cache_frames
        self._core = _Core(config, fixed_mean, fixed_std)
        self._cache = np.zeros((0, config.n_mels), dtype=np.float32)

    def reset(self) -> None:
        self._core.reset()
        self._cache = np.zeros((0, self.config.n_mels), dtype=np.float32)

    def push(self, samples: npt.ArrayLike) -> MelChunk:
        new = self._core.push(samples).astype(np.float32)
        if new.shape[0] == 0:
            return MelChunk(new, new, 0)
        cache = self._cache
        joined = np.concatenate((cache, new), axis=0)
        self._cache = joined[-self.cache_frames :] if self.cache_frames else joined[:0]
        return MelChunk(new, joined, cache.shape[0])
