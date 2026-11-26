"""FRIDAY Ears: the Silero voice gate. Every rule runs on an injected probability stream (no model file, no network, no
clock); one optional test reads the real pinned file and skips visibly where it is not on disk."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import stream_ear  # noqa: E402
import vad_onnx  # noqa: E402
from fake_transducer import FakeModel, pcm_bytes, write_model_dir  # noqa: E402
from stream_ear import EnergyVad, TransducerEngine  # noqa: E402
from transducer_loop import NemotronStream  # noqa: E402
from vad_onnx import FRAME, FRAME_MS, SileroGate, SileroStream, VadUnavailable, build_gate, clamp_config  # noqa: E402


class Script:
    """A scorer that returns the next scripted probability per frame; it also records the frames it was given."""

    def __init__(self, ps):
        self.ps, self.at, self.frames, self.resets = list(ps), 0, [], 0

    def __call__(self, frame):
        self.frames.append(np.array(frame))
        p = self.ps[min(self.at, len(self.ps) - 1)]
        self.at += 1
        return p

    def reset(self):
        self.resets += 1


def frame(value=0.0):
    return np.full(FRAME, value, dtype=np.float32)


def run(ps, **kw):
    """Push one frame per probability. Returns the steps."""
    stream = SileroStream(scorer=Script(ps), **kw)
    return stream, [stream.push(frame(i / 1000)) for i in range(len(ps))]


def events(steps):
    return [s.event for s in steps]


# ---- the config ----------------------------------------------------------------------------------------------------


def test_the_ears_object_is_clamped_and_a_missing_one_gives_the_defaults():
    d = clamp_config(None)
    assert (d.mode, d.start, d.end, d.min_speech_ms, d.pre_roll_ms, d.onset_frames) == ("auto", 0.5, 0.35, 120, 500, 3)
    assert clamp_config({}) == d and clamp_config("nope") == d  # type: ignore[arg-type]
    wild = clamp_config({"vad": "SILERO", "vadStart": 5, "vadEnd": 9, "minSpeechMs": 1, "preRollMs": 99999})
    assert wild.mode == "silero" and wild.start == 0.9 and wild.end == pytest.approx(0.85)
    assert (wild.min_speech_ms, wild.pre_roll_ms) == (60, 1000)
    low = clamp_config({"vadStart": 0.0, "vadEnd": 0.0, "minSpeechMs": 9999, "preRollMs": 0})
    assert low.start == 0.2 and low.end == 0.05 and (low.min_speech_ms, low.pre_roll_ms) == (400, 200)


@pytest.mark.parametrize("bad", [True, "0.7", None, float("nan"), float("inf"), [], {}])
def test_a_wrong_typed_number_falls_to_its_default(bad):
    cfg = clamp_config({"vad": "bogus", "vadStart": bad, "vadEnd": bad, "minSpeechMs": bad, "preRollMs": bad})
    assert (cfg.mode, cfg.start, cfg.end, cfg.min_speech_ms, cfg.pre_roll_ms) == ("auto", 0.5, 0.35, 120, 500)


# ---- onset, hysteresis, min speech ---------------------------------------------------------------------------------


def test_speech_starts_on_the_third_frame_in_a_row_which_is_96_ms():
    _, steps = run([0.1, 0.9, 0.9, 0.9, 0.9])
    assert events(steps) == [None, None, None, "start", None]
    assert [s.speaking for s in steps] == [False, False, False, True, True]
    assert 3 * FRAME_MS == 96


def test_one_loud_frame_or_two_is_not_a_start_and_the_count_restarts_after_a_dip():
    _, steps = run([0.9, 0.9, 0.2, 0.9, 0.9, 0.2, 0.9])
    assert not any(s.speaking for s in steps) and events(steps) == [None] * 7


def test_a_probability_between_the_two_thresholds_never_starts_speech():
    _, steps = run([0.36, 0.49, 0.4, 0.45, 0.49, 0.36] * 5)
    assert not any(s.speaking for s in steps) and not any(s.events for s in steps)


def test_a_probability_between_the_two_thresholds_never_ends_speech_so_it_does_not_flap():
    _, steps = run([0.9] * 3 + [0.36, 0.49, 0.4, 0.45, 0.36, 0.49] * 6 + [0.9, 0.2])
    flat = [e for s in steps for e in s.events]
    assert flat == ["start", "end"]
    assert [s.speaking for s in steps[3:-1]] == [True] * (len(steps) - 4)


def test_speech_ends_only_below_the_end_threshold_not_at_it():
    _, steps = run([0.9] * 5 + [0.35, 0.35, 0.349])
    assert events(steps)[-3:] == [None, None, "end"]


def test_a_burst_shorter_than_min_speech_is_cancelled_and_a_longer_one_ends():
    _, short = run([0.9, 0.9, 0.9, 0.1])  # 96 ms of speech < 120 ms
    assert events(short) == [None, None, "start", "cancel"] and short[-1].speaking is False
    _, longer = run([0.9, 0.9, 0.9, 0.9, 0.1])  # 128 ms
    assert events(longer) == [None, None, "start", None, "end"]


def test_the_thresholds_and_the_onset_are_the_ones_asked_for():
    _, steps = run([0.7, 0.7, 0.55, 0.3, 0.2], start=0.7, end=0.25, onset_frames=2)
    assert events(steps) == [None, "start", None, None, "end"]


def test_a_new_turn_can_start_after_one_ends():
    _, steps = run([0.9] * 5 + [0.1] * 2 + [0.9] * 4 + [0.1])
    assert [e for s in steps for e in s.events] == ["start", "end", "start", "end"]


# ---- pre-roll ------------------------------------------------------------------------------------------------------


def test_the_start_step_returns_500_ms_of_pre_roll_oldest_first_with_the_onset_frames_in_it():
    quiet = 40
    _, steps = run([0.05] * quiet + [0.9] * 3 + [0.9] * 2)
    start = steps[quiet + 2]
    assert start.event == "start"
    ms = start.audio.size * 1000 / 16000
    assert abs(ms - 500) <= FRAME_MS  # 500 +- one frame
    frames = start.audio.reshape(-1, FRAME)
    marks = [round(float(f[0]) * 1000) for f in frames]
    assert marks == sorted(marks) and marks[-1] == quiet + 2  # oldest first, ending on the third onset frame
    assert marks[-3:] == [quiet, quiet + 1, quiet + 2]  # the withheld onset frames are the newest three
    after = steps[quiet + 3]
    assert after.audio.size == FRAME and round(float(after.audio[0]) * 1000) == quiet + 3  # then frames pass through


def test_a_short_silence_gives_a_short_pre_roll_and_the_ring_follows_the_setting():
    _, steps = run([0.05] * 4 + [0.9] * 3)
    assert steps[-1].audio.size == 7 * FRAME
    _, tight = run([0.05] * 40 + [0.9] * 3, pre_roll_ms=200)
    assert abs(tight[-1].audio.size * 1000 / 16000 - 200) <= FRAME_MS


def test_the_second_turn_pre_roll_holds_only_audio_after_the_first_turn_ended():
    _, steps = run([0.9] * 5 + [0.1] * 2 + [0.05] * 3 + [0.9] * 3)
    second = steps[-1]
    # the frame that ended turn one belongs to turn one: 1 low frame, 3 quiet, 3 onset
    assert second.event == "start" and second.audio.size == 7 * FRAME


def test_audio_is_gated_so_silence_between_turns_is_never_returned():
    _, steps = run([0.05] * 10)
    assert all(s.audio.size == 0 for s in steps)


# ---- chunking and input types --------------------------------------------------------------------------------------


def test_any_chunk_size_gives_the_same_events_as_whole_frames():
    ps = [0.05] * 6 + [0.9] * 6 + [0.1] * 3
    whole, _ = run(ps)
    pcm = np.concatenate([frame(i / 1000) for i in range(len(ps))])
    got = []
    stream = SileroStream(scorer=Script(ps))
    for at in range(0, pcm.size, 333):  # odd chunks: a frame is cut across pushes
        step = stream.push(pcm[at : at + 333])
        got += list(step.events)
    assert got == ["start", "end"] and not stream.speaking and whole is not stream


def test_int16_bytes_and_int16_arrays_are_read_as_16_bit_pcm():
    script = Script([0.1])
    stream = SileroStream(scorer=script)
    stream.push(np.full(FRAME, 16384, dtype="<i2").tobytes())
    stream.push(np.full(FRAME, -16384, dtype=np.int16))
    assert script.frames[0][0] == pytest.approx(0.5) and script.frames[1][0] == pytest.approx(-0.5)


def test_a_push_shorter_than_a_frame_scores_nothing_and_reports_the_last_state():
    script = Script([0.9])
    stream = SileroStream(scorer=script)
    step = stream.push(np.zeros(100, dtype=np.float32))
    assert script.at == 0 and step.p == 0.0 and step.speaking is False and step.event is None


def test_reset_clears_the_turn_the_audio_carry_and_the_scorer():
    script = Script([0.9] * 6)
    stream = SileroStream(scorer=script)
    for _ in range(4):
        stream.push(frame())
    stream.push(np.zeros(100, dtype=np.float32))
    assert stream.speaking
    stream.reset()
    assert not stream.speaking and script.resets >= 2 and stream.p == 0.0
    assert stream.push(np.zeros(FRAME - 100, dtype=np.float32)).p == 0.0  # the 100 carried samples are gone


# ---- the gate (the EnergyVad interface) ----------------------------------------------------------------------------


def gate_over(ps, **kw):
    return SileroGate(SileroStream(scorer=Script(ps)), **kw)


def test_the_gate_reads_speech_only_after_the_onset_and_counts_silence_on_the_audio_clock():
    gate = gate_over([0.05] * 3 + [0.9] * 6 + [0.1] * 3)
    slice_ = np.zeros(FRAME, dtype=np.float32)
    probs = [gate.push(slice_, 32) for _ in range(12)]
    assert probs[2] < 0.5 and gate.silence_ms >= 0
    assert [p >= 0.5 for p in probs] == [False] * 5 + [True] * 4 + [False] * 3
    assert probs[3] < 0.5 and probs[4] < 0.5  # a loud frame before the onset is not yet speech to the endpointer
    gate.reset()
    assert gate.silence_ms == 0 and gate.probability == 0.0


def test_the_gate_silence_resets_while_speaking_and_grows_after_it_ends():
    gate = gate_over([0.9] * 3 + [0.3] * 4)
    sl = np.zeros(FRAME, dtype=np.float32)
    for _ in range(3):
        gate.push(sl, 32)
    assert gate.silence_ms == 0 and gate.probability >= 0.5
    for _ in range(4):
        gate.push(sl, 32)
    assert gate.silence_ms == 4 * 32 and gate.probability < 0.5  # the end frame itself is already quiet


def test_the_gate_hysteresis_band_reads_as_speech_while_speaking_and_as_quiet_while_idle():
    gate = gate_over([0.9] * 3 + [0.4] * 3)
    sl = np.zeros(FRAME, dtype=np.float32)
    got = [gate.push(sl, 32) for _ in range(6)]
    assert all(p >= 0.5 for p in got[2:])
    idle = gate_over([0.4] * 6)
    assert all(idle.push(sl, 32) < 0.5 for _ in range(6))


def test_twenty_millisecond_slices_still_reach_the_model_in_whole_frames():
    script = Script([0.9] * 10)
    gate = SileroGate(SileroStream(scorer=script))
    for _ in range(40):  # 800 ms in 20 ms slices
        gate.push(np.zeros(320, dtype=np.float32), 20)
    assert script.at == 800 * 16 // FRAME  # 25 frames


def test_a_scorer_that_fails_mid_stream_hands_the_gate_to_the_energy_fallback():
    class Boom(Script):
        def __call__(self, frame):
            raise RuntimeError("session died")

    fallback = EnergyVad()
    gate = SileroGate(SileroStream(scorer=Boom([0.9])), fallback=fallback)
    tone = (np.sin(np.arange(320) * 0.3) * 0.3).astype(np.float32)
    for _ in range(40):
        gate.push(np.zeros(FRAME, dtype=np.float32), 32)
    for _ in range(8):
        gate.push(tone, 20)
    assert gate.engine == "energy" and gate.probability == fallback.probability == 1.0
    gate.reset()
    assert gate.probability == 0.0 and fallback.probability == 0.0
    with pytest.raises(RuntimeError):
        SileroGate(SileroStream(scorer=Boom([0.9]))).push(np.zeros(FRAME, dtype=np.float32), 32)


# ---- choosing the gate ---------------------------------------------------------------------------------------------


def test_energy_mode_a_missing_file_and_a_missing_runtime_all_keep_the_energy_gate(monkeypatch, tmp_path):
    monkeypatch.setattr(vad_onnx, "find_model", lambda: None)
    assert build_gate(clamp_config(None), EnergyVad)[1] == "energy"
    assert build_gate(clamp_config({"vad": "silero"}), EnergyVad)[1] == "energy"
    monkeypatch.setattr(vad_onnx, "find_model", lambda: tmp_path / "silero_vad.onnx")  # present, not a model

    def broken(_path):
        raise VadUnavailable("no onnxruntime")

    monkeypatch.setattr(vad_onnx, "OnnxScorer", broken)
    assert build_gate(clamp_config({"vad": "auto"}), EnergyVad)[1] == "energy"
    monkeypatch.setattr(vad_onnx, "OnnxScorer", lambda _p: Script([0.1]))
    assert build_gate(clamp_config({"vad": "energy"}), EnergyVad)[1] == "energy"
    gate, name = build_gate(clamp_config({"vad": "auto", "vadStart": 0.6}), EnergyVad)
    assert name == "silero" and isinstance(gate, SileroGate)


def test_find_model_refuses_a_file_that_is_not_the_pinned_size(monkeypatch, tmp_path):
    root = tmp_path / "models"
    root.mkdir()
    monkeypatch.setenv("FRIDAY_ROOT", str(tmp_path))
    assert vad_onnx.find_model() is None
    (root / "silero_vad.onnx").write_bytes(b"123")
    assert vad_onnx.find_model() is None  # a partial download is never opened
    with (root / "silero_vad.onnx").open("wb") as handle:
        handle.truncate(vad_onnx.SILERO_BYTES)
    assert vad_onnx.find_model() == root / "silero_vad.onnx"


def test_the_pinned_size_matches_the_voice_runtime_constant():
    import voice_runtime

    assert vad_onnx.SILERO_BYTES == voice_runtime.SILERO_BYTES and vad_onnx.SILERO_FILE == voice_runtime.SILERO_NAME


# ---- in the stream engine ------------------------------------------------------------------------------------------


def engine_with(tmp_path, monkeypatch, ps=None):
    model = FakeModel()
    folder = write_model_dir(tmp_path / "ear", model.dims)
    engine = TransducerEngine(NemotronStream(model.factory, threads=1))
    if ps is not None:
        monkeypatch.setattr(vad_onnx, "find_model", lambda: tmp_path / "silero_vad.onnx")
        monkeypatch.setattr(vad_onnx, "OnnxScorer", lambda _p: Script(ps))
    else:
        monkeypatch.setattr(vad_onnx, "find_model", lambda: None)
    return engine, folder


def test_the_engine_keeps_the_energy_gate_when_the_file_is_absent_or_ears_vad_is_energy(tmp_path, monkeypatch):
    engine, folder = engine_with(tmp_path, monkeypatch)
    assert engine.open(folder, locale="en-US")["vad"] == "energy" and isinstance(engine._vad, EnergyVad)
    engine, folder = engine_with(tmp_path, monkeypatch, ps=[0.9])
    assert engine.open(folder, ears={"vad": "energy"})["vad"] == "energy" and isinstance(engine._vad, EnergyVad)


@pytest.mark.parametrize("mode", ["auto", "silero"])
def test_the_engine_uses_silero_when_the_file_is_there_and_the_mode_allows_it(tmp_path, monkeypatch, mode):
    engine, folder = engine_with(tmp_path, monkeypatch, ps=[0.9] * 200)
    info = engine.open(folder, ears={"vad": mode, "vadStart": 0.6})
    assert info["vad"] == "silero" and isinstance(engine._vad, SileroGate)
    events = []
    data = pcm_bytes(0.9, 0.3) + pcm_bytes(0.5)
    for at in range(0, len(data), 3200):
        events += engine.feed(data[at : at + 3200])
    kinds = [e["event"] for e in events if e["type"] == "endpoint"]
    assert kinds and kinds[0] == "StartOfTurn"


def test_an_open_without_ears_or_with_junk_still_opens_on_the_defaults(tmp_path, monkeypatch):
    engine, folder = engine_with(tmp_path, monkeypatch)
    for ears in (None, "x", 5, [], {"vadStart": "high"}):
        assert engine.open(folder, ears=ears)["vad"] == "energy"


def test_the_stream_open_op_passes_ears_to_the_engine_and_reports_the_gate(tmp_path, monkeypatch):
    seen = {}

    class Spy(TransducerEngine):
        def open(self, model_dir, **options):
            seen.update(options)
            return super().open(model_dir, **options)

    monkeypatch.setattr(vad_onnx, "find_model", lambda: None)
    model = FakeModel()
    folder = write_model_dir(tmp_path / "ear", model.dims)
    engine = Spy(NemotronStream(model.factory, threads=1))
    monkeypatch.setattr(stream_ear, "choose_tier", lambda *a, **k: stream_ear.TierChoice("x", "ok", folder, None, None))
    monkeypatch.setattr(stream_ear, "engine_spec", lambda name: stream_ear.EngineSpec("x", "x", {}, lambda: engine))
    host = stream_ear.StreamHost()
    reply = host.handle({"op": "stream-open", "streamEngine": "auto", "ears": {"vad": "energy", "preRollMs": 300}})
    assert reply["ok"] is True and reply["vad"] == "energy"
    assert seen["ears"] == {"vad": "energy", "preRollMs": 300}


# ---- the real model (optional) -------------------------------------------------------------------------------------


def _real_model():
    try:
        import onnxruntime  # noqa: F401
    except ImportError:
        return None
    return vad_onnx.find_model()


@pytest.mark.skipif(_real_model() is None, reason="the pinned silero_vad.onnx or onnxruntime is not available here")
def test_the_real_model_keeps_quiet_and_noise_as_not_speech_and_repeats_after_a_reset():
    path = _real_model()
    assert path is not None
    rng = np.random.default_rng(7)
    noise = (rng.standard_normal(16000) * 0.01).astype(np.float32)
    stream = SileroStream(model_path=path)
    first = stream.push(noise)
    assert not first.speaking and first.event is None and 0.0 <= first.p < 0.5
    quiet = stream.push(np.zeros(16000, dtype=np.float32))
    assert not quiet.speaking and quiet.p < 0.2
    stream.reset()
    again = stream.push(noise)
    assert again.p == pytest.approx(first.p, abs=1e-6)  # the state and context start clean
    one_shot = vad_onnx.score_window(path, noise[:FRAME])
    assert 0.0 <= one_shot <= 1.0
