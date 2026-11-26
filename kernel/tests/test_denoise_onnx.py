"""FRIDAY Ears: the streaming denoisers. Every rule runs on an injected graph (no model file, no network, no clock). The
tests that open the real pinned files (DPDFNet 2, GTCRN) are parametrised over the engines whose file is on disk here:
with none on disk pytest reports them as an empty parameter set (visible with ``-rs``), never as a pass. Synthetic
signals only: nothing here says how a denoiser changes the word error rate on a real voice."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import denoise_onnx as dn  # noqa: E402
from denoise_onnx import ENGINES, DenoiseUnavailable, StreamDenoiser  # noqa: E402

DPDF, GTCRN = ENGINES["dpdfnet2"], ENGINES["gtcrn"]


class Identity:
    """A graph that answers with the spectrum it was given."""

    def __call__(self, ri):
        return ri

    def reset(self):
        pass


class Delayed:
    """A graph that answers with the spectrum of ``frames`` frames ago (zeros first), like a graph with its own lag."""

    def __init__(self, frames):
        self.frames, self.queue = frames, []

    def __call__(self, ri):
        self.queue.append(ri)
        return self.queue.pop(0) if len(self.queue) > self.frames else np.zeros_like(ri)

    def reset(self):
        self.queue = []


class Decay:
    """A graph with state: each answer is scaled down by one more step than the last."""

    def __init__(self):
        self.n = 0

    def __call__(self, ri):
        self.n += 1
        return ri / (1.0 + self.n)

    def reset(self):
        self.n = 0


class Breaks:
    """Identity until the ``at``-th call, then it raises (or answers with NaN)."""

    def __init__(self, at, nan=False):
        self.at, self.nan, self.n = at, nan, 0

    def __call__(self, ri):
        self.n += 1
        if self.n >= self.at:
            if self.nan:
                return np.full_like(ri, np.nan)
            raise RuntimeError("the graph broke")
        return ri

    def reset(self):
        self.n = 0


def signal(n, seed=1):
    return (np.random.default_rng(seed).standard_normal(n) * 0.1).astype(np.float32)


def stream(denoiser, x, chunk):
    out = [denoiser.process(x[i : i + chunk]) for i in range(0, len(x), chunk)]
    out.append(denoiser.flush())
    return np.concatenate(out)


# ---- the windows and the frame loop -------------------------------------------------------------------------------


@pytest.mark.parametrize("spec", [DPDF, GTCRN], ids=["dpdfnet2", "gtcrn"])
def test_the_window_used_twice_overlap_adds_to_one_at_half_overlap(spec):
    w = dn.window_for(spec).astype(np.float64)
    assert w.size == spec.win and spec.hop * 2 == spec.win and spec.bins == spec.win // 2 + 1
    total = w[: spec.hop] ** 2 + w[spec.hop :] ** 2
    assert np.allclose(total, 1.0, atol=1e-6)


@pytest.mark.parametrize("spec", [DPDF, GTCRN], ids=["dpdfnet2", "gtcrn"])
@pytest.mark.parametrize("chunk", [1, 333, 4096])
def test_an_identity_graph_gives_back_the_audio_at_any_chunk_size_with_no_samples_lost(spec, chunk):
    x = signal(5000, seed=3)
    out = stream(StreamDenoiser(spec.name, graph=Identity()), x, chunk)
    assert out.size == x.size  # flush drains the frame that was still filling
    # The very first hop has no frame before it to overlap with, so only from there on is it the input again.
    assert np.allclose(out[spec.hop :], x[spec.hop :], atol=1e-5)
    assert np.abs(out[: spec.hop]).max() <= np.abs(x[: spec.hop]).max() + 1e-6


def test_the_answer_does_not_depend_on_how_the_audio_was_cut_into_chunks():
    x = signal(6400, seed=4)
    a = stream(StreamDenoiser("gtcrn", graph=Decay()), x, 100)
    b = stream(StreamDenoiser("gtcrn", graph=Decay()), x, 1777)
    assert np.array_equal(a, b)


def test_the_state_is_carried_between_frames_and_reset_starts_clean():
    x = signal(4000, seed=5)
    fresh = stream(StreamDenoiser("dpdfnet2", graph=Decay()), x, 640)
    d = StreamDenoiser("dpdfnet2", graph=Decay())
    first = stream(d, x, 640)
    again = stream(d, x, 640)  # no reset: the graph is deeper into its decay, so the answer is quieter
    assert np.array_equal(first, fresh)
    assert np.abs(again).mean() < np.abs(first).mean() * 0.5
    d.reset()
    assert np.array_equal(stream(d, x, 640), fresh)


def test_run_clip_removes_the_graphs_own_delay_so_the_clip_lines_up_with_the_input():
    x = signal(8000, seed=6)
    d = StreamDenoiser("dpdfnet2", graph=Delayed(DPDF.delay // DPDF.hop))  # holds back 4 frames, as DPDFNet does
    out = d.run_clip(x)
    assert out.size == x.size and d.active
    assert np.allclose(out[DPDF.hop :], x[DPDF.hop :], atol=1e-5)
    assert DPDF.delay == 640 and GTCRN.delay == 0
    assert DPDF.latency_ms == pytest.approx(50.0) and GTCRN.latency_ms == pytest.approx(16.0)


def test_int16_bytes_and_arrays_are_accepted_like_the_other_ears():
    pcm = (signal(1600, seed=7) * 32768).astype("<i2")
    d = StreamDenoiser("off")
    assert np.allclose(d.process(pcm.tobytes()), pcm.astype(np.float32) / 32768.0)
    assert np.allclose(d.process(pcm), pcm.astype(np.float32) / 32768.0)


# ---- never raises: every failure is a passthrough -------------------------------------------------------------------


def test_a_graph_that_breaks_mid_stream_becomes_a_passthrough_with_no_gap_and_no_repeat():
    x = signal(9000, seed=8)
    d = StreamDenoiser("gtcrn", graph=Breaks(at=6))
    out = stream(d, x, 500)
    assert out.size == x.size
    assert not d.active and "runtime error" in d.reason and "the graph broke" in d.reason
    assert d.status()["engine"] == "passthrough" and d.status()["wanted"] == "gtcrn"
    # Everything the graph never reached is the input itself, sample for sample.
    committed = 5 * GTCRN.hop  # five frames went through before the sixth broke
    assert np.array_equal(out[committed:], x[committed:])
    assert np.array_equal(d.process(x[:100]), x[:100])  # and it stays a passthrough


def test_a_graph_that_answers_with_nan_is_dropped_before_the_nan_reaches_the_output():
    x = signal(6000, seed=9)
    d = StreamDenoiser("dpdfnet2", graph=Breaks(at=3, nan=True))
    out = stream(d, x, 480)
    assert np.isfinite(out).all() and out.size == x.size and not d.active
    assert np.array_equal(out[2 * DPDF.hop :], x[2 * DPDF.hop :])


def test_a_break_while_draining_the_tail_still_returns_every_sample_once():
    x = signal(2000, seed=10)
    frames_for_audio = (x.size - GTCRN.win) // GTCRN.hop + 1
    d = StreamDenoiser("gtcrn", graph=Breaks(at=frames_for_audio + 1))  # fine for the audio, breaks on the padding
    out = stream(d, x, 400)
    assert out.size == x.size and np.isfinite(out).all() and not d.active
    assert np.array_equal(out[-100:], x[-100:])


def test_a_missing_model_is_a_passthrough_that_says_why(tmp_path, monkeypatch):
    monkeypatch.setenv("FRIDAY_ROOT", str(tmp_path))
    x = signal(3200, seed=11)
    for name in dn.DENOISE_ENGINES:
        d = StreamDenoiser(name)
        assert not d.active and "not on disk" in d.reason
        assert np.array_equal(d.process(x), x) and d.flush().size == 0
        assert np.array_equal(d.run_clip(x), x)
        assert d.status()["active"] is False and d.status()["rtf"] is None


def test_off_and_unknown_engines_pass_the_audio_through_and_garbage_does_not_raise():
    x = signal(800, seed=12)
    off, odd = StreamDenoiser("off"), StreamDenoiser("rnnoise")
    assert off.reason == "off" and "rnnoise" in odd.reason
    for d in (off, odd, StreamDenoiser("gtcrn", graph=Identity())):
        assert d.process(None).size == 0 and d.process("not audio").size == 0
        assert d.reset() is None
    assert np.array_equal(off.process(x), x)


def test_a_file_that_is_not_the_pinned_size_is_never_opened(tmp_path):
    folder = tmp_path / GTCRN.catalog_id
    folder.mkdir()
    (folder / GTCRN.file).write_bytes(b"x" * 100)
    assert dn.find_model(GTCRN, tmp_path) is None  # a partial download
    with (folder / GTCRN.file).open("r+b") as f:
        f.truncate(GTCRN.bytes)
    assert dn.find_model(GTCRN, tmp_path) == folder / GTCRN.file
    d = StreamDenoiser("gtcrn", model_path=folder / GTCRN.file)  # the right size, but zeros: not a graph
    assert not d.active and d.reason
    x = signal(1600, seed=13)
    assert np.array_equal(d.process(x), x)


def test_a_graph_with_the_wrong_signature_is_refused_by_name():
    class Tensor:
        def __init__(self, name, shape):
            self.name, self.shape = name, shape

    class Session:
        def get_inputs(self):
            return [Tensor("spec", [1, 1, 99, 2]), Tensor("state_in", [10])]

        def get_outputs(self):
            return [Tensor("a", []), Tensor("b", [])]

        def get_modelmeta(self):
            return type("M", (), {"custom_metadata_map": {}})()

    with pytest.raises(DenoiseUnavailable, match="DPDFNet streaming signature"):
        dn.DpdfGraph(Session(), DPDF)
    with pytest.raises(DenoiseUnavailable, match="GTCRN streaming signature"):
        dn.GtcrnGraph(Session(), GTCRN)


def test_the_engine_table_matches_the_pins():
    """The sizes written here are the ones electron/voice-pins.cjs pins (a pin moves, this file moves with it)."""
    pins = (Path(__file__).resolve().parents[2] / "electron" / "voice-pins.cjs").read_text(encoding="utf-8")
    for spec in ENGINES.values():
        assert f"bytes: {spec.bytes}," in pins and f'"{spec.file}"' in pins, spec.name


# ---- the real files (only where they are on disk) ------------------------------------------------------------------


def on_disk():
    """The engines whose pinned file is under <FRIDAY_ROOT>/models and whose runtime is installed."""
    try:
        import onnxruntime  # noqa: F401
    except ImportError:
        return []
    return [name for name in dn.DENOISE_ENGINES if dn.find_model(ENGINES[name]) is not None]


REAL = pytest.mark.parametrize("name", on_disk())


@REAL
def test_the_real_graph_has_the_state_the_wrapper_expects(name):
    path = dn.find_model(ENGINES[name])
    assert path is not None
    graph = dn.open_graph(ENGINES[name], path)
    if name == "dpdfnet2":
        assert graph.state.shape == (45424,)  # type: ignore[attr-defined]
        assert float(np.abs(graph.state).sum()) > 0  # type: ignore[attr-defined]  # the first state is the metadata's
    else:
        assert {k: v.shape for k, v in graph.caches.items()} == {  # type: ignore[attr-defined]
            "conv_cache": (2, 1, 16, 16, 33),
            "tra_cache": (2, 3, 1, 1, 16),
            "inter_cache": (2, 1, 33, 16),
        }
    out = graph(np.zeros((ENGINES[name].bins, 2), dtype=np.float32))
    assert out.shape == (ENGINES[name].bins, 2) and np.isfinite(out).all()


@REAL
def test_the_real_graph_streams_the_same_answer_for_any_chunking_and_after_a_reset(name):
    x = signal(24000, seed=21)  # 1.5 s of noise
    d = StreamDenoiser(name)
    assert d.active, d.reason
    a = stream(d, x, 320)
    d.reset()
    b = stream(d, x, 1000)
    assert a.size == x.size and np.isfinite(a).all()
    assert np.array_equal(a, b)  # the state was carried frame to frame and reset to its first value
    second_half_fresh = stream(StreamDenoiser(name), x[12000:], 320)
    assert not np.array_equal(a[12000:], second_half_fresh)  # the second half knew about the first


@REAL
def test_the_real_graph_turns_stationary_noise_down_and_reports_its_speed(name):
    x = (np.random.default_rng(22).standard_normal(32000) * 0.05).astype(np.float32)
    d = StreamDenoiser(name)
    out = d.run_clip(x)

    def rms(a):
        return float(np.sqrt(np.mean(a.astype(np.float64) ** 2)))

    assert out.size == x.size and rms(out[16000:]) < 0.2 * rms(x[16000:])
    status = d.status()
    assert status["engine"] == name and status["active"] and status["frames"] > 0
    assert status["rtf"] is not None and status["rtf"] > 0 and status["latencyMs"] == ENGINES[name].latency_ms
    assert 0 <= status["keepRatio"] < 0.3
