"""FRIDAY Voice post-processing: the own finishing chain of the speaking voice, numpy only.

A clause leaves the speech graphs as raw audio. This chain shapes it into the voice FRIDAY keeps: a clean low end,
warmth, presence and air from RBJ biquads, an even level from a soft-knee compressor, tamed sibilance from a
band-limited de-esser, and a soft limiter so nothing ever clips. It works at any sample rate and on any chunk size.

Interface contract
------------------
* ``FxChain(sample_rate, spec)`` builds a chain. ``process(x)`` takes one chunk (any 1-D float array, any length,
  one sample included) and returns a float32 array of the same length. State is carried between calls, so a clip
  processed in any chunking equals the clip processed whole (to float rounding, far below 1e-5). ``reset()`` forgets
  the clip. Non-finite input is zeroed and the output is always finite and never above the limiter ceiling.
* ``spec`` is plain data (see ``normalise_spec``): ``dc_hz``, ``highpass_hz``, ``eq`` (up to eight bands of
  ``lowshelf``, ``peak``, ``highshelf``, ``highpass`` or ``lowpass``), ``compressor``, ``deesser``, ``gain_db`` and
  ``limiter``. Every number is clamped, unknown keys are ignored, and anything that is not a dict is an empty spec,
  which is the limiter alone. ``DEFAULT_SPECS`` holds the starting chains.
* ``biquad_coefficients`` and ``Biquad`` are the filters alone. A biquad runs block by block through an FFT
  convolution with the recursion's own impulse response, so a clause costs a few milliseconds, not a Python loop per
  sample. The compressor and the de-esser read their level once per millisecond hop on a fixed global grid and move
  their gain with a linear ramp between hops, which keeps them causal and independent of the chunk size.
* ``fade_edges``, ``fade_in``, ``fade_out`` and ``crossfade`` are the helpers that join clause chunks without clicks.
  ``trim_silence`` cuts the digital silence the speech graphs pad around a clause (about half a second at the start),
  keeping a short guard, so the first sound of a reply is not delayed by it.

Nothing in this file writes to disk, opens a socket or keeps anything but the filter and gain state of a chain.
"""

from __future__ import annotations

import copy
import math
from collections.abc import Mapping
from functools import lru_cache
from typing import Any

import numpy as np

BLOCK = 2048
MIN_RATE = 4000
MAX_RATE = 384000
DEFAULT_RATE = 44100
MAX_EQ_BANDS = 8
EQ_TYPES = ("lowshelf", "peak", "highshelf", "highpass", "lowpass")
HOP_SECONDS = 0.001

_TINY = 1e-12


def _number(value: Any, default: float, low: float, high: float) -> float:
    """``value`` as a finite float inside ``[low, high]``; anything else is ``default``."""
    if isinstance(value, bool):
        return default
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return default
    if not math.isfinite(number):
        return default
    return min(high, max(low, number))


def _rate(value: Any) -> int:
    return int(_number(value, DEFAULT_RATE, MIN_RATE, MAX_RATE))


# ---- biquads ----------------------------------------------------------------------------------------------------


def biquad_coefficients(
    kind: str, sample_rate: int, freq_hz: float, gain_db: float = 0.0, q: float = 0.7071
) -> tuple[np.ndarray, np.ndarray]:
    """RBJ cookbook coefficients ``(b, a)`` (``a[0]`` is the cookbook ``a0``; ``Biquad`` normalises).

    ``kind`` is ``lowshelf``, ``peak``, ``highshelf``, ``highpass``, ``lowpass`` or ``bandpass`` (constant 0 dB peak).
    The frequency is held below 0.45 of the rate, ``q`` to 0.1..20 and the gain to +-30 dB: a filter is always stable.
    """
    sr = _rate(sample_rate)
    freq = _number(freq_hz, 1000.0, 10.0, 0.45 * sr)
    qq = _number(q, 0.7071, 0.1, 20.0)
    gain = _number(gain_db, 0.0, -30.0, 30.0)
    w0 = 2.0 * math.pi * freq / sr
    cos, sin = math.cos(w0), math.sin(w0)
    alpha = sin / (2.0 * qq)
    amp = 10.0 ** (gain / 40.0)
    root = 2.0 * math.sqrt(amp) * alpha
    if kind == "peak":
        b = [1 + alpha * amp, -2 * cos, 1 - alpha * amp]
        a = [1 + alpha / amp, -2 * cos, 1 - alpha / amp]
    elif kind == "lowshelf":
        b = [
            amp * ((amp + 1) - (amp - 1) * cos + root),
            2 * amp * ((amp - 1) - (amp + 1) * cos),
            amp * ((amp + 1) - (amp - 1) * cos - root),
        ]
        a = [(amp + 1) + (amp - 1) * cos + root, -2 * ((amp - 1) + (amp + 1) * cos), (amp + 1) + (amp - 1) * cos - root]
    elif kind == "highshelf":
        b = [
            amp * ((amp + 1) + (amp - 1) * cos + root),
            -2 * amp * ((amp - 1) + (amp + 1) * cos),
            amp * ((amp + 1) + (amp - 1) * cos - root),
        ]
        a = [(amp + 1) - (amp - 1) * cos + root, 2 * ((amp - 1) - (amp + 1) * cos), (amp + 1) - (amp - 1) * cos - root]
    elif kind == "highpass":
        b = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2]
        a = [1 + alpha, -2 * cos, 1 - alpha]
    elif kind == "lowpass":
        b = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2]
        a = [1 + alpha, -2 * cos, 1 - alpha]
    elif kind == "bandpass":
        b = [alpha, 0.0, -alpha]
        a = [1 + alpha, -2 * cos, 1 - alpha]
    else:
        raise ValueError(f"no filter named {kind!r}")
    return np.asarray(b, dtype=np.float64), np.asarray(a, dtype=np.float64)


def dc_blocker_coefficients(sample_rate: int, freq_hz: float) -> tuple[np.ndarray, np.ndarray]:
    """A first-order high-pass, ``y[n] = x[n] - x[n-1] + R y[n-1]``, with its corner at ``freq_hz``."""
    sr = _rate(sample_rate)
    pole = math.exp(-2.0 * math.pi * _number(freq_hz, 10.0, 1.0, 0.1 * sr) / sr)
    return np.asarray([1.0, -1.0, 0.0]), np.asarray([1.0, -pole, 0.0])


@lru_cache(maxsize=256)
def _impulse(a1: float, a2: float) -> np.ndarray:
    """The impulse response ``g`` (``BLOCK + 1`` samples) of ``1 / (1 + a1 z^-1 + a2 z^-2)``."""
    g = [0.0] * (BLOCK + 1)
    g[0] = 1.0
    g[1] = -a1
    for n in range(2, BLOCK + 1):
        g[n] = -a1 * g[n - 1] - a2 * g[n - 2]
    out = np.asarray(g, dtype=np.float64)
    out.setflags(write=False)
    return out


class Biquad:
    """One second-order section with state carried between ``process`` calls (direct form I, float64)."""

    def __init__(self, b: np.ndarray, a: np.ndarray) -> None:
        a0 = float(a[0])
        if not math.isfinite(a0) or a0 == 0.0:
            raise ValueError("a filter needs a non-zero a0")
        self.b = np.asarray(b, dtype=np.float64) / a0
        self.a = np.asarray(a, dtype=np.float64) / a0
        self.x1 = self.x2 = self.y1 = self.y2 = 0.0

    def reset(self) -> None:
        self.x1 = self.x2 = self.y1 = self.y2 = 0.0

    def gain_db(self, freq_hz: float, sample_rate: int) -> float:
        """The magnitude of the response at ``freq_hz`` in dB (for tests and for choosing a curve)."""
        w = 2.0 * math.pi * float(freq_hz) / _rate(sample_rate)
        z1 = complex(math.cos(w), -math.sin(w))
        z2 = z1 * z1
        num = self.b[0] + self.b[1] * z1 + self.b[2] * z2
        den = 1.0 + self.a[1] * z1 + self.a[2] * z2
        return 20.0 * math.log10(max(abs(num / den), _TINY))

    def process(self, x: np.ndarray) -> np.ndarray:
        """Filter float64 samples; any length. The result has the same length."""
        x = np.asarray(x, dtype=np.float64)
        if x.size <= BLOCK:
            return self._block(x)
        return np.concatenate([self._block(x[i : i + BLOCK]) for i in range(0, x.size, BLOCK)])

    def _block(self, x: np.ndarray) -> np.ndarray:
        m = x.size
        if m == 0:
            return x.copy()
        b0, b1, b2 = self.b
        a1, a2 = float(self.a[1]), float(self.a[2])
        padded = np.concatenate(([self.x2, self.x1], x))
        v = b0 * padded[2:] + b1 * padded[1:-1] + b2 * padded[:-2]
        if a1 == 0.0 and a2 == 0.0:
            y = v
        else:
            g = _impulse(a1, a2)
            if m <= 64:
                y = np.convolve(g[:m], v)[:m]
            else:
                size = 1 << (2 * m - 1).bit_length()
                y = np.fft.irfft(np.fft.rfft(v, size) * np.fft.rfft(g[:m], size), size)[:m]
            # The part of the output that the previous two outputs still ring into.
            y = y + self.y1 * g[1 : m + 1] - a2 * self.y2 * g[:m]
        self.x2, self.x1 = (float(padded[-2]), float(padded[-1]))
        self.y2, self.y1 = (float(y[-2]) if m > 1 else self.y1, float(y[-1]))
        return y


# ---- level-driven gain (compressor and de-esser) ------------------------------------------------------------------


def _reduction_db(level_db: np.ndarray, threshold_db: float, ratio: float, knee_db: float) -> np.ndarray:
    """Gain reduction in dB for a level in dB: the soft-knee static curve of a downward compressor."""
    over = level_db - threshold_db
    slope = 1.0 - 1.0 / ratio
    if knee_db <= 0.0:
        return slope * np.maximum(over, 0.0)
    inside = slope * (over + knee_db / 2.0) ** 2 / (2.0 * knee_db)
    return np.where(over <= -knee_db / 2.0, 0.0, np.where(over >= knee_db / 2.0, slope * over, inside))


class _HopGain:
    """A gain that follows the level of a side-chain, read once per hop on a grid fixed to the start of the clip.

    A hop is about a millisecond. When one closes, its mean-square level sets a target reduction, which is smoothed
    with the attack and release (in dB), and the gain ramps linearly from the previous hop's value to the new one
    over the next hop. Samples only ever see hops that are complete, so the result is causal and does not depend on
    how the clip was cut into chunks.
    """

    def __init__(
        self, sample_rate: int, *, threshold_db: float, ratio: float, knee_db: float,
        attack_ms: float, release_ms: float, max_reduction_db: float,
    ) -> None:  # fmt: skip
        self.hop = max(4, int(round(sample_rate * HOP_SECONDS)))
        hop_seconds = self.hop / sample_rate
        self.attack = math.exp(-hop_seconds / (attack_ms / 1000.0))
        self.release = math.exp(-hop_seconds / (release_ms / 1000.0))
        self.threshold_db, self.ratio, self.knee_db = threshold_db, ratio, knee_db
        self.max_reduction_db = max_reduction_db
        self.reset()

    def reset(self) -> None:
        self.pos = 0  # samples already in the open hop
        self.energy = 0.0  # their sum of squares
        self.smooth = 0.0  # smoothed reduction in dB
        self.gain_before = 1.0  # the gain the open hop ramps from ...
        self.gain_after = 1.0  # ... and to

    def gains(self, side: np.ndarray) -> np.ndarray:
        """One linear gain per sample of ``side`` (the side-chain signal, float64)."""
        n = side.size
        if n == 0:
            return np.zeros(0)
        hop = self.hop
        index = self.pos + np.arange(n)
        hop_id = index // hop
        closed = (self.pos + n) // hop
        energy = np.bincount(hop_id, weights=side * side, minlength=closed + 1)
        energy[0] += self.energy
        anchors = [self.gain_before, self.gain_after]
        if closed:
            level = 10.0 * np.log10(energy[:closed] / hop + _TINY)
            target = np.minimum(
                _reduction_db(level, self.threshold_db, self.ratio, self.knee_db), self.max_reduction_db
            )
            smooth = self.smooth
            for want in target.tolist():
                coef = self.attack if want > smooth else self.release
                smooth = coef * smooth + (1.0 - coef) * want
                anchors.append(10.0 ** (-smooth / 20.0))
            self.smooth = smooth
        table = np.asarray(anchors)
        frac = (index - hop_id * hop + 1) / hop
        out = table[hop_id] + (table[hop_id + 1] - table[hop_id]) * frac
        self.pos = (self.pos + n) % hop
        self.energy = float(energy[closed]) if self.pos else 0.0
        self.gain_before, self.gain_after = float(table[closed]), float(table[closed + 1])
        return out


# ---- the spec ---------------------------------------------------------------------------------------------------

_COMPRESSOR = {
    "threshold_db": -20.0,
    "ratio": 2.0,
    "knee_db": 8.0,
    "attack_ms": 8.0,
    "release_ms": 120.0,
    "makeup_db": 0.0,
}
_DEESSER = {
    "hz": 6500.0,
    "q": 1.4,
    "threshold_db": -32.0,
    "ratio": 3.0,
    "max_reduction_db": 6.0,
    "attack_ms": 1.0,
    "release_ms": 40.0,
}
_BAND = {"type": "peak", "hz": 1000.0, "gain_db": 0.0, "q": 0.9}


def _clean_band(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, Mapping) or raw.get("type") not in EQ_TYPES:
        return None
    return {
        "type": raw["type"],
        "hz": _number(raw.get("hz"), _BAND["hz"], 20.0, 20000.0),
        "gain_db": _number(raw.get("gain_db"), 0.0, -18.0, 18.0),
        "q": _number(raw.get("q"), _BAND["q"], 0.1, 10.0),
    }


def _clean_compressor(raw: Any) -> dict[str, float] | None:
    if not isinstance(raw, Mapping):
        return None
    return {
        "threshold_db": _number(raw.get("threshold_db"), _COMPRESSOR["threshold_db"], -60.0, 0.0),
        "ratio": _number(raw.get("ratio"), _COMPRESSOR["ratio"], 1.0, 20.0),
        "knee_db": _number(raw.get("knee_db"), _COMPRESSOR["knee_db"], 0.0, 24.0),
        "attack_ms": _number(raw.get("attack_ms"), _COMPRESSOR["attack_ms"], 0.5, 200.0),
        "release_ms": _number(raw.get("release_ms"), _COMPRESSOR["release_ms"], 5.0, 2000.0),
        "makeup_db": _number(raw.get("makeup_db"), 0.0, -12.0, 18.0),
    }


def _clean_deesser(raw: Any) -> dict[str, float] | None:
    if not isinstance(raw, Mapping):
        return None
    return {
        "hz": _number(raw.get("hz"), _DEESSER["hz"], 3000.0, 12000.0),
        "q": _number(raw.get("q"), _DEESSER["q"], 0.5, 6.0),
        "threshold_db": _number(raw.get("threshold_db"), _DEESSER["threshold_db"], -60.0, 0.0),
        "ratio": _number(raw.get("ratio"), _DEESSER["ratio"], 1.0, 20.0),
        "max_reduction_db": _number(raw.get("max_reduction_db"), _DEESSER["max_reduction_db"], 0.0, 18.0),
        "attack_ms": _number(raw.get("attack_ms"), _DEESSER["attack_ms"], 0.2, 50.0),
        "release_ms": _number(raw.get("release_ms"), _DEESSER["release_ms"], 5.0, 500.0),
    }


def normalise_spec(spec: Any) -> dict[str, Any]:
    """The canonical form of a chain description: every number clamped, every default filled, extras dropped.

    ``compressor`` and ``deesser`` are ``None`` when absent, false, or not a dict. ``limiter`` is always present.
    ``0`` for ``dc_hz`` or ``highpass_hz`` turns that stage off.
    """
    raw: Mapping[str, Any] = spec if isinstance(spec, Mapping) else {}
    eq_in = raw.get("eq")
    bands_in: list[Any] = eq_in if isinstance(eq_in, list) else []
    bands = [band for band in (_clean_band(item) for item in bands_in) if band is not None][:MAX_EQ_BANDS]
    lim_in = raw.get("limiter")
    limiter_in: Mapping[str, Any] = lim_in if isinstance(lim_in, Mapping) else {}
    ceiling = _number(limiter_in.get("ceiling"), 0.98, 0.5, 1.0)
    return {
        "dc_hz": _number(raw.get("dc_hz"), 0.0, 0.0, 40.0),
        "highpass_hz": _number(raw.get("highpass_hz"), 0.0, 0.0, 400.0),
        "eq": bands,
        "compressor": _clean_compressor(raw.get("compressor")),
        "deesser": _clean_deesser(raw.get("deesser")),
        "gain_db": _number(raw.get("gain_db"), 0.0, -24.0, 24.0),
        "limiter": {
            "threshold": _number(limiter_in.get("threshold"), 0.86, 0.1, ceiling - 0.02),
            "ceiling": ceiling,
        },
    }


# The finishing chains of the three named voices (the same numbers as ``friday_voice_recipes.json``), and ``clean``,
# the safety limiter alone. They were tuned on the F-voice blends of the 2026-11-26 sweep: a clean low end, a little
# warmth, a mud cut, presence and air that make the line gentler in tilt than the raw blend, 2-3:1 compression with
# about 9 dB of make-up (the raw voice peaks near -6 dBFS and averages near -28), and a light de-esser.
DEFAULT_SPECS: dict[str, dict[str, Any]] = {
    "clean": {},
    "warm": {
        "dc_hz": 12.0,
        "highpass_hz": 80.0,
        "eq": [
            {"type": "lowshelf", "hz": 190.0, "gain_db": 0.8, "q": 0.7},
            {"type": "peak", "hz": 380.0, "gain_db": -1.5, "q": 1.0},
            {"type": "peak", "hz": 3300.0, "gain_db": 3.0, "q": 0.8},
            {"type": "highshelf", "hz": 7000.0, "gain_db": 4.0, "q": 0.7},
        ],
        "compressor": {
            "threshold_db": -27.0,
            "ratio": 2.8,
            "knee_db": 10.0,
            "attack_ms": 5.0,
            "release_ms": 120.0,
            "makeup_db": 9.0,
        },
        "deesser": {"hz": 6800.0, "q": 1.4, "threshold_db": -38.0, "ratio": 3.0, "max_reduction_db": 5.0},
        "limiter": {"threshold": 0.86, "ceiling": 0.98},
    },
    "bright": {
        "dc_hz": 12.0,
        "highpass_hz": 90.0,
        "eq": [
            {"type": "peak", "hz": 380.0, "gain_db": -1.0, "q": 1.0},
            {"type": "peak", "hz": 3800.0, "gain_db": 3.5, "q": 0.9},
            {"type": "highshelf", "hz": 8000.0, "gain_db": 5.0, "q": 0.7},
        ],
        "compressor": {
            "threshold_db": -27.0,
            "ratio": 3.0,
            "knee_db": 10.0,
            "attack_ms": 4.0,
            "release_ms": 110.0,
            "makeup_db": 9.0,
        },
        "deesser": {"hz": 7000.0, "q": 1.4, "threshold_db": -39.0, "ratio": 3.5, "max_reduction_db": 7.0},
        "limiter": {"threshold": 0.86, "ceiling": 0.98},
    },
    "calm": {
        "dc_hz": 12.0,
        "highpass_hz": 70.0,
        "eq": [
            {"type": "lowshelf", "hz": 170.0, "gain_db": 2.0, "q": 0.7},
            {"type": "peak", "hz": 400.0, "gain_db": -1.0, "q": 1.0},
            {"type": "peak", "hz": 3000.0, "gain_db": 1.5, "q": 0.9},
            {"type": "highshelf", "hz": 8500.0, "gain_db": 1.5, "q": 0.7},
        ],
        "compressor": {
            "threshold_db": -28.0,
            "ratio": 3.0,
            "knee_db": 12.0,
            "attack_ms": 8.0,
            "release_ms": 160.0,
            "makeup_db": 9.5,
        },
        "deesser": {"hz": 6400.0, "q": 1.3, "threshold_db": -37.0, "ratio": 3.0, "max_reduction_db": 5.0},
        "limiter": {"threshold": 0.84, "ceiling": 0.98},
    },
}


# ---- the chain --------------------------------------------------------------------------------------------------


class FxChain:
    """The finishing chain of one voice at one sample rate. One chain per stream; not thread-safe."""

    def __init__(self, sample_rate: Any, spec: Any = None) -> None:
        self.sample_rate = _rate(sample_rate)
        self.spec = normalise_spec(spec)
        sr = self.sample_rate
        spec_ = self.spec
        self._filters: list[Biquad] = []
        if spec_["dc_hz"] > 0:
            self._filters.append(Biquad(*dc_blocker_coefficients(sr, spec_["dc_hz"])))
        if spec_["highpass_hz"] > 0:
            self._filters.append(Biquad(*biquad_coefficients("highpass", sr, spec_["highpass_hz"], 0.0, 0.7071)))
        for band in spec_["eq"]:
            self._filters.append(Biquad(*biquad_coefficients(band["type"], sr, band["hz"], band["gain_db"], band["q"])))
        comp = spec_["compressor"]
        self._comp: _HopGain | None = None
        self._makeup = 1.0
        if comp is not None:
            self._comp = _HopGain(
                sr, threshold_db=comp["threshold_db"], ratio=comp["ratio"], knee_db=comp["knee_db"],
                attack_ms=comp["attack_ms"], release_ms=comp["release_ms"], max_reduction_db=60.0,
            )  # fmt: skip
            self._makeup = 10.0 ** (comp["makeup_db"] / 20.0)
        ess = spec_["deesser"]
        self._ess: _HopGain | None = None
        self._ess_band: Biquad | None = None
        if ess is not None and ess["max_reduction_db"] > 0:
            self._ess_band = Biquad(*biquad_coefficients("bandpass", sr, ess["hz"], 0.0, ess["q"]))
            self._ess = _HopGain(
                sr, threshold_db=ess["threshold_db"], ratio=ess["ratio"], knee_db=0.0,
                attack_ms=ess["attack_ms"], release_ms=ess["release_ms"], max_reduction_db=ess["max_reduction_db"],
            )  # fmt: skip
        self._gain = 10.0 ** (spec_["gain_db"] / 20.0)

    def reset(self) -> None:
        for stage in (*self._filters, self._ess_band):
            if stage is not None:
                stage.reset()
        for gain in (self._comp, self._ess):
            if gain is not None:
                gain.reset()

    def process(self, x: Any) -> np.ndarray:
        """One chunk in, one chunk of the same length out (float32). Safe on any input."""
        y = np.nan_to_num(np.asarray(x, dtype=np.float64).reshape(-1), nan=0.0, posinf=0.0, neginf=0.0)
        if y.size == 0:
            return np.zeros(0, dtype=np.float32)
        for stage in self._filters:
            y = stage.process(y)
        if self._comp is not None:
            y = y * self._comp.gains(y) * self._makeup
        if self._ess is not None and self._ess_band is not None:
            band = self._ess_band.process(y)
            y = y - (1.0 - self._ess.gains(band)) * band
        y = y * self._gain
        limiter = self.spec["limiter"]
        y = soft_limit(y, limiter["threshold"], limiter["ceiling"])
        return np.nan_to_num(y, nan=0.0, posinf=0.0, neginf=0.0).astype(np.float32)


def soft_limit(x: np.ndarray, threshold: float, ceiling: float) -> np.ndarray:
    """Memoryless soft clip: untouched up to ``threshold``, then a tanh curve that never passes ``ceiling``."""
    mag = np.abs(x)
    room = max(ceiling - threshold, 1e-6)
    shaped = threshold + room * np.tanh((mag - threshold) / room)
    return np.sign(x) * np.where(mag > threshold, np.minimum(shaped, ceiling), mag)


# ---- fades and joins --------------------------------------------------------------------------------------------


def _ramp(count: int) -> np.ndarray:
    """A raised-cosine ramp from 0 to 1 over ``count`` samples (both ends exactly 0 and 1)."""
    if count <= 1:
        return np.ones(max(count, 0))
    return 0.5 - 0.5 * np.cos(np.pi * np.arange(count) / (count - 1))


def _fade_samples(sample_rate: Any, ms: Any) -> int:
    return int(round(_rate(sample_rate) * _number(ms, 8.0, 0.0, 500.0) / 1000.0))


def fade_in(x: Any, sample_rate: Any, ms: float = 8.0) -> np.ndarray:
    out = np.array(x, dtype=np.float32).reshape(-1)
    count = min(_fade_samples(sample_rate, ms), out.size)
    if count > 1:
        out[:count] *= _ramp(count).astype(np.float32)
    return out


def fade_out(x: Any, sample_rate: Any, ms: float = 8.0) -> np.ndarray:
    out = np.array(x, dtype=np.float32).reshape(-1)
    count = min(_fade_samples(sample_rate, ms), out.size)
    if count > 1:
        out[out.size - count :] *= _ramp(count)[::-1].astype(np.float32)
    return out


def fade_edges(x: Any, sample_rate: Any, ms: float = 8.0) -> np.ndarray:
    """Fade both ends of a clip so a join never clicks. A clip shorter than two fades gets two halves."""
    out = np.array(x, dtype=np.float32).reshape(-1)
    count = min(_fade_samples(sample_rate, ms), out.size // 2)
    if count > 1:
        ramp = _ramp(count).astype(np.float32)
        out[:count] *= ramp
        out[out.size - count :] *= ramp[::-1]
    return out


def crossfade(a: Any, b: Any, overlap: int) -> np.ndarray:
    """Join two clips with an equal-power overlap of ``overlap`` samples (cut to the shorter clip).

    The tail of ``a`` fades out with a cosine and the head of ``b`` fades in with a sine, so two uncorrelated clips
    keep their power across the join. The result is ``len(a) + len(b) - overlap`` samples long.
    """
    first = np.asarray(a, dtype=np.float32).reshape(-1)
    second = np.asarray(b, dtype=np.float32).reshape(-1)
    count = int(max(0, min(int(overlap), first.size, second.size)))
    if count == 0:
        return np.concatenate([first, second])
    phase = (np.arange(count) + 0.5) / count * (np.pi / 2.0)
    mixed = first[first.size - count :] * np.cos(phase).astype(np.float32) + second[:count] * np.sin(phase).astype(
        np.float32
    )
    return np.concatenate([first[: first.size - count], mixed.astype(np.float32), second[count:]])


def trim_silence(
    x: Any, sample_rate: Any, floor_db: float = -60.0, lead_ms: float = 15.0, tail_ms: float = 80.0
) -> np.ndarray:
    """Cut the quiet padding around a clip: everything before the first and after the last sample louder than
    ``floor_db`` (dBFS peak), except a guard of ``lead_ms`` before and ``tail_ms`` after. Quiet inside the clip stays.
    A clip with nothing louder than the floor gives an empty array."""
    sig = np.nan_to_num(np.asarray(x, dtype=np.float32).reshape(-1), nan=0.0, posinf=0.0, neginf=0.0)
    floor = 10.0 ** (_number(floor_db, -60.0, -120.0, 0.0) / 20.0)
    loud = np.flatnonzero(np.abs(sig) >= floor)
    if loud.size == 0:
        return np.zeros(0, dtype=np.float32)
    lead = int(round(_rate(sample_rate) * _number(lead_ms, 15.0, 0.0, 2000.0) / 1000.0))
    tail = int(round(_rate(sample_rate) * _number(tail_ms, 80.0, 0.0, 2000.0) / 1000.0))
    return sig[max(0, int(loud[0]) - lead) : min(sig.size, int(loud[-1]) + 1 + tail)].copy()


def spec_copy(name: str) -> dict[str, Any]:
    """A private copy of one of the starting chains (the clean chain for an unknown name)."""
    return copy.deepcopy(DEFAULT_SPECS.get(name, DEFAULT_SPECS["clean"]))
