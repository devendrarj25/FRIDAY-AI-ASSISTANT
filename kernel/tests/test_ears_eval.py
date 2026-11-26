import json
import math
import struct
import sys
import wave
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import ears_eval as ee  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
FIXTURE_DIR = REPO / "core" / "fixtures" / "ears"
SYNTHETIC_KINDS = {"speech", "music", "tv", "noise", "silence"}


def _scene(kind="speech", utterances=None, duration_ms=4000, sid="s"):
    samples = np.zeros(int(ee.RATE * duration_ms / 1000), dtype=np.float32)
    return ee.Scene(id=sid, kind=kind, samples=samples, utterances=utterances or [])


class Scripted:
    """An ears stand-in that answers with fixed turns, so each metric is checked on numbers worked out by hand."""

    def __init__(self, turns, frames=None):
        self.turns, self.frames = turns, frames

    def run(self, samples):
        n = len(samples) * 1000 // ee.RATE // ee.SLICE_MS
        return ee.EarsRun(frames=self.frames if self.frames is not None else [False] * n, turns=self.turns)


# ---- generators -------------------------------------------------------------------------------------------------


def test_generators_are_deterministic_bounded_and_the_right_length():
    for gen in (ee.speech_like, ee.music_like, ee.tv_like, ee.noise_floor, ee.silence):
        a, b, c = gen(1500, seed=3), gen(1500, seed=3), gen(1500, seed=4)
        assert a.dtype == np.float32 and len(a) == ee.RATE * 3 // 2
        assert np.array_equal(a, b), gen.__name__
        assert not np.array_equal(a, c), gen.__name__
        assert float(np.max(np.abs(a))) <= 1.0
    assert ee.dbfs(ee.silence(500, seed=1)) < -60
    assert len(ee.speech_like(0, seed=1)) == 0


def test_speech_like_has_a_syllable_rhythm_that_music_does_not():
    speech, music = ee.speech_like(3000, seed=1), ee.music_like(3000, seed=1)
    assert ee.syllabic_index(speech) > 2 * ee.syllabic_index(music)
    # the tv stand-in copies the rhythm of speech but is noise, not harmonics
    assert ee.syllabic_index(ee.tv_like(3000, seed=1)) > ee.syllabic_index(music)


def test_level_variants_hit_their_target_and_clipping_really_clips():
    base = ee.speech_like(2000, seed=2)
    assert abs(ee.dbfs(ee.scale_dbfs(base, -26.0)) - (-26.0)) < 0.5
    assert abs(ee.dbfs(ee.scale_dbfs(base, -45.0)) - (-45.0)) < 0.5
    hot = ee.clip(ee.scale_dbfs(base, -12.0), drive=8.0)
    assert float(np.max(np.abs(hot))) == 1.0
    assert float(np.mean(np.abs(hot) >= 0.999)) > 0.001
    assert float(np.mean(np.abs(ee.scale_dbfs(base, -26.0)) >= 0.999)) == 0.0


# ---- the seven metrics ------------------------------------------------------------------------------------------


def test_vad_frame_f1_counts_true_and_false_frames():
    truth = [False, True, True, True, False, False]
    assert ee.vad_frame_f1(truth, truth)["f1"] == 1.0
    out = ee.vad_frame_f1(truth, [True, True, True, False, False, False])
    assert (out["tp"], out["fp"], out["fn"]) == (2, 1, 1)
    assert out["precision"] == pytest.approx(2 / 3) and out["recall"] == pytest.approx(2 / 3)
    assert ee.vad_frame_f1(truth, [False] * 6)["recall"] == 0.0
    assert ee.vad_frame_f1([False] * 4, [False] * 4)["f1"] == 0.0  # nothing to find, nothing found: no score to claim


def test_onset_eot_and_clip_start_loss_come_from_matched_turns():
    scene = _scene(utterances=[[(1000, 2000)]])
    ears = Scripted([ee.Turn(start_ms=1060, end_ms=2420, sent_start_ms=1040, text="ok")])
    m = ee.evaluate([scene], ears)["metrics"]
    assert m["onsetMs"]["p50"] == 60
    assert m["eotMs"]["p50"] == 420
    assert m["clipStartLossMs"]["mean"] == 40  # the ASR was handed audio from 1040 ms, speech began at 1000
    assert m["prematureCutPct"]["estimate"] == 0.0


def test_a_turn_that_closes_inside_a_pause_is_a_premature_cut_and_its_tail_a_false_turn():
    scene = _scene(utterances=[[(500, 1500), (2100, 3000)]])
    ears = Scripted(
        [
            ee.Turn(start_ms=540, end_ms=1920, sent_start_ms=40, text="ok"),
            ee.Turn(start_ms=2140, end_ms=3420, sent_start_ms=2000, text="ok"),
        ]
    )
    report = ee.evaluate([scene], ears)
    assert report["metrics"]["prematureCutPct"]["estimate"] == 1.0
    assert report["metrics"]["prematureCutPct"]["n"] == 1
    assert report["counts"]["falseTurns"] == 1 and report["counts"]["missed"] == 0


def test_a_clip_with_no_start_loss_reports_zero_and_a_missed_utterance_is_counted_not_hidden():
    scene = _scene(utterances=[[(1000, 1800)], [(3000, 3500)]])
    ears = Scripted([ee.Turn(start_ms=1040, end_ms=2200, sent_start_ms=540, text="ok")])
    report = ee.evaluate([scene], ears)
    assert report["metrics"]["clipStartLossMs"]["mean"] == 0
    assert report["counts"]["missed"] == 1 and report["counts"]["utterances"] == 2


def test_a_turn_that_ended_before_the_speech_began_is_a_false_turn_not_a_match():
    scene = _scene(utterances=[[(3000, 3800)]])
    early = ee.Turn(start_ms=200, end_ms=900, sent_start_ms=0, text="ok")  # a cough, long over by the time she speaks
    report = ee.evaluate([scene], Scripted([early]))
    assert report["counts"]["missed"] == 1 and report["counts"]["falseTurns"] == 1
    assert report["metrics"]["onsetMs"]["n"] == 0 and report["metrics"]["prematureCutPct"]["n"] == 0


def test_non_speech_text_counts_only_clips_that_gave_words():
    scenes = [_scene("music", sid="m"), _scene("noise", sid="n"), _scene("silence", sid="q"), _scene("tv", sid="t")]
    turn = [ee.Turn(start_ms=500, end_ms=1500, sent_start_ms=0, text="")]

    def says(text):
        return lambda samples, turn: text

    hmm = ee.evaluate(scenes, Scripted(turn), transcribe=says("Thanks for watching"))["metrics"]["nonSpeechTextPct"]
    assert hmm["estimate"] == 1.0 and hmm["n"] == 4
    # punctuation and a blank are not words
    none = ee.evaluate(scenes, Scripted(turn), transcribe=says(" . "))["metrics"]["nonSpeechTextPct"]
    assert none["estimate"] == 0.0
    # Hindi text counts as text, and a gate that lets nothing through scores zero
    hindi = ee.evaluate(scenes[:1], Scripted(turn), transcribe=says("धन्यवाद"))["metrics"]["nonSpeechTextPct"]
    assert hindi["estimate"] == 1.0
    closed = ee.evaluate(scenes, Scripted([]), transcribe=says("anything"))["metrics"]["nonSpeechTextPct"]
    assert closed["estimate"] == 0.0


def test_false_turns_per_hour_scales_the_count_by_the_audio_length():
    half_hour = 1_800_000
    scene = _scene("tv", duration_ms=half_hour)
    two = [
        ee.Turn(start_ms=1000, end_ms=3000, sent_start_ms=500),
        ee.Turn(start_ms=9000, end_ms=11000, sent_start_ms=8500),
    ]
    m = ee.evaluate([scene], Scripted(two))["metrics"]["falseTurnsPerHour"]
    assert m["perHour"] == pytest.approx(4.0) and m["turns"] == 2 and m["hours"] == pytest.approx(0.5)


def test_evaluate_refuses_an_empty_set_and_a_scene_of_an_unknown_kind():
    with pytest.raises(ValueError, match="no scenes"):
        ee.evaluate([], Scripted([]))
    with pytest.raises(ValueError, match="kind"):
        ee.evaluate([_scene("dog")], Scripted([]))


def test_a_speech_scene_with_no_speech_to_find_refuses_instead_of_a_silent_zero():
    with pytest.raises(ValueError, match="utterance"):
        ee.evaluate([_scene("speech", utterances=[])], Scripted([]))


# ---- the fixture and the built-in baseline ----------------------------------------------------------------------


def test_manifest_is_synthetic_specs_only_and_covers_every_hard_case():
    files = sorted(p.name for p in FIXTURE_DIR.iterdir())
    assert files == ["manifest.json"], "specs only: no audio, no recordings in the repository"
    manifest = json.loads((FIXTURE_DIR / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["version"] == 1 and manifest["synthetic"] is True
    scenes = ee.load_scenes(FIXTURE_DIR / "manifest.json")
    assert {s.kind for s in scenes} == SYNTHETIC_KINDS
    ids = [s.id for s in scenes]
    assert len(ids) == len(set(ids))
    for needed in ("quiet", "loud", "clipped", "pause", "oneword", "over-tv"):
        assert any(needed in i for i in ids), needed
    assert all(len(s.samples) == manifest["scenes"][n]["durationMs"] * ee.RATE // 1000 for n, s in enumerate(scenes))


@pytest.mark.parametrize(
    "edit",
    [
        lambda m: m["scenes"].append({**m["scenes"][0]}),  # a repeated id
        lambda m: m["scenes"][0].update(kind="dog"),
        lambda m: m["scenes"][0].update(level="deafening"),
        lambda m: m["scenes"][0]["utterances"][0].__setitem__(0, [3900, 99000]),  # speech past the end
        lambda m: m.update(version=2),
    ],
)
def test_a_bad_manifest_is_refused(tmp_path, edit):
    manifest = json.loads((FIXTURE_DIR / "manifest.json").read_text(encoding="utf-8"))
    edit(manifest)
    bad = tmp_path / "manifest.json"
    bad.write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(ValueError):
        ee.load_scenes(bad)


def test_the_energy_baseline_hears_speech_ignores_silence_and_cuts_a_long_pause():
    by_id = {s.id: s for s in ee.load_scenes(FIXTURE_DIR / "manifest.json")}
    base = ee.EnergyBaseline()
    quiet_room = base.run(by_id["silence"].samples)
    assert quiet_room.turns == [] and not any(quiet_room.frames)
    spoken = next(s for s in by_id.values() if s.id.startswith("speech-normal"))
    run = base.run(spoken.samples)
    assert len(run.frames) == len(spoken.samples) * 1000 // ee.RATE // ee.SLICE_MS
    assert run.turns and run.turns[0].start_ms >= spoken.utterances[0][0][0]
    assert all(t.text for t in run.turns)
    pause = next(s for s in by_id.values() if "pause" in s.id)
    long_gap = pause.utterances[0][1][0] - pause.utterances[0][0][1]
    assert long_gap > base.hangover_ms, "the fixture pause must be longer than the baseline's patience"
    cut = ee.evaluate([pause], base)
    assert cut["metrics"]["prematureCutPct"]["estimate"] == 1.0


def test_synthetic_report_has_seven_metrics_and_is_the_same_every_run():
    first = ee.evaluate(ee.load_scenes(FIXTURE_DIR / "manifest.json"), ee.EnergyBaseline())
    second = ee.evaluate(ee.load_scenes(FIXTURE_DIR / "manifest.json"), ee.EnergyBaseline())
    assert first == second
    assert list(first["metrics"]) == [
        "vadFrameF1", "onsetMs", "clipStartLossMs", "eotMs", "prematureCutPct", "nonSpeechTextPct", "falseTurnsPerHour",
    ]  # fmt: skip
    assert 0.0 <= first["metrics"]["vadFrameF1"]["f1"] <= 1.0
    assert not math.isnan(first["metrics"]["falseTurnsPerHour"]["perHour"])


def test_cli_synthetic_prints_seven_rows_and_exits_zero():
    lines: list[str] = []
    assert ee.main(["--synthetic"], out=lines.append) == 0
    rows = [ln for ln in lines if ln.split(":")[0] in ee.METRIC_NAMES]
    assert [r.split(":")[0] for r in rows] == list(ee.METRIC_NAMES) and len(rows) == 7
    assert any("synthetic" in ln.lower() for ln in lines), "the run says its numbers are synthetic, not the owner's mic"


# ---- owner recordings stay outside the repository ----------------------------------------------------------------


def _write_wav(path: Path, samples: np.ndarray):
    pcm = (np.clip(samples, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(ee.RATE)
        w.writeframes(pcm.tobytes())


def test_a_missing_owner_set_skips_visibly_and_measures_nothing(tmp_path, monkeypatch):
    monkeypatch.delenv("FRIDAY_ROOT", raising=False)
    lines: list[str] = []
    code = ee.main(["--owner", "--root", str(tmp_path)], out=lines.append)
    assert code == ee.EXIT_NO_DATA
    assert lines and lines[0].startswith("SKIP") and "voice-eval" in lines[0]
    assert not any(ln.split(":")[0] in ee.METRIC_NAMES for ln in lines), "no number is printed without data"
    assert ee.main(["--owner"], out=lines.append) == ee.EXIT_NO_DATA  # no root and no FRIDAY_ROOT


def test_owner_recordings_load_from_the_data_root_and_score_with_the_same_metrics(tmp_path):
    folder = tmp_path / "voice-eval" / "ears"
    folder.mkdir(parents=True)
    speech = ee.scale_dbfs(ee.speech_like(1500, seed=9), -26.0)
    clip = np.concatenate([ee.silence(700, seed=1), speech, ee.silence(1500, seed=2)])
    _write_wav(folder / "mic-01.wav", clip)
    (folder / "mic-01.json").write_text(json.dumps({"kind": "speech", "utterances": [[[700, 2200]]]}), encoding="utf-8")
    _write_wav(folder / "tv-01.wav", ee.scale_dbfs(ee.tv_like(2000, seed=5), -35.0))
    (folder / "tv-01.json").write_text(json.dumps({"kind": "tv", "utterances": []}), encoding="utf-8")
    (folder / "orphan.wav").write_bytes(b"not a wav")  # no label file: skipped, never guessed
    (folder / "bad.wav").write_bytes(b"RIFF")  # label but a broken wav: refused with the name
    (folder / "bad.json").write_text(json.dumps({"kind": "speech", "utterances": [[[0, 100]]]}), encoding="utf-8")
    with pytest.raises(ValueError, match="bad.wav"):
        ee.load_owner_scenes(tmp_path)
    (folder / "bad.wav").unlink()
    (folder / "bad.json").unlink()
    scenes = ee.load_owner_scenes(tmp_path)
    assert [s.id for s in scenes] == ["mic-01", "tv-01"]
    lines: list[str] = []
    assert ee.main(["--owner", "--root", str(tmp_path)], out=lines.append) == ee.EXIT_OK
    assert sum(1 for ln in lines if ln.split(":")[0] in ee.METRIC_NAMES) == 7
    assert any("owner" in ln.lower() for ln in lines)


def test_a_data_root_inside_the_repository_is_refused(tmp_path):
    lines: list[str] = []
    assert ee.main(["--owner", "--root", str(REPO / "temporary")], out=lines.append) == ee.EXIT_REFUSED
    assert lines[0].startswith("REFUSED")


def test_wav_reader_rejects_the_wrong_rate_and_stereo(tmp_path):
    path = tmp_path / "x.wav"
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(44100)
        w.writeframes(struct.pack("<hh", 1, 2) * 100)
    with pytest.raises(ValueError, match="16 kHz mono"):
        ee.read_wav(path)
