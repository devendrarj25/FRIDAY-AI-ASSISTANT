"""FRIDAY Voice post-processing: streaming-safe filters, dynamics, limiter and chunk joins on synthetic signals.

No model, no network, no clock: every signal is a sine, a noise burst or a harmonic stack made here.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import voice_fx  # noqa: E402

RATES = (16000, 22050, 24000, 44100, 48000)


def _sine(freq: float, sr: int, secs: float = 1.0, amp: float = 0.3) -> np.ndarray:
    t = np.arange(int(sr * secs)) / sr
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def _rms_db(x: np.ndarray) -> float:
    x = np.asarray(x, dtype=np.float64)
    return 10 * math.log10(float(np.mean(x * x)) + 1e-20)


def _speechlike(sr: int, secs: float = 2.0, seed: int = 3) -> np.ndarray:
    rng = np.random.default_rng(seed)
    t = np.arange(int(sr * secs)) / sr
    f0 = 200 * (1 + 0.1 * np.sin(2 * np.pi * 3 * t))
    phase = 2 * np.pi * np.cumsum(f0) / sr
    voiced = sum(np.sin(k * phase) / k for k in range(1, 12))
    env = 0.5 * (1 + np.sin(2 * np.pi * 4 * t)) ** 2
    hiss = rng.standard_normal(t.size) * 0.05 * (0.5 + 0.5 * np.sin(2 * np.pi * 1.3 * t))
    out = 0.4 * voiced * env + hiss
    return (out / max(1e-9, float(np.max(np.abs(out)))) * 0.8).astype(np.float32)


def _chunked(chain: voice_fx.FxChain, x: np.ndarray, sizes: list[int]) -> np.ndarray:
    parts, i, k = [], 0, 0
    while i < x.size:
        size = sizes[k % len(sizes)]
        parts.append(chain.process(x[i : i + size]))
        i += size
        k += 1
    return np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)


def _reference_biquad(b: np.ndarray, a: np.ndarray, x: np.ndarray) -> np.ndarray:
    """The textbook sample loop (direct form I), the oracle for the block filter."""
    y = np.zeros(x.size)
    x1 = x2 = y1 = y2 = 0.0
    for n, v in enumerate(np.asarray(x, dtype=np.float64)):
        out = b[0] * v + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2
        x2, x1, y2, y1 = x1, v, y1, out
        y[n] = out
    return y


# ---- biquads ----------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("sr", RATES)
def test_biquad_block_filter_matches_the_sample_loop(sr):
    b, a = voice_fx.biquad_coefficients("peak", sr, 3500.0, 4.0, 1.2)
    x = np.random.default_rng(1).standard_normal(5000)
    got = voice_fx.Biquad(b, a).process(x)
    want = _reference_biquad(b / a[0], a / a[0], x)
    assert np.max(np.abs(got - want)) < 1e-9


def test_biquad_state_is_carried_across_chunks():
    b, a = voice_fx.biquad_coefficients("highpass", 44100, 80.0, 0.0, 0.7071)
    x = np.random.default_rng(2).standard_normal(9000)
    whole = voice_fx.Biquad(b, a).process(x)
    piece = voice_fx.Biquad(b, a)
    parts = np.concatenate([piece.process(x[i : i + 777]) for i in range(0, x.size, 777)])
    assert np.max(np.abs(whole - parts)) < 1e-9


def test_biquad_handles_blocks_longer_than_its_table_and_single_samples():
    b, a = voice_fx.biquad_coefficients("lowshelf", 48000, 200.0, 3.0, 0.7)
    x = np.random.default_rng(3).standard_normal(voice_fx.BLOCK * 2 + 17)
    one = voice_fx.Biquad(b, a)
    whole = one.process(x)
    single = voice_fx.Biquad(b, a)
    first = np.array([single.process(x[i : i + 1])[0] for i in range(300)])
    assert np.max(np.abs(whole[:300] - first)) < 1e-9
    assert np.all(np.isfinite(whole))


@pytest.mark.parametrize(
    ("kind", "freq", "gain", "probe", "expected"),
    [
        ("peak", 3500.0, 6.0, 3500.0, 6.0),
        ("peak", 3500.0, 6.0, 300.0, 0.0),
        ("lowshelf", 200.0, 4.0, 40.0, 4.0),
        ("lowshelf", 200.0, 4.0, 6000.0, 0.0),
        ("highshelf", 8000.0, 3.0, 20000.0, 3.0),
        ("highshelf", 8000.0, 3.0, 400.0, 0.0),
    ],
)
def test_rbj_filters_hit_their_designed_gain(kind, freq, gain, probe, expected):
    sr = 48000
    b, a = voice_fx.biquad_coefficients(kind, sr, freq, gain, 0.8)
    filt = voice_fx.Biquad(b, a)
    assert filt.gain_db(probe, sr) == pytest.approx(expected, abs=0.35)
    tone = _sine(probe, sr, 1.0, 0.2)
    out = filt.process(tone)
    measured = _rms_db(out[sr // 2 :]) - _rms_db(tone[sr // 2 :])
    assert measured == pytest.approx(filt.gain_db(probe, sr), abs=0.1)


def test_highpass_cuts_rumble_and_keeps_the_voice_band():
    sr = 44100
    b, a = voice_fx.biquad_coefficients("highpass", sr, 80.0, 0.0, 0.7071)
    low = voice_fx.Biquad(b, a).process(_sine(20.0, sr, 2.0))
    mid = voice_fx.Biquad(b, a).process(_sine(1000.0, sr, 1.0))
    assert _rms_db(low[sr:]) - _rms_db(_sine(20.0, sr, 1.0)) < -20
    assert _rms_db(mid[sr // 2 :]) - _rms_db(_sine(1000.0, sr, 0.5)) == pytest.approx(0.0, abs=0.1)


def test_filter_frequencies_are_clamped_below_nyquist():
    for sr in (8000, 16000, 44100):
        b, a = voice_fx.biquad_coefficients("peak", sr, 90000.0, 6.0, 1.0)
        out = voice_fx.Biquad(b, a).process(np.random.default_rng(4).standard_normal(4000))
        assert np.all(np.isfinite(out))
        assert np.all(np.abs(np.roots(a)) < 1.0)


# ---- the chain --------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("sr", RATES)
@pytest.mark.parametrize("name", sorted(voice_fx.DEFAULT_SPECS))
def test_chunking_does_not_change_the_result(sr, name):
    x = _speechlike(sr, 1.5)
    whole = voice_fx.FxChain(sr, voice_fx.DEFAULT_SPECS[name]).process(x)
    for sizes in ([1000], [1, 7, 4096, 333, 50000], [441, 1, 1, 2999]):
        got = _chunked(voice_fx.FxChain(sr, voice_fx.DEFAULT_SPECS[name]), x, sizes)
        assert got.shape == whole.shape
        assert np.max(np.abs(got - whole)) < 1e-5, (sr, name, sizes)


def test_one_sample_at_a_time_equals_the_whole_clip():
    sr = 22050
    x = _speechlike(sr, 0.4)
    spec = voice_fx.DEFAULT_SPECS["warm"]
    whole = voice_fx.FxChain(sr, spec).process(x)
    chain = voice_fx.FxChain(sr, spec)
    one = np.concatenate([chain.process(x[i : i + 1]) for i in range(x.size)])
    assert np.max(np.abs(one - whole)) < 1e-5


def test_reset_makes_the_chain_forget_the_clip():
    sr = 44100
    x = _speechlike(sr, 1.0)
    chain = voice_fx.FxChain(sr, voice_fx.DEFAULT_SPECS["warm"])
    first = chain.process(x)
    chain.process(_speechlike(sr, 0.5, seed=9))
    chain.reset()
    assert np.max(np.abs(chain.process(x) - first)) < 1e-6


def test_process_returns_float32_mono_and_leaves_the_input_alone():
    x = _speechlike(44100, 0.5)
    before = x.copy()
    out = voice_fx.FxChain(44100, voice_fx.DEFAULT_SPECS["warm"]).process(x)
    assert out.dtype == np.float32
    assert out.ndim == 1
    assert out.shape == x.shape
    assert np.array_equal(x, before)


def test_empty_and_odd_inputs_are_safe():
    chain = voice_fx.FxChain(44100, voice_fx.DEFAULT_SPECS["warm"])
    assert chain.process(np.zeros(0, dtype=np.float32)).size == 0
    assert chain.process([0.1, -0.1, 0.2]).dtype == np.float32
    assert chain.process(np.ones((2, 3), dtype=np.float32)).size == 6


def test_non_finite_input_never_makes_non_finite_output():
    x = _speechlike(44100, 0.5)
    x[100] = np.nan
    x[200] = np.inf
    x[300] = -np.inf
    chain = voice_fx.FxChain(44100, voice_fx.DEFAULT_SPECS["bright"])
    out = chain.process(x)
    assert np.all(np.isfinite(out))
    assert np.all(np.isfinite(chain.process(_speechlike(44100, 0.2))))


def test_an_empty_spec_is_clean_below_the_limiter():
    sr = 44100
    x = _speechlike(sr, 0.5) * 0.5
    out = voice_fx.FxChain(sr, {}).process(x)
    assert np.max(np.abs(out - x)) < 1e-6


def test_limiter_never_passes_its_ceiling_and_is_clean_below_its_knee():
    sr = 44100
    loud = _sine(300.0, sr, 0.5, 6.0)
    chain = voice_fx.FxChain(sr, {"limiter": {"threshold": 0.8, "ceiling": 0.95}})
    out = chain.process(loud)
    assert float(np.max(np.abs(out))) <= 0.95 + 1e-6
    quiet = _sine(300.0, sr, 0.2, 0.5)
    assert np.max(np.abs(chain.process(quiet) - quiet)) < 1e-6


def test_dc_offset_is_removed():
    sr = 44100
    x = np.full(sr * 2, 0.2, dtype=np.float32) + _sine(500.0, sr, 2.0, 0.05)
    out = voice_fx.FxChain(sr, {"dc_hz": 15}).process(x)
    assert abs(float(np.mean(out[sr:]))) < 0.003


def test_compressor_lowers_a_loud_tone_by_the_designed_amount():
    sr = 44100
    comp = {"threshold_db": -20.0, "ratio": 4.0, "knee_db": 0.0, "attack_ms": 5.0, "release_ms": 80.0}
    chain = voice_fx.FxChain(sr, {"compressor": comp, "limiter": {"threshold": 0.95, "ceiling": 0.99}})
    tone = _sine(400.0, sr, 1.5, 0.5)
    out = chain.process(tone)
    level_in = _rms_db(tone[sr:])
    level_out = _rms_db(out[sr:])
    over = level_in - comp["threshold_db"]
    assert level_in - level_out == pytest.approx(over * (1 - 1 / comp["ratio"]), abs=0.6)


def test_compressor_leaves_a_quiet_tone_alone_and_makeup_is_added():
    sr = 44100
    comp = {"threshold_db": -20.0, "ratio": 3.0, "knee_db": 6.0, "makeup_db": 0.0}
    tone = _sine(400.0, sr, 1.0, 0.01)
    quiet = voice_fx.FxChain(sr, {"compressor": comp}).process(tone)
    assert _rms_db(quiet[sr // 2 :]) - _rms_db(tone[sr // 2 :]) == pytest.approx(0.0, abs=0.05)
    comp["makeup_db"] = 3.0
    lifted = voice_fx.FxChain(sr, {"compressor": comp}).process(tone)
    assert _rms_db(lifted[sr // 2 :]) - _rms_db(tone[sr // 2 :]) == pytest.approx(3.0, abs=0.1)


def test_compressor_attack_is_slower_than_release_recovery_is_gradual():
    sr = 44100
    comp = {"threshold_db": -30.0, "ratio": 6.0, "knee_db": 0.0, "attack_ms": 20.0, "release_ms": 200.0}
    chain = voice_fx.FxChain(sr, {"compressor": comp})
    loud = _sine(300.0, sr, 0.5, 0.5)
    out = chain.process(np.concatenate([loud, _sine(300.0, sr, 0.5, 0.01)]))
    early = _rms_db(out[: sr // 100])
    settled = _rms_db(out[sr // 2 - sr // 20 : sr // 2])
    assert settled < early - 1.0  # the squeeze arrives after the attack
    tail_start = _rms_db(out[sr // 2 : sr // 2 + sr // 50])
    tail_late = _rms_db(out[-sr // 20 :])
    assert tail_late > tail_start + 3.0  # and lets go slowly


def test_deesser_cuts_a_sibilant_band_more_than_a_voiced_tone():
    sr = 44100
    spec = {"deesser": {"hz": 6500.0, "threshold_db": -35.0, "ratio": 6.0, "max_reduction_db": 12.0}}
    ess = _sine(6500.0, sr, 1.0, 0.2)
    vowel = _sine(500.0, sr, 1.0, 0.2)
    ess_out = voice_fx.FxChain(sr, spec).process(ess)
    vowel_out = voice_fx.FxChain(sr, spec).process(vowel)
    cut_ess = _rms_db(ess[sr // 2 :]) - _rms_db(ess_out[sr // 2 :])
    cut_vowel = _rms_db(vowel[sr // 2 :]) - _rms_db(vowel_out[sr // 2 :])
    assert cut_ess > 3.0
    assert abs(cut_vowel) < 0.3
    assert cut_ess <= 12.5


def test_gain_is_applied_and_clamped():
    sr = 44100
    x = _sine(300.0, sr, 0.5, 0.05)
    up = voice_fx.FxChain(sr, {"gain_db": 6.0}).process(x)
    assert _rms_db(up) - _rms_db(x) == pytest.approx(6.0, abs=0.05)
    crazy = voice_fx.FxChain(sr, {"gain_db": 9999.0}).process(x)
    assert float(np.max(np.abs(crazy))) <= 1.0


# ---- the spec ---------------------------------------------------------------------------------------------------


def test_every_default_spec_is_valid_and_already_canonical():
    assert {"warm", "bright", "calm", "clean"} <= set(voice_fx.DEFAULT_SPECS)
    for name, spec in voice_fx.DEFAULT_SPECS.items():
        assert voice_fx.normalise_spec(spec) == voice_fx.normalise_spec(voice_fx.normalise_spec(spec)), name


def test_bad_parameters_are_clamped_and_never_raise():
    bad = {
        "highpass_hz": "loud",
        "dc_hz": float("nan"),
        "gain_db": float("inf"),
        "eq": [
            {"type": "peak", "hz": -5, "gain_db": 500, "q": 0},
            {"type": "nonsense", "hz": 1000, "gain_db": 3},
            "not a band",
            {"type": "lowshelf", "hz": 1e9, "gain_db": -500, "q": 1e9},
        ]
        + [{"type": "peak", "hz": 1000, "gain_db": 1}] * 20,
        "compressor": {"threshold_db": 99, "ratio": -3, "knee_db": 1e6, "attack_ms": 0, "release_ms": 1e9},
        "deesser": {"hz": 1, "q": 0, "threshold_db": "x", "ratio": 1e9, "max_reduction_db": 1e9},
        "limiter": {"threshold": 5, "ceiling": 0},
        "mystery": 1,
    }
    spec = voice_fx.normalise_spec(bad)
    assert len(spec["eq"]) <= voice_fx.MAX_EQ_BANDS
    assert all(band["type"] in voice_fx.EQ_TYPES for band in spec["eq"])
    assert 0.5 <= spec["limiter"]["ceiling"] <= 1.0
    assert spec["limiter"]["threshold"] < spec["limiter"]["ceiling"]
    assert "mystery" not in spec
    out = voice_fx.FxChain(44100, bad).process(_speechlike(44100, 0.3))
    assert np.all(np.isfinite(out))
    assert float(np.max(np.abs(out))) <= 1.0


@pytest.mark.parametrize("junk", [None, 5, "warm", [1, 2], {"eq": "x"}, {"compressor": 7}])
def test_a_spec_that_is_not_a_dict_gives_a_working_clean_chain(junk):
    out = voice_fx.FxChain(44100, junk).process(_speechlike(44100, 0.2))
    assert np.all(np.isfinite(out))


def test_compressor_and_deesser_off_switches():
    spec = voice_fx.normalise_spec({"compressor": False, "deesser": None})
    assert spec["compressor"] is None
    assert spec["deesser"] is None


@pytest.mark.parametrize("sr", [1, 100, 8000, 96000, 10**9, "x", None])
def test_odd_sample_rates_are_clamped(sr):
    chain = voice_fx.FxChain(sr, voice_fx.DEFAULT_SPECS["warm"])
    assert voice_fx.MIN_RATE <= chain.sample_rate <= voice_fx.MAX_RATE
    assert np.all(np.isfinite(chain.process(np.random.default_rng(5).standard_normal(3000).astype(np.float32) * 0.1)))


# ---- fades and joins --------------------------------------------------------------------------------------------


def test_fade_edges_ramp_both_ends_over_the_requested_time():
    sr = 44100
    x = np.ones(sr, dtype=np.float32)
    out = voice_fx.fade_edges(x, sr, 8.0)
    n = int(round(sr * 0.008))
    assert out[0] == pytest.approx(0.0, abs=1e-6)
    assert out[-1] == pytest.approx(0.0, abs=1e-6)
    assert out[n] == pytest.approx(1.0, abs=1e-4)
    assert out[sr // 2] == 1.0
    assert np.all(np.diff(out[:n]) >= 0)
    assert x[0] == 1.0  # the input is untouched


def test_fade_edges_on_a_clip_shorter_than_both_fades():
    out = voice_fx.fade_edges(np.ones(50, dtype=np.float32), 44100, 8.0)
    assert out.size == 50
    assert np.all(np.isfinite(out))
    assert float(np.max(out)) <= 1.0
    assert voice_fx.fade_edges(np.zeros(0, dtype=np.float32), 44100).size == 0


def test_fade_in_and_fade_out_touch_only_their_side():
    x = np.ones(1000, dtype=np.float32)
    fin = voice_fx.fade_in(x, 44100, 4.0)
    fout = voice_fx.fade_out(x, 44100, 4.0)
    assert fin[0] == pytest.approx(0.0, abs=1e-6)
    assert fin[-1] == 1.0
    assert fout[0] == 1.0
    assert fout[-1] == pytest.approx(0.0, abs=1e-6)


def test_crossfade_is_equal_power_and_joins_the_lengths():
    a = np.full(1000, 0.5, dtype=np.float32)
    b = np.full(1200, 0.5, dtype=np.float32)
    out = voice_fx.crossfade(a, b, 200)
    assert out.size == 1000 + 1200 - 200
    assert np.array_equal(out[:800], a[:800])
    assert np.array_equal(out[1000:], b[200:])
    joined = out[800:1000]
    # equal-power for the same signal on both sides (fully correlated): amplitude peaks at 0.5*sqrt(2)
    assert float(np.max(joined)) == pytest.approx(0.5 * math.sqrt(2), abs=0.01)
    # for independent signals the power stays flat across the join
    rng = np.random.default_rng(7)
    na = rng.standard_normal(20000).astype(np.float32)
    nb = rng.standard_normal(20000).astype(np.float32)
    mixed = voice_fx.crossfade(na, nb, 10000)[10000:20000]
    assert float(np.mean(mixed**2)) == pytest.approx(1.0, abs=0.08)


def test_crossfade_with_short_or_empty_parts():
    a = np.ones(10, dtype=np.float32)
    b = np.ones(30, dtype=np.float32)
    assert voice_fx.crossfade(a, b, 500).size == 30  # the overlap shrinks to the shorter clip
    assert np.array_equal(voice_fx.crossfade(np.zeros(0, dtype=np.float32), b, 8), b)
    assert np.array_equal(voice_fx.crossfade(a, np.zeros(0, dtype=np.float32), 8), a)
    assert np.array_equal(voice_fx.crossfade(a, b, 0), np.concatenate([a, b]))


# ---- the padding the speech graphs leave around a clause ----------------------------------------------------------


def test_trim_silence_cuts_the_padding_and_keeps_a_short_guard():
    sr = 44100
    body = _sine(300.0, sr, 0.5, 0.3)
    padded = np.concatenate([np.zeros(sr // 2, dtype=np.float32), body, np.zeros(sr // 2, dtype=np.float32)])
    out = voice_fx.trim_silence(padded, sr, lead_ms=15.0, tail_ms=80.0)
    guard_in, guard_out = int(round(sr * 0.015)), int(round(sr * 0.080))
    assert abs(out.size - (body.size + guard_in + guard_out)) <= 4
    assert np.all(out[: guard_in - 2] == 0)
    assert float(np.max(np.abs(out))) == pytest.approx(float(np.max(np.abs(body))))
    assert padded.size > out.size  # the input is not touched


def test_trim_silence_keeps_a_pause_inside_the_clip():
    sr = 22050
    tone = _sine(250.0, sr, 0.2, 0.3)
    clip = np.concatenate([np.zeros(5000, dtype=np.float32), tone, np.zeros(sr // 2, dtype=np.float32), tone])
    out = voice_fx.trim_silence(clip, sr, lead_ms=0.0, tail_ms=0.0)
    assert abs(out.size - (tone.size * 2 + sr // 2)) <= 4


def test_trim_silence_of_silence_and_of_a_clip_with_no_padding():
    sr = 16000
    assert voice_fx.trim_silence(np.zeros(sr, dtype=np.float32), sr).size == 0
    assert voice_fx.trim_silence(np.zeros(0, dtype=np.float32), sr).size == 0
    tone = _sine(300.0, sr, 0.3, 0.3)
    assert np.array_equal(voice_fx.trim_silence(tone, sr), tone)
    noisy = tone.copy()
    noisy[0] = np.nan
    assert np.all(np.isfinite(voice_fx.trim_silence(noisy, sr)))


def test_trim_silence_floor_is_a_level_in_dbfs():
    sr = 16000
    quiet = _sine(300.0, sr, 0.3, 0.002)  # about -54 dBFS
    assert voice_fx.trim_silence(quiet, sr, floor_db=-60.0).size > 0
    assert voice_fx.trim_silence(quiet, sr, floor_db=-40.0).size == 0
