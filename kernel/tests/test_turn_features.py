"""The end-of-turn model input is built by FRIDAY's own numpy extractor; the package extractor is only a fallback."""

from __future__ import annotations

import sys
import types

import numpy as np
import pytest
import turn_features as tf
import voice_runtime


def _speechlike(seconds: float, seed: int = 7) -> np.ndarray:
    rng = np.random.default_rng(seed)
    t = np.arange(int(seconds * 16000)) / 16000.0
    voice = sum(np.sin(2 * np.pi * f * t) / (i + 1) for i, f in enumerate((140, 280, 420, 910, 1800)))
    envelope = 0.5 + 0.5 * np.sin(2 * np.pi * 3.1 * t)
    return (0.2 * envelope * voice + 0.01 * rng.standard_normal(t.size)).astype(np.float32)


def test_the_filterbank_is_80_by_201_float32_and_built_once():
    first = tf.mel_filterbank()
    assert first.shape == (80, 201) and first.dtype == np.float32
    assert tf.mel_filterbank() is first
    assert float(first.min()) >= 0.0 and bool(np.all(first.sum(axis=1) > 0))


def test_filter_centres_rise_with_the_band_number():
    bank = tf.mel_filterbank()
    centres = (bank * np.arange(201)).sum(axis=1) / bank.sum(axis=1)
    assert bool(np.all(np.diff(centres) > 0))


def test_an_eight_second_window_gives_exactly_800_frames():
    feat = tf.TurnFeatures()(np.zeros(128000, dtype=np.float32), padding=0)
    assert feat.shape == (80, 800) and feat.dtype == np.float32


def test_a_tone_lights_the_band_that_holds_it():
    t = np.arange(128000) / 16000.0
    feat = tf.TurnFeatures()(np.sin(2 * np.pi * 1000 * t).astype(np.float32))
    bank = tf.mel_filterbank()
    band = int(np.argmax(feat.mean(axis=1)))
    centre = float((np.arange(201) * 40.0 * bank[band]).sum() / bank[band].sum())
    assert abs(centre - 1000.0) < 120.0


def test_the_log_range_is_clamped_to_two_units():
    feat = tf.TurnFeatures()(_speechlike(8.0))
    assert float(feat.max() - feat.min()) <= 2.0 + 1e-5 and bool(np.isfinite(feat).all())


def test_the_extractor_does_not_touch_its_input_and_repeats():
    wave = _speechlike(3.0)
    keep = wave.copy()
    extractor = tf.TurnFeatures()
    a, b = extractor(wave), extractor(wave)
    assert np.array_equal(wave, keep) and np.array_equal(a, b)


def test_a_short_clip_sits_at_the_back_of_a_zero_window_and_is_standardised():
    window = tf.turn_window(_speechlike(1.0), 128000)
    assert window.shape == (128000,)
    assert not window[:112000].any()
    tail = window[112000:]
    assert abs(float(tail.mean())) < 1e-4 and abs(float(tail.std()) - 1.0) < 1e-3


def test_a_long_clip_keeps_only_its_last_eight_seconds():
    clip = _speechlike(12.0)
    assert np.allclose(tf.turn_window(clip, 128000), tf.turn_window(clip[-128000:], 128000))


def test_the_model_input_is_one_by_80_by_800_float32_for_any_length():
    for seconds in (0.2, 1.0, 8.0, 15.0):
        out = tf.turn_input(_speechlike(seconds))
        assert out.shape == (1, 80, 800) and out.dtype == np.float32 and bool(np.isfinite(out).all())


@pytest.mark.parametrize("clip", [np.zeros(0), np.zeros(16000), np.full(16000, np.nan), np.full(16000, np.inf)])
def test_silence_empty_and_hostile_clips_do_not_raise(clip):
    out = tf.turn_input(clip)
    assert out.shape == (1, 80, 800) and bool(np.isfinite(out).all())


def test_frames_are_cut_or_padded_with_the_floor_value():
    assert tf.fit_frames(np.zeros((80, 900))).shape == (80, 800)
    padded = tf.fit_frames(np.zeros((80, 790)))
    assert padded.shape == (80, 800) and float(padded[0, -1]) == tf.FRAME_PAD_VALUE and float(padded[0, 0]) == 0.0


def test_another_extractor_with_the_same_call_can_be_passed_in():
    seen: dict = {}

    class Other:
        n_samples = 64000

        def __call__(self, waveform, padding=0):
            seen["size"] = waveform.size
            return np.ones((80, 400), dtype=np.float32)

    out = tf.turn_input(_speechlike(2.0), Other())
    assert seen["size"] == 64000 and out.shape == (1, 80, 800) and float(out[0, 0, -1]) == tf.FRAME_PAD_VALUE


def _poison_package(monkeypatch):
    """A package extractor that must not be touched: importing it fails the test."""
    for name in ("faster_whisper", "faster_whisper.feature_extractor"):
        monkeypatch.setitem(sys.modules, name, None)


def _stand_in_runtime(monkeypatch, probability: float = 0.8):
    opened: list = []

    class Session:
        def __init__(self, path, sess_options=None, providers=None):
            opened.append(sess_options)

        def run(self, _names, feeds):
            assert feeds["input_features"].shape == (1, 80, 800)
            return [np.array([[probability]], dtype=np.float32)]

    ort = types.ModuleType("onnxruntime")
    ort.InferenceSession = Session  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "onnxruntime", ort)
    return opened


def _boom(*_a, **_k):
    raise RuntimeError("boom")


@pytest.fixture
def _model_dir(monkeypatch, tmp_path):
    monkeypatch.setenv("FRIDAY_ROOT", str(tmp_path))
    folder = tmp_path / "models" / "smart-turn"
    folder.mkdir(parents=True)
    (folder / voice_runtime.SMART_TURN_NAME).write_bytes(b"x")
    voice_runtime._turn_model.clear()
    yield
    voice_runtime._turn_model.clear()


def test_scoring_uses_the_own_extractor_and_never_loads_the_package(monkeypatch, _model_dir):
    _stand_in_runtime(monkeypatch)
    _poison_package(monkeypatch)
    out = voice_runtime.score_turn(_speechlike(2.0), 16000)
    assert out["ready"] is True and abs(out["probability"] - 0.8) < 1e-6
    held = next(iter(voice_runtime._turn_model.values()))
    assert isinstance(held[1], tf.TurnFeatures)


def test_the_smart_turn_session_gets_the_budget_options_not_the_runtime_default(monkeypatch, _model_dir):
    opened = _stand_in_runtime(monkeypatch)
    _poison_package(monkeypatch)
    seen = {}

    def budget(role, phase=None, cores=None, intra=None):
        seen["role"] = role
        return "options-from-the-budget"

    monkeypatch.setattr(voice_runtime.voice_budget, "ort_session_options", budget)
    voice_runtime.score_turn(_speechlike(2.0), 16000)
    assert seen == {"role": "turn"} and opened == ["options-from-the-budget"]


def test_the_package_extractor_is_the_fallback_when_the_own_one_fails(monkeypatch, _model_dir):
    _stand_in_runtime(monkeypatch, 0.4)
    used = {"package": 0}

    class Package:
        n_samples = 128000

        def __init__(self, feature_size=80, chunk_length=8):
            used["package"] += 1

        def __call__(self, audio, padding=0):
            return np.zeros((80, 800), dtype=np.float32)

    fe = types.ModuleType("faster_whisper.feature_extractor")
    fe.FeatureExtractor = Package  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "faster_whisper.feature_extractor", fe)
    monkeypatch.setattr(tf.TurnFeatures, "__call__", _boom)
    out = voice_runtime.score_turn(_speechlike(2.0), 16000)
    assert out["ready"] is True and abs(out["probability"] - 0.4) < 1e-6 and used["package"] == 1


def test_both_extractors_failing_is_not_a_cut_off(monkeypatch, _model_dir):
    _stand_in_runtime(monkeypatch)
    _poison_package(monkeypatch)
    monkeypatch.setattr(tf.TurnFeatures, "__call__", _boom)
    out = voice_runtime.score_turn(_speechlike(2.0), 16000)
    assert out["ready"] is False and out["probability"] is None


@pytest.mark.parametrize("seconds", [0.5, 3.0, 8.0, 11.0])
def test_features_match_the_package_extractor_within_1e_4(seconds):
    from faster_whisper.feature_extractor import FeatureExtractor  # type: ignore

    clip = _speechlike(seconds)
    ours = tf.turn_input(clip)
    theirs = tf.turn_input(clip, FeatureExtractor(feature_size=80, chunk_length=8))
    assert ours.shape == theirs.shape
    assert float(np.max(np.abs(ours - theirs))) < 1e-4
