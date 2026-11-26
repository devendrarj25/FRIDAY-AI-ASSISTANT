"""FRIDAY Ears: the room and the speaker as scores (``ear_scene``) and their seam in the stream engine.

Synthetic signals with a fixed seed only: a harmonic mix with a kick (music), a formant-filtered pulse train chopped
at the syllable rate (speech), noise chopped at 4 Hz, steady noise. No microphone, TV, network or date is involved, so
every threshold stays a lead until the owner's room measures it.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import ear_scene  # noqa: E402
import stream_ear  # noqa: E402
from ear_scene import (  # noqa: E402
    SceneTracker,
    SpeakerScorer,
    clean_embedding,
    fbank,
    read_window,
    tag_for,
)
from fake_transducer import FakeModel, write_model_dir  # noqa: E402
from stream_ear import EnergyVad, TransducerEngine  # noqa: E402
from transducer_loop import NemotronStream  # noqa: E402

R = 16000


# ---- synthetic rooms ----------------------------------------------------------------------------------------------


def music(seconds: float, seed: int = 0) -> np.ndarray:
    """Four chords of six harmonics with vibrato, a 2 Hz kick and a little hiss."""
    rng = np.random.default_rng(seed)
    t = np.arange(int(seconds * R)) / R
    warp = t - 0.004 * np.cos(2 * np.pi * 5.2 * t) / (2 * np.pi * 5.2)
    out = np.zeros_like(t)
    chords = [(261.6, 329.6, 392.0), (220.0, 261.6, 329.6), (174.6, 220.0, 261.6), (196.0, 246.9, 293.7)]
    for k, chord in enumerate(chords):
        mask = ((t >= k * seconds / 4) & (t < (k + 1) * seconds / 4)).astype(float)
        mask = np.convolve(mask, np.hanning(800) / np.hanning(800).sum(), mode="same")
        for f in chord:
            for h in range(1, 7):
                out += mask * (0.5 / h) * np.sin(2 * np.pi * f * h * warp)
    for b in np.arange(0, seconds, 0.5):
        i = int(b * R)
        n = min(int(0.15 * R), t.size - i)
        out[i : i + n] += 0.8 * np.sin(2 * np.pi * 55 * np.arange(n) / R) * np.exp(-np.arange(n) / (0.04 * R))
    out += 0.01 * rng.standard_normal(t.size)
    return (0.25 * out / np.abs(out).max()).astype(np.float32)


def speech(seconds: float, seed: int = 0, sentence_every: float | None = 4.0) -> np.ndarray:
    """A glottal pulse train (f0 100-150 Hz, formants moving every 220 ms) chopped at the syllable rate, a short gap
    between words and, every ``sentence_every`` seconds, a 0.5 s pause (None: an unbroken run, a TV)."""
    rng = np.random.default_rng(seed)
    n = int(seconds * R)
    t = np.arange(n) / R
    f0 = 120 + 25 * np.sin(2 * np.pi * 0.7 * t + seed) + 8 * np.sin(2 * np.pi * 2.3 * t)
    phase = 2 * np.pi * np.cumsum(f0) / R
    vowels = [(730, 1090), (270, 2290), (660, 1720), (300, 870), (530, 1840)]
    idx = (t / 0.22).astype(int)
    f1 = np.convolve(np.array([vowels[(i * 7 + seed) % 5][0] for i in idx], float), np.ones(800) / 800, mode="same")
    f2 = np.convolve(np.array([vowels[(i * 7 + seed) % 5][1] for i in idx], float), np.ones(800) / 800, mode="same")
    out = np.zeros(n)
    for h in range(1, 40):
        fh = h * f0
        env = np.exp(-0.5 * ((fh - f1) / 130) ** 2) + 0.6 * np.exp(-0.5 * ((fh - f2) / 200) ** 2) + 0.05
        out += env / h**0.5 * np.sin(h * phase)
    amp = (0.5 + 0.5 * np.sin(2 * np.pi * t / 0.22 - np.pi / 2)) ** 1.5
    gap = ((t % 0.9) > 0.72).astype(float)
    if sentence_every is not None:
        gap = np.maximum(gap, ((t % sentence_every) > sentence_every - 0.5).astype(float))
    gap = np.convolve(gap, np.hanning(400) / np.hanning(400).sum(), mode="same")
    amp *= 1 - gap
    out = out * amp + rng.standard_normal(n) * 0.03 * (1 - amp)
    return (0.3 * out / np.abs(out).max()).astype(np.float32)


def chopped_noise(seconds: float, hz: float = 4.0, depth: float = 0.9, seed: int = 0) -> np.ndarray:
    t = np.arange(int(seconds * R)) / R
    gain = 1 - depth + depth * (0.5 + 0.5 * np.sin(2 * np.pi * hz * t))
    return (0.2 * np.random.default_rng(seed).standard_normal(t.size) * gain).astype(np.float32)


def steady_noise(seconds: float, seed: int = 0) -> np.ndarray:
    return (0.1 * np.random.default_rng(seed).standard_normal(int(seconds * R))).astype(np.float32)


def tracker_over(audio: np.ndarray, **kw) -> SceneTracker:
    tracker = SceneTracker(score_scene=True, **kw)
    for i in range(0, audio.size, 320):
        tracker.push(audio[i : i + 320])
    return tracker


# ---- the room ------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("seed", [0, 1, 2])
def test_harmonic_music_reads_as_music_at_or_above_0_7(seed):
    tracker = tracker_over(music(9.0, seed))
    assert tracker.env is not None and tracker.env["kind"] == "music" and tracker.env["score"] >= 0.7
    assert tracker.raising is True


@pytest.mark.parametrize("seed", [0, 1, 2])
def test_speech_like_audio_reads_as_speech_and_does_not_raise(seed):
    tracker = tracker_over(speech(9.0, seed))
    assert tracker.env is not None and tracker.env["kind"] == "speech" and tracker.env["score"] >= 0.7
    assert tracker.raising is False


def test_noise_chopped_at_the_syllable_rate_reads_as_speech_and_steady_noise_as_noise():
    chopped = tracker_over(chopped_noise(6.0))
    assert chopped.env is not None and chopped.env["kind"] == "speech"
    steady = tracker_over(steady_noise(6.0))
    assert steady.env is not None and steady.env["kind"] == "noise" and steady.env["score"] >= 0.7
    assert steady.raising is False  # noise alone never raises the gate


def test_a_quiet_room_has_no_env_and_a_window_too_short_reads_nothing():
    assert tracker_over(np.zeros(R * 5, dtype=np.float32)).env is None
    assert read_window(np.zeros(1000, dtype=np.float32)) is None
    quiet = tracker_over(1e-4 * steady_noise(5.0))
    assert quiet.env is None and quiet.raising is False


def test_speech_that_never_pauses_for_twelve_seconds_is_a_tv_and_one_with_sentence_pauses_is_not():
    tv = tracker_over(speech(18.0, 0, sentence_every=None))
    assert tv.env is not None and tv.env["kind"] == "tv" and tv.env["score"] >= 0.7 and tv.raising is True
    talker = tracker_over(speech(18.0, 0, sentence_every=4.0))
    assert talker.env is not None and talker.env["kind"] == "speech" and talker.raising is False


def test_music_before_speech_does_not_count_toward_the_tv_run():
    tracker = tracker_over(np.concatenate([music(6.0), speech(8.0, 0, sentence_every=None)]))
    assert tracker.env is not None and tracker.env["kind"] == "speech" and tracker._run_ms <= 9000


def test_the_raise_needs_two_windows_and_leaves_with_hysteresis():
    tracker = SceneTracker(score_scene=True)
    one = music(1.5)
    tracker.push(one)
    assert tracker.raising is False  # one window is not enough
    tracker.push(music(1.5, 1))
    assert tracker.raising is True
    for _ in range(4):
        tracker.push(steady_noise(1.5))
    assert tracker.raising is False  # the music is gone


def test_scene_off_reads_nothing_and_a_tracker_with_both_off_ignores_the_audio():
    off = SceneTracker()
    off.push(music(6.0))
    assert off.windows == 0 and off.env is None and off.raising is False and off.speaker_tag is None
    speaker_only = SceneTracker(score_speaker=True)
    speaker_only.push(music(6.0))
    assert speaker_only.env is None and speaker_only.raising is False  # without scene scoring nothing can raise


def test_a_failing_reading_never_reaches_the_audio_path(monkeypatch):
    def boom(_x):
        raise RuntimeError("bad window")

    monkeypatch.setattr(ear_scene, "read_window", boom)
    tracker = SceneTracker(score_scene=True)
    tracker.push(music(3.0))  # does not raise
    assert tracker.env is None


def test_every_threshold_is_listed_as_a_lead():
    leads = ear_scene.leads()
    assert leads["ownerAt"] == 0.5 and leads["otherBelow"] == 0.25 and leads["gateStartRaised"] == 0.6
    assert leads["minWordsRaised"] == 2 and leads["tvRunS"] == 12.0


# ---- the speaker ---------------------------------------------------------------------------------------------------


def unit(*values: float) -> list[float]:
    vec = np.zeros(128)
    vec[: len(values)] = values
    return list(vec / np.linalg.norm(vec))


def test_the_tags_follow_the_leads_and_missing_scores_are_unknown():
    assert tag_for(0.5) == "owner" and tag_for(0.9) == "owner"
    assert tag_for(0.2499) == "other" and tag_for(-0.3) == "other"
    assert tag_for(0.25) == "unknown" and tag_for(0.49) == "unknown"
    assert tag_for(None) == "unknown" and tag_for(float("nan")) == "unknown"


def test_a_window_is_scored_against_the_owner_embedding_by_cosine():
    owner = unit(1.0)
    scorer = SpeakerScorer(owner, embedder=lambda _w: np.asarray(unit(1.0, 0.2)))
    assert scorer.ready and 0.97 < (scorer.score(np.zeros(100)) or 0) <= 1.0
    other = SpeakerScorer(owner, embedder=lambda _w: np.asarray(unit(0.0, 1.0)))
    assert other.score(np.zeros(100)) == pytest.approx(0.0, abs=1e-9)


def test_no_owner_embedding_no_model_or_a_failing_model_leaves_the_speaker_unknown(tmp_path):
    assert SpeakerScorer(None, embedder=lambda _w: np.asarray(unit(1.0))).score(np.zeros(100)) is None
    missing = SpeakerScorer(unit(1.0), model_path=lambda: None)
    assert missing.score(np.zeros(100)) is None and missing.ready is False
    bad_file = tmp_path / "model_int8.onnx"
    bad_file.write_bytes(b"not a model")
    broken = SpeakerScorer(unit(1.0), model_path=lambda: bad_file)
    assert broken.score(np.zeros(100)) is None and broken.ready is False  # onnxruntime or the file fails: unknown

    def explode(_w):
        raise RuntimeError("no")

    assert SpeakerScorer(unit(1.0), embedder=explode).score(np.zeros(100)) is None


@pytest.mark.parametrize(
    "raw",
    [None, "abc", b"x" * 100, [1.0] * 10, [1.0] * 5000, [float("nan")] * 128, [True] * 128, [0.0] * 128, ["a"] * 128],
)
def test_an_odd_owner_embedding_is_refused(raw):
    assert clean_embedding(raw) is None


def test_a_good_owner_embedding_becomes_a_unit_vector():
    vec = clean_embedding([3.0] * 64 + [4.0] * 64)
    assert vec is not None and vec.size == 128 and float(np.linalg.norm(vec)) == pytest.approx(1.0)


def test_the_fbank_is_80_mel_log_features_with_zero_mean_and_finite():
    feats = fbank(speech(1.5))
    assert feats.shape == (148, 80) and np.all(np.isfinite(feats))
    assert float(np.abs(feats.mean(axis=0)).max()) < 1e-3
    assert fbank(np.zeros(100, dtype=np.float32)).shape[1] == 80  # a clip shorter than a frame is padded, not refused


def test_the_tracker_tags_the_turn_from_the_windows_of_speech_it_heard():
    owner_embed = SpeakerScorer(unit(1.0), embedder=lambda _w: np.asarray(unit(1.0, 0.1)))
    tracker = SceneTracker(score_scene=True, score_speaker=True, speaker=owner_embed)
    assert tracker.speaker_tag == {"tag": "unknown", "score": None}  # nothing heard yet
    tracker.push(speech(4.5))
    assert tracker.speaker_tag is not None and tracker.speaker_tag["tag"] == "owner"
    tracker.new_turn()  # a new turn starts its own mean, and keeps the last window until it has its own
    stranger = SpeakerScorer(unit(1.0), embedder=lambda _w: np.asarray(unit(0.0, 1.0)))
    tracker.speaker = stranger
    tracker.push(speech(3.0, 1))
    assert tracker.speaker_tag == {"tag": "other", "score": 0.0}


def test_music_windows_are_not_scored_as_a_voice():
    calls = []

    def embed(window):
        calls.append(len(window))
        return np.asarray(unit(1.0))

    tracker = SceneTracker(score_scene=True, score_speaker=True, speaker=SpeakerScorer(unit(1.0), embedder=embed))
    tracker.push(music(6.0))
    assert calls == [] and tracker.speaker_tag == {"tag": "unknown", "score": None}


# ---- the seam in the stream engine ---------------------------------------------------------------------------------

OPEN_CHROME = [(1, 1), (3, 2), (3, 3), (3, 4), (6, 5)]


def int16(audio: np.ndarray) -> bytes:
    return (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()


def make_engine(tmp_path, script=None):
    model = FakeModel(script=script or OPEN_CHROME)
    folder = write_model_dir(tmp_path / "model", model.dims)
    return TransducerEngine(NemotronStream(model.factory, threads=1)), folder


def then_quiet(audio: np.ndarray, seconds: float = 1.2) -> np.ndarray:
    """The audio and a pause after it, so the turn ends and its closing note carries what was read meanwhile."""
    return np.concatenate([audio, np.zeros(int(seconds * R), dtype=np.float32)])


def drive(engine, audio, step=640):
    data, notes = int16(audio), []
    for i in range(0, len(data), step * 2):
        engine.feed(data[i : i + step * 2])
        notes += engine.take_turns()
    return notes


def silero_gate(engine):
    import vad_onnx

    class Level:
        def __call__(self, frame):
            return 0.9 if float((frame * frame).mean()) ** 0.5 > 0.02 else 0.05

        def reset(self):
            pass

    engine._vad = vad_onnx.SileroGate(vad_onnx.SileroStream(scorer=Level()), fallback=EnergyVad())
    engine.vad_engine = "silero"


def test_without_scene_or_other_voice_the_engine_builds_no_tracker_and_the_notes_are_the_old_ones(tmp_path):
    for ears in ({}, {"vad": "energy", "eagerness": "normal"}, {"scene": "off", "otherVoice": "off"}):
        engine, folder = make_engine(tmp_path)
        engine.open(folder, locale="en-US", ears=ears)
        assert engine._scene is None
        notes = drive(engine, music(6.0))
        assert notes and all(set(n) == {"turnId", "event", "text", "vadP", "speechMs"} for n in notes)
        assert engine._vad.margin_db == 12.0  # the gate is untouched
    plain, folder = make_engine(tmp_path)
    plain.open(folder, locale="en-US")  # no ears at all
    assert plain._scene is None and drive(plain, music(4.5)) == []


def test_scene_score_adds_env_to_the_turn_notes_and_raises_the_gate_and_the_words(tmp_path):
    engine, folder = make_engine(tmp_path)
    engine.open(folder, locale="en-US", ears={"vad": "energy", "scene": "score"})
    notes = drive(engine, then_quiet(music(6.0)))
    assert engine._vad.margin_db == 15.0  # the energy gate gains 3 dB, never loses
    withenv = [n for n in notes if "env" in n]
    assert withenv and withenv[-1]["env"]["kind"] == "music" and withenv[-1]["env"]["score"] >= 0.7
    assert all("speaker" not in n and "needsWake" not in n for n in notes)  # only what is switched on
    engine.reset()
    assert engine._vad.margin_db == 12.0  # a new utterance starts from the saved gate


def test_the_silero_start_becomes_0_6_and_never_goes_down(tmp_path):
    engine, folder = make_engine(tmp_path)
    engine.open(folder, locale="en-US", ears={"scene": "score"})
    silero_gate(engine)
    drive(engine, music(6.0))
    assert engine._vad._stream.start == 0.6
    engine.reset()
    assert engine._vad._stream.start == 0.5
    high, folder2 = make_engine(tmp_path / "b")
    high.open(folder2, locale="en-US", ears={"scene": "score"})
    silero_gate(high)
    high._vad._stream.start = 0.8  # the owner already asked for a stricter start
    drive(high, music(6.0))
    assert high._vad._stream.start == 0.8  # raising never lowers
    high.reset()
    assert high._vad._stream.start == 0.8


def test_a_one_word_final_is_dropped_while_music_holds_and_two_words_are_kept(tmp_path):
    one, folder = make_engine(tmp_path, script=OPEN_CHROME[:1])
    one.open(folder, locale="en-US", ears={"vad": "energy", "scene": "score"})
    drive(one, music(6.0))
    final = one.finalize()
    assert final["text"] == "" and final.get("dropped") == "scene-needs-words"
    many, folder2 = make_engine(tmp_path / "b")
    many.open(folder2, locale="en-US", ears={"vad": "energy", "scene": "score"})
    drive(many, music(6.0))
    assert "scene-needs-words" not in str(many.finalize().get("dropped", ""))
    calm, folder3 = make_engine(tmp_path / "c", script=OPEN_CHROME[:1])
    calm.open(folder3, locale="en-US", ears={"vad": "energy", "scene": "score"})
    drive(calm, speech(6.0))
    assert calm.finalize().get("dropped") != "scene-needs-words"  # speech alone keeps one-word commands


def other_voice_engine(tmp_path, mode, vector):
    engine, folder = make_engine(tmp_path)
    engine.open(folder, locale="en-US", ears={"vad": "energy", "otherVoice": mode, "ownerEmbedding": unit(1.0)})
    assert engine._scene is not None and engine._scene.speaker is not None
    engine._scene.speaker._embed = lambda _w: np.asarray(vector)
    return engine


def test_other_voice_score_only_tags_and_hold_also_marks_need_wake(tmp_path):
    scored = other_voice_engine(tmp_path, "score", unit(0.0, 1.0))
    notes = [n for n in drive(scored, then_quiet(speech(6.0))) if "speaker" in n]
    assert notes and notes[-1]["speaker"]["tag"] == "other" and "env" not in notes[-1]
    assert all("needsWake" not in n for n in notes)  # score is a tag only
    held = other_voice_engine(tmp_path / "b", "hold", unit(0.0, 1.0))
    held_notes = [n for n in drive(held, then_quiet(speech(6.0))) if "speaker" in n]
    assert held_notes[-1]["needsWake"] is True
    mine = other_voice_engine(tmp_path / "c", "hold", unit(1.0, 0.05))
    mine_notes = [n for n in drive(mine, then_quiet(speech(6.0))) if "speaker" in n]
    assert mine_notes[-1]["speaker"]["tag"] == "owner" and mine_notes[-1]["needsWake"] is False


def test_hold_marks_a_tv_as_need_wake_even_for_an_unknown_voice(tmp_path):
    engine, folder = make_engine(tmp_path)
    engine.open(folder, locale="en-US", ears={"vad": "energy", "scene": "score", "otherVoice": "hold"})
    notes = [n for n in drive(engine, then_quiet(speech(18.0, 0, sentence_every=None))) if "env" in n]
    assert notes[-1]["env"]["kind"] == "tv" and notes[-1]["needsWake"] is True
    assert notes[-1]["speaker"] == {"tag": "unknown", "score": None}


# ---- a speaker never approves and never lowers anything ------------------------------------------------------------


def test_an_owner_tag_never_lowers_the_gate_the_words_or_the_wake_need(tmp_path):
    engine, folder = make_engine(tmp_path, script=OPEN_CHROME[:1])
    engine.open(
        folder,
        locale="en-US",
        ears={"vad": "energy", "scene": "score", "otherVoice": "hold", "ownerEmbedding": unit(1.0)},
    )
    engine._scene.speaker._embed = lambda _w: np.asarray(unit(1.0))  # a perfect owner match on every window
    notes = drive(engine, then_quiet(speech(16.0, 0, sentence_every=None)))  # a TV whose voice matches the owner
    assert notes[-1]["speaker"]["tag"] == "owner" and notes[-1]["env"]["kind"] == "tv"
    assert notes[-1]["needsWake"] is True  # the owner tag did not take the wake need away
    assert engine._vad.margin_db == 15.0  # still raised: the owner tag did not relax the gate
    assert engine.finalize().get("dropped") == "scene-needs-words"  # still needs two words


def test_the_notes_only_ever_carry_tags_and_the_modules_name_no_approval():
    allowed = {"turnId", "event", "text", "vadP", "speechMs", "env", "speaker", "needsWake"}
    scene = SceneTracker(score_scene=True, score_speaker=True)
    engine = TransducerEngine()
    engine._scene, engine._hold_other = scene, True
    assert set(engine._scene_notes()) <= allowed - {"turnId", "event", "text", "vadP", "speechMs"}
    for module in (ear_scene, stream_ear):
        source = Path(str(module.__file__)).read_text(encoding="utf-8").lower()
        assert "auto_approve" not in source and "approve(" not in source and "authority" not in source
    seam = Path(str(ear_scene.__file__)).read_text(encoding="utf-8")
    assert "start = " not in seam and ".start =" not in seam  # this module never writes a threshold; the engine does


def test_the_gate_helper_is_a_max_so_it_cannot_lower_a_start():
    source = Path(str(stream_ear.__file__)).read_text(encoding="utf-8")
    assert "max(float(stream.start), GATE_START_RAISED)" in source
    assert "float(gate.margin_db) + 3.0" in source
