"""FRIDAY Echo: a known-reference acoustic echo canceller for barge-in.

The far end is FRIDAY's own speech, so the exact signal that reaches the
speaker is known. ``EchoCanceller.process(mic, ref)`` takes one 16 kHz mono
int16 microphone frame and the frame FRIDAY is playing at the same moment, finds
how late the room returns that sound (cross-correlation on a short window), lines
the reference up and lets the SpeexDSP adaptive filter (``pyaec``, MIT, the
SpeexDSP code is BSD) subtract it. What is left is the owner's voice.

Rules this module keeps:

- Optional. A missing ``pyaec`` or ``numpy`` import, a failed filter, an
  unsupported frame or a reference that is silent returns the microphone frame
  unchanged. It never raises into the audio path.
- No timer and no thread of its own. The delay is re-estimated inside
  ``process`` every few hundred milliseconds of audio, while a reference plays.
- Both frames must run on one clock: one reference frame (silence when nothing
  plays) per microphone frame, ``None`` meaning silence of the same length.
- The filter is synchronous and cheap (about a millisecond per 10 ms of audio);
  a caller on the event loop runs it in a worker thread.

Not wired into live capture yet, and not measured on a real speaker or room.
"""

from __future__ import annotations

import threading
from typing import Any

SAMPLE_RATE = 16000
AEC_FRAME = 160  # 10 ms, the unit the SpeexDSP filter works in
FILTER_SAMPLES = 1600  # 100 ms of echo path the adaptive filter can model
MAX_DELAY_SAMPLES = 6400  # 400 ms: speaker, driver and room latency searched
WINDOW_SAMPLES = 8000  # 500 ms of microphone audio used to find the delay
MIN_WINDOW_SAMPLES = 3200  # the first estimate may use 200 ms
FIRST_ESTIMATE_EVERY = 1600  # samples between tries until a delay is known
ESTIMATE_EVERY = 8000  # samples between re-checks afterwards
MIN_CONFIDENCE = 0.2  # normalised correlation needed to trust a delay
DELAY_JITTER = 16  # a new delay within 1 ms of the old one is ignored
ALIGN_MARGIN = 16  # feed the reference this much earlier so the filter stays causal
SILENT_PEAK = 32  # a reference whose peak is under this carries no echo
MAX_ERRORS = 3  # consecutive failures before the canceller turns itself off
RING_SAMPLES = MAX_DELAY_SAMPLES + WINDOW_SAMPLES + AEC_FRAME * 4

ENGINE = "speexdsp-aec"
LICENSE = "MIT (pyaec); SpeexDSP code is BSD"


def _load() -> tuple[Any, Any, str]:
    """(numpy, pyaec.Aec, "") when both import, else (None, None, the reason)."""
    try:
        import numpy as np  # type: ignore
    except Exception:
        return None, None, "numpy is not installed"
    try:
        from pyaec import Aec  # type: ignore
    except BaseException:
        return None, None, "pyaec is not installed"
    return np, Aec, ""


def echo_status() -> dict:
    """The Doctor and health row: optional, never a gate."""
    np, _aec, reason = _load()
    ready = np is not None and not reason
    return {
        "ready": ready,
        "engine": ENGINE if ready else "none",
        "reason": "" if ready else f"optional - {reason}",
        "optional": True,
        "gate": False,
        "license": LICENSE,
        "bundled": False,
        "wired": False,
    }


class _Ring:
    """The last ``size`` samples of one stream, read by distance from the newest."""

    def __init__(self, np: Any, size: int) -> None:
        self._np = np
        self._data = np.zeros(size, dtype=np.int16)
        self._size = size
        self.total = 0

    def write(self, samples: Any) -> None:
        np = self._np
        n = len(samples)
        if n == 0:
            return
        if n >= self._size:
            first_kept = self.total + n - self._size
            self._data[np.arange(first_kept, first_kept + self._size) % self._size] = samples[-self._size :]
        else:
            start = self.total % self._size
            first = min(n, self._size - start)
            self._data[start : start + first] = samples[:first]
            if first < n:
                self._data[: n - first] = samples[first:]
        self.total += n

    def read(self, back: int, count: int) -> Any:
        """``count`` samples ending ``back`` samples before the newest one.

        Positions that were never written or are already overwritten are zero.
        """
        np = self._np
        out = np.zeros(count, dtype=np.int16)
        end = self.total - back
        begin = end - count
        low = max(begin, self.total - self._size, 0)
        if end <= low:
            return out
        idx = np.arange(low, end) % self._size
        out[low - begin : low - begin + (end - low)] = self._data[idx]
        return out


class EchoCanceller:
    """Subtract FRIDAY's own playback from the microphone, frame by frame."""

    def __init__(self, sample_rate: int = SAMPLE_RATE, preprocess: bool = False) -> None:
        self._lock = threading.Lock()
        self._np: Any = None
        self._aec: Any = None
        self._reason = ""
        self._errors = 0
        self._preprocess = bool(preprocess)
        self._delay: int | None = None
        self._confidence = 0.0
        self._since_estimate = 0
        self._frames = 0
        self._cancelled = 0
        self._ref: Any = None
        self._mic: Any = None
        if sample_rate != SAMPLE_RATE:
            self._reason = f"only {SAMPLE_RATE} Hz is supported"
            return
        np, aec_class, reason = _load()
        if reason:
            self._reason = reason
            return
        try:
            self._aec = aec_class(AEC_FRAME, FILTER_SAMPLES, SAMPLE_RATE, self._preprocess)
        except Exception as exc:
            self._reason = f"the echo filter did not start: {exc}"
            return
        self._np = np
        self._ref = _Ring(np, RING_SAMPLES)
        self._mic = _Ring(np, WINDOW_SAMPLES)

    @property
    def ready(self) -> bool:
        return self._aec is not None and not self._reason

    @property
    def delay_ms(self) -> float | None:
        return None if self._delay is None else self._delay * 1000.0 / SAMPLE_RATE

    def status(self) -> dict:
        return {
            "ready": self.ready,
            "engine": ENGINE if self.ready else "none",
            "reason": self._reason,
            "delayMs": self.delay_ms,
            "confidence": round(self._confidence, 3),
            "frames": self._frames,
            "cancelledFrames": self._cancelled,
        }

    def reset(self) -> None:
        """Forget the delay and both buffers (a new playback session or device)."""
        with self._lock:
            self._delay = None
            self._confidence = 0.0
            self._since_estimate = 0
            if self._np is not None:
                self._ref = _Ring(self._np, RING_SAMPLES)
                self._mic = _Ring(self._np, WINDOW_SAMPLES)
            if self._reason.startswith("turned off"):
                self._reason = ""
                self._errors = 0

    def process(self, mic: Any, ref: Any = None) -> Any:
        """The microphone frame with FRIDAY's own voice taken out.

        ``mic`` and ``ref`` are 16 kHz mono int16, as ``bytes`` (little endian)
        or a numpy int16 array, and the answer has the type and length of
        ``mic``. ``ref`` is what plays during this frame; ``None`` means nothing
        plays. Anything this cannot handle returns ``mic`` unchanged.
        """
        if not self.ready:
            return mic
        try:
            with self._lock:
                return self._process(mic, ref)
        except Exception as exc:
            self._errors += 1
            if self._errors >= MAX_ERRORS:
                self._reason = f"turned off after {self._errors} failures: {type(exc).__name__}"
            return mic

    def _as_pcm(self, frame: Any) -> Any:
        np = self._np
        if isinstance(frame, (bytes, bytearray, memoryview)):
            raw = bytes(frame)
            if len(raw) % 2:
                return None
            return np.frombuffer(raw, dtype="<i2").astype(np.int16)
        if isinstance(frame, np.ndarray) and frame.dtype == np.int16 and frame.ndim == 1:
            return frame
        return None

    def _process(self, mic: Any, ref: Any) -> Any:
        np = self._np
        mic_pcm = self._as_pcm(mic)
        if mic_pcm is None or len(mic_pcm) == 0:
            return mic
        n = len(mic_pcm)
        ref_pcm = None if ref is None else self._as_pcm(ref)
        if ref is not None and ref_pcm is None:
            ref_pcm = np.zeros(n, dtype=np.int16)  # an unusable reference counts as silence
        if ref_pcm is None:
            ref_pcm = np.zeros(n, dtype=np.int16)
        self._ref.write(ref_pcm)
        self._mic.write(mic_pcm)
        self._frames += 1
        self._since_estimate += n

        playing = int(np.max(np.abs(ref_pcm.astype(np.int32)))) >= SILENT_PEAK
        if playing:
            self._estimate_delay()
        if self._delay is None or not self._recent_reference():
            self._errors = 0
            return mic
        aligned = self._ref.read(max(0, self._delay - ALIGN_MARGIN), n)
        if int(np.max(np.abs(aligned.astype(np.int32)))) < SILENT_PEAK:
            self._errors = 0
            return mic
        cleaned = self._cancel(mic_pcm, aligned)
        self._errors = 0
        self._cancelled += 1
        if isinstance(mic, np.ndarray):
            return cleaned
        return cleaned.astype("<i2").tobytes()

    def _recent_reference(self) -> bool:
        """True while any reference in the echo-path window was audible."""
        np = self._np
        span = self._ref.read(0, min(self._ref.total, MAX_DELAY_SAMPLES + AEC_FRAME))
        return bool(len(span)) and int(np.max(np.abs(span.astype(np.int32)))) >= SILENT_PEAK

    def _cancel(self, mic_pcm: Any, aligned: Any) -> Any:
        np = self._np
        n = len(mic_pcm)
        out = np.empty(n, dtype=np.int16)
        for start in range(0, n, AEC_FRAME):
            rec = mic_pcm[start : start + AEC_FRAME]
            echo = aligned[start : start + AEC_FRAME]
            size = len(rec)
            if size < AEC_FRAME:  # a short tail is padded with silence, then cut back
                rec = np.concatenate([rec, np.zeros(AEC_FRAME - size, dtype=np.int16)])
                echo = np.concatenate([echo, np.zeros(AEC_FRAME - size, dtype=np.int16)])
            result = self._aec.cancel_echo(rec.tolist(), echo.tolist())
            out[start : start + size] = np.asarray(result[:size], dtype=np.int16)
        return out

    def _estimate_delay(self) -> None:
        """Find the speaker-to-microphone delay by normalised cross-correlation."""
        np = self._np
        every = ESTIMATE_EVERY if self._delay is not None else FIRST_ESTIMATE_EVERY
        window = min(self._mic.total, WINDOW_SAMPLES)
        if self._since_estimate < every or window < MIN_WINDOW_SAMPLES:
            return
        self._since_estimate = 0
        mic = self._mic.read(0, window).astype(np.float64)
        span = window + MAX_DELAY_SAMPLES
        ref = self._ref.read(0, span).astype(np.float64)
        mic_energy = float(np.dot(mic, mic))
        if mic_energy <= 0.0 or float(np.dot(ref, ref)) <= 0.0:
            return
        size = 1 << (span + window - 1).bit_length()
        corr = np.fft.irfft(np.fft.rfft(ref, size) * np.conj(np.fft.rfft(mic, size)), size)
        corr = corr[: MAX_DELAY_SAMPLES + 1]  # corr[k]: reference starting k into its span
        power = np.concatenate([[0.0], np.cumsum(ref * ref)])
        ref_energy = power[window : window + MAX_DELAY_SAMPLES + 1] - power[: MAX_DELAY_SAMPLES + 1]
        norm = np.sqrt(np.maximum(ref_energy, 1.0) * mic_energy)
        score = corr / norm
        peak = int(np.argmax(score))
        confidence = float(score[peak])
        if confidence < MIN_CONFIDENCE:
            return
        delay = MAX_DELAY_SAMPLES - peak
        self._confidence = confidence
        if self._delay is None or abs(delay - self._delay) > DELAY_JITTER:
            self._delay = delay
