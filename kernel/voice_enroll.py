"""FRIDAY · the owner's own voice: a voiceprint and a personal "Friday" template, from the owner's recordings.

What it does, in plain words:
  * A voiceprint says whether a sentence sounds like the owner's voice (timbre and pitch of the owner's own
    recordings). It is a convenience signal. It never approves an action, and it is not a security lock.
  * A personal wake template says whether a short clip sounds like the owner saying "Friday". It is matched
    against the owner's own takes (dynamic time warping), so an accent the transcriber mishears still wakes her.

What it is not: a trained neural speaker model. numpy only, no download, no torch. It was calibrated on the
owner's recordings alone, so how well it rejects other people is measured only when the owner runs the guest test.
`engine` and `evidence` say so in every answer.

The profile is built from WAV/WebM/OGG files the desktop saved (see electron/voice-enroll.cjs). The desktop keeps
the profile encrypted with the Windows safe store and hands it to the worker with `load_profile`; this module never
writes the profile itself.
"""

from __future__ import annotations

import math

import numpy as np
from wake_features import FRAME, HOP, N_FFT, RATE, mel_filterbank, to_float

ENGINE = "dsp-mfcc-v1"
EVIDENCE = "calibrated on the owner's recordings only; other speakers were not measured"

N_MFCC = 20
SPEAKER_CEPS = 19  # c1..c19 (c0 is loudness)
WAKE_CEPS = 13  # c1..c13 for the word template
MIN_VOICED_S = 0.35
MAX_CLIP_S = 15.0

MIN_WAKE_TAKES = 5
GOOD_WAKE_TAKES = 8
MIN_SPEECH_CLIPS = 6
MIN_SPEECH_SECONDS = 20.0

TARGET_WAKE_LOO_FRR = 0.15  # held-out takes the template would have refused
WAKE_BAND = 0.35  # Sakoe-Chiba band as a fraction of the longer sequence
WAKE_SCALES = (0.8, 1.0, 1.25)
WAKE_HOP_S = 0.05
WAKE_BEST_K = 3

SPEAKER_MATCH_AT = 0.75  # similarity at the calibrated edge, the value the app's speaker gate already uses


# --------------------------------------------------------------------------- features
def _frames(x: np.ndarray) -> np.ndarray:
    if len(x) < FRAME:
        x = np.pad(x, (0, FRAME - len(x)))
    count = 1 + (len(x) - FRAME) // HOP
    idx = np.arange(FRAME)[None, :] + HOP * np.arange(count)[:, None]
    return x[idx] * np.hamming(FRAME)[None, :]


def _frame_rms(x: np.ndarray) -> np.ndarray:
    framed = _frames(x)
    return np.sqrt(np.mean(framed * framed, axis=1) + 1e-12)


def trim_voiced(x: np.ndarray, pad_s: float = 0.08) -> np.ndarray:
    """The part of a clip that holds speech: frames above a floor set from the clip's own loudness."""
    if len(x) < FRAME:
        return x
    rms = _frame_rms(x)
    peak = float(np.percentile(rms, 95))
    floor = max(1.5e-3, 0.08 * peak)
    live = np.nonzero(rms > floor)[0]
    if live.size == 0:
        return x[:0]
    pad = int(pad_s * RATE)
    start = max(0, int(live[0]) * HOP - pad)
    end = min(len(x), int(live[-1]) * HOP + FRAME + pad)
    return x[start:end]


def log_mel(x: np.ndarray) -> np.ndarray:
    spec = np.abs(np.fft.rfft(_frames(x), n=N_FFT, axis=1)) ** 2
    mel = spec @ mel_filterbank().T
    return np.log(mel + 1e-8)


def _dct_matrix(n_in: int, n_out: int) -> np.ndarray:
    k = np.arange(n_out)[:, None]
    n = np.arange(n_in)[None, :]
    return np.cos(math.pi / n_in * (n + 0.5) * k) * math.sqrt(2.0 / n_in)


_DCT = _dct_matrix(40, N_MFCC)


def mfcc(x: np.ndarray) -> np.ndarray:
    """(frames, N_MFCC) cepstra of a clip."""
    return log_mel(x) @ _DCT.T


def f0_track(x: np.ndarray, low: float = 70.0, high: float = 400.0) -> np.ndarray:
    """Pitch in Hz of the voiced frames, by autocorrelation. Empty when nothing is voiced."""
    framed = _frames(x)
    lo, hi = int(RATE / high), int(RATE / low)
    out: list[float] = []
    for frame in framed[::2]:
        frame = frame - frame.mean()
        energy = float(frame @ frame)
        if energy < 1e-6:
            continue
        acf = np.correlate(frame, frame, mode="full")[len(frame) - 1 :]
        window = acf[lo : hi + 1]
        if window.size == 0:
            continue
        lag = int(np.argmax(window)) + lo
        if acf[lag] / (acf[0] + 1e-12) >= 0.35:
            out.append(RATE / lag)
    return np.asarray(out, dtype=np.float64)


def speaker_vector(x: np.ndarray) -> np.ndarray | None:
    """One fixed-length vector for a clip of speech, or None when too little of it is voiced."""
    voiced = trim_voiced(x)
    if len(voiced) < MIN_VOICED_S * RATE:
        return None
    ceps = mfcc(voiced)[:, 1 : 1 + SPEAKER_CEPS]
    if len(ceps) < 8:
        return None
    delta = np.diff(ceps, axis=0)
    f0 = f0_track(voiced)
    if f0.size >= 5:
        pitch = [float(np.log(np.median(f0))), float(np.std(np.log(f0)))]
    else:
        pitch = [0.0, 0.0]
    return np.concatenate([ceps.mean(axis=0), ceps.std(axis=0), delta.std(axis=0)[:12], pitch])


def word_sequence(x: np.ndarray) -> np.ndarray | None:
    """The cepstral path of one spoken word (mean-removed, 20 ms steps), or None when it is too short."""
    voiced = trim_voiced(x)
    if len(voiced) < 0.2 * RATE:
        return None
    ceps = mfcc(voiced)[:, 1 : 1 + WAKE_CEPS]
    ceps = ceps - ceps.mean(axis=0, keepdims=True)
    ceps = ceps[::2]
    return ceps if len(ceps) >= 6 else None


# --------------------------------------------------------------------------- DTW
def dtw(a: np.ndarray, b: np.ndarray, band: float = WAKE_BAND) -> float:
    """Length-normalised dynamic-time-warping distance between two cepstral paths."""
    n, m = len(a), len(b)
    cost = np.sqrt(((a[:, None, :] - b[None, :, :]) ** 2).sum(axis=2))
    width = max(int(band * max(n, m)), abs(n - m) + 2)
    acc = np.full((n + 1, m + 1), np.inf)
    acc[0, 0] = 0.0
    for i in range(1, n + 1):
        lo = max(1, i - width)
        hi = min(m, i + width)
        for j in range(lo, hi + 1):
            acc[i, j] = cost[i - 1, j - 1] + min(acc[i - 1, j], acc[i, j - 1], acc[i - 1, j - 1])
    return float(acc[n, m] / (n + m))


def _resample_seq(seq: np.ndarray, length: int) -> np.ndarray:
    idx = np.linspace(0, len(seq) - 1, max(2, length))
    return np.stack([np.interp(idx, np.arange(len(seq)), seq[:, d]) for d in range(seq.shape[1])], axis=1)


def best_window_distance(x: np.ndarray, templates: list[np.ndarray]) -> float | None:
    """Slide a word-length window over a clip and return the closest it gets to the owner's takes."""
    ceps = mfcc(x)[:, 1 : 1 + WAKE_CEPS][::2]
    if len(ceps) < 6 or not templates:
        return None
    lengths = [len(t) for t in templates]
    base = int(np.median(lengths))
    hop = max(1, int(WAKE_HOP_S / 0.02))
    best: float | None = None
    for scale in WAKE_SCALES:
        size = max(6, int(base * scale))
        if size > len(ceps):
            continue
        for start in range(0, len(ceps) - size + 1, hop):
            seg = ceps[start : start + size]
            seg = seg - seg.mean(axis=0, keepdims=True)
            dists = sorted(dtw(seg, t) for t in templates)
            score = float(np.mean(dists[:WAKE_BEST_K]))
            if best is None or score < best:
                best = score
    return best


# --------------------------------------------------------------------------- building the profile
def _to_pcm(clip) -> np.ndarray:
    x = to_float(clip)
    if len(x) > MAX_CLIP_S * RATE:
        x = x[: int(MAX_CLIP_S * RATE)]
    return x


def build_profile(clips: list[dict]) -> dict:
    """Build the owner's profile from `[{id, kind: "wake"|"speech", pcm}]` (pcm: 16 kHz mono samples).

    Never raises on thin data: a part that cannot be built says why in `reasons` and stays `ready: false`.
    """
    speech_vecs: list[np.ndarray] = []
    speech_ids: list[str] = []
    speech_audio: list[np.ndarray] = []
    speech_seconds = 0.0
    wake_seqs: list[np.ndarray] = []
    wake_ids: list[str] = []
    other_audio: list[tuple[str, np.ndarray]] = []
    for clip in clips:
        pcm = _to_pcm(clip["pcm"])
        kind = str(clip.get("kind") or "speech")
        cid = str(clip.get("id") or len(speech_ids) + len(wake_ids))
        if kind == "wake":
            seq = word_sequence(pcm)
            if seq is not None:
                wake_seqs.append(seq)
                wake_ids.append(cid)
            vec = speaker_vector(pcm)
            if vec is not None:
                speech_vecs.append(vec)
                speech_ids.append(cid)
                speech_audio.append(pcm)
        else:
            vec = speaker_vector(pcm)
            if vec is not None:
                speech_vecs.append(vec)
                speech_ids.append(cid)
                speech_audio.append(pcm)
                speech_seconds += len(trim_voiced(pcm)) / RATE
                other_audio.append((cid, pcm))
    profile: dict = {
        "version": 1,
        "engine": ENGINE,
        "evidence": EVIDENCE,
        "speaker": _build_speaker(speech_vecs, speech_ids, speech_audio, len(other_audio), speech_seconds),
        "wake": _build_wake(wake_seqs, wake_ids, other_audio),
        "baseline": owner_baseline([pcm for _cid, pcm in other_audio]),
    }
    return profile


def owner_baseline(clips: list[np.ndarray]) -> dict | None:
    """How the owner usually sounds (median pitch, pitch spread, loudness), measured by the same function the
    app uses on every spoken utterance, so the tone reading is calibrated from the first sentence instead of after
    five. None when too few clips have a measurable voice."""
    try:
        import voice_runtime
    except Exception:  # noqa: BLE001 — the profile is still useful without a tone baseline
        return None
    rows = []
    for pcm in clips:
        measured = voice_runtime.voice_prosody(np.asarray(pcm, dtype=np.float32), RATE)
        if measured.get("ok") and float(measured.get("voicedShare", 0.0)) >= 0.2:
            rows.append(measured)
    if len(rows) < 4:
        return None
    return {
        "pitchHz": round(float(np.median([r["pitchHz"] for r in rows])), 1),
        "pitchSpreadSemitones": round(float(np.median([r["pitchSpreadSemitones"] for r in rows])), 2),
        "energyDbfs": round(float(np.median([r["energyDbfs"] for r in rows])), 1),
        "clips": len(rows),
    }


def _build_speaker(
    vecs: list[np.ndarray], ids: list[str], audio: list[np.ndarray], speech_clips: int, speech_seconds: float
) -> dict:
    reasons: list[str] = []
    if speech_clips < MIN_SPEECH_CLIPS:
        reasons.append(f"need at least {MIN_SPEECH_CLIPS} spoken sentences (have {speech_clips})")
    if speech_seconds < MIN_SPEECH_SECONDS:
        reasons.append(f"need at least {int(MIN_SPEECH_SECONDS)} s of speech (have {speech_seconds:.0f} s)")
    if len(vecs) < 4:
        return {"ready": False, "reasons": reasons or ["too few usable clips"], "clips": len(vecs)}
    data = np.stack(vecs)
    centroid = data.mean(axis=0)
    spread = data.std(axis=0)
    scale = np.maximum(spread, 0.5 * float(np.median(spread)) + 1e-6)
    loo: list[float] = []
    for i in range(len(data)):
        rest = np.delete(data, i, axis=0)
        loo.append(float(np.sqrt(np.mean(((data[i] - rest.mean(axis=0)) / scale) ** 2))))
    # A later utterance is often much shorter than a recorded sentence, and a short one varies more. The edge is
    # also set from short crops of the owner's own clips, each measured against the other clips.
    rng = np.random.default_rng(11)
    crops: list[float] = []
    for i, pcm in enumerate(audio):
        voiced = trim_voiced(pcm)
        rest = np.delete(data, i, axis=0).mean(axis=0)
        for fraction in (0.3, 0.5, 0.7):
            size = int(len(voiced) * fraction)
            if size < MIN_VOICED_S * RATE:
                continue
            start = int(rng.integers(0, len(voiced) - size + 1))
            vec = speaker_vector(voiced[start : start + size])
            if vec is not None:
                crops.append(float(np.sqrt(np.mean(((vec - rest) / scale) ** 2))))
    short = float(np.percentile(crops, 90)) if crops else 0.0
    edge = max(1.25 * max(loo), 1.5 * float(np.median(loo)), 1.15 * short, 0.8)
    return {
        "ready": not reasons,
        "reasons": reasons,
        "clips": len(vecs),
        "seconds": round(speech_seconds, 1),
        "centroid": [float(v) for v in centroid],
        "scale": [float(v) for v in scale],
        "edge": float(edge),
        "looMax": float(max(loo)),
        "looMedian": float(np.median(loo)),
        "shortClipP90": round(short, 4),
    }


def _build_wake(seqs: list[np.ndarray], ids: list[str], others: list[tuple[str, np.ndarray]]) -> dict:
    reasons: list[str] = []
    if len(seqs) < MIN_WAKE_TAKES:
        reasons.append(
            f"need at least {MIN_WAKE_TAKES} takes of the wake word (have {len(seqs)}); {GOOD_WAKE_TAKES} is better"
        )
        return {"ready": False, "reasons": reasons, "takes": len(seqs)}
    # Held-out positives: each take against the others.
    positives: list[float] = []
    for i in range(len(seqs)):
        rest = [s for j, s in enumerate(seqs) if j != i]
        dists = sorted(dtw(seqs[i], t) for t in rest)
        positives.append(float(np.mean(dists[: min(WAKE_BEST_K, len(dists))])))
    # Negatives: the owner's other sentences (many words, none of them the wake word), best window over each.
    negatives: list[float] = []
    for _cid, pcm in others:
        d = best_window_distance(pcm, seqs)
        if d is not None:
            negatives.append(d)
    if not negatives:
        reasons.append("no spoken sentences to test against; record the sentences too")
        return {"ready": False, "reasons": reasons, "takes": len(seqs)}
    pos_max = max(positives)
    neg_min = min(negatives)
    gap = neg_min - pos_max
    threshold = pos_max + 0.45 * gap if gap > 0 else pos_max
    frr = sum(1 for p in positives if p > threshold) / len(positives)
    false_accepts = sum(1 for n in negatives if n <= threshold)
    if gap <= 0:
        reasons.append(
            "your own sentences sound too close to the wake word; re-record the wake word more clearly and consistently"
        )
    if frr > TARGET_WAKE_LOO_FRR:
        reasons.append(f"held-out takes were refused {frr:.0%} of the time")
    if false_accepts:
        reasons.append(f"{false_accepts} of your other sentences matched the wake word")
    return {
        "ready": not reasons,
        "reasons": reasons,
        "takes": len(seqs),
        "threshold": float(threshold),
        "positiveMax": float(pos_max),
        "positiveMean": float(np.mean(positives)),
        "negativeMin": float(neg_min),
        "margin": float(gap),
        "heldOutRefusalRate": float(frr),
        "negativeClips": len(negatives),
        "falseAcceptsOnOwnSentences": int(false_accepts),
        "templates": [s.tolist() for s in seqs],
    }


# --------------------------------------------------------------------------- scoring
def public_summary(profile: dict | None) -> dict:
    """What the interface may show: numbers and reasons, never the templates or the centroid."""
    if not profile:
        return {"built": False, "engine": ENGINE, "evidence": EVIDENCE}
    speaker = dict(profile.get("speaker") or {})
    wake = dict(profile.get("wake") or {})
    for hidden in ("centroid", "scale"):
        speaker.pop(hidden, None)
    wake.pop("templates", None)
    return {
        "built": True,
        "engine": ENGINE,
        "evidence": EVIDENCE,
        "speaker": speaker,
        "wake": wake,
        "baseline": profile.get("baseline"),
    }


def score_speaker(profile: dict | None, pcm) -> dict:
    speaker = (profile or {}).get("speaker") or {}
    if not speaker.get("ready"):
        return {"enrolled": False, "similarity": None, "match": False, "reason": "no-voiceprint"}
    vec = speaker_vector(_to_pcm(pcm))
    if vec is None:
        return {"enrolled": True, "similarity": None, "match": False, "reason": "too-little-speech"}
    centroid = np.asarray(speaker["centroid"], dtype=np.float64)
    scale = np.asarray(speaker["scale"], dtype=np.float64)
    distance = float(np.sqrt(np.mean(((vec - centroid) / scale) ** 2)))
    edge = float(speaker["edge"])
    similarity = max(0.0, min(1.0, 1.0 - (1.0 - SPEAKER_MATCH_AT) * distance / edge))
    match = distance <= edge
    return {
        "enrolled": True,
        "similarity": round(similarity, 4),
        "distance": round(distance, 4),
        "edge": round(edge, 4),
        "match": match,
        "reason": "speaker-match" if match else "speaker-mismatch",
    }


def score_wake(profile: dict | None, pcm) -> dict:
    wake = (profile or {}).get("wake") or {}
    if not wake.get("ready"):
        return {"ready": False, "matched": False, "reason": "no-personal-wake"}
    templates = [np.asarray(t, dtype=np.float64) for t in wake["templates"]]
    x = _to_pcm(pcm)
    if len(trim_voiced(x)) > 4.0 * RATE:
        return {"ready": True, "matched": False, "reason": "clip-too-long"}
    distance = best_window_distance(x, templates)
    if distance is None:
        return {"ready": True, "matched": False, "reason": "too-short"}
    matched = distance <= float(wake["threshold"])
    return {
        "ready": True,
        "matched": matched,
        "distance": round(distance, 4),
        "threshold": round(float(wake["threshold"]), 4),
        "reason": "personal-wake-match" if matched else "personal-wake-no-match",
    }


def score_clip(profile: dict | None, pcm) -> dict:
    return {
        "engine": ENGINE,
        "evidence": EVIDENCE,
        "speaker": score_speaker(profile, pcm),
        "wake": score_wake(profile, pcm),
    }
