"""The voice evaluation proxies: pitch, tilt, rate and round-trip error on synthetic signals, and the sweep driver.

Every clip here is a sine, a harmonic stack or noise made in the test, and the speech engine and the recognisers are
small fakes, so nothing needs a model file, the network or the clock.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import friday_voice  # noqa: E402
import tts_eval  # noqa: E402


def _stack(f0, sr, secs=1.0, slope=1.0, amp=0.3, top=7500.0):
    """Harmonics at k*f0 with amplitude 1/k**slope. f0 may be an array (a glide) of one value per sample."""
    n = int(sr * secs)
    freq = np.full(n, f0, dtype=np.float64) if np.isscalar(f0) else np.asarray(f0, dtype=np.float64)
    phase = 2 * np.pi * np.cumsum(freq) / sr
    out = np.zeros(n)
    k = 1
    while k * float(np.max(freq)) < top and k < 80:
        out += np.sin(k * phase) / k**slope
        k += 1
    return (amp * out / np.max(np.abs(out))).astype(np.float32)


def _syllables(rate_hz, sr, secs=3.0, lead=0.0, tail=0.0):
    t = np.arange(int(sr * secs)) / sr
    env = 0.5 * (1 - np.cos(2 * np.pi * rate_hz * t))
    body = (0.4 * env * np.sin(2 * np.pi * 180 * t)).astype(np.float32)
    pad = lambda s: np.zeros(int(sr * s), dtype=np.float32)  # noqa: E731
    return np.concatenate([pad(lead), body, pad(tail)])


# ---- pitch ------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("sr", [16000, 22050, 44100])
@pytest.mark.parametrize("f0", [110.0, 200.0, 310.0])
def test_f0_track_finds_the_pitch_of_a_harmonic_stack(sr, f0):
    stats = tts_eval.f0_stats(tts_eval.f0_track(_stack(f0, sr), sr))
    assert stats["median_hz"] == pytest.approx(f0, rel=0.02)
    assert stats["voiced_ratio"] > 0.8


def test_f0_track_does_not_jump_an_octave_when_the_second_harmonic_is_strongest():
    sr = 22050
    n = sr
    t = np.arange(n) / sr
    x = 0.1 * np.sin(2 * np.pi * 200 * t) + 0.3 * np.sin(2 * np.pi * 400 * t) + 0.1 * np.sin(2 * np.pi * 600 * t)
    stats = tts_eval.f0_stats(tts_eval.f0_track(x.astype(np.float32), sr))
    assert stats["median_hz"] == pytest.approx(200.0, rel=0.03)


def test_f0_range_of_a_glide_is_measured_in_semitones():
    sr = 22050
    glide = np.linspace(150.0, 250.0, sr * 2)
    stats = tts_eval.f0_stats(tts_eval.f0_track(_stack(glide, sr, 2.0), sr))
    assert stats["range_st"] == pytest.approx(7.0, abs=0.9)  # 12*log2(240/160)
    assert stats["p10_hz"] < stats["median_hz"] < stats["p90_hz"]


def test_noise_and_silence_have_no_pitch():
    sr = 16000
    noise = np.random.default_rng(0).standard_normal(sr).astype(np.float32) * 0.1
    assert tts_eval.f0_stats(tts_eval.f0_track(noise, sr))["voiced_ratio"] < 0.2
    stats = tts_eval.f0_stats(tts_eval.f0_track(np.zeros(sr, dtype=np.float32), sr))
    assert stats["voiced_ratio"] == 0.0
    assert stats["median_hz"] == 0.0
    assert tts_eval.f0_track(np.zeros(5, dtype=np.float32), sr).size == 0


def test_semitones():
    assert tts_eval.semitones(400.0, 200.0) == pytest.approx(12.0)
    assert tts_eval.semitones(200.0, 200.0) == 0.0
    assert tts_eval.semitones(0.0, 200.0) == 0.0


# ---- tilt, rate, clipping, silence --------------------------------------------------------------------------------


def test_spectral_tilt_of_white_noise_is_flat_and_of_a_one_over_k_stack_is_steep():
    sr = 44100
    white = np.random.default_rng(1).standard_normal(sr * 2).astype(np.float32) * 0.1
    assert tts_eval.spectral_tilt(white, sr) == pytest.approx(0.0, abs=0.6)
    steep = tts_eval.spectral_tilt(_stack(110.0, sr, 2.0, slope=1.0), sr)
    steeper = tts_eval.spectral_tilt(_stack(110.0, sr, 2.0, slope=2.0), sr)
    assert steep == pytest.approx(-6.0, abs=1.5)
    assert steeper < steep - 3.0


def test_spectral_tilt_of_an_empty_or_silent_clip_is_zero():
    assert tts_eval.spectral_tilt(np.zeros(0, dtype=np.float32), 44100) == 0.0
    assert tts_eval.spectral_tilt(np.zeros(44100, dtype=np.float32), 44100) == 0.0


@pytest.mark.parametrize("rate", [3.0, 4.0, 5.0])
def test_speaking_rate_counts_amplitude_pulses_per_second(rate):
    sr = 22050
    assert tts_eval.speaking_rate(_syllables(rate, sr), sr) == pytest.approx(rate, rel=0.12)


def test_speaking_rate_ignores_leading_and_trailing_silence():
    sr = 22050
    assert tts_eval.speaking_rate(_syllables(4.0, sr, 3.0, lead=1.0, tail=1.5), sr) == pytest.approx(4.0, rel=0.12)


def test_a_steady_tone_and_silence_have_no_syllables():
    sr = 22050
    tone = np.sin(2 * np.pi * 200 * np.arange(sr * 2) / sr).astype(np.float32) * 0.3
    assert tts_eval.speaking_rate(tone, sr) < 0.8
    assert tts_eval.speaking_rate(np.zeros(sr, dtype=np.float32), sr) == 0.0


def test_clip_and_silence_ratios():
    sr = 16000
    x = np.zeros(sr, dtype=np.float32)
    x[: sr // 4] = 1.0
    assert tts_eval.clip_ratio(x) == pytest.approx(0.25, abs=1e-6)
    y = np.concatenate([np.zeros(sr // 2, dtype=np.float32), _syllables(4.0, sr, 0.5) + 0.2])
    assert tts_eval.silence_ratio(y, sr) == pytest.approx(0.5, abs=0.05)
    assert tts_eval.silence_ratio(np.zeros(0, dtype=np.float32), sr) == 1.0
    assert tts_eval.clip_ratio(np.zeros(0, dtype=np.float32)) == 0.0


def test_profile_has_every_number_the_report_needs():
    sr = 22050
    row = tts_eval.profile(_stack(210.0, sr, 2.0), sr)
    for key in ("seconds", "median_hz", "p10_hz", "p90_hz", "range_st", "voiced_ratio", "tilt_db_oct", "rate_syl_s"):
        assert key in row
    for key in ("clip_ratio", "silence_ratio", "leading_silence_ms"):
        assert key in row
    assert row["seconds"] == pytest.approx(2.0, abs=0.01)
    assert all(math.isfinite(v) for v in row.values())


# ---- resampling, timing, text -------------------------------------------------------------------------------------


def test_resample_keeps_a_tone_and_its_length():
    x = np.sin(2 * np.pi * 440 * np.arange(44100) / 44100).astype(np.float32) * 0.5
    y = tts_eval.resample(x, 44100, 16000)
    assert y.size == 16000
    assert y.dtype == np.float32
    spec = np.abs(np.fft.rfft(y))
    assert int(np.argmax(spec)) == 440
    assert tts_eval.resample(x, 44100, 44100) is not x
    assert np.array_equal(tts_eval.resample(x, 44100, 44100), x)
    assert tts_eval.resample(np.zeros(0, dtype=np.float32), 44100, 16000).size == 0


def test_rtf_is_compute_time_over_audio_time():
    assert tts_eval.rtf(1.0, 4.0) == pytest.approx(0.25)
    assert tts_eval.rtf(1.0, 0.0) == 0.0


@pytest.mark.parametrize(
    ("text", "first"),
    [
        ("Hello, I am Friday. Tell me more.", "Hello,"),
        ("नमस्ते। मैं फ्राइडे हूँ।", "नमस्ते।"),
        ("No punctuation at all here", "No punctuation at all here"),
        ("  ", ""),
    ],
)
def test_first_clause_ends_at_the_first_mark(text, first):
    assert tts_eval.first_clause(text) == first


def test_the_fixed_test_set_has_ten_distinct_sentences_in_each_of_four_kinds():
    sets = tts_eval.test_set()
    assert set(sets) == {"hi", "en", "hing-roman", "hing-deva"}
    seen = set()
    for kind, rows in sets.items():
        assert len(rows) == 10, kind
        seen.update(rows)
    assert len(seen) == 40
    assert all(any("ऀ" <= c <= "ॿ" for c in s) for s in sets["hi"])
    assert all(any("ऀ" <= c <= "ॿ" for c in s) for s in sets["hing-deva"])
    assert not any(any("ऀ" <= c <= "ॿ" for c in s) for s in sets["hing-roman"] + sets["en"])
    assert tts_eval.LANG_OF == {"hi": "hi", "en": "en", "hing-roman": "na", "hing-deva": "hi"}


# ---- round trip -------------------------------------------------------------------------------------------------


def test_error_rates_use_the_right_normaliser_for_each_kind():
    assert tts_eval.error_rates("en", "It's ten o'clock", "it is ten o'clock") == (0.0, 0.0)
    wer, cer = tts_eval.error_rates("hi", "आज मौसम अच्छा है", "आज मौसम अच्छा")
    assert wer == pytest.approx(0.25)
    assert 0 < cer < 0.3
    assert tts_eval.error_rates("hing-roman", "kaam ho gaya", "काम हो गया")[0] == 0.0
    assert tts_eval.error_rates("hing-deva", "मैसेज भेज दूँ", "मैसेज भेज दूं") == (0.0, 0.0)
    assert tts_eval.error_rates("hi", "", "")[0] == 0.0


def test_round_trip_averages_the_errors_per_kind_and_overall():
    clips = [
        {"kind": "en", "text": "hello there friend", "audio": np.zeros(3200, dtype=np.float32)},
        {"kind": "en", "text": "good morning", "audio": np.zeros(3200, dtype=np.float32)},
        {"kind": "hi", "text": "नमस्ते दोस्त", "audio": np.zeros(3200, dtype=np.float32)},
    ]
    heard = {"hello there friend": "hello there friend", "good morning": "good evening", "नमस्ते दोस्त": "नमस्ते दोस्त"}
    calls = []

    def listen(audio, kind, text):
        calls.append(kind)
        return heard[text]

    out = tts_eval.round_trip(clips, listen)
    assert out["en"]["n"] == 2
    assert out["en"]["wer"] == pytest.approx(0.25)
    assert out["hi"]["wer"] == 0.0
    assert out["all"]["n"] == 3
    assert out["all"]["wer"] == pytest.approx((0.0 + 0.5 + 0.0) / 3)
    assert calls == ["en", "en", "hi"]


def test_round_trip_counts_a_recogniser_that_fails_as_a_miss_not_a_crash():
    def broken(audio, kind, text):
        raise RuntimeError("no model")

    out = tts_eval.round_trip([{"kind": "en", "text": "hi", "audio": np.zeros(10, dtype=np.float32)}], broken)
    assert out["all"]["failed"] == 1
    assert out["all"]["wer"] == 1.0


# ---- ranking ----------------------------------------------------------------------------------------------------


def _row(rid, median, rng, tilt, wer=0.05, cer=0.03, base=None, clip=0.0):
    return {
        "id": rid,
        "base_of": base,
        "profile": {"median_hz": median, "range_st": rng, "tilt_db_oct": tilt, "clip_ratio": clip},
        "stt": {"all": {"wer": wer, "cer": cer, "n": 40}},
    }


def test_rank_keeps_only_candidates_that_pass_every_gate_and_picks_the_best():
    plain = _row("F2", 225.0, 9.0, -9.0, wer=0.06, cer=0.03)
    rows = [
        plain,
        _row("good", 215.0, 8.0, -7.0, wer=0.07, cer=0.04, base="F2"),
        _row("low-pitch", 170.0, 8.0, -7.0, base="F2"),
        _row("flat-melody", 215.0, 4.0, -7.0, base="F2"),
        _row("dull", 215.0, 8.0, -10.0, base="F2"),
        _row("unclear", 215.0, 8.0, -7.0, wer=0.12, cer=0.08, base="F2"),
        _row("clipped", 215.0, 8.0, -7.0, base="F2", clip=0.01),
    ]
    out = tts_eval.rank_candidates(rows)
    assert out["best"] == "good"
    assert [r["id"] for r in out["passed"]] == ["good"]
    why = {r["id"]: r["failed"] for r in out["rejected"]}
    assert why["low-pitch"] == ["f0_median"]
    assert why["flat-melody"] == ["f0_range"]
    assert why["dull"] == ["tilt"]
    assert why["unclear"] == ["stt"]
    assert why["clipped"] == ["clipping"]


def test_rank_with_no_passing_candidate_has_no_best_and_orders_by_fewest_failures():
    rows = [_row("F1", 200.0, 8.0, -9.0), _row("bad", 120.0, 2.0, -12.0, base="F1")]
    out = tts_eval.rank_candidates(rows)
    assert out["best"] is None
    assert out["rejected"][0]["id"] == "bad"


def test_rank_prefers_a_pitch_near_the_target_and_a_livelier_line():
    plain = _row("F2", 225.0, 9.0, -9.0)
    a = _row("a", 232.0, 7.0, -7.0, base="F2")
    b = _row("b", 212.0, 8.5, -7.0, base="F2")
    assert tts_eval.rank_candidates([plain, a, b])["best"] == "b"


# ---- the sweep with a fake engine ---------------------------------------------------------------------------------


class FakeVoice:
    sample_rate = 22050

    def __init__(self):
        self.calls = []

    def style(self, name):
        k = float("F1F2F3F4F5M1M2".index(name)) / 2 + 1
        return friday_voice.Style(np.full((1, 2, 3), k, dtype=np.float32), np.full((1, 2, 3), k, dtype=np.float32))

    def warm_up(self):
        return 0.0

    def synth(self, text, lang, style, steps=5, speed=1.0, seed=None):
        self.calls.append((text, lang, steps, speed, seed))
        f0 = 180.0 + 12.0 * float(style.ttl.reshape(-1)[0])
        return _stack(f0, self.sample_rate, 0.6 + 0.01 * len(text))


def _fake_listen(audio, kind, text):
    return text


CANDS = [
    {"id": "plainF2", "base": {"F2": 1.0}, "fx": "clean"},
    {"id": "mixA", "base": {"F2": 0.6, "F1": 0.4}, "fx": "warm", "speed_scale": 0.97, "steps": 4},
]


def test_sweep_renders_every_sentence_for_every_candidate_and_reports_the_numbers(tmp_path):
    voice = FakeVoice()
    report = tts_eval.run_sweep(voice, CANDS, per_kind=2, listen=_fake_listen, seed=7)
    assert [r["id"] for r in report["candidates"]] == ["plainF2", "mixA"]
    assert report["per_kind"] == 2
    for row in report["candidates"]:
        assert row["clips"] == 8
        assert row["profile"]["median_hz"] > 0
        assert row["stt"]["all"]["wer"] == 0.0
        assert row["rtf"] >= 0
        assert row["first_clause_ms"] >= 0
        assert set(row["by_kind"]) == {"hi", "en", "hing-roman", "hing-deva"}
    # the second candidate used its own steps and speed, and every call carried the fixed seed
    assert any(c[2] == 4 and c[3] == pytest.approx(0.97) for c in voice.calls)
    assert {c[4] for c in voice.calls} == {7}
    json.dumps(report)  # the report is plain data


def test_sweep_languages_follow_the_kind():
    voice = FakeVoice()
    tts_eval.run_sweep(voice, CANDS[:1], per_kind=1, listen=None, seed=1)
    langs = {c[1] for c in voice.calls}
    assert langs == {"hi", "en", "na"}


def test_sweep_without_a_recogniser_still_measures_the_voice():
    report = tts_eval.run_sweep(FakeVoice(), CANDS[:1], per_kind=1, listen=None, seed=1)
    assert "stt" not in report["candidates"][0] or report["candidates"][0]["stt"] is None


def test_sweep_shares_the_raw_render_between_candidates_that_differ_only_in_the_chain():
    voice = FakeVoice()
    twin = [
        {"id": "x", "base": {"F2": 1.0}, "fx": "clean"},
        {"id": "y", "base": {"F2": 1.0}, "fx": "warm"},
    ]
    tts_eval.run_sweep(voice, twin, per_kind=1, listen=None, seed=1, first_clause=False)
    assert len(voice.calls) == 4  # four sentences, rendered once for both


def test_sweep_can_save_listening_files(tmp_path):
    report = tts_eval.run_sweep(FakeVoice(), CANDS[:1], per_kind=1, listen=None, seed=1, audio_dir=tmp_path)
    files = sorted(p.name for p in (tmp_path / "plainF2").glob("*.wav"))
    assert files == ["en-01.wav", "hi-01.wav", "hing-deva-01.wav", "hing-roman-01.wav"]
    assert report["candidates"][0]["clips"] == 4


def test_the_default_candidates_are_the_nine_blends_plus_the_plain_bases():
    cands = tts_eval.default_candidates()
    ids = [c["id"] for c in cands]
    assert len(ids) == len(set(ids))
    assert {"plain-F1", "plain-F2", "plain-F4"} <= set(ids)
    blends = [c for c in cands if len(c["base"]) > 1]
    assert len(blends) >= 9
    for c in cands:
        assert sum(c["base"].values()) == pytest.approx(1.0)
        assert set(c["base"]) <= {"F1", "F2", "F4"}


# ---- the command line --------------------------------------------------------------------------------------------


def test_the_sweep_refuses_an_output_folder_inside_the_repository():
    messages = []
    inside = tts_eval.REPO_ROOT / "temporary" / "tts-sweep-out"
    code = tts_eval.main(["sweep", "--model-dir", str(inside), "--out", str(inside)], out=messages.append)
    assert code == tts_eval.EXIT_REFUSED
    assert "outside the repository" in messages[-1]
    assert not inside.exists()


def test_the_sweep_with_no_model_folder_measures_nothing(tmp_path):
    messages = []
    code = tts_eval.main(
        ["sweep", "--model-dir", str(tmp_path / "missing"), "--out", str(tmp_path / "o")], out=messages.append
    )
    assert code == tts_eval.EXIT_NO_DATA
    assert messages[-1].startswith("NO DATA")
    assert not (tmp_path / "o").exists()


def test_the_command_line_needs_a_known_command():
    assert tts_eval.main([], out=lambda _m: None) == tts_eval.EXIT_USAGE
    assert tts_eval.main(["frobnicate"], out=lambda _m: None) == tts_eval.EXIT_USAGE


def test_the_sweep_writes_its_report_outside_the_repository(tmp_path, monkeypatch):
    monkeypatch.setattr(tts_eval, "_open_engine", lambda folder: FakeVoice())
    messages = []
    model = tmp_path / "model"
    model.mkdir()
    out = tmp_path / "report"
    code = tts_eval.main(
        ["sweep", "--model-dir", str(model), "--out", str(out), "--per-kind", "1", "--only", "plain-F2,blend-a"],
        out=messages.append,
    )
    assert code == tts_eval.EXIT_OK
    report = json.loads((out / "tts-sweep.json").read_text(encoding="utf-8"))
    assert [r["id"] for r in report["candidates"]] == ["plain-F2", "blend-a"]
    assert report["ranking"]["best"] in (None, "blend-a")
    assert any("tts-sweep.json" in m for m in messages)


class PaddedVoice(FakeVoice):
    """Like the real graphs: half a second of digital silence before and after the voice."""

    def synth(self, text, lang, style, steps=5, speed=1.0, seed=None):
        body = super().synth(text, lang, style, steps, speed, seed)
        pad = np.zeros(self.sample_rate // 2, dtype=np.float32)
        return np.concatenate([pad, body, pad])


def test_sweep_trims_the_padding_before_measuring_unless_told_not_to():
    trimmed = tts_eval.run_sweep(PaddedVoice(), CANDS[:1], per_kind=1, listen=None, seed=1, first_clause=False)
    kept = tts_eval.run_sweep(PaddedVoice(), CANDS[:1], per_kind=1, listen=None, seed=1, first_clause=False, trim=False)
    assert trimmed["candidates"][0]["profile"]["leading_silence_ms"] < 60
    assert kept["candidates"][0]["profile"]["leading_silence_ms"] > 400
    assert trimmed["candidates"][0]["seconds"] < kept["candidates"][0]["seconds"] - 3.0
    assert trimmed["candidates"][0]["raw_seconds"] == pytest.approx(kept["candidates"][0]["raw_seconds"])


# ---- the recognisers, with the packages replaced by stand-ins -------------------------------------------------------


def test_whisper_listener_asks_for_the_language_of_the_kind_and_joins_the_segments(monkeypatch):
    import types

    seen = []

    class Seg:
        def __init__(self, text):
            self.text = text

    class FakeModel:
        def __init__(self, folder, **kw):
            seen.append(("open", folder, kw))

        def transcribe(self, audio, **kw):
            seen.append(("run", kw["language"], kw["beam_size"], audio.dtype))
            return iter([Seg(" hello "), Seg("there ")]), object()

    monkeypatch.setitem(sys.modules, "faster_whisper", types.SimpleNamespace(WhisperModel=FakeModel))
    listen = tts_eval.whisper_listener("/models/small")
    assert listen(np.zeros(1600, dtype=np.float64), "en", "x") == "hello there"
    assert listen(np.zeros(1600, dtype=np.float32), "hing-roman", "x") == "hello there"
    assert seen[0][0] == "open"
    assert seen[0][2]["local_files_only"] is True  # never a silent download
    assert [s[1] for s in seen if s[0] == "run"] == ["en", "hi"]
    assert all(s[3] == np.float32 for s in seen if s[0] == "run")


def test_hindi_ear_listener_reads_through_the_kernels_own_reader(monkeypatch):
    import hindi_ear

    opened = []
    monkeypatch.setattr(hindi_ear, "_load", lambda folder: opened.append(folder) or "model")
    monkeypatch.setattr(hindi_ear, "_read", lambda model, audio: (f"{model}:{audio.size}", 0.9))
    listen = tts_eval.hindi_ear_listener("/models/ear")
    assert listen(np.zeros(800, dtype=np.float32), "hi", "x") == "model:800"
    assert opened == [Path("/models/ear")]


def test_a_recogniser_that_cannot_open_is_named_and_the_sweep_still_measures(monkeypatch, tmp_path):
    def boom(folder):
        raise RuntimeError("no package")

    monkeypatch.setattr(tts_eval, "_open_engine", lambda folder: FakeVoice())
    monkeypatch.setattr(tts_eval, "whisper_listener", boom)
    messages = []
    model = tmp_path / "m"
    model.mkdir()
    code = tts_eval.main(
        ["sweep", "--model-dir", str(model), "--stt-dir", "x", "--out", str(tmp_path / "o"), "--per-kind", "1"],
        out=messages.append,
    )
    assert code == tts_eval.EXIT_OK
    assert any(m.startswith("NOTE: a recogniser did not open") for m in messages)
    assert (tmp_path / "o" / "tts-sweep.json").is_file()


def test_the_recipes_flag_measures_the_shipped_voices_next_to_the_plain_bases(monkeypatch, tmp_path):
    monkeypatch.setattr(tts_eval, "_open_engine", lambda folder: FakeVoice())
    model = tmp_path / "m"
    model.mkdir()
    code = tts_eval.main(
        [
            "sweep",
            "--model-dir",
            str(model),
            "--out",
            str(tmp_path / "o"),
            "--per-kind",
            "1",
            "--recipes",
            "friday,nope",
        ],
        out=lambda _m: None,
    )
    assert code == tts_eval.EXIT_OK
    report = json.loads((tmp_path / "o" / "tts-sweep.json").read_text(encoding="utf-8"))
    ids = [r["id"] for r in report["candidates"]]
    assert ids == ["plain-F1", "plain-F2", "plain-F4", "friday"]
    friday = report["candidates"][-1]
    assert friday["base_of"] == "plain-F2"
    assert friday["fx"]["compressor"]["makeup_db"] > 0


def test_no_matching_candidate_is_a_usage_error(monkeypatch, tmp_path):
    monkeypatch.setattr(tts_eval, "_open_engine", lambda folder: FakeVoice())
    model = tmp_path / "m"
    model.mkdir()
    code = tts_eval.main(
        ["sweep", "--model-dir", str(model), "--out", str(tmp_path / "o"), "--only", "ghost"], out=lambda _m: None
    )
    assert code == tts_eval.EXIT_USAGE
    assert not (tmp_path / "o").exists()


def test_fx_names_are_crossed_with_the_blends_and_name_their_plain_base(monkeypatch, tmp_path):
    monkeypatch.setattr(tts_eval, "_open_engine", lambda folder: FakeVoice())
    model = tmp_path / "m"
    model.mkdir()
    out = tmp_path / "o"
    code = tts_eval.main(
        [
            "sweep",
            "--model-dir",
            str(model),
            "--out",
            str(out),
            "--per-kind",
            "1",
            "--only",
            "plain-F2,blend-a",
            "--fx",
            "warm,calm",
        ],
        out=lambda _m: None,
    )
    assert code == tts_eval.EXIT_OK
    report = json.loads((out / "tts-sweep.json").read_text(encoding="utf-8"))
    assert [r["id"] for r in report["candidates"]] == ["plain-F2", "blend-a+warm", "blend-a+calm"]
    assert {r["base_of"] for r in report["candidates"][1:]} == {"plain-F2"}


# ---- which recogniser the gate trusts -------------------------------------------------------------------------------


def _per_kind(**kinds):
    return {k: {"wer": w, "cer": c, "n": n, "failed": 0} for k, (w, c, n) in kinds.items()}


def test_gate_stt_takes_hindi_from_the_ear_and_english_from_the_first_recogniser_and_skips_roman_hinglish():
    row = {
        "stt": _per_kind(
            en=(0.04, 0.02, 10),
            hi=(0.40, 0.14, 10),
            **{"hing-roman": (0.70, 0.30, 10)},
            **{"hing-deva": (0.45, 0.18, 10)},
        ),
        "stt_alt": {"hindi-ear": _per_kind(hi=(0.04, 0.02, 10), **{"hing-deva": (0.06, 0.03, 10)})},
    }
    got = tts_eval.gate_stt(row)
    assert got is not None
    assert got["kinds"] == ["en", "hi", "hing-deva"]
    assert got["n"] == 30
    assert got["wer"] == pytest.approx((0.04 + 0.04 + 0.06) / 3)
    assert got["cer"] == pytest.approx((0.02 + 0.02 + 0.03) / 3)


def test_gate_stt_without_the_ear_uses_the_first_recogniser_and_weights_by_clip_count():
    row = {"stt": _per_kind(en=(0.10, 0.05, 30), hi=(0.40, 0.20, 10))}
    got = tts_eval.gate_stt(row)
    assert got is not None
    assert got["wer"] == pytest.approx((0.10 * 30 + 0.40 * 10) / 40)
    assert tts_eval.gate_stt({"stt": None}) is None
    assert tts_eval.gate_stt({}) is None
    assert tts_eval.gate_stt({"stt": {"all": {"wer": 0.1, "cer": 0.1, "n": 5, "failed": 0}}}) is None


def test_rank_judges_the_gate_numbers_not_the_noisy_pooled_whisper_score():
    def row(rid, whisper_hi, ear_hi, base=None):
        return {
            "id": rid,
            "base_of": base,
            "profile": {
                "median_hz": 210.0,
                "range_st": 8.0,
                "tilt_db_oct": -6.0 if base is None else -5.0,
                "clip_ratio": 0.0,
            },
            "stt": _per_kind(en=(0.05, 0.02, 10), hi=(whisper_hi, 0.15, 10)),
            "stt_alt": {"hindi-ear": _per_kind(hi=(ear_hi, 0.02, 10))},
        }

    plain = row("plain", 0.30, 0.05)
    noisy_but_clear = row("a", 0.55, 0.05, base="plain")  # whisper hears it worse, the Hindi ear does not
    really_worse = row("b", 0.30, 0.15, base="plain")
    out = tts_eval.rank_candidates([plain, noisy_but_clear, really_worse])
    assert [e["id"] for e in out["passed"]] == ["a"]
    assert out["rejected"][0]["id"] == "b"
    assert out["rejected"][0]["failed"] == ["stt"]
    assert out["passed"][0]["stt_gate"]["kinds"] == ["en", "hi"]


def test_the_sweep_records_the_gate_numbers_when_a_recogniser_ran():
    report = tts_eval.run_sweep(
        FakeVoice(),
        CANDS[:1],
        per_kind=2,
        listen=_fake_listen,
        listen_alt={"hindi-ear": (_fake_listen, ("hi", "hing-deva"))},
        seed=1,
    )
    gate = report["candidates"][0]["stt_gate"]
    assert gate["kinds"] == ["en", "hi", "hing-deva"]
    assert gate["wer"] == 0.0
    assert set(report["candidates"][0]["stt_alt"]["hindi-ear"]) == {"hi", "hing-deva", "all"}
