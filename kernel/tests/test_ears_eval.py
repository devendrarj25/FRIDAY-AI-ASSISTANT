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


# ---- the denoise A/B ---------------------------------------------------------------------------------------------


class FakeDenoiser:
    """A denoiser stand-in: ``gain`` scales the clip, ``active=False`` is a model that is not on disk."""

    def __init__(self, name, gain=1.0, active=True, reason=""):
        self.name, self.gain, self.active, self.reason = name, gain, active, reason

    def run_clip(self, samples):
        return (np.asarray(samples) * self.gain).astype(np.float32)

    def status(self):
        return {
            "engine": self.name,
            "active": self.active,
            "reason": self.reason,
            "rtf": 0.125 if self.active else None,
        }


def _loud(kind, text="", utterances=None, sid="s"):
    samples = (np.random.default_rng(3).standard_normal(ee.RATE * 2) * 0.1).astype(np.float32)
    return ee.Scene(id=sid, kind=kind, samples=samples, utterances=utterances or [], text=text)


def _says_hello_when_it_hears_something(samples):
    return "hello world" if float(np.abs(samples).max()) > 0.01 else ""


_TURN = ee.Turn(start_ms=0, end_ms=1500, sent_start_ms=0, text="ok")


def _ab_scenes():
    return [_loud("speech", "hello world", [[(200, 1500)]], "say"), _loud("noise", sid="room")]


def test_apply_denoiser_keeps_the_labels_the_text_and_the_length_and_leaves_the_original_alone():
    scenes = _ab_scenes()
    before = scenes[0].samples.copy()
    out = ee.apply_denoiser(scenes, FakeDenoiser("half", gain=0.5))
    assert [(s.id, s.kind, s.utterances, s.text) for s in out] == [(s.id, s.kind, s.utterances, s.text) for s in scenes]
    assert all(len(a.samples) == len(b.samples) for a, b in zip(out, scenes, strict=True))
    assert np.allclose(out[0].samples, before * 0.5) and np.array_equal(scenes[0].samples, before)


def test_word_error_rate_is_edits_over_all_reference_words_not_a_mean_of_clip_rates():
    scenes = [_loud("speech", "one two three four", [[(0, 100)]], "a"), _loud("speech", "five", [[(0, 100)]], "b")]
    said = {id(scenes[0].samples): "one two three", id(scenes[1].samples): "six"}  # 1 edit in 4 words, 1 edit in 1 word
    got = ee.word_error_rate(scenes, lambda x: said[id(x)])
    assert got == {"wer": pytest.approx(2 / 5), "words": 5, "clips": 2}  # a mean of 0.25 and 1.0 would be 0.625
    assert ee.word_error_rate(scenes, None) == {"wer": None, "words": 0, "clips": 0}
    no_text = [_loud("speech", "", [[(0, 100)]]), _loud("noise")]  # no reference words, or not speech: not counted
    assert ee.word_error_rate(no_text, lambda x: "anything")["wer"] is None


def _run(wer, halluc_hits, n=4):
    estimate = halluc_hits / n
    metrics = {"nonSpeechTextPct": {"estimate": estimate, "n": n}}
    return {"report": {"metrics": metrics}, "wer": {"wer": wer, "words": 100, "clips": 5}}


def test_the_adopt_rule_keeps_a_denoiser_only_if_wer_stays_within_half_a_point_and_hallucinations_do_not_rise():
    raw = _run(0.100, 1)
    assert ee.adopt_verdict(raw, _run(0.104, 1))["keep"] is True  # +0.4 pt, no rise
    assert ee.adopt_verdict(raw, _run(0.090, 0))["keep"] is True  # better on both
    worse = ee.adopt_verdict(raw, _run(0.106, 1))  # +0.6 pt
    assert worse["keep"] is False and "+0.60 pt" in worse["why"]
    rose = ee.adopt_verdict(raw, _run(0.100, 2))  # WER the same, one more no-speech clip with words
    assert rose["keep"] is False and "rose" in rose["why"]
    assert ee.adopt_verdict(raw, _run(None, 1))["keep"] is None  # no word error rate: undecided, never a guess
    assert ee.adopt_verdict(_run(None, 1), _run(0.1, 1))["keep"] is None
    assert ee.WER_TOLERANCE_PT == 0.5 and "0.5 point" in ee.DENOISE_RULE


def test_the_ab_scores_raw_and_each_denoiser_and_says_keep_or_drop_by_the_rule():
    ears = Scripted([_TURN])
    engines = {
        "same": FakeDenoiser("same"),
        "mute": FakeDenoiser("mute", gain=0.0),
        "gone": FakeDenoiser("gone", active=False, reason="no file"),
    }
    ab = ee.denoise_ab(
        _ab_scenes(), ears, list(engines), transcribe=_says_hello_when_it_hears_something, denoiser_factory=engines.get
    )
    assert [r["engine"] for r in ab["runs"]] == ["raw", "same", "mute"]
    assert ab["skipped"] == [{"engine": "gone", "reason": "no file"}]
    assert ab["runs"][0]["wer"]["wer"] == 0.0 and ab["runs"][2]["wer"]["wer"] == 1.0  # the muted clip says nothing
    assert ab["verdicts"]["same"]["keep"] is True
    assert ab["verdicts"]["mute"]["keep"] is False  # no hallucination, but every word lost
    rows = ee.ab_rows(ab)
    assert rows[0].startswith("denoise A/B (raw vs same, mute)") and any(r.startswith("rule: ") for r in rows)
    assert any(r.startswith("WER: raw 0.00% | same 0.00% | mute 100.00%") for r in rows)
    assert "SKIP gone: no file" in rows and any(r.startswith("same: KEEP") for r in rows)
    assert any(r.startswith("mute: DROP") for r in rows) and any("real-time factor" in r for r in rows)
    assert [r.split(":")[0] for r in rows if r.split(":")[0] in ee.METRIC_NAMES] == list(ee.METRIC_NAMES)


class FailsPartWay(FakeDenoiser):
    """Cleans the first clip, then drops to passthrough the way ``StreamDenoiser._fail`` does."""

    def __init__(self, name):
        super().__init__(name)
        self.clips = 0

    def run_clip(self, samples):
        self.clips += 1
        if self.clips > 1:
            self.active, self.reason = False, "runtime error: RuntimeError: boom"
        return super().run_clip(samples)


def test_a_denoiser_that_fails_part_way_is_skipped_and_never_gets_a_keep_verdict():
    ab = ee.denoise_ab(
        _ab_scenes(),
        Scripted([_TURN]),
        ["flaky"],
        transcribe=_says_hello_when_it_hears_something,
        denoiser_factory=FailsPartWay,
    )
    assert [r["engine"] for r in ab["runs"]] == ["raw"] and ab["verdicts"] == {}
    assert len(ab["skipped"]) == 1 and ab["skipped"][0]["engine"] == "flaky"
    assert "boom" in ab["skipped"][0]["reason"] and "mid-run" in ab["skipped"][0]["reason"]
    assert any(r.startswith("SKIP flaky:") for r in ee.ab_rows(ab))


def test_without_a_recogniser_the_wer_is_unverified_and_the_verdict_undecided():
    ab = ee.denoise_ab(_ab_scenes(), Scripted([_TURN]), ["same"], denoiser_factory=lambda n: FakeDenoiser(n))
    rows = ee.ab_rows(ab)
    assert any(r.startswith("WER: raw n/a") and "UNVERIFIED" in r for r in rows)
    assert ab["verdicts"]["same"]["keep"] is None and any("UNDECIDED" in r for r in rows)


def test_cli_denoise_ab_prints_the_rows_and_a_missing_model_is_a_visible_skip(tmp_path, monkeypatch):
    lines: list[str] = []
    code = ee.main(
        ["--synthetic", "--denoise-ab", "gtcrn"], out=lines.append, denoiser_factory=lambda n: FakeDenoiser(n)
    )
    assert code == ee.EXIT_OK and any(ln.startswith("vadFrameF1: raw ") and "| gtcrn " in ln for ln in lines)
    monkeypatch.setenv("FRIDAY_ROOT", str(tmp_path))  # nothing on disk: the real denoisers are passthroughs
    lines = []
    assert ee.main(["--synthetic", "--denoise-ab"], out=lines.append) == ee.EXIT_NO_DATA
    assert sum(1 for ln in lines if ln.startswith("SKIP ")) == 2 and any("not on disk" in ln for ln in lines)
    lines = []
    assert ee.main(["--synthetic", "--denoise-ab", "magic"], out=lines.append) == ee.EXIT_USAGE
    assert lines and lines[0].startswith("REFUSED")


def test_owner_labels_may_carry_the_spoken_text_and_it_must_be_a_string(tmp_path):
    folder = tmp_path / "voice-eval" / "ears"
    folder.mkdir(parents=True)
    clip = np.concatenate([ee.silence(300, seed=1), ee.speech_like(1200, seed=9), ee.silence(500, seed=2)])
    _write_wav(folder / "a.wav", clip)
    label = {"kind": "speech", "utterances": [[[300, 1500]]], "text": "namaste friday"}
    (folder / "a.json").write_text(json.dumps(label), encoding="utf-8")
    assert [s.text for s in ee.load_owner_scenes(tmp_path)] == ["namaste friday"]
    (folder / "a.json").write_text(json.dumps({**label, "text": 5}), encoding="utf-8")
    with pytest.raises(ValueError, match="text must be a string"):
        ee.load_owner_scenes(tmp_path)
