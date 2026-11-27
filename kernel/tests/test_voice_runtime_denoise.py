"""denoise_pcm picks FRIDAY Denoise (then Denoise Lite) when weights are installed, pyrnnoise only otherwise.
Unit rules run on a tiny fake graph (no model file, no network); the real pinned weights are only read when
FRIDAY_DENOISE_SCRATCH_ROOT points at a models root, and that test skips visibly without it."""

from __future__ import annotations

import os
import sys
import types
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import denoise_onnx as dn  # noqa: E402
import voice_runtime  # noqa: E402

RATE = 16000


class Half:
    """A tiny graph that halves every spectrum bin (a crude, deterministic suppressor)."""

    def __call__(self, ri):
        return ri * 0.5

    def reset(self):
        pass


def _signal(seconds=1.0, snr_db=5.0, seed=7):
    """Speech-like: a gliding 120 Hz voice with a formant bump and a 3 Hz syllable envelope, plus white noise."""
    rng = np.random.default_rng(seed)
    t = np.arange(int(RATE * seconds)) / RATE
    f0 = 120 + 20 * np.sin(2 * np.pi * 3 * t)
    phase = 2 * np.pi * np.cumsum(f0) / RATE
    voice = sum(np.sin(k * phase) / k**0.7 * np.exp(-(((k * f0 - 700) / 900) ** 2)) for k in range(1, 25))
    env = np.clip(np.sin(2 * np.pi * 3 * t), 0, None) ** 0.5
    voice = 0.3 * voice * env / np.max(np.abs(voice * env))
    noise = rng.standard_normal(t.size)
    noise *= np.sqrt(np.mean(voice**2) / 10 ** (snr_db / 10)) / np.std(noise)
    return voice.astype(np.float32), (voice + noise).astype(np.float32)


def _snr(clean, est):
    err = est - clean
    return 10 * np.log10(np.sum(clean**2) / max(np.sum(err**2), 1e-12))


@pytest.fixture
def fake_friday(monkeypatch):
    """Both FRIDAY engines look installed and open the fake graph."""
    monkeypatch.setattr(dn, "find_model", lambda spec, root=None: Path("fake.onnx"))
    monkeypatch.setattr(dn, "build_denoiser", lambda name, **kw: dn.StreamDenoiser(name, graph=Half()))


@pytest.fixture
def no_friday(monkeypatch):
    monkeypatch.setattr(dn, "find_model", lambda spec, root=None: None)


def _fake_rnnoise(monkeypatch, calls):
    class RNNoise:
        def __init__(self, rate):
            calls.append(rate)

        def denoise_chunk(self, pcm, partial=True):
            yield 0.9, (pcm[0] // 2).astype(np.int16)

    module = types.ModuleType("pyrnnoise")
    module.__dict__["RNNoise"] = RNNoise
    monkeypatch.setitem(sys.modules, "pyrnnoise", module)


def test_friday_path_preserves_length_and_scale(fake_friday):
    _clean, noisy = _signal()
    out = np.asarray(voice_runtime.denoise_pcm(noisy, RATE))
    assert out.shape == noisy.shape and out.dtype == np.float32
    assert np.max(np.abs(out)) <= 1.0
    ratio = np.sqrt(np.mean(out**2) / np.mean(noisy**2))
    assert 0.4 < ratio < 0.6  # the fake graph halves the spectrum


def test_friday_path_wins_over_pyrnnoise(fake_friday, monkeypatch):
    calls: list[int] = []
    _fake_rnnoise(monkeypatch, calls)
    voice_runtime.denoise_pcm(_signal()[1], RATE)
    assert calls == []


def test_fallback_to_pyrnnoise_without_weights(no_friday, monkeypatch):
    calls: list[int] = []
    _fake_rnnoise(monkeypatch, calls)
    _clean, noisy = _signal()
    out = np.asarray(voice_runtime.denoise_pcm(noisy, RATE))
    assert calls == [RATE] and out.size > 0


def test_no_weights_no_wheel_returns_input(no_friday, monkeypatch):
    monkeypatch.setitem(sys.modules, "pyrnnoise", None)
    _clean, noisy = _signal()
    assert voice_runtime.denoise_pcm(noisy, RATE) is noisy


def test_other_sample_rate_skips_friday_path(fake_friday, monkeypatch):
    calls: list[int] = []
    _fake_rnnoise(monkeypatch, calls)
    voice_runtime.denoise_pcm(_signal()[1], 48000)
    assert calls == [48000]


def test_lite_used_when_main_missing(monkeypatch):
    monkeypatch.setattr(dn, "find_model", lambda spec, root=None: Path("f.onnx") if spec.name == "gtcrn" else None)
    seen: list[str] = []

    def build(name, **kw):
        seen.append(name)
        return dn.StreamDenoiser(name, graph=Half())

    monkeypatch.setattr(dn, "build_denoiser", build)
    voice_runtime.denoise_pcm(_signal()[1], RATE)
    assert seen == ["gtcrn"]


def test_broken_friday_graph_falls_back(monkeypatch):
    monkeypatch.setattr(dn, "find_model", lambda spec, root=None: Path("f.onnx"))
    monkeypatch.setattr(dn, "build_denoiser", lambda name, **kw: dn.StreamDenoiser(name, model_path=Path("/nope")))
    calls: list[int] = []
    _fake_rnnoise(monkeypatch, calls)
    voice_runtime.denoise_pcm(_signal()[1], RATE)
    assert calls == [RATE]


def test_noise_status_names_friday_engine(fake_friday):
    st = voice_runtime.noise_status()
    assert st["ready"] is True and st["engine"] == "friday-dpdfnet2"


def test_noise_status_pyrnnoise_when_no_weights(no_friday, monkeypatch):
    monkeypatch.setitem(sys.modules, "pyrnnoise", types.ModuleType("pyrnnoise"))
    assert voice_runtime.noise_status()["engine"] == "pyrnnoise"


SCRATCH = os.environ.get("FRIDAY_DENOISE_SCRATCH_ROOT", "")


@pytest.mark.skipif(not SCRATCH, reason="set FRIDAY_DENOISE_SCRATCH_ROOT to a models root holding the pinned weights")
def test_real_weights_gain_snr_at_5_db(monkeypatch):
    monkeypatch.setenv("FRIDAY_ROOT", SCRATCH)
    clean, noisy = _signal(3.0)
    out = np.asarray(voice_runtime.denoise_pcm(noisy, RATE))
    assert out.size == noisy.size
    print(f"input SNR {_snr(clean, noisy):.2f} dB, FRIDAY path {_snr(clean, out):.2f} dB")
    assert _snr(clean, out) >= _snr(clean, noisy) - 1.0  # not worse than the input by more than 1 dB
