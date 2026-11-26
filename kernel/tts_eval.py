"""Objective proxies for FRIDAY Voice, and the sweep that compares voice recipes on a fixed test set.

These numbers are not listening. They say whether a voice sits in the pitch band, has a lively melody, a warm spectrum,
a sane speaking rate, no clipping and a recogniser can still read it back; the owner's ears decide the rest.

Interface contract
------------------
* Pure measurements on a float32 mono clip: ``f0_track`` and ``f0_stats`` (autocorrelation pitch, 70-400 Hz, median and
  the 10th-90th percentile range in semitones), ``spectral_tilt`` (dB per octave, 100 Hz to 8 kHz), ``speaking_rate``
  (a syllable-pulse proxy, per second), ``clip_ratio``, ``silence_ratio``, ``rtf`` and ``profile`` (all at once).
* ``round_trip(clips, listen)`` scores what a recogniser hears back from synthesized clips (WER and CER through the
  same normalisers as ``stt_bench``: English with ``english=True``, Hindi as written, Hinglish folded across scripts).
  ``whisper_listener`` and ``hindi_ear_listener`` build recognisers from a model folder given on the command line;
  ``gate_stt`` picks the numbers the gate judges (the Hindi ear for Hindi when it ran).
* ``run_sweep`` renders the fixed test set (10 sentences each of Hindi, English, Hinglish in Roman letters and
  Hinglish in Devanagari) for each candidate recipe, applies its chain, and returns a plain-data report.
  ``rank_candidates`` applies the gates. ``main`` is the command line:
  ``python kernel/tts_eval.py sweep --model-dir D [--stt-dir D] [--hindi-ear-dir D] --out DIR``. The report is written
  outside the repository only (a folder inside it is refused, as in ``stt_bench``). Exit 0 done, 1 usage,
  2 refused, 3 no data (no voice model on disk).

Nothing here downloads, and nothing runs unless the command line is used.
"""

from __future__ import annotations

import contextlib
import json
import math
import os
import re
import sys
import time
import wave
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any

import friday_voice
import numpy as np
import stt_bench
import voice_fx

REPO_ROOT = Path(__file__).resolve().parents[1]
EXIT_OK, EXIT_USAGE, EXIT_REFUSED, EXIT_NO_DATA = 0, 1, 2, 3

KINDS = ("hi", "en", "hing-roman", "hing-deva")
LANG_OF = {"hi": "hi", "en": "en", "hing-roman": "na", "hing-deva": "hi"}
STT_RATE = 16000

# The gates a candidate must pass (targets from the voice research of 2026-11-26; provisional until heard).
GATES = {
    "f0_median_hz": (190.0, 235.0),
    "f0_range_st": 6.0,
    "stt_margin": 0.02,
    "clip_ratio": 0.001,
}
PITCH_TARGET_HZ = 212.0

_TEST_SET: dict[str, tuple[str, ...]] = {
    "hi": (
        "नमस्ते, मैं फ्राइडे हूँ। बताइए, मैं आपकी क्या मदद करूँ?",
        "आज मौसम बहुत सुहावना है, बाहर थोड़ी हवा चल रही है।",
        "आपकी बैठक कल सुबह दस बजे शुरू होगी।",
        "क्या आप चाहते हैं कि मैं यह संदेश अभी भेज दूँ?",
        "ठीक है, मैंने आपके लिए अलार्म सात बजकर तीस मिनट पर लगा दिया है।",
        "आज आपके खाते में पाँच हज़ार दो सौ रुपये जमा हुए हैं।",
        "माफ़ कीजिए, मुझे यह बात ठीक से समझ नहीं आई, क्या आप दोबारा बता सकते हैं?",
        "आपका जन्मदिन पंद्रह मार्च को आता है, मैं उस दिन आपको याद दिला दूँगी।",
        "बहुत अच्छा, काम पूरा हो गया है।",
        "शाम को चार बजे डॉक्टर से मिलने का समय तय है, इसलिए समय पर निकल जाइएगा।",
    ),
    "en": (
        "Hello, I am Friday. Tell me, how can I help you today?",
        "Your meeting with the design team starts tomorrow at ten thirty in the morning.",
        "Sure, I have set an alarm for seven fifteen.",
        "Would you like me to send that message now, or wait until you are ready?",
        "The weather is lovely today, with a light breeze and a high of twenty six degrees.",
        "Sorry, I did not quite catch that. Could you say it once more?",
        "You have three new emails, and one of them looks important.",
        "Your flight lands on the fourteenth of March at six forty in the evening.",
        "All done, everything is saved.",
        "Take a short break, drink some water, and I will remind you again in an hour.",
    ),
    "hing-roman": (
        "Haan boss, aapka meeting kal subah ten baje hai, main reminder laga deti hoon.",
        "Aaj ka mausam bahut accha hai, bahar halki hawa chal rahi hai.",
        "Kya aap chahte hain ki main yeh message abhi bhej doon?",
        "Theek hai, maine alarm saat baje ke liye set kar diya hai.",
        "Aapke account mein paanch hazaar rupaye credit hue hain.",
        "Sorry, mujhe yeh samajh nahi aaya, kya aap ek baar phir bata sakte hain?",
        "Aapka flight chaudah March ko shaam chhe baje land karega.",
        "Bahut badiya, kaam ho gaya hai aur sab kuch save hai.",
        "Aapko teen naye email aaye hain, ek unmein kaafi zaroori lag raha hai.",
        "Thoda break le lijiye, paani peeje, main ek ghante baad phir yaad dila doongi.",
    ),
    "hing-deva": (
        "हाँ बॉस, आपकी मीटिंग कल सुबह दस बजे है, मैं रिमाइंडर लगा देती हूँ।",
        "आज का वेदर बहुत अच्छा है, बाहर हल्की हवा चल रही है।",
        "क्या आप चाहते हैं कि मैं यह मैसेज अभी सेंड कर दूँ?",
        "ठीक है, मैंने अलार्म सात बजे के लिए सेट कर दिया है।",
        "आपके अकाउंट में पाँच हज़ार रुपये क्रेडिट हुए हैं।",
        "सॉरी, मुझे यह समझ नहीं आया, क्या आप एक बार फिर बता सकते हैं?",
        "आपकी फ्लाइट चौदह मार्च को शाम छह बजे लैंड करेगी।",
        "बहुत बढ़िया, काम हो गया है और सब कुछ सेव है।",
        "आपको तीन नए ईमेल आए हैं, एक उनमें काफ़ी ज़रूरी लग रहा है।",
        "थोड़ा ब्रेक ले लीजिए, पानी पीजिए, मैं एक घंटे बाद फिर याद दिला दूँगी।",
    ),
}


def test_set() -> dict[str, list[str]]:
    """The fixed sentences: 10 each of Hindi, English, Roman Hinglish and Devanagari Hinglish (copies)."""
    return {kind: list(rows) for kind, rows in _TEST_SET.items()}


# ---- measurements -----------------------------------------------------------------------------------------------


def _mono(x: Any) -> np.ndarray:
    return np.nan_to_num(np.asarray(x, dtype=np.float64).reshape(-1), nan=0.0, posinf=0.0, neginf=0.0)


def _frames(x: np.ndarray, size: int, hop: int) -> np.ndarray:
    if size <= 0 or hop <= 0 or x.size < size:
        return np.zeros((0, max(size, 0)))
    return np.lib.stride_tricks.sliding_window_view(x, size)[::hop]


def _frame_db(x: np.ndarray, sample_rate: int, win_ms: float, hop_ms: float) -> np.ndarray:
    size = max(1, int(sample_rate * win_ms / 1000))
    hop = max(1, int(sample_rate * hop_ms / 1000))
    frames = _frames(x, size, hop)
    if not frames.shape[0]:
        return np.zeros(0)
    return 10.0 * np.log10(np.mean(frames * frames, axis=1) + 1e-10)


def semitones(a_hz: float, b_hz: float) -> float:
    """``a`` above ``b`` in semitones (0 when either is not a pitch)."""
    if a_hz <= 0 or b_hz <= 0:
        return 0.0
    return 12.0 * math.log2(a_hz / b_hz)


def f0_track(
    x: Any, sample_rate: int, fmin: float = 70.0, fmax: float = 400.0, frame_ms: float = 40.0, hop_ms: float = 10.0
) -> np.ndarray:
    """One pitch estimate per hop in Hz, ``nan`` where the frame is silent or unvoiced (autocorrelation, with the
    shortest strong peak preferred so an octave jump up is not mistaken for the pitch)."""
    sig = _mono(x)
    step = max(1, int(sample_rate) // 16000)
    if step > 1:
        usable = (sig.size // step) * step
        sig = sig[:usable].reshape(-1, step).mean(axis=1)
    rate = sample_rate / step
    size, hop = int(rate * frame_ms / 1000), max(1, int(rate * hop_ms / 1000))
    frames = _frames(sig, size, hop)
    if not frames.shape[0]:
        return np.zeros(0)
    frames = frames - frames.mean(axis=1, keepdims=True)
    energy = 10.0 * np.log10(np.mean(frames * frames, axis=1) + 1e-12)
    active = (energy > energy.max() - 40.0) & (energy > -65.0)
    window = np.hanning(size)
    nfft = 1 << (2 * size - 1).bit_length()
    auto = np.fft.irfft(np.abs(np.fft.rfft(frames * window, nfft)) ** 2, nfft)
    shape = np.fft.irfft(np.abs(np.fft.rfft(window, nfft)) ** 2, nfft)
    lo, hi = max(2, int(rate / fmax)), min(size - 2, int(math.ceil(rate / fmin)))
    if hi <= lo + 2:
        return np.full(frames.shape[0], np.nan)
    norm = auto[:, : hi + 2] / (auto[:, :1] + 1e-12) / (shape[None, : hi + 2] / shape[0] + 1e-12)
    inner = norm[:, lo - 1 : hi + 2]
    centre = inner[:, 1:-1]
    peak = (centre >= inner[:, :-2]) & (centre > inner[:, 2:])
    cand = np.where(peak, centre, -np.inf)
    best = cand.max(axis=1)
    near_best = cand >= (0.9 * best)[:, None]
    pick = np.argmax(near_best, axis=1) + lo
    out = np.full(frames.shape[0], np.nan)
    voiced = active & np.isfinite(best) & (best >= 0.35)
    for i in np.flatnonzero(voiced):
        lag = int(pick[i])
        left, mid, right = norm[i, lag - 1], norm[i, lag], norm[i, lag + 1]
        denom = left - 2 * mid + right
        shift = 0.5 * (left - right) / denom if abs(denom) > 1e-12 else 0.0
        out[i] = rate / (lag + float(np.clip(shift, -1, 1)))
    return out


def f0_stats(track: np.ndarray) -> dict[str, float]:
    """Median, 10th and 90th percentile (Hz), their spread in semitones, and the voiced share of the frames."""
    track = np.asarray(track, dtype=np.float64)
    voiced = track[np.isfinite(track)]
    if voiced.size == 0:
        return {"median_hz": 0.0, "p10_hz": 0.0, "p90_hz": 0.0, "range_st": 0.0, "voiced_ratio": 0.0}
    p10, med, p90 = (float(v) for v in np.percentile(voiced, [10, 50, 90]))
    return {
        "median_hz": med,
        "p10_hz": p10,
        "p90_hz": p90,
        "range_st": semitones(p90, p10),
        "voiced_ratio": float(voiced.size) / float(track.size),
    }


def spectral_tilt(x: Any, sample_rate: int, lo: float = 100.0, hi: float = 8000.0) -> float:
    """Slope in dB per octave of the long-term average spectrum of the active frames between ``lo`` and ``hi`` Hz.

    The spectrum is smoothed over one-octave windows spaced a third of an octave apart, so a few harmonics more or
    less in a window do not move it. White noise is 0; a 1/k harmonic stack is about -6.
    """
    sig = _mono(x)
    size = 2048
    if sig.size < size:
        return 0.0
    frames = _frames(sig, size, size // 2)
    power = np.mean(frames * frames, axis=1)
    keep = power > power.max() * 10 ** (-3.5)
    if power.max() <= 1e-12 or not keep.any():
        return 0.0
    spec = np.abs(np.fft.rfft(frames[keep] * np.hanning(size), axis=1)) ** 2
    mean_power = spec.mean(axis=0)
    freqs = np.fft.rfftfreq(size, 1.0 / sample_rate)
    top = min(float(hi), 0.45 * sample_rate)
    centres = float(lo) * math.sqrt(2) * 2 ** (np.arange(0, 64) / 3.0)
    centres = centres[centres * math.sqrt(2) <= top]
    if centres.size < 3:
        return 0.0
    csum = np.concatenate([[0.0], np.cumsum(mean_power)])
    a = np.searchsorted(freqs, centres / math.sqrt(2), side="left")
    b = np.searchsorted(freqs, centres * math.sqrt(2), side="right")
    mean_in = (csum[b] - csum[a]) / np.maximum(b - a, 1)
    db = 10.0 * np.log10(mean_in + 1e-20)
    return float(np.polyfit(np.log2(centres), db, 1)[0])


def speaking_rate(x: Any, sample_rate: int) -> float:
    """Syllable pulses per second of speech: peaks of the smoothed loudness curve, over the time spent speaking.

    Leading and trailing silence and pauses longer than a quarter second do not count as speaking time. This is a
    proxy (a vowel nucleus is a loudness bump), good for comparing voices, not for counting real syllables.
    """
    hop_ms = 10.0
    level = _frame_db(_mono(x), sample_rate, 25.0, hop_ms)
    if level.size < 8 or float(level.max()) < -70.0:
        return 0.0
    active = level > level.max() - 30.0
    smooth = np.convolve(level, np.ones(5) / 5.0, mode="same")
    peaks: list[int] = []
    for i in range(1, level.size - 1):
        if not active[i] or not (smooth[i] >= smooth[i - 1] and smooth[i] > smooth[i + 1]):
            continue
        if peaks:
            last = peaks[-1]
            shallow = float(smooth[last : i + 1].min()) > min(smooth[last], smooth[i]) - 3.0
            if (i - last) * hop_ms < 100.0 or shallow:
                if smooth[i] > smooth[last]:
                    peaks[-1] = i
                continue
        peaks.append(i)
    idx = np.flatnonzero(active)
    if idx.size == 0:
        return 0.0
    first, last_i = int(idx[0]), int(idx[-1])
    paused = 0
    run = 0
    for flag in active[first : last_i + 1]:
        if flag:
            paused += run if run * hop_ms > 250.0 else 0
            run = 0
        else:
            run += 1
    seconds = ((last_i - first + 1) - paused) * hop_ms / 1000.0
    return len(peaks) / seconds if seconds > 0 else 0.0


def clip_ratio(x: Any, level: float = 0.99) -> float:
    sig = np.abs(_mono(x))
    return float(np.mean(sig >= level)) if sig.size else 0.0


def silence_ratio(x: Any, sample_rate: int, floor_db: float = -50.0) -> float:
    """The share of 10 ms frames quieter than ``floor_db`` (dBFS); an empty clip is all silence."""
    level = _frame_db(_mono(x), sample_rate, 10.0, 10.0)
    return float(np.mean(level < floor_db)) if level.size else 1.0


def leading_silence_ms(x: Any, sample_rate: int, floor_db: float = -50.0) -> float:
    level = _frame_db(_mono(x), sample_rate, 10.0, 10.0)
    loud = np.flatnonzero(level >= floor_db)
    return float(loud[0]) * 10.0 if loud.size else float(level.size) * 10.0


def rtf(compute_seconds: float, audio_seconds: float) -> float:
    """Real-time factor: compute time over audio time (0 for no audio)."""
    return float(compute_seconds) / float(audio_seconds) if audio_seconds > 0 else 0.0


def profile(x: Any, sample_rate: int) -> dict[str, float]:
    """Every measurement of one clip as plain numbers."""
    sig = _mono(x)
    row = f0_stats(f0_track(sig, sample_rate))
    row.update(
        {
            "seconds": sig.size / float(sample_rate),
            "tilt_db_oct": spectral_tilt(sig, sample_rate),
            "rate_syl_s": speaking_rate(sig, sample_rate),
            "clip_ratio": clip_ratio(sig),
            "silence_ratio": silence_ratio(sig, sample_rate),
            "leading_silence_ms": leading_silence_ms(sig, sample_rate),
        }
    )
    return {k: float(v) for k, v in row.items()}


def mean_profile(rows: Sequence[Mapping[str, float]]) -> dict[str, float]:
    if not rows:
        return {}
    keys = rows[0].keys()
    return {k: float(np.mean([r[k] for r in rows])) for k in keys}


def resample(x: Any, rate_in: int, rate_out: int) -> np.ndarray:
    """Band-limited resampling by the Fourier method (float32 in, float32 out)."""
    sig = np.asarray(x, dtype=np.float32).reshape(-1)
    if rate_in == rate_out or sig.size == 0:
        return sig.copy()
    count = max(1, int(round(sig.size * rate_out / rate_in)))
    spec = np.fft.rfft(sig.astype(np.float64))
    fitted = np.zeros(count // 2 + 1, dtype=np.complex128)
    keep = min(spec.size, fitted.size)
    fitted[:keep] = spec[:keep]
    return (np.fft.irfft(fitted, count) * (count / sig.size)).astype(np.float32)


_CLAUSE_END = re.compile(r"[,.;:!?।](?=\s|$)")


def first_clause(text: str) -> str:
    """The text up to and including the first clause mark: what a streaming voice speaks first."""
    body = str(text or "").strip()
    found = _CLAUSE_END.search(body)
    return body[: found.end()] if found else body


_first_clause_text = first_clause

# ---- round trip -------------------------------------------------------------------------------------------------


def error_rates(kind: str, reference: str, heard: str) -> tuple[float, float]:
    """(WER, CER) of what was heard against what was spoken, with the normaliser that fits the kind."""
    if kind == "en":
        return stt_bench.wer(reference, heard, english=True), stt_bench.cer(reference, heard, english=True)
    if kind == "hi":
        return stt_bench.wer(reference, heard), stt_bench.cer(reference, heard)
    return stt_bench.folded_wer(reference, heard), stt_bench.folded_cer(reference, heard)


Listener = Callable[[np.ndarray, str, str], str]


def _pool(rows: list[tuple[float, float, bool]]) -> dict[str, float]:
    return {
        "wer": float(np.mean([r[0] for r in rows])),
        "cer": float(np.mean([r[1] for r in rows])),
        "n": len(rows),
        "failed": sum(1 for r in rows if r[2]),
    }


def round_trip(clips: Sequence[Mapping[str, Any]], listen: Listener) -> dict[str, dict[str, float]]:
    """Mean WER and CER per kind and over all clips. ``listen(audio16k, kind, text)`` returns what it heard; the
    text is only for stand-ins in tests. A recogniser that raises counts the clip as fully wrong and as ``failed``."""
    per: dict[str, list[tuple[float, float, bool]]] = {}
    for clip in clips:
        kind, text = str(clip["kind"]), str(clip["text"])
        try:
            wer, cer = error_rates(kind, text, listen(clip["audio"], kind, text))
            miss = False
        except Exception:  # noqa: BLE001 - one clip a recogniser cannot read is a miss, never a crash of the sweep
            wer, cer, miss = 1.0, 1.0, True
        per.setdefault(kind, []).append((wer, cer, miss))
    out = {kind: _pool(rows) for kind, rows in per.items()}
    everything = [row for rows in per.values() for row in rows]
    if everything:
        out["all"] = _pool(everything)
    return out


def whisper_listener(folder: str | os.PathLike[str]) -> Listener:
    """A faster-whisper recogniser from a model folder (CPU, int8, greedy). Raises when the package is missing."""
    from faster_whisper import WhisperModel  # type: ignore[import-untyped]

    model = WhisperModel(str(folder), device="cpu", compute_type="int8", local_files_only=True)

    def listen(audio: np.ndarray, kind: str, _text: str) -> str:
        segments, _info = model.transcribe(
            np.asarray(audio, dtype=np.float32),
            language="en" if kind == "en" else "hi",
            beam_size=1,
            vad_filter=False,
            condition_on_previous_text=False,
            without_timestamps=True,
        )
        return " ".join(seg.text.strip() for seg in segments).strip()

    return listen


def hindi_ear_listener(folder: str | os.PathLike[str]) -> Listener:
    """The Hindi ear from a model folder, through FRIDAY's own reader (no faster-whisper in between)."""
    import hindi_ear

    model = hindi_ear._load(Path(folder))

    def listen(audio: np.ndarray, _kind: str, _text: str) -> str:
        text, _confidence = hindi_ear._read(model, np.asarray(audio, dtype=np.float32))
        return text

    return listen


# ---- ranking ----------------------------------------------------------------------------------------------------


GATE_KINDS = ("en", "hi", "hing-deva")


def gate_stt(row: Mapping[str, Any]) -> dict[str, Any] | None:
    """The round-trip numbers the STT gate judges: English from the first recogniser, Hindi and Devanagari Hinglish
    from the Hindi ear when it ran (a small Whisper writes Hindi poorly, so its error would measure the recogniser),
    pooled by clip count. Roman Hinglish is left out: a recogniser that answers in Devanagari is marked down for
    spelling, not for the voice. None when no recogniser ran."""
    first = row.get("stt") or {}
    others = [v for _name, v in sorted((row.get("stt_alt") or {}).items())]
    parts: list[Mapping[str, float]] = []
    used: list[str] = []
    for kind in GATE_KINDS:
        found = next((src[kind] for src in [*others, first] if kind in src), None)
        if found is not None and found.get("n"):
            parts.append(found)
            used.append(kind)
    if not parts:
        return None
    total = sum(p["n"] for p in parts)
    return {
        "wer": sum(p["wer"] * p["n"] for p in parts) / total,
        "cer": sum(p["cer"] * p["n"] for p in parts) / total,
        "n": total,
        "kinds": used,
    }


def _stt_failed(row: Mapping[str, Any], base: Mapping[str, Any] | None) -> bool:
    if base is None:
        return False
    mine, theirs = gate_stt(row), gate_stt(base)
    if mine is None or theirs is None:
        # No per-kind numbers: fall back to the pooled round trip when both rows have one.
        mine = (row.get("stt") or {}).get("all")
        theirs = (base.get("stt") or {}).get("all")
    if not mine or not theirs:
        return False
    margin = GATES["stt_margin"]
    return mine["wer"] > theirs["wer"] + margin or mine["cer"] > theirs["cer"] + margin


def _score(row: Mapping[str, Any], base: Mapping[str, Any] | None) -> float:
    prof = row["profile"]
    lively = min(prof["range_st"], 9.0) / 3.0
    pitch = -abs(prof["median_hz"] - PITCH_TARGET_HZ) / 20.0
    warm = 0.0
    if base is not None:
        warm = min(max(prof["tilt_db_oct"] - base["profile"]["tilt_db_oct"], 0.0), 3.0) / 3.0
    return lively + pitch + warm


def rank_candidates(rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Apply the gates to every row that names a plain base (``base_of``) and pick the best passing one.

    Gates: pitch median in 190-235 Hz, spread of at least 6 semitones, a spectral tilt gentler than the plain base's,
    recogniser WER and CER no more than 2 points above the plain base's, and no clipping. A gate that cannot be
    checked (no recogniser, no base row) is not applied. ``best`` is None when nothing passes.
    """
    by_id = {r["id"]: r for r in rows}
    passed: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    for row in rows:
        if not row.get("base_of"):
            continue
        base = by_id.get(row["base_of"])
        prof = row["profile"]
        failed = []
        if not GATES["f0_median_hz"][0] <= prof["median_hz"] <= GATES["f0_median_hz"][1]:
            failed.append("f0_median")
        if prof["range_st"] < GATES["f0_range_st"]:
            failed.append("f0_range")
        if base is not None and not prof["tilt_db_oct"] > base["profile"]["tilt_db_oct"]:
            failed.append("tilt")
        if _stt_failed(row, base):
            failed.append("stt")
        if prof["clip_ratio"] > GATES["clip_ratio"]:
            failed.append("clipping")
        entry = {"id": row["id"], "failed": failed, "score": _score(row, base), "stt_gate": gate_stt(row)}
        (rejected if failed else passed).append(entry)
    passed.sort(key=lambda e: -e["score"])
    rejected.sort(key=lambda e: (len(e["failed"]), -e["score"]))
    return {"best": passed[0]["id"] if passed else None, "passed": passed, "rejected": rejected, "gates": GATES}


# ---- candidates and the sweep ---------------------------------------------------------------------------------------

# Nine blends of the F voices that sound closest to a sweet, warm young woman, plus the plain voices to compare with.
_BLENDS = {
    "blend-a": {"F2": 0.6, "F1": 0.2, "F4": 0.2},
    "blend-b": {"F1": 0.6, "F2": 0.2, "F4": 0.2},
    "blend-c": {"F4": 0.6, "F2": 0.2, "F1": 0.2},
    "blend-d": {"F2": 0.5, "F4": 0.3, "F1": 0.2},
    "blend-e": {"F2": 0.4, "F1": 0.4, "F4": 0.2},
    "blend-f": {"F2": 0.4, "F4": 0.4, "F1": 0.2},
    "blend-g": {"F1": 0.4, "F4": 0.4, "F2": 0.2},
    "blend-h": {"F1": 1 / 3, "F2": 1 / 3, "F4": 1 / 3},
    "blend-i": {"F2": 0.8, "F1": 0.1, "F4": 0.1},
}


def default_candidates() -> list[dict[str, Any]]:
    """The plain voices F1, F2 and F4 first, then the nine blends, all with the clean chain."""
    plain = [{"id": f"plain-{p}", "base": {p: 1.0}, "fx": "clean"} for p in ("F1", "F2", "F4")]
    return plain + [{"id": cid, "base": dict(w), "fx": "clean"} for cid, w in _BLENDS.items()]


def _dominant(base: Mapping[str, float]) -> str:
    return max(base, key=lambda k: base[k])


def _is_plain(cand: Mapping[str, Any]) -> bool:
    return (
        len(cand["base"]) == 1 and cand.get("fx") in (None, "clean", {}) and float(cand.get("speed_scale", 1.0)) == 1.0
    )


def _fx_spec(fx: Any) -> dict[str, Any]:
    return voice_fx.spec_copy(fx) if isinstance(fx, str) else voice_fx.normalise_spec(fx)


def _write_wav(path: Path, audio: np.ndarray, rate: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(int(rate))
        handle.writeframes(pcm.tobytes())


def run_sweep(
    voice: Any,
    candidates: Sequence[Mapping[str, Any]],
    *,
    per_kind: int = 10,
    listen: Listener | None = None,
    listen_alt: Mapping[str, tuple[Listener, Sequence[str]]] | None = None,
    stt_per_kind: int | None = None,
    steps: int = 5,
    seed: int = 0,
    audio_dir: Path | None = None,
    first_clause: bool = True,
    trim: bool = True,
    clock: Callable[[], float] = time.perf_counter,
) -> dict[str, Any]:
    """Render the test set for each candidate (``id``, ``base`` weights, ``fx``, optional ``steps``, ``speed_scale``),
    trim the padding the graphs leave around a clause, apply its chain, measure it, and read it back (``trim=False``
    keeps the padding). Clips that differ only in the chain share one raw render."""
    sets = test_set()
    per_kind = max(1, min(int(per_kind), 10))
    rate = int(voice.sample_rate)
    raw: dict[tuple[Any, ...], tuple[np.ndarray, float]] = {}
    styles: dict[tuple[tuple[str, float], ...], friday_voice.Style] = {}
    plain_of = {_dominant(c["base"]): c["id"] for c in candidates if _is_plain(c)}
    with contextlib.suppress(Exception):  # a warm-up that fails only makes the first timing slower
        voice.warm_up()
    report_rows: list[dict[str, Any]] = []
    for cand in candidates:
        base = {k: float(v) for k, v in cand["base"].items()}
        key = tuple(sorted(base.items()))
        if key not in styles:
            styles[key] = friday_voice.blend_styles([voice.style(k) for k in base], list(base.values()))
        style = styles[key]
        cand_steps = int(cand.get("steps", steps))
        speed = float(cand.get("speed_scale", 1.0))
        spec = _fx_spec(cand.get("fx"))
        compute = 0.0
        seconds = 0.0
        raw_seconds = 0.0
        clips: list[dict[str, Any]] = []
        profiles: dict[str, list[dict[str, float]]] = {kind: [] for kind in KINDS}
        for kind in KINDS:
            for number, text in enumerate(sets[kind][:per_kind], 1):
                rkey = (key, cand_steps, speed, seed, text)
                if rkey not in raw:
                    began = clock()
                    audio = voice.synth(text, LANG_OF[kind], style, steps=cand_steps, speed=speed, seed=seed)
                    raw[rkey] = (np.asarray(audio, dtype=np.float32), clock() - began)
                dry, took = raw[rkey]
                began = clock()
                lean = voice_fx.trim_silence(dry, rate) if trim else dry
                wet = voice_fx.fade_edges(voice_fx.FxChain(rate, spec).process(lean), rate)
                compute += took + (clock() - began)
                seconds += wet.size / rate
                raw_seconds += dry.size / rate
                profiles[kind].append(profile(wet, rate))
                clips.append({"kind": kind, "text": text, "audio": wet, "n": number})
                if audio_dir is not None:
                    _write_wav(Path(audio_dir) / str(cand["id"]) / f"{kind}-{number:02d}.wav", wet, rate)
        row: dict[str, Any] = {
            "id": cand["id"],
            "base": base,
            "fx": cand.get("fx"),
            "steps": cand_steps,
            "speed_scale": speed,
            "base_of": None if _is_plain(cand) else plain_of.get(_dominant(base)),
            "clips": len(clips),
            "seconds": seconds,
            "raw_seconds": raw_seconds,
            "rtf": rtf(compute, raw_seconds),
            "profile": mean_profile([p for kind in KINDS for p in profiles[kind]]),
            "by_kind": {kind: mean_profile(profiles[kind]) for kind in KINDS},
            "stt": None,
        }
        if first_clause:
            times: list[float] = []
            for kind in KINDS:
                for text in sets[kind][: min(3, per_kind)]:
                    began = clock()
                    part = voice.synth(
                        _first_clause_text(text), LANG_OF[kind], style, steps=cand_steps, speed=speed, seed=seed
                    )
                    voice_fx.fade_edges(voice_fx.FxChain(rate, spec).process(part), rate)
                    times.append((clock() - began) * 1000.0)
            row["first_clause_ms"] = float(np.median(times)) if times else 0.0
        else:
            row["first_clause_ms"] = 0.0
        if listen is not None or listen_alt:
            keep = stt_per_kind if stt_per_kind is not None else per_kind
            heard = [{**c, "audio": resample(c["audio"], rate, STT_RATE)} for c in clips if c["n"] <= max(1, keep)]
            if listen is not None:
                row["stt"] = round_trip(heard, listen)
            if listen_alt:
                row["stt_alt"] = {
                    name: round_trip([c for c in heard if c["kind"] in kinds], fn)
                    for name, (fn, kinds) in listen_alt.items()
                }
            row["stt_gate"] = gate_stt(row)
        report_rows.append(row)
    return {
        "schema": 1,
        "per_kind": per_kind,
        "seed": seed,
        "sample_rate": rate,
        "candidates": report_rows,
    }


# ---- the command line -------------------------------------------------------------------------------------------


def _open_engine(folder: Path) -> Any:
    return friday_voice.open_voice(folder)


def main(argv: list[str] | None = None, *, out: Callable[[str], None] = print) -> int:
    """``sweep --model-dir D [--stt-dir D] [--hindi-ear-dir D] --out DIR [--per-kind N] [--stt-per-kind N] [--steps N]
    [--seed N] [--only IDS] [--fx NAMES] [--recipes IDS] [--save-audio]``."""
    import argparse

    ap = argparse.ArgumentParser(prog="tts_eval.py")
    ap.add_argument("command", choices=["sweep"])
    ap.add_argument("--model-dir", required=True)
    ap.add_argument("--stt-dir")
    ap.add_argument("--hindi-ear-dir")
    ap.add_argument("--out", required=True)
    ap.add_argument("--per-kind", type=int, default=10)
    ap.add_argument("--stt-per-kind", type=int)
    ap.add_argument("--steps", type=int, default=5)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--only", help="comma separated candidate ids")
    ap.add_argument("--fx", help="comma separated chain names to cross with every blend (default: the clean chain)")
    ap.add_argument("--recipes", help="comma separated recipe ids to measure instead of the default candidates")
    ap.add_argument("--save-audio", action="store_true", help="also write the clips as .wav files next to the report")
    try:
        args = ap.parse_args(argv)
    except SystemExit:
        return EXIT_USAGE
    dest = Path(args.out)
    if stt_bench.is_inside_repo(dest):
        out("REFUSED: a sweep report is written outside the repository")
        return EXIT_REFUSED
    voice = _open_engine(Path(args.model_dir))
    if voice is None:
        out(f"NO DATA: no voice model in {args.model_dir}; nothing was measured")
        return EXIT_NO_DATA
    candidates = _pick_candidates(args)
    if candidates is None:
        out("REFUSED: no candidate matches --only or --recipes")
        return EXIT_USAGE
    listen = alt = None
    try:
        if args.stt_dir:
            listen = whisper_listener(args.stt_dir)
        if args.hindi_ear_dir:
            alt = {"hindi-ear": (hindi_ear_listener(args.hindi_ear_dir), ("hi", "hing-deva"))}
    except Exception as exc:  # noqa: BLE001 - a recogniser that cannot open is named, and the sweep still measures the voice
        out(f"NOTE: a recogniser did not open ({exc}); the round trip is skipped")
        listen = alt = None
    report = run_sweep(
        voice,
        candidates,
        per_kind=args.per_kind,
        listen=listen,
        listen_alt=alt,
        stt_per_kind=args.stt_per_kind,
        steps=args.steps,
        seed=args.seed,
        audio_dir=dest / "audio" if args.save_audio else None,
    )
    report["ranking"] = rank_candidates(report["candidates"])
    dest.mkdir(parents=True, exist_ok=True)
    target = dest / "tts-sweep.json"
    target.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    for row in report["candidates"]:
        prof = row["profile"]
        heard = (row.get("stt") or {}).get("all")
        said = f", WER {heard['wer']:.3f} CER {heard['cer']:.3f}" if heard else ""
        out(
            f"{row['id']}: f0 {prof['median_hz']:.0f} Hz, spread {prof['range_st']:.1f} st, "
            f"tilt {prof['tilt_db_oct']:.1f} dB/oct, rate {prof['rate_syl_s']:.1f}/s, RTF {row['rtf']:.2f}, "
            f"first clause {row['first_clause_ms']:.0f} ms{said}"
        )
    out(f"best passing candidate: {report['ranking']['best']}")
    out(f"report written: {target}")
    return EXIT_OK


def _pick_candidates(args: Any) -> list[dict[str, Any]] | None:
    cands = default_candidates()
    if args.recipes:
        import voice_persona

        wanted = [s.strip() for s in args.recipes.split(",") if s.strip()]
        cands = [c for c in (voice_persona.candidate(i) for i in wanted) if c]
        cands = default_candidates()[:3] + cands
    if args.only:
        wanted_ids = {s.strip() for s in args.only.split(",") if s.strip()}
        cands = [c for c in cands if c["id"] in wanted_ids]
    if args.fx:
        plain = [c for c in cands if _is_plain(c)]
        crossed = []
        for c in cands:
            if _is_plain(c) and not args.recipes:
                continue
            for name in (s.strip() for s in args.fx.split(",") if s.strip()):
                crossed.append({**c, "id": f"{c['id']}+{name}", "fx": name})
        cands = plain + crossed
    return cands or None


if __name__ == "__main__":
    sys.exit(main())
