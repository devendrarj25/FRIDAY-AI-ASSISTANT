"""FRIDAY Ears: mel front end against closed-form references (no librosa, no network, no clock)."""

from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import mel_frontend as mf  # noqa: E402

RATE = 16000


def _tone(seconds: float, hz: float, amp: float = 0.5) -> np.ndarray:
    t = np.arange(int(seconds * RATE))
    return amp * np.cos(2 * np.pi * hz * t / RATE)


def test_mel_scales_match_their_closed_forms():
    assert mf.hz_to_mel(0.0) == 0.0
    assert mf.hz_to_mel(1000.0) == pytest.approx(15.0)  # Slaney: linear 200/3 Hz per mel up to 1 kHz
    assert mf.hz_to_mel(1000.0, "htk") == pytest.approx(2595.0 * math.log10(1 + 1000 / 700))
    assert mf.hz_to_mel(7000.0) == pytest.approx(15.0 + math.log(7.0) / (math.log(6.4) / 27.0))
    for scale in ("slaney", "htk"):
        for hz in (50.0, 999.0, 1000.0, 3333.0, 7999.0):
            assert mf.mel_to_hz(mf.hz_to_mel(hz, scale), scale) == pytest.approx(hz)


def _reference_bank(cfg: mf.MelConfig) -> np.ndarray:
    """Scalar loops straight from the triangle definition."""
    fmax = cfg.fmax or cfg.sample_rate / 2
    lo, hi = mf.hz_to_mel(cfg.fmin, cfg.mel_scale), mf.hz_to_mel(fmax, cfg.mel_scale)
    edges = [mf.mel_to_hz(lo + (hi - lo) * i / (cfg.n_mels + 1), cfg.mel_scale) for i in range(cfg.n_mels + 2)]
    out = np.zeros((cfg.n_mels, cfg.n_fft // 2 + 1))
    for m in range(cfg.n_mels):
        left, mid, right = edges[m], edges[m + 1], edges[m + 2]
        for k in range(cfg.n_fft // 2 + 1):
            f = k * cfg.sample_rate / cfg.n_fft
            if left < f <= mid:
                w = (f - left) / (mid - left)
            elif mid < f < right:
                w = (right - f) / (right - mid)
            else:
                w = 0.0
            out[m, k] = w * (2.0 / (right - left) if cfg.mel_norm == "slaney" else 1.0)
    return out


@pytest.mark.parametrize(
    "cfg",
    [
        mf.nemo_config(),
        mf.whisper_config(),
        mf.nemo_config(mel_scale="htk", mel_norm="none", n_mels=40),
        mf.nemo_config(fmin=100.0, fmax=7600.0, n_mels=64),
    ],
)
def test_filterbank_equals_scalar_reference(cfg):
    bank = mf.mel_filterbank(cfg)
    assert bank.shape == (cfg.n_mels, cfg.n_fft // 2 + 1)
    assert np.all(bank >= 0)
    np.testing.assert_allclose(bank, _reference_bank(cfg), atol=1e-12)


def test_hann_window_is_periodic_and_centred_in_the_fft_frame():
    cfg = mf.nemo_config()
    win = mf.hann_window(cfg)
    assert win.shape == (512,)
    assert np.all(win[:56] == 0) and np.all(win[456:] == 0)
    assert win[56] == 0.0 and win[56 + 200] == pytest.approx(1.0)  # periodic Hann peaks at n = N/2


def test_power_spectrum_of_a_bin_centred_tone_is_the_hann_line_triple():
    cfg = mf.whisper_config()  # n_fft == win_length == 400, so a 1 kHz tone sits on bin 25
    amp, k = 0.5, 25
    power = mf.power_spectrum(_tone(0.025, 1000.0, amp)[None, :], mf.hann_window(cfg), cfg.n_fft)[0]
    expected = np.zeros(cfg.n_fft // 2 + 1)
    expected[k] = (amp * cfg.n_fft / 4) ** 2
    expected[k - 1] = expected[k + 1] = (amp * cfg.n_fft / 8) ** 2
    np.testing.assert_allclose(power, expected, atol=1e-9)


def test_preemphasis_on_a_constant_and_with_a_carried_sample():
    out = mf.preemphasis(np.full(5, 2.0), 0.97)
    np.testing.assert_allclose(out, [2.0] + [2.0 * 0.03] * 4)
    carried = mf.preemphasis(np.full(3, 2.0), 0.97, previous=2.0)
    np.testing.assert_allclose(carried, [2.0 * 0.03] * 3)
    assert mf.preemphasis(np.array([]), 0.97).size == 0


def test_silence_is_the_log_guard_and_frame_count_follows_the_layout():
    cfg = mf.nemo_config()
    feats = mf.MelFrontend(cfg).extract(np.zeros(RATE))
    assert feats.shape == (1 + (RATE - 400) // 160, 128)
    np.testing.assert_allclose(feats, math.log(2.0**-24), atol=1e-6)
    assert mf.MelFrontend(cfg).extract(np.zeros(399)).shape == (0, 128)
    assert mf.MelFrontend(cfg).extract(np.zeros(400)).shape == (1, 128)
    assert mf.MelFrontend(cfg).extract(np.array([], dtype=np.float64)).shape == (0, 128)


def test_tone_log_mel_equals_log_of_filterbank_times_the_closed_form_spectrum():
    cfg = mf.whisper_config(normalize="none", log_guard=1e-10)
    amp, k = 0.5, 25
    feats = mf.MelFrontend(cfg).extract(_tone(0.025, 1000.0, amp))
    assert feats.shape == (1, 80)
    power = np.zeros(cfg.n_fft // 2 + 1)
    power[k] = (amp * cfg.n_fft / 4) ** 2
    power[k - 1] = power[k + 1] = (amp * cfg.n_fft / 8) ** 2
    expected = np.log10(_reference_bank(cfg) @ power + 1e-10)
    np.testing.assert_allclose(feats[0], expected, atol=2e-4)
    bank = mf.mel_filterbank(cfg)
    centre_bin = int(np.argmax(bank[int(np.argmax(feats[0]))]))
    assert abs(centre_bin * RATE / cfg.n_fft - 1000.0) < 100.0


def test_int16_input_is_scaled_like_float():
    cfg = mf.nemo_config()
    sig = _tone(0.2, 440.0, 0.25)
    as_int = np.round(sig * 32768.0).astype(np.int16)
    np.testing.assert_allclose(
        mf.MelFrontend(cfg).extract(as_int), mf.MelFrontend(cfg).extract(as_int / 32768.0), atol=1e-6
    )


def test_streaming_chunks_give_the_offline_frames_for_any_chunking():
    cfg = mf.nemo_config()
    rng = np.random.default_rng(1234)
    sig = 0.3 * rng.standard_normal(int(1.7 * RATE)) + _tone(1.7, 523.0, 0.2)
    offline = mf.MelFrontend(cfg).extract(sig)
    for sizes in ([1600], [1], [160, 161, 159], [37, 4000, 5, 799]):
        stream = mf.StreamingMel(cfg)
        pos, i, got = 0, 0, []
        while pos < sig.size:
            n = sizes[i % len(sizes)] if sizes != [1] else 1 + (pos % 3)
            got.append(stream.push(sig[pos : pos + n]).frames)
            pos, i = pos + n, i + 1
        np.testing.assert_allclose(np.concatenate(got), offline, atol=1e-5, err_msg=str(sizes))


def test_streaming_with_dither_repeats_and_matches_offline():
    cfg = mf.nemo_config(dither=1.0, dither_seed=3)
    sig = np.zeros(9600)
    offline = mf.MelFrontend(cfg).extract(sig)
    stream = mf.StreamingMel(cfg)
    got = np.concatenate([stream.push(sig[i : i + 700]).frames for i in range(0, sig.size, 700)])
    np.testing.assert_allclose(got, offline, atol=1e-5)
    assert not np.allclose(offline, mf.MelFrontend(mf.nemo_config()).extract(sig), atol=1e-3)
    np.testing.assert_array_equal(offline, mf.MelFrontend(cfg).extract(sig))  # seeded: a rerun repeats


def test_pre_encode_cache_is_the_last_nine_frames_of_earlier_chunks():
    cfg = mf.nemo_config()
    stream = mf.StreamingMel(cfg)
    sig = _tone(1.0, 700.0)
    first = stream.push(sig[:3200])
    assert first.cache_len == 0 and first.encoder_input.shape == first.frames.shape
    second = stream.push(sig[3200:6400])
    assert second.cache_len == mf.PRE_ENCODE_CACHE_FRAMES == 9
    np.testing.assert_array_equal(second.encoder_input[:9], first.frames[-9:])
    np.testing.assert_array_equal(second.encoder_input[9:], second.frames)
    short = mf.StreamingMel(cfg, cache_frames=9)
    tiny = short.push(sig[:500])  # 1 frame: the next chunk can only cache 1 row
    assert short.push(sig[500:1500]).cache_len == tiny.frames.shape[0] == 1
    assert stream.push(np.zeros(10)).frames.shape == (0, 128)  # no complete frame yet: nothing, not the cache alone


def test_reset_restarts_the_stream_and_the_preemphasis_carry():
    cfg = mf.nemo_config()
    sig = _tone(0.3, 900.0)
    stream = mf.StreamingMel(cfg)
    first = stream.push(sig).frames
    stream.reset()
    np.testing.assert_array_equal(stream.push(sig).frames, first)


def test_per_feature_and_whisper_normalisation_are_offline_only():
    nemo = mf.nemo_config(normalize="per_feature")
    sig = _tone(0.5, 440.0) + 0.05 * np.random.default_rng(0).standard_normal(8000)
    feats = mf.MelFrontend(nemo).extract(sig)
    np.testing.assert_allclose(feats.mean(axis=0), 0.0, atol=1e-4)
    np.testing.assert_allclose(feats.std(axis=0, ddof=1), 1.0, atol=1e-3)
    wh = mf.MelFrontend(mf.whisper_config()).extract(sig)
    assert wh.min() >= wh.max() - 2.0 - 1e-6  # clamp to max - 8, then / 4
    for cfg in (nemo, mf.whisper_config()):
        with pytest.raises(ValueError, match="whole utterance"):
            mf.StreamingMel(cfg)


def test_fixed_normalisation_streams_and_needs_its_statistics():
    cfg = mf.nemo_config(normalize="fixed", n_mels=16)
    with pytest.raises(ValueError):
        mf.MelFrontend(cfg)
    mean, std = np.full(16, -5.0), np.full(16, 2.0)
    raw = mf.MelFrontend(mf.nemo_config(n_mels=16)).extract(_tone(0.3, 440.0))
    fixed = mf.MelFrontend(cfg, fixed_mean=mean, fixed_std=std).extract(_tone(0.3, 440.0))
    np.testing.assert_allclose(fixed, (raw + 5.0) / 2.0, atol=1e-5)
    streamed = mf.StreamingMel(cfg, fixed_mean=mean, fixed_std=std).push(_tone(0.3, 440.0)).frames
    np.testing.assert_allclose(streamed, fixed, atol=1e-5)


@pytest.mark.parametrize(
    "kwargs",
    [{"win_length": 600}, {"n_fft": 511}, {"preemph": 1.0}, {"n_mels": 0}, {"fmax": 9000.0}, {"log_guard": 0.0}],
)
def test_bad_config_is_refused(kwargs):
    with pytest.raises(ValueError):
        mf.nemo_config(**kwargs)


def test_two_dimensional_audio_is_refused():
    with pytest.raises(ValueError, match="one-dimensional"):
        mf.MelFrontend(mf.nemo_config()).extract(np.zeros((2, 800)))
