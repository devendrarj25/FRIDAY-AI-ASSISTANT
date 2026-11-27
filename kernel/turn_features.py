"""FRIDAY Ears: the log-mel input of the end-of-turn model, numpy only.

Interface contract
------------------
* ``TurnFeatures(feature_size=80, chunk_length=8)`` is the extractor. ``n_samples`` is the window length in samples
  (8 s at 16 kHz) and ``extractor(waveform, padding=0)`` returns the Whisper-style log-mel as ``(80, frames)`` float32:
  400-point FFT, 160-sample hop, periodic Hann window, reflect padding, Slaney mel filters, ``log10`` with a floor,
  clamp to ``max - 8`` then ``(x + 4) / 4``. The filterbank and window are built once per process and shared.
* ``turn_input(samples, extractor=None)`` is the whole model input: the last 8 s of the clip, standardised, with a
  shorter clip placed at the back of a zero window, as ``(1, 80, 800)`` float32. ``extractor`` may be any object with
  ``n_samples`` and the call above, so the older package extractor can still be passed in as a fallback.
* Never raises for a normal clip. An empty or non-finite clip gives a window of the floor value, not an exception.

The module has no import side effects. Import it inside the feature that needs it (numpy is optional at boot).
"""

from __future__ import annotations

from functools import lru_cache
from typing import Any, Protocol

import numpy as np
import numpy.typing as npt

SAMPLE_RATE = 16000
N_FFT = 400
HOP_LENGTH = 160
N_MELS = 80
WINDOW_SECONDS = 8
MODEL_FRAMES = 800
FRAME_PAD_VALUE = -1.5
MIN_POWER = 1e-10
LOG_RANGE = 8.0
VARIANCE_GUARD = 1e-7
# Slaney mel scale: linear below 1 kHz, logarithmic above.
_MEL_TOP = 45.245640471924965
_LINEAR_STEP_HZ = 200.0 / 3
_LOG_START_HZ = 1000.0

Float32 = npt.NDArray[np.float32]


class TurnExtractor(Protocol):
    n_samples: int

    def __call__(self, waveform: Any, padding: int = 0) -> Any: ...


@lru_cache(maxsize=4)
def mel_filterbank(sample_rate: int = SAMPLE_RATE, n_fft: int = N_FFT, n_mels: int = N_MELS) -> Float32:
    """Slaney-normalised triangular filters, ``(n_mels, n_fft // 2 + 1)`` float32. Built once per argument set."""
    n_mels = int(n_mels)
    bins = np.fft.rfftfreq(n=n_fft, d=1.0 / sample_rate)
    mels = np.linspace(0.0, _MEL_TOP, n_mels + 2)
    freqs = _LINEAR_STEP_HZ * mels
    log_start_mel = _LOG_START_HZ / _LINEAR_STEP_HZ
    log_step = np.log(6.4) / 27.0
    high = mels >= log_start_mel
    freqs[high] = _LOG_START_HZ * np.exp(log_step * (mels[high] - log_start_mel))
    widths = np.diff(freqs)
    ramps = freqs.reshape(-1, 1) - bins.reshape(1, -1)
    lower = -ramps[:-2] / widths[:-1, None]
    upper = ramps[2:] / widths[1:, None]
    weights = np.maximum(0.0, np.minimum(lower, upper))
    weights *= (2.0 / (freqs[2 : n_mels + 2] - freqs[:n_mels]))[:, None]
    weights.setflags(write=False)
    return weights.astype(np.float32)


@lru_cache(maxsize=4)
def _hann(n_fft: int) -> Float32:
    return np.hanning(n_fft + 1)[:-1].astype(np.float32)


class TurnFeatures:
    """The log-mel extractor for one window length. Holds the cached filterbank; safe to call from many threads."""

    def __init__(
        self,
        feature_size: int = N_MELS,
        chunk_length: int = WINDOW_SECONDS,
        sampling_rate: int = SAMPLE_RATE,
        n_fft: int = N_FFT,
        hop_length: int = HOP_LENGTH,
    ) -> None:
        self.feature_size = int(feature_size)
        self.sampling_rate = int(sampling_rate)
        self.n_fft = int(n_fft)
        self.hop_length = int(hop_length)
        self.n_samples = int(chunk_length) * self.sampling_rate
        self.mel_filters = mel_filterbank(self.sampling_rate, self.n_fft, self.feature_size)

    def __call__(self, waveform: Any, padding: int = 0) -> Float32:
        wave = np.asarray(waveform, dtype=np.float32).reshape(-1)
        if padding:
            wave = np.pad(wave, (0, int(padding)))
        half = self.n_fft // 2
        if wave.size < 2:
            wave = np.pad(wave, (0, 2 - wave.size))
        padded = np.pad(wave, (half, half), mode="reflect")
        count = 1 + (padded.size - self.n_fft) // self.hop_length
        frames = np.lib.stride_tricks.sliding_window_view(padded, self.n_fft)[:: self.hop_length][:count]
        spectrum = np.fft.rfft(frames * _hann(self.n_fft), axis=-1).astype(np.complex64)
        power = (spectrum.real**2 + spectrum.imag**2).T[:, :-1]
        mel = self.mel_filters @ power
        log_spec = np.log10(np.clip(mel, MIN_POWER, None))
        log_spec = np.maximum(log_spec, log_spec.max() - LOG_RANGE)
        return ((log_spec + 4.0) / 4.0).astype(np.float32)


def turn_window(samples: Any, n_samples: int) -> Float32:
    """The last ``n_samples`` of the clip, standardised. A shorter clip sits at the back of a zero window."""
    audio = np.asarray(samples, dtype=np.float32).reshape(-1)
    audio = np.nan_to_num(audio, nan=0.0, posinf=0.0, neginf=0.0)
    if audio.size < n_samples:
        real = _standardise(audio) if audio.size else audio
        return np.pad(real, (n_samples - real.size, 0)).astype(np.float32)
    return _standardise(audio[-n_samples:]).astype(np.float32)


def _standardise(audio: Float32) -> Float32:
    return (audio - audio.mean()) / np.sqrt(float(audio.var()) + VARIANCE_GUARD)


def fit_frames(features: Any, frames: int = MODEL_FRAMES) -> Float32:
    """Cut or pad (with the floor value) the time axis to exactly ``frames``."""
    feat = np.asarray(features, dtype=np.float32)
    if feat.shape[1] > frames:
        return feat[:, :frames]
    if feat.shape[1] < frames:
        return np.pad(feat, ((0, 0), (0, frames - feat.shape[1])), constant_values=FRAME_PAD_VALUE)
    return feat


def turn_input(samples: Any, extractor: TurnExtractor | None = None) -> Float32:
    """The model input ``(1, 80, 800)`` for a clip. Pass ``extractor`` to use another extractor with the same call."""
    extract = extractor if extractor is not None else _shared_extractor()
    window = turn_window(samples, int(extract.n_samples))
    feat = fit_frames(extract(window, padding=0))
    return feat[None].astype(np.float32)


@lru_cache(maxsize=1)
def _shared_extractor() -> TurnFeatures:
    return TurnFeatures()
