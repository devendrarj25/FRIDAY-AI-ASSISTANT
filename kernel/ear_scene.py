"""FRIDAY Ears: what the room sounds like (speech, music, tv, noise) and whose voice it is, as scores.

Interface contract
------------------
* Scores only. Nothing here approves, executes or lowers anything. ``env`` and ``speaker`` are tags on a turn note;
  the engine may use ``env`` to RAISE the voice-gate start (0.6) and the word count (2) while music or a TV plays,
  and ``speaker`` only labels the turn. A speaker match is never an approval and never lowers a threshold.
* ``SceneTracker.push(samples)`` takes 16 kHz mono float PCM of any length and reads the room once per 1.5 s window,
  by DSP first (numpy only, no model): spectral flatness, spectral stability of the fine structure (tonality, the
  steadiness of a harmonic mix), the ~4 Hz syllabic modulation of the band energy, and the length of the unbroken
  run (no pause of 300 ms or more). Speech wobbles at the syllable rate and breaks into words; music holds a stable
  harmonic mix and does not wobble; a flat unmodulated spectrum is noise; speech that never pauses for ~12 s is a TV
  or a radio. ``env`` is ``{"kind": speech|music|tv|noise, "score": 0..1}``, smoothed over windows.
* ``SpeakerScorer`` scores each window that holds speech against the owner's WeSpeaker embedding (the pinned int8
  file ``voice_runtime`` already tracks, ``speaker-wespeaker/onnx/model_int8.onnx``): cosine, ``owner`` at or above
  0.5, ``other`` below 0.25, ``unknown`` in between and whenever the file, the runtime or the owner's embedding is
  missing. The owner's embedding arrives with the stream-open ``ears.ownerEmbedding`` (a list of floats); this module
  never stores or logs it.
* Every threshold below is a LEAD from synthetic signals and the literature, not a measurement: it is calibrated only
  on the owner's PC (his room, his TV, his microphone). ``leads()`` lists them so a report never calls them verified.

numpy is imported at the top (the module is imported only when a stream opens with ``ears``); onnxruntime only when
the speaker file is on disk. A failure in either degrades to ``unknown`` or no tag; it never raises into the audio
path.
"""

from __future__ import annotations

import contextlib
import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import friday_runtime
import numpy as np

RATE = 16_000
WINDOW_S = 1.5
WINDOW = int(RATE * WINDOW_S)
FRAME = 400  # 25 ms
HOP = 160  # 10 ms
N_FFT = 512
BAND = (100.0, 4000.0)
SPEECH_BAND = (300.0, 3400.0)
SYLLABLE_BAND = (2.5, 7.0)
ENVELOPE_BAND = (0.5, 25.0)

# --- leads: starting values, calibrated only on the owner's PC -------------------------------------------------------
QUIET_DBFS = -55.0  # a window below this holds no scene
ACTIVE_RANGE_DB = 35.0  # frames this far under the window's peak are pauses, not sound
PAUSE_DB = 25.0
BREAK_MS = 300  # a pause this long ends an unbroken run
TV_RUN_S = 12.0  # speech this long without a break is a TV or a radio (the wake guard uses 20 s)
TV_RUN_FROM_S = 6.0
ACT_AT = 0.6  # a music or tv score at or above this raises the voice gate; hysteresis leaves below LEAVE_AT
LEAVE_AT = 0.4
ACT_WINDOWS = 2  # consecutive windows at or above ACT_AT before the gate is raised (a debounce of 3 s)
RUN_SPEECH_AT = 0.3
NO_SCENE_BELOW = 0.1  # a room with nothing in it has no env
SMOOTH = 0.5  # weight of the newest window in the running score
OWNER_AT = 0.5
OTHER_BELOW = 0.25
GATE_START_RAISED = 0.6
MIN_WORDS_RAISED = 2
SCENE_RAISING = ("music", "tv")
KINDS = ("speech", "music", "tv", "noise")
MIN_EMBED_DIM = 64
MAX_EMBED_DIM = 1024
SPEAKER_PINNED = ("speaker-wespeaker", "onnx", "model_int8.onnx")
SPEAKER_LEGACY = "wespeaker-ecapa.onnx"


def leads() -> dict[str, float]:
    """Every starting value of this module, for a report or a settings page to call a lead."""
    return {
        "quietDbfs": QUIET_DBFS,
        "tvRunS": TV_RUN_S,
        "actAt": ACT_AT,
        "leaveAt": LEAVE_AT,
        "actWindows": ACT_WINDOWS,
        "ownerAt": OWNER_AT,
        "otherBelow": OTHER_BELOW,
        "gateStartRaised": GATE_START_RAISED,
        "minWordsRaised": MIN_WORDS_RAISED,
    }


def _ramp(value: float, low: float, high: float) -> float:
    """0 at or below ``low``, 1 at or above ``high``, smooth between."""
    if high <= low:
        return 1.0 if value >= high else 0.0
    t = min(1.0, max(0.0, (value - low) / (high - low)))
    return t * t * (3.0 - 2.0 * t)


def _float_pcm(samples: Any) -> np.ndarray:
    arr = np.asarray(samples)
    if arr.dtype.kind in "iu":
        arr = arr.astype(np.float32) / 32768.0
    arr = np.asarray(arr, dtype=np.float32).reshape(-1)
    return np.nan_to_num(arr, nan=0.0, posinf=0.0, neginf=0.0)


# --------------------------------------------------------------------------- window features
@dataclass(frozen=True)
class Features:
    rms_dbfs: float
    flatness: float  # 0 tonal .. 1 flat (median of the active frames)
    tonality: float  # 0 .. 1: how steady the fine spectral structure is from frame to frame
    modulation: float  # ~4 Hz syllabic depth of the band energy (0 steady .. ~1 fully chopped)
    gap_fraction: float  # share of frames that are pauses
    longest_gap_ms: int
    run_ms: int  # sound since the last pause of BREAK_MS or more in this window (the whole window when none)
    broke: bool  # the window holds a pause of BREAK_MS or more
    active: bool


@dataclass(frozen=True)
class Read:
    """One window: the three scores before the run length, and the features they came from."""

    features: Features
    speech: float
    music: float
    noise: float


_WIN = np.hamming(FRAME).astype(np.float32)
_FREQ = np.fft.rfftfreq(N_FFT, 1.0 / RATE)
_BAND_BINS = np.where((_FREQ >= BAND[0]) & (_FREQ <= BAND[1]))[0]
_SPEECH_BINS = np.where((_FREQ >= SPEECH_BAND[0]) & (_FREQ <= SPEECH_BAND[1]))[0]


def _frames(x: np.ndarray) -> np.ndarray:
    count = 1 + (x.size - FRAME) // HOP
    index = np.arange(FRAME)[None, :] + HOP * np.arange(count)[:, None]
    return x[index]


def _fine_structure(log_power: np.ndarray, width: int = 15) -> np.ndarray:
    """The log spectrum minus its own smooth envelope: what is left is the harmonic comb (or its absence)."""
    kernel = np.ones(width, dtype=np.float32) / width
    pad = width // 2
    padded = np.pad(log_power, ((0, 0), (pad, pad)), mode="edge")
    smooth = np.apply_along_axis(lambda row: np.convolve(row, kernel, mode="valid"), 1, padded)
    return log_power - smooth


def _modulation(envelope: np.ndarray) -> float:
    """Depth of the 2.5-7 Hz wobble of the band energy envelope (100 frames per second)."""
    mean = float(envelope.mean())
    if envelope.size < 32 or mean <= 1e-9:
        return 0.0
    centred = envelope / mean - 1.0
    window = np.hanning(centred.size)
    spectrum = np.abs(np.fft.rfft(centred * window)) ** 2
    freq = np.fft.rfftfreq(centred.size, 0.01)
    band = spectrum[(freq >= SYLLABLE_BAND[0]) & (freq <= SYLLABLE_BAND[1])].sum()
    # a unit sinusoid has 4 * band / sum(window)^2 ~ 1 (Parseval over the three Hann bins it spreads to)
    depth = math.sqrt(max(0.0, float(band))) * 2.0 / max(1e-9, float(window.sum())) / math.sqrt(1.5)
    return float(min(1.5, depth))


def window_features(x: np.ndarray) -> Features | None:
    """The features of one window of 16 kHz float PCM, or None when it is too short to read."""
    if x.size < FRAME * 8:
        return None
    rms = float(np.sqrt(np.mean(x * x)))
    rms_db = 20.0 * math.log10(rms) if rms > 1e-9 else -120.0
    frames = _frames(x)
    frame_db = 10.0 * np.log10(np.mean(frames * frames, axis=1) + 1e-12)
    peak_db = float(frame_db.max())
    if rms_db < QUIET_DBFS:
        return Features(rms_db, 1.0, 0.0, 0.0, 1.0, int(frame_db.size * 10), 0, True, False)
    sound = frame_db > peak_db - ACTIVE_RANGE_DB
    pause = frame_db < peak_db - PAUSE_DB
    longest, current, since, broke = 0, 0, 0, False
    need = BREAK_MS // 10
    for flag in pause:
        current = current + 1 if flag else 0
        longest = max(longest, current)
        if current >= need:
            since, broke = 0, True
        elif current == 0:
            since += 1
    spectrum = np.abs(np.fft.rfft(frames * _WIN[None, :], n=N_FFT, axis=1)) ** 2 + 1e-12
    band = spectrum[:, _BAND_BINS]
    flat_all = np.exp(np.mean(np.log(band), axis=1)) / np.mean(band, axis=1)
    live = np.where(sound)[0]
    flatness = float(np.median(flat_all[live])) if live.size else 1.0
    tonality = 0.0
    consecutive = np.where(sound[:-1] & sound[1:])[0]
    if consecutive.size:
        fine = _fine_structure(np.log(band))
        fine = fine - fine.mean(axis=1, keepdims=True)
        norm = np.linalg.norm(fine, axis=1) + 1e-9
        both = np.sum(fine[consecutive] * fine[consecutive + 1], axis=1) / (norm[consecutive] * norm[consecutive + 1])
        tonality = float(np.clip(both.mean(), 0.0, 1.0))
    envelope = np.sqrt(spectrum[:, _SPEECH_BINS].sum(axis=1))
    return Features(
        rms_db,
        flatness,
        tonality,
        _modulation(envelope),
        float(pause.mean()),
        int(longest * 10),
        since * 10,
        broke,
        True,
    )


def read_window(x: np.ndarray) -> Read | None:
    """Scores for one window (speech, music, noise), or None for a window that holds no scene (quiet or short)."""
    f = window_features(x)
    if f is None or not f.active:
        return None
    mod = _ramp(f.modulation, 0.25, 0.6)
    tonal = _ramp(f.tonality, 0.55, 0.85)
    flat = _ramp(f.flatness, 0.2, 0.5)
    gaps = _ramp(f.gap_fraction, 0.03, 0.2)
    music = tonal * (1.0 - mod) * (1.0 - flat)
    noise = flat * (1.0 - mod) * (1.0 - tonal)
    speech = mod * (1.0 - 0.7 * tonal) * (0.7 + 0.3 * max(gaps, 1.0 - tonal))
    return Read(f, float(speech), float(music), float(noise))


# --------------------------------------------------------------------------- speaker
def fbank(x: np.ndarray, n_mels: int = 80) -> np.ndarray:
    """Kaldi-style log-mel features (25/10 ms, Hamming, pre-emphasis 0.97, mean-normalised): WeSpeaker's input."""
    wave = (np.asarray(x, dtype=np.float64) * 32768.0).reshape(-1)
    if wave.size < FRAME:
        wave = np.pad(wave, (0, FRAME - wave.size))
    frames = _frames(wave.astype(np.float32)).astype(np.float64)
    frames = frames - frames.mean(axis=1, keepdims=True)
    shifted = np.concatenate([frames[:, :1], frames[:, :-1]], axis=1)
    frames = (frames - 0.97 * shifted) * np.hamming(FRAME)[None, :]
    power = np.abs(np.fft.rfft(frames, n=N_FFT, axis=1)) ** 2
    mel = np.log(np.maximum(power @ _mel_bank(n_mels).T, 1.19e-7))
    return (mel - mel.mean(axis=0, keepdims=True)).astype(np.float32)


_MEL_CACHE: dict[int, np.ndarray] = {}


def _mel_bank(n_mels: int) -> np.ndarray:
    cached = _MEL_CACHE.get(n_mels)
    if cached is not None:
        return cached

    def to_mel(hz: np.ndarray | float) -> Any:
        return 1127.0 * np.log1p(np.asarray(hz) / 700.0)

    low, high = float(to_mel(20.0)), float(to_mel(RATE / 2.0))
    centres = low + (high - low) * np.arange(n_mels + 2) / (n_mels + 1)
    mel_of_bin = to_mel(_FREQ)
    bank = np.zeros((n_mels, _FREQ.size), dtype=np.float64)
    for m in range(n_mels):
        left, mid, right = centres[m], centres[m + 1], centres[m + 2]
        up = (mel_of_bin - left) / (mid - left)
        down = (right - mel_of_bin) / (right - mid)
        bank[m] = np.maximum(0.0, np.minimum(up, down))
    _MEL_CACHE[n_mels] = bank
    return bank


def speaker_model_path() -> Path | None:
    """The WeSpeaker file ``voice_runtime`` tracks (pinned int8 first, then the hand-placed one), or None."""
    try:
        import voice_runtime

        pinned = voice_runtime.voice_root().joinpath(*SPEAKER_PINNED)
        if pinned.is_file() and pinned.stat().st_size > 0:
            return pinned
        return voice_runtime.find_named(SPEAKER_LEGACY)
    except Exception:  # noqa: BLE001 — no lookup means no model: every speaker stays unknown
        return None


def onnx_embedder(path: Path) -> Callable[[np.ndarray], np.ndarray]:
    """``embed(float pcm) -> vector`` over the WeSpeaker file. Raises when onnxruntime or the file fails."""
    session = friday_runtime.open_session(path, "vad")  # one thread, in the audio group's budget
    name = session.get_inputs()[0].name

    def embed(pcm: np.ndarray) -> np.ndarray:
        feats = fbank(pcm)[None, :, :]
        out = session.run(None, {name: feats})[0]
        return np.asarray(out, dtype=np.float64).reshape(-1)

    return embed


def clean_embedding(raw: Any) -> np.ndarray | None:
    """A unit vector from the owner's embedding as the stream-open carried it, or None for anything odd."""
    if isinstance(raw, (str, bytes)) or not isinstance(raw, Sequence):
        return None
    if not MIN_EMBED_DIM <= len(raw) <= MAX_EMBED_DIM:
        return None
    try:
        vec = np.asarray([float(v) for v in raw if not isinstance(v, bool)], dtype=np.float64)
    except (TypeError, ValueError):
        return None
    if vec.size != len(raw) or not np.all(np.isfinite(vec)):
        return None
    norm = float(np.linalg.norm(vec))
    return vec / norm if norm > 1e-9 else None


def tag_for(score: float | None) -> str:
    """owner at or above ``OWNER_AT``, other below ``OTHER_BELOW``, unknown otherwise and without a score."""
    if score is None or not math.isfinite(score):
        return "unknown"
    if score >= OWNER_AT:
        return "owner"
    if score < OTHER_BELOW:
        return "other"
    return "unknown"


class SpeakerScorer:
    """Cosine of a window's embedding against the owner's. The model loads on the first window, once; a model that
    is missing or fails leaves every window ``unknown`` for the rest of the stream."""

    def __init__(
        self,
        owner: Any = None,
        *,
        embedder: Callable[[np.ndarray], np.ndarray] | None = None,
        model_path: Callable[[], Path | None] = speaker_model_path,
    ) -> None:
        self.owner = clean_embedding(owner)
        self._embed = embedder
        self._model_path = model_path
        self._broken = False

    @property
    def ready(self) -> bool:
        return self.owner is not None and not self._broken

    def _embedder(self) -> Callable[[np.ndarray], np.ndarray] | None:
        if self._embed is not None or self._broken:
            return self._embed
        path = self._model_path()
        if path is None:
            self._broken = True
            return None
        try:
            self._embed = onnx_embedder(path)
        except Exception:  # noqa: BLE001 — no runtime or a bad file: unknown, never a crash
            self._broken = True
        return self._embed

    def score(self, window: np.ndarray) -> float | None:
        """The cosine to the owner (-1..1), or None without an owner embedding, a model or a readable window."""
        if self.owner is None or self._broken:
            return None
        embed = self._embedder()
        if embed is None:
            return None
        try:
            vec = np.asarray(embed(window), dtype=np.float64).reshape(-1)
        except Exception:  # noqa: BLE001
            self._broken = True
            return None
        if vec.size != self.owner.size or not np.all(np.isfinite(vec)):
            return None
        norm = float(np.linalg.norm(vec))
        return float(vec @ self.owner / norm) if norm > 1e-9 else None


# --------------------------------------------------------------------------- the tracker
@dataclass
class SceneTracker:
    """Reads the room every 1.5 s and keeps ``env`` (smoothed over windows) and the turn's ``speaker``.

    ``score_scene`` (``ears.scene == "score"``) turns the room reading on; ``score_speaker`` (``ears.otherVoice`` of
    ``score`` or ``hold``) turns the speaker reading on. Neither changes anything by itself: ``raising`` and the tags
    are read by the engine, which may only make its gate stricter."""

    score_scene: bool = False
    score_speaker: bool = False
    speaker: SpeakerScorer | None = None
    _buffer: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=np.float32))
    _scores: dict[str, float] = field(default_factory=lambda: dict.fromkeys(KINDS, 0.0))
    _run_ms: int = 0
    _raising: bool = False
    _hot: int = 0
    _first: bool = True
    _speaker_scores: list[float] = field(default_factory=list)
    _last_speaker: float | None = None
    windows: int = 0

    def reset(self) -> None:
        self._buffer = np.zeros(0, dtype=np.float32)
        self._scores = dict.fromkeys(KINDS, 0.0)
        self._run_ms = 0
        self._raising = False
        self._hot = 0
        self._first = True
        self._speaker_scores = []
        self._last_speaker = None
        self.windows = 0

    def new_turn(self) -> None:
        """A turn started: its speaker score starts again (the room reading carries on)."""
        self._speaker_scores = []

    def push(self, samples: Any) -> None:
        if not (self.score_scene or self.score_speaker):
            return
        self._buffer = np.concatenate([self._buffer, _float_pcm(samples)])
        while self._buffer.size >= WINDOW:
            window, self._buffer = self._buffer[:WINDOW], self._buffer[WINDOW:]
            with contextlib.suppress(Exception):  # a failed reading is no reading; the audio path never sees it
                self._read(window)

    def _read(self, window: np.ndarray) -> None:
        self.windows += 1
        read = read_window(window)
        if read is None:
            self._run_ms = 0
            self._decay()
            return
        f = read.features
        self._run_ms = f.run_ms if f.broke else self._run_ms + int(WINDOW_S * 1000)
        if read.speech < RUN_SPEECH_AT:
            self._run_ms = 0  # the run that makes a TV is a run of speech: music and noise do not count toward it
        run = _ramp(self._run_ms / 1000.0, TV_RUN_FROM_S, TV_RUN_S)
        raw = {"speech": read.speech * (1.0 - run), "music": read.music, "tv": read.speech * run, "noise": read.noise}
        for kind in KINDS:
            self._scores[kind] = raw[kind] if self._first else (1.0 - SMOOTH) * self._scores[kind] + SMOOTH * raw[kind]
        self._first = False
        if self.score_scene:
            level = max(self._scores[k] for k in SCENE_RAISING)
            self._hot = self._hot + 1 if level >= ACT_AT else 0
            self._raising = self._hot >= ACT_WINDOWS or (self._raising and level >= LEAVE_AT)
        if self.score_speaker and self.speaker is not None and (raw["speech"] + raw["tv"]) >= 0.3:
            value = self.speaker.score(window)
            if value is not None:
                self._speaker_scores.append(value)
                self._last_speaker = value

    def _decay(self) -> None:
        for kind in KINDS:
            self._scores[kind] *= 1.0 - SMOOTH
        self._hot = 0
        if self._raising and max(self._scores[k] for k in SCENE_RAISING) < LEAVE_AT:
            self._raising = False

    @property
    def env(self) -> dict[str, Any] | None:
        """``{"kind", "score"}`` of the room; None before a window, in a silent room, or without ``score_scene``."""
        if not self.score_scene or self.windows == 0:
            return None
        kind = max(KINDS, key=lambda k: self._scores[k])
        if self._scores[kind] < NO_SCENE_BELOW:
            return None
        return {"kind": kind, "score": round(float(self._scores[kind]), 3)}

    @property
    def raising(self) -> bool:
        """Music or a TV is playing at or above ``ACT_AT``: the engine may make its voice gate stricter."""
        return self.score_scene and self._raising

    @property
    def speaker_tag(self) -> dict[str, Any] | None:
        """``{"tag", "score"}`` of this turn (mean over its scored windows, else the last), None when not scoring."""
        if not self.score_speaker:
            return None
        pool = self._speaker_scores or ([self._last_speaker] if self._last_speaker is not None else [])
        score = float(np.mean(pool)) if pool else None
        return {"tag": tag_for(score), "score": None if score is None else round(score, 3)}
