"""How well FRIDAY's ears work, in seven numbers, before and after any change to them.

The ears are everything between the microphone and the transcript: the voice gate, the endpointer, and the text that
reaches the brain. This harness scores them on scenes with known truth (where speech starts and ends, and which
scenes hold no speech at all):

- ``vadFrameF1``: voice-gate quality, 20 ms frame by frame (precision, recall, F1).
- ``onsetMs``: how late a turn opens after the speech really began.
- ``clipStartLossMs``: how much of the first word was missing from the audio handed to the recogniser.
- ``eotMs``: how long after the speech really ended the turn closed (turns that closed early are not in it).
- ``prematureCutPct``: turns that closed while the speaker was still inside the utterance (a pause), with a 95% range.
- ``nonSpeechTextPct``: clips with no speech (music, TV, noise, silence) that still produced words, with a 95% range.
- ``falseTurnsPerHour``: turns opened where no utterance was going on; a fragment left by a premature cut counts too.

Two inputs. ``--synthetic`` renders the scenes in ``core/fixtures/ears/manifest.json`` with numpy (seeded, no audio
in the repository). ``--owner`` reads the owner's own labelled recordings from ``<FRIDAY_ROOT>/voice-eval/ears``:
``name.wav`` (16 kHz mono, 16-bit) plus ``name.json`` (``{"kind": ..., "utterances": [[[startMs, endMs], ...]]}``).
That folder is outside the repository on purpose, and a missing one is a visible SKIP, never a score.

The built-in subject is ``EnergyBaseline``: today's energy gate with a fixed hangover and a stand-in recogniser that
writes "ok" for any audio it is given. So the synthetic numbers measure the harness and the energy gate, not the
speech model, and not the owner's microphone: that baseline is run by the owner on his PC (unverified here).
Another ears implementation plugs in by offering ``run(samples) -> EarsRun``.

``--denoise-ab`` runs the same scoring on the raw clips and on each denoiser's output (``denoise_onnx``), prints the
change per metric and the word error rate, and applies the adopt rule: keep a denoiser only if the word error rate does
not worsen by more than 0.5 point and the share of no-speech clips that still produced words does not rise. The word
error rate needs the owner's recordings with a ``"text"`` in the label file and a recogniser, so on the synthetic scenes
it prints UNVERIFIED and the verdict is undecided. It does not connect a denoiser to the live stream.

Reuses ``stt_bench`` for the timing summaries, the Wilson range and the text normaliser.
"""

from __future__ import annotations

import json
import math
import os
import wave
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

import numpy as np
import stt_bench
from denoise_onnx import DENOISE_ENGINES

RATE = 16_000
SLICE_MS = 20
SLICE = RATE * SLICE_MS // 1000
KINDS = ("speech", "music", "tv", "noise", "silence")
BACKGROUND_KINDS = ("music", "tv", "noise")
LEVEL_DBFS = {"quiet": -45.0, "normal": -26.0, "loud": -12.0, "clipped": -12.0}
CLIP_DRIVE = 8.0
MANIFEST_VERSION = 1
DEFAULT_MANIFEST = Path(__file__).resolve().parents[1] / "core" / "fixtures" / "ears" / "manifest.json"
OWNER_FOLDER = ("voice-eval", "ears")
METRIC_NAMES = (
    "vadFrameF1",
    "onsetMs",
    "clipStartLossMs",
    "eotMs",
    "prematureCutPct",
    "nonSpeechTextPct",
    "falseTurnsPerHour",
)
EXIT_OK, EXIT_USAGE, EXIT_REFUSED, EXIT_NO_DATA = stt_bench.EXIT_OK, stt_bench.EXIT_USAGE, stt_bench.EXIT_REFUSED, 3
MAX_DURATION_MS = 3_600_000

# ---- signal generators ------------------------------------------------------------------------------------------


def _count(ms: int) -> int:
    return max(0, int(ms) * RATE // 1000)


def dbfs(x: np.ndarray) -> float:
    """RMS level in dB relative to full scale; -120 for silence."""
    if x.size == 0:
        return -120.0
    rms = float(np.sqrt(np.mean(np.square(x, dtype=np.float64))))
    return 20.0 * math.log10(rms) if rms > 1e-9 else -120.0


def scale_dbfs(x: np.ndarray, target: float) -> np.ndarray:
    """Scale to an RMS level. No clipping here: ``clip`` and the scene renderer own that."""
    level = dbfs(x)
    if level <= -119.0:
        return x.astype(np.float32)
    return (x * 10.0 ** ((target - level) / 20.0)).astype(np.float32)


def clip(x: np.ndarray, drive: float = CLIP_DRIVE) -> np.ndarray:
    """Overdrive then hard-clip to full scale, like a mic turned up too far."""
    return np.clip(x * drive, -1.0, 1.0).astype(np.float32)


def _fade(x: np.ndarray, ms: int = 10) -> np.ndarray:
    n = min(len(x) // 2, _count(ms))
    if n > 0:
        ramp = np.linspace(0.0, 1.0, n, dtype=np.float32)
        x[:n] *= ramp
        x[-n:] *= ramp[::-1]
    return x


def _normalised(x: np.ndarray) -> np.ndarray:
    return scale_dbfs(x, LEVEL_DBFS["normal"])


def _syllables(n: int, rng: np.random.Generator) -> np.ndarray:
    """A 3.5-5 Hz envelope that never drops below 30%: syllables, not gaps."""
    t = np.arange(n) / RATE
    rate = rng.uniform(3.5, 5.0)
    return (0.65 + 0.35 * np.sin(2 * np.pi * rate * t + rng.uniform(0, 2 * np.pi))).astype(np.float32)


def speech_like(ms: int, seed: int, f0: float | None = None) -> np.ndarray:
    """Harmonics of a gliding voice, shaped by three formant bumps and a syllable rhythm."""
    n = _count(ms)
    if n == 0:
        return np.zeros(0, dtype=np.float32)
    rng = np.random.default_rng(seed)
    base = f0 if f0 is not None else 110.0 + (seed * 13) % 70
    t = np.arange(n) / RATE
    inst = base * (1.0 + 0.03 * np.sin(2 * np.pi * 0.7 * t + rng.uniform(0, 6.28)))
    phase = 2 * np.pi * np.cumsum(inst) / RATE
    formants = (rng.uniform(450, 650), rng.uniform(1300, 1700), rng.uniform(2400, 2700))
    out = np.zeros(n, dtype=np.float64)
    for h in range(1, 41):
        freq = inst * h
        if float(freq[0]) > 4000.0:
            break
        gain = sum(np.exp(-(((freq - f) / 220.0) ** 2)) for f in formants) + 0.05
        out += (gain / h) * np.sin(h * phase)
    out = out.astype(np.float32) * _syllables(n, rng)
    return _normalised(_fade(out))


def music_like(ms: int, seed: int) -> np.ndarray:
    """A steady chord of notes with six harmonics each and a slow tremolo: pitched, but no syllable rhythm."""
    n = _count(ms)
    if n == 0:
        return np.zeros(0, dtype=np.float32)
    rng = np.random.default_rng(seed)
    t = np.arange(n) / RATE
    root = rng.choice([196.0, 220.0, 246.9, 261.6])
    out = np.zeros(n, dtype=np.float64)
    for ratio in (1.0, 1.26, 1.5):
        for h in range(1, 7):
            out += np.sin(2 * np.pi * root * ratio * h * t + rng.uniform(0, 6.28)) / h
    out *= 1.0 + 0.1 * np.sin(2 * np.pi * 0.5 * t)
    return _normalised(_fade(out.astype(np.float32)))


def _shaped_noise(n: int, rng: np.random.Generator, low: float, high: float, tilt: float) -> np.ndarray:
    spectrum = np.fft.rfft(rng.standard_normal(n))
    freqs = np.fft.rfftfreq(n, 1 / RATE)
    keep = (freqs >= low) & (freqs <= high)
    spectrum = spectrum * keep / np.maximum(freqs, 1.0) ** tilt
    return np.fft.irfft(spectrum, n).astype(np.float32)


def tv_like(ms: int, seed: int) -> np.ndarray:
    """Speech-band noise with the syllable rhythm of talk: it moves like speech but is not a voice."""
    n = _count(ms)
    if n == 0:
        return np.zeros(0, dtype=np.float32)
    rng = np.random.default_rng(seed)
    body = _shaped_noise(n, rng, 200.0, 4000.0, 0.5) * _syllables(n, rng)
    return _normalised(_fade(body))


def noise_floor(ms: int, seed: int) -> np.ndarray:
    """Broadband hiss with a pink tilt, steady in time."""
    n = _count(ms)
    if n == 0:
        return np.zeros(0, dtype=np.float32)
    return _normalised(_fade(_shaped_noise(n, np.random.default_rng(seed), 20.0, 7900.0, 0.5)))


def silence(ms: int, seed: int) -> np.ndarray:
    """A quiet room: gaussian hiss near -70 dBFS."""
    n = _count(ms)
    rng = np.random.default_rng(seed)
    return scale_dbfs(rng.standard_normal(n).astype(np.float32), -70.0) if n else np.zeros(0, dtype=np.float32)


def syllabic_index(x: np.ndarray) -> float:
    """Share of the level-envelope movement that sits at 2-8 Hz, where syllables live (0 to 1)."""
    hop = RATE // 100
    frames = len(x) // hop
    if frames < 32:
        return 0.0
    env = np.sqrt(np.mean(np.square(x[: frames * hop].reshape(frames, hop), dtype=np.float64), axis=1))
    env = (env - env.mean()) * np.hanning(frames)
    power = np.abs(np.fft.rfft(env)) ** 2
    freqs = np.fft.rfftfreq(frames, 1 / 100)
    total = float(power[(freqs >= 0.5) & (freqs <= 50)].sum())
    return float(power[(freqs >= 2) & (freqs <= 8)].sum()) / total if total > 0 else 0.0


# ---- scenes -----------------------------------------------------------------------------------------------------


@dataclass
class Scene:
    """Audio with known truth. ``utterances`` holds one list of ``(startMs, endMs)`` speech segments per utterance;
    the gaps between segments of one utterance are pauses, not the end."""

    id: str
    kind: str
    samples: np.ndarray
    utterances: list[list[tuple[int, int]]] = field(default_factory=list)
    text: str = ""  # what was said, when written down (``"text"`` in the label file); the word error rate needs it

    @property
    def duration_ms(self) -> int:
        return len(self.samples) * 1000 // RATE


def _check_utterances(utterances: Any, duration_ms: int, where: str) -> list[list[tuple[int, int]]]:
    if not isinstance(utterances, list):
        raise ValueError(f"{where}: utterances must be a list")  # noqa: TRY004
    out: list[list[tuple[int, int]]] = []
    last_end = 0
    for u in utterances:
        if not isinstance(u, list) or not u:
            raise ValueError(f"{where}: an utterance needs at least one [startMs, endMs] segment")
        segments: list[tuple[int, int]] = []
        for seg in u:
            ok = isinstance(seg, (list, tuple)) and len(seg) == 2 and all(type(v) is int for v in seg)
            if not ok or not 0 <= seg[0] < seg[1] <= duration_ms:
                raise ValueError(f"{where}: segment {seg!r} must be integers with 0 <= start < end <= {duration_ms}")
            if seg[0] < last_end:
                raise ValueError(f"{where}: segments must be in order and not overlap")
            last_end = seg[1]
            segments.append((seg[0], seg[1]))
        out.append(segments)
    return out


def _render(spec: dict, where: str) -> Scene:
    sid, kind = spec.get("id"), spec.get("kind")
    if not isinstance(sid, str) or not sid:
        raise ValueError(f"{where}: a scene needs an id")
    if kind not in KINDS:
        raise ValueError(f"{where}: kind {kind!r} is not one of {', '.join(KINDS)}")
    level = spec.get("level", "normal")
    if level not in LEVEL_DBFS:
        raise ValueError(f"{where}: level {level!r} is not one of {', '.join(LEVEL_DBFS)}")
    ms, seed = spec.get("durationMs"), spec.get("seed")
    if type(ms) is not int or not 500 <= ms <= MAX_DURATION_MS or type(seed) is not int:
        raise ValueError(f"{where}: durationMs (500..{MAX_DURATION_MS}) and seed must be integers")
    utterances = _check_utterances(spec.get("utterances", []), ms, where)
    if kind == "speech" and not utterances:
        raise ValueError(f"{where}: a speech scene needs at least one utterance")
    if kind != "speech" and utterances:
        raise ValueError(f"{where}: a {kind} scene holds no speech, so it has no utterances")
    target = spec.get("dbfs", LEVEL_DBFS[level])
    if not isinstance(target, (int, float)) or isinstance(target, bool) or not -90 <= target <= 0:
        raise ValueError(f"{where}: dbfs must be a number from -90 to 0")
    out = silence(ms, seed).astype(np.float64)
    generators: dict[str, Callable[[int, int], np.ndarray]] = {
        "music": music_like,
        "tv": tv_like,
        "noise": noise_floor,
    }
    if kind in generators:
        out += scale_dbfs(generators[kind](ms, seed), float(target))
    background = spec.get("background")
    if background is not None:
        bg_kind, bg_db = background.get("kind"), background.get("dbfs")
        if bg_kind not in BACKGROUND_KINDS or not isinstance(bg_db, (int, float)) or not -90 <= bg_db <= 0:
            raise ValueError(f"{where}: background needs a kind of {', '.join(BACKGROUND_KINDS)} and a dbfs")
        out += scale_dbfs(generators[bg_kind](ms, seed + 1000), float(bg_db))
    for i, utterance in enumerate(utterances):
        for j, (start, end) in enumerate(utterance):
            voice = scale_dbfs(speech_like(end - start, seed * 101 + i * 7 + j), float(target))
            at = _count(start)
            out[at : at + len(voice)] += voice
    mixed = out.astype(np.float32)
    mixed = clip(mixed) if level == "clipped" else np.clip(mixed, -1.0, 1.0)
    return Scene(id=sid, kind=kind, samples=mixed, utterances=utterances)


def load_scenes(path: Path = DEFAULT_MANIFEST) -> list[Scene]:
    """Render every scene of a manifest. A bad manifest raises ``ValueError`` and renders nothing."""
    try:
        manifest = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"manifest unreadable: {exc}") from exc
    if not isinstance(manifest, dict) or manifest.get("version") != MANIFEST_VERSION:
        raise ValueError(f"manifest version must be {MANIFEST_VERSION}")
    if manifest.get("rate") != RATE or manifest.get("sliceMs") != SLICE_MS:
        raise ValueError(f"manifest must use rate {RATE} and sliceMs {SLICE_MS}")
    specs = manifest.get("scenes")
    if not isinstance(specs, list) or not specs:
        raise ValueError("manifest has no scenes")
    scenes = [_render(spec, f"scene {n}") for n, spec in enumerate(specs)]
    ids = [s.id for s in scenes]
    if len(ids) != len(set(ids)):
        raise ValueError("scene ids must be unique")
    return scenes


# ---- owner recordings -------------------------------------------------------------------------------------------


def read_wav(path: Path) -> np.ndarray:
    """A 16 kHz mono 16-bit PCM file as float32 in [-1, 1]."""
    try:
        with wave.open(str(path), "rb") as w:
            ok = (w.getframerate(), w.getnchannels(), w.getsampwidth()) == (RATE, 1, 2)
            frames = w.readframes(w.getnframes()) if ok else b""
    except (wave.Error, EOFError) as exc:
        raise ValueError(f"{Path(path).name}: need 16 kHz mono 16-bit PCM ({exc})") from exc
    if not ok:
        raise ValueError(f"{Path(path).name}: need 16 kHz mono 16-bit PCM")
    return (np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0).astype(np.float32)


def owner_folder(root: Path) -> Path:
    return Path(root).joinpath(*OWNER_FOLDER)


def load_owner_scenes(root: Path) -> list[Scene]:
    """The owner's labelled clips under ``<root>/voice-eval/ears``. A root inside the repository is refused; a missing
    folder gives ``[]``; a wav without its label file is skipped, never guessed; a broken pair raises."""
    if stt_bench.is_inside_repo(Path(root)):
        raise ValueError("owner recordings must live outside the repository")
    folder = owner_folder(root)
    if not folder.is_dir():
        return []
    scenes: list[Scene] = []
    for wav_path in sorted(folder.glob("*.wav")):
        label = wav_path.with_suffix(".json")
        if not label.is_file():
            continue
        samples = read_wav(wav_path)
        try:
            spec = json.loads(label.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ValueError(f"{label.name}: unreadable ({exc})") from exc
        kind = spec.get("kind") if isinstance(spec, dict) else None
        if kind not in KINDS:
            raise ValueError(f"{label.name}: kind must be one of {', '.join(KINDS)}")
        duration = len(samples) * 1000 // RATE
        utterances = _check_utterances(spec.get("utterances", []), duration, label.name)
        if (kind == "speech") != bool(utterances):
            raise ValueError(f"{label.name}: only a speech clip has utterances, and it needs at least one")
        text = spec.get("text", "")
        if not isinstance(text, str):
            raise ValueError(f"{label.name}: text must be a string")
        scenes.append(Scene(id=wav_path.stem, kind=kind, samples=samples, utterances=utterances, text=text))
    return scenes


# ---- the subject under test -------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Turn:
    """One turn the ears opened. ``sent_start_ms`` is where the audio handed to the recogniser begins (it includes the
    pre-roll), so ``sent_start_ms`` after the real speech start means the first word was clipped."""

    start_ms: int
    end_ms: int
    sent_start_ms: int
    text: str = ""


@dataclass
class EarsRun:
    frames: list[bool]  # one voice-gate decision per 20 ms slice
    turns: list[Turn]


class Ears(Protocol):
    def run(self, samples: np.ndarray) -> EarsRun: ...


class EnergyBaseline:
    """Today's energy gate (``stream_ear.EnergyVad``) with a fixed hangover and pre-roll, and a stand-in recogniser
    that writes "ok" for any audio it is given, so a gate that lets noise through shows as text."""

    def __init__(self, pre_roll_ms: int = 500, hangover_ms: int = 420) -> None:
        self.pre_roll_ms, self.hangover_ms = pre_roll_ms, hangover_ms

    def run(self, samples: np.ndarray) -> EarsRun:
        from stream_ear import EnergyVad

        vad = EnergyVad()
        frames = [vad.push(samples[i * SLICE : (i + 1) * SLICE]) >= 0.5 for i in range(len(samples) // SLICE)]
        turns: list[Turn] = []
        start = last = -1
        for i, speaking in enumerate(frames):
            if speaking:
                if start < 0:
                    start = i
                last = i
            elif start >= 0 and (i - last) * SLICE_MS >= self.hangover_ms:
                turns.append(self._turn(start, last))
                start = -1
        if start >= 0:
            turns.append(self._turn(start, last, cap=len(frames) * SLICE_MS))
        return EarsRun(frames=frames, turns=turns)

    def _turn(self, first: int, last: int, cap: int | None = None) -> Turn:
        opened = (first + 1) * SLICE_MS  # the decision lands when the slice that tipped it has been heard
        closed = (last + 1) * SLICE_MS + self.hangover_ms
        return Turn(
            start_ms=opened,
            end_ms=min(closed, cap) if cap is not None else closed,
            sent_start_ms=max(0, opened - self.pre_roll_ms),
            text="ok",
        )


# ---- metrics ----------------------------------------------------------------------------------------------------


def _truth_frames(scene: Scene) -> list[bool]:
    frames = [False] * (len(scene.samples) // SLICE)
    for utterance in scene.utterances:
        for start, end in utterance:
            for i in range(start // SLICE_MS, min(len(frames), -(-end // SLICE_MS))):
                frames[i] = True
    return frames


def _f1(tp: int, fp: int, fn: int) -> dict:
    return {
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "precision": tp / (tp + fp) if tp + fp else 0.0,
        "recall": tp / (tp + fn) if tp + fn else 0.0,
        "f1": 2 * tp / (2 * tp + fp + fn) if tp else 0.0,
    }


def vad_frame_f1(truth: list[bool], pred: list[bool]) -> dict:
    """Frame-level precision, recall and F1. ``pred`` is padded or cut to the length of ``truth``. F1 is 0 when no
    frame was correctly found, including a clip with nothing to find: no score is claimed from nothing."""
    pred = (list(pred) + [False] * len(truth))[: len(truth)]
    tp = sum(1 for t, p in zip(truth, pred, strict=True) if t and p)
    fp = sum(1 for t, p in zip(truth, pred, strict=True) if p and not t)
    fn = sum(1 for t, p in zip(truth, pred, strict=True) if t and not p)
    return _f1(tp, fp, fn)


def _match(utterances: list[list[tuple[int, int]]], turns: list[Turn]) -> tuple[list[tuple[int, Turn]], set[int]]:
    """Pair each utterance with the earliest unused turn that overlaps it. Returns (utterance index, turn) pairs and
    the indexes of turns that matched nothing."""
    used: set[int] = set()
    pairs: list[tuple[int, Turn]] = []
    for ui, utterance in enumerate(utterances):
        first, last = utterance[0][0], utterance[-1][1]
        for ti, turn in enumerate(turns):
            if ti not in used and turn.start_ms <= last and turn.end_ms >= first:
                used.add(ti)
                pairs.append((ui, turn))
                break
    return pairs, {i for i in range(len(turns)) if i not in used}


def _words(text: str) -> bool:
    return bool(stt_bench.normalise(text))


def evaluate(scenes: list[Scene], ears: Ears, transcribe: Callable[[np.ndarray, Turn], str] | None = None) -> dict:
    """Run ``ears`` over every scene and return ``{"metrics": {seven}, "counts": {...}}``.

    ``transcribe(samples, turn)`` replaces ``turn.text`` for scenes with no speech, to test a recogniser behind the
    gate; it is not called for speech scenes. Raises ``ValueError`` for no scenes, an unknown kind, or a speech scene
    with nothing to find."""
    if not scenes:
        raise ValueError("no scenes to evaluate")
    for scene in scenes:
        if scene.kind not in KINDS:
            raise ValueError(f"scene {scene.id!r}: kind {scene.kind!r} is not one of {', '.join(KINDS)}")
        if scene.kind == "speech" and not scene.utterances:
            raise ValueError(f"scene {scene.id!r}: a speech scene needs at least one utterance")
    tp = fp = fn = 0
    onsets: list[float | None] = []
    losses: list[float | None] = []
    timelines: list[dict] = []
    premature = matched = missed = false_turns = utterances = 0
    quiet_clips = quiet_with_words = 0
    total_ms = 0
    for scene in scenes:
        run = ears.run(scene.samples)
        part = vad_frame_f1(_truth_frames(scene), run.frames)
        tp, fp, fn = tp + part["tp"], fp + part["fp"], fn + part["fn"]
        total_ms += scene.duration_ms
        pairs, stray = _match(scene.utterances, run.turns)
        false_turns += len(stray)
        utterances += len(scene.utterances)
        missed += len(scene.utterances) - len(pairs)
        for ui, turn in pairs:
            first, last = scene.utterances[ui][0][0], scene.utterances[ui][-1][1]
            matched += 1
            onsets.append(turn.start_ms - first)
            losses.append(max(0, turn.sent_start_ms - first))
            events = [
                {"kind": "speech_start", "t": first},
                {"kind": "speech_end", "t": last},
                {"kind": "endpoint", "t": turn.end_ms},
            ]
            m = stt_bench.latency_metrics({"events": sorted(events, key=lambda e: e["t"])})
            if m["prematureEndpoint"]:
                premature += 1
            else:
                timelines.append(m)
        if scene.kind != "speech":
            quiet_clips += 1
            for turn in run.turns:
                text = turn.text
                if transcribe is not None:
                    a = max(0, turn.sent_start_ms) * RATE // 1000
                    text = transcribe(scene.samples[a : max(a, turn.end_ms * RATE // 1000)], turn)
                if _words(text):
                    quiet_with_words += 1
                    break
    hours = total_ms / 3_600_000
    f1 = _f1(tp, fp, fn)
    metrics = {
        "vadFrameF1": {**f1, "frames": tp + fp + fn},
        "onsetMs": stt_bench.summarise_latency(onsets),
        "clipStartLossMs": {
            **stt_bench.summarise_latency(losses),
            "withLoss": sum(1 for v in losses if v is not None and v > 0),
        },
        "eotMs": stt_bench.summarise_latency([m["endpointLatencyMs"] for m in timelines]),
        "prematureCutPct": stt_bench.wilson_rate(premature, matched),
        "nonSpeechTextPct": stt_bench.wilson_rate(quiet_with_words, quiet_clips),
        "falseTurnsPerHour": {
            "perHour": false_turns / hours if hours else 0.0,
            "turns": false_turns,
            "hours": hours,
        },
    }
    counts = {
        "scenes": len(scenes),
        "utterances": utterances,
        "matched": matched,
        "missed": missed,
        "falseTurns": false_turns,
        "audioSeconds": total_ms / 1000,
    }
    return {"metrics": metrics, "counts": counts}


# ---- denoise A/B ------------------------------------------------------------------------------------------------

DENOISE_RULE = (
    "keep a denoiser only if the word error rate does not worsen by more than 0.5 point "
    "and the share of no-speech clips that still produced words does not rise"
)
WER_TOLERANCE_PT = 0.5
AB_METRICS = (
    ("vadFrameF1", "f1", 3),
    ("onsetMs", "p50", 0),
    ("clipStartLossMs", "mean", 1),
    ("eotMs", "p50", 0),
    ("prematureCutPct", "pct", 1),
    ("nonSpeechTextPct", "pct", 1),
    ("falseTurnsPerHour", "perHour", 1),
)


def apply_denoiser(scenes: list[Scene], denoiser: Any) -> list[Scene]:
    """The same scenes with every clip run through ``denoiser.run_clip`` (same length, so the labels stay true)."""
    cleaned = []
    for s in scenes:
        samples = np.asarray(denoiser.run_clip(s.samples), dtype=np.float32)
        cleaned.append(Scene(id=s.id, kind=s.kind, samples=samples, utterances=s.utterances, text=s.text))
    return cleaned


def word_error_rate(scenes: list[Scene], transcribe: Callable[[np.ndarray], str] | None) -> dict:
    """Corpus word error rate over the speech clips that have reference text: edits over reference words (not a mean of
    per-clip rates). ``wer`` is None when no recogniser is plugged in or no clip has text."""
    if transcribe is None:
        return {"wer": None, "words": 0, "clips": 0}
    edits = words = clips = 0
    for scene in scenes:
        reference = stt_bench.normalise(scene.text)
        if scene.kind != "speech" or not reference:
            continue
        count = len(reference.split())
        edits += round(stt_bench.wer(scene.text, transcribe(scene.samples)) * count)
        words += count
        clips += 1
    return {"wer": edits / words if words else None, "words": words, "clips": clips}


def _scalar(report: dict, name: str, key: str) -> float | None:
    part = report["metrics"][name]
    if key == "pct":
        return part["estimate"] * 100 if part.get("n") else None
    value = part.get(key)
    return None if value is None else float(value)


def adopt_verdict(raw: dict, den: dict) -> dict:
    """The adopt rule. ``keep`` is None (undecided) when the word error rate was not measured on both sides."""
    wer_raw, wer_den = raw["wer"]["wer"], den["wer"]["wer"]
    if wer_raw is None or wer_den is None:
        return {
            "keep": None,
            "why": "no word error rate (needs the owner's recordings with text and a recogniser)",
        }
    worse_pt = (wer_den - wer_raw) * 100
    halluc_raw = _scalar(raw["report"], "nonSpeechTextPct", "pct")
    halluc_den = _scalar(den["report"], "nonSpeechTextPct", "pct")
    rose = halluc_raw is not None and halluc_den is not None and halluc_den > halluc_raw
    keep = worse_pt <= WER_TOLERANCE_PT and not rose
    why = f"WER {worse_pt:+.2f} pt (limit +{WER_TOLERANCE_PT}); no-speech text {'rose' if rose else 'did not rise'}"
    return {"keep": keep, "why": why}


def denoise_ab(
    scenes: list[Scene],
    ears: Ears,
    engines: list[str],
    *,
    transcribe: Callable[[np.ndarray], str] | None = None,
    denoiser_factory: Callable[[str], Any] | None = None,
) -> dict:
    """Score ``ears`` on the raw scenes, then on the same scenes after each denoiser, and say whether to keep each.

    ``transcribe(samples)`` is the recogniser behind the gate: it gives the word error rate (speech clips with text)
    and the text of the turns on no-speech clips. A denoiser whose model is not on disk is skipped with its reason."""
    if denoiser_factory is None:
        import denoise_onnx

        denoiser_factory = denoise_onnx.StreamDenoiser

    recogniser = transcribe
    behind_gate = None if recogniser is None else (lambda x, _t: recogniser(x))

    def one(name: str, material: list[Scene], status: dict) -> dict:
        report = evaluate(material, ears, behind_gate)
        return {"engine": name, "status": status, "report": report, "wer": word_error_rate(material, transcribe)}

    runs = [one("raw", scenes, {"active": True, "reason": "", "rtf": None})]
    skipped: list[dict] = []
    for name in engines:
        denoiser = denoiser_factory(name)
        if not denoiser.active:
            skipped.append({"engine": name, "reason": denoiser.status()["reason"]})
            continue
        material = apply_denoiser(scenes, denoiser)
        status = denoiser.status()
        if not status.get("active", True):  # it fell to passthrough part-way: later clips are raw, so no verdict
            skipped.append({"engine": name, "reason": f"stopped mid-run: {status.get('reason') or 'unknown'}"})
            continue
        runs.append(one(name, material, status))
    verdicts = {r["engine"]: adopt_verdict(runs[0], r) for r in runs[1:]}
    return {"rule": DENOISE_RULE, "runs": runs, "skipped": skipped, "verdicts": verdicts}


def ab_rows(ab: dict) -> list[str]:
    """One row per metric (raw, then each denoiser with its change), the WER row, the speed, a verdict per engine."""
    raw, others = ab["runs"][0], ab["runs"][1:]

    def cell(run: dict, name: str, key: str, digits: int) -> str:
        value = _scalar(run["report"], name, key)
        base = _scalar(raw["report"], name, key)
        if value is None:
            return f"{run['engine']} n/a"
        shown = f"{run['engine']} {value:.{digits}f}"
        if run is not raw and base is not None:
            shown += f" ({value - base:+.{digits}f})"
        return shown

    rows = [f"denoise A/B (raw vs {', '.join(r['engine'] for r in others) or 'nothing: no denoiser model on disk'})"]
    rows.append(f"rule: {ab['rule']}")
    for name, key, digits in AB_METRICS:
        rows.append(f"{name}: " + " | ".join(cell(r, name, key, digits) for r in ab["runs"]))
    wers = []
    for r in ab["runs"]:
        value = r["wer"]["wer"]
        wers.append(f"{r['engine']} n/a" if value is None else f"{r['engine']} {value * 100:.2f}%")
    rows.append("WER: " + " | ".join(wers) + ("" if raw["wer"]["wer"] is not None else " (not measured: UNVERIFIED)"))
    speeds = [f"{r['engine']} {r['status']['rtf']:.3f}" for r in others if r["status"].get("rtf") is not None]
    if speeds:
        rows.append("denoise real-time factor (this machine, below 1 keeps up): " + ", ".join(speeds))
    for skip in ab["skipped"]:
        rows.append(f"SKIP {skip['engine']}: {skip['reason']}")
    for engine, verdict in ab["verdicts"].items():
        state = {True: "KEEP", False: "DROP", None: "UNDECIDED"}[verdict["keep"]]
        rows.append(f"{engine}: {state} ({verdict['why']})")
    return rows


# ---- report and command line ------------------------------------------------------------------------------------


def _n(value: float | None, digits: int = 0) -> str:
    return "n/a" if value is None else f"{value:.{digits}f}"


def _range(part: dict) -> str:
    if part["n"] == 0:
        return "n/a over 0 trials"
    return f"{part['estimate'] * 100:.1f}% (95% {part['low'] * 100:.1f}-{part['high'] * 100:.1f}, n={part['n']})"


def metric_rows(report: dict) -> list[str]:
    m = report["metrics"]

    def timing(p: dict) -> str:
        return f"p50 {_n(p['p50'])} p90 {_n(p['p90'])} (n={p['n']})"

    return [
        f"vadFrameF1: {m['vadFrameF1']['f1']:.3f} (precision {m['vadFrameF1']['precision']:.3f}, "
        f"recall {m['vadFrameF1']['recall']:.3f}, {m['vadFrameF1']['frames']} frames)",
        f"onsetMs: {timing(m['onsetMs'])}",
        f"clipStartLossMs: mean {_n(m['clipStartLossMs']['mean'], 1)} p90 {_n(m['clipStartLossMs']['p90'])} "
        f"({m['clipStartLossMs']['withLoss']} of {m['clipStartLossMs']['n']} clipped)",
        f"eotMs: {timing(m['eotMs'])}",
        f"prematureCutPct: {_range(m['prematureCutPct'])}",
        f"nonSpeechTextPct: {_range(m['nonSpeechTextPct'])}",
        f"falseTurnsPerHour: {m['falseTurnsPerHour']['perHour']:.1f} "
        f"({m['falseTurnsPerHour']['turns']} turns in {m['falseTurnsPerHour']['hours']:.3f} h)",
    ]


def main(
    argv: list[str] | None = None,
    *,
    out: Callable[[str], None] = print,
    ears: Ears | None = None,
    transcribe: Callable[[np.ndarray], str] | None = None,
    denoiser_factory: Callable[[str], Any] | None = None,
) -> int:
    """``--synthetic`` scores the fixture scenes; ``--owner [--root DIR]`` scores the owner's recordings.
    ``--denoise-ab [engines]`` compares raw against each denoiser (``transcribe`` is the recogniser behind the gate).
    Exit 0 done, 1 usage, 2 refused (a bad set, or a root inside the repository), 3 no data (a visible SKIP)."""
    import argparse

    ap = argparse.ArgumentParser(prog="ears_eval.py")
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--synthetic", action="store_true", help="render core/fixtures/ears/manifest.json")
    mode.add_argument("--owner", action="store_true", help="score <root>/voice-eval/ears")
    ap.add_argument("--manifest", default=str(DEFAULT_MANIFEST))
    ap.add_argument("--root", default=os.environ.get("FRIDAY_ROOT", ""))
    ap.add_argument("--json", action="store_true", help="print the whole report as JSON after the rows")
    ap.add_argument(
        "--denoise-ab",
        nargs="?",
        const=",".join(DENOISE_ENGINES),
        default=None,
        metavar="ENGINES",
        help="compare raw against each denoiser (comma list, default all); a model not on disk is a visible SKIP",
    )
    try:
        args = ap.parse_args(argv)
    except SystemExit:
        return EXIT_USAGE
    subject: Ears = ears if ears is not None else EnergyBaseline()
    try:
        if args.synthetic:
            scenes = load_scenes(Path(args.manifest))
            source = "synthetic scenes (rendered by numpy; not the owner's microphone)"
        else:
            if not args.root:
                out("SKIP: no data root (--root or FRIDAY_ROOT); owner recordings are read from <root>/voice-eval/ears")
                return EXIT_NO_DATA
            scenes = load_owner_scenes(Path(args.root))
            if not scenes:
                out(f"SKIP: no owner recordings in {owner_folder(Path(args.root))} (voice-eval/ears); nothing measured")
                return EXIT_NO_DATA
            source = f"owner recordings ({len(scenes)} clips)"
        if args.denoise_ab is not None:
            names = [n.strip() for n in args.denoise_ab.split(",") if n.strip()]
            unknown = [n for n in names if n not in DENOISE_ENGINES]
            if not names or unknown:
                out(f"REFUSED: --denoise-ab engines are {', '.join(DENOISE_ENGINES)} (got {args.denoise_ab!r})")
                return EXIT_USAGE
            ab = denoise_ab(scenes, subject, names, transcribe=transcribe, denoiser_factory=denoiser_factory)
            out(f"ears eval over {source}")
            for row in ab_rows(ab):
                out(row)
            if args.json:
                out(json.dumps(ab, ensure_ascii=False, sort_keys=True))
            return EXIT_NO_DATA if not ab["verdicts"] else EXIT_OK
        report = evaluate(scenes, subject)
    except ValueError as exc:
        out(f"REFUSED: {exc}")
        return EXIT_REFUSED
    out(f"ears eval over {source}")
    for row in metric_rows(report):
        out(row)
    if args.json:
        out(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
