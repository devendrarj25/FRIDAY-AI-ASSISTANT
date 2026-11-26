"""FRIDAY's NeMo ear runner: features, files, CTC / RNN-T / TDT readings over fake onnxruntime sessions.

No weights and no network. Every expected value comes from a fixture worked out by hand or from an independent
write-out of the published NeMo rule inside this file.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Any

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import nemo_ear  # noqa: E402
from hotword_trie import HotwordTrie  # noqa: E402
from mel_frontend import MelFrontend, mel_filterbank, nemo_config  # noqa: E402
from nemo_ear import NemoEar, NemoEarError, NemoFeatures, NemoFiles  # noqa: E402

MARK = "▁"
V = 40
D = 12
H = 6
LAYERS = 2
SECOND = np.zeros(16000, dtype=np.float32)
SCRIPT = [0, 1, 1, 0, 2, 0, 2, 2, 3, 0, 0, 4, 0]  # best piece of each of the 13 frames of one second


def make_vocab(size: int = V) -> dict[int, str]:
    pieces = {0: "<blk>"}
    for i in range(1, size):
        pieces[i] = (MARK if i % 3 == 1 else "") + chr(0x0915 + i)
    return pieces


def tone(seconds: float = 1.0, seed: int = 1) -> np.ndarray:
    count = int(16000 * seconds)
    noise = np.random.default_rng(seed).standard_normal(count)
    return (0.3 * np.sin(2 * np.pi * 440 * np.arange(count) / 16000) + 0.05 * noise).astype(np.float32)


# ---- fake sessions -------------------------------------------------------------------------------------------------


class Port:
    def __init__(self, name: str, shape: list, kind: str = "tensor(float)") -> None:
        self.name, self.shape, self.type = name, shape, kind


class CtcSession:
    """Answers ``logprobs`` frame by frame from a script of best pieces (0.9 on the piece, the rest spread)."""

    def __init__(self, script: list[int], vocab: int = 5, scale: float = 1.0) -> None:
        self.script, self.vocab, self.scale = script, vocab, scale
        self.seen: dict[str, Any] = {}

    def run(self, names: list[str], feeds: dict[str, Any]) -> list[np.ndarray]:
        self.seen = {"names": names, "shape": feeds["audio_signal"].shape, "length": feeds["length"].tolist()}
        frames = (feeds["audio_signal"].shape[2] - 1) // 8 + 1
        rows = np.full((1, frames, self.vocab), math.log(0.1 / (self.vocab - 1)), dtype=np.float32)
        for t in range(frames):
            rows[0, t, self.script[t % len(self.script)]] = math.log(0.9)
        return [rows * self.scale]


class EncoderSession:
    def __init__(self, dim: int = D, seed: int = 5) -> None:
        self.dim, self.seed = dim, seed

    def run(self, names: list[str], feeds: dict[str, Any]) -> list[np.ndarray]:
        frames = (int(feeds["length"][0]) - 1) // 8 + 1
        out = np.random.default_rng(self.seed).normal(size=(1, self.dim, frames)).astype(np.float32)
        return [out, np.asarray([frames], dtype=np.int64)]


class JointSession:
    """A decoder_joint graph: logits from the encoder frame, the token and a squashed LSTM state; counts its runs."""

    def __init__(self, width: int, blank_bias: float = 2.0, seed: int = 3, ints: str = "tensor(int32)") -> None:
        rng = np.random.default_rng(seed)
        self.width, self.ints = width, ints
        self.proj = rng.normal(size=(D, width)) * 1.2
        self.emb = rng.normal(size=(V, width))
        self.mix = rng.normal(size=width)
        self.bias = np.zeros(width)
        self.bias[0] = blank_bias
        self.runs = 0
        self.feeds: dict[str, Any] = {}

    def get_inputs(self) -> list[Port]:
        return [
            Port("encoder_outputs", ["b", D, 1]),
            Port("targets", ["b", 1], self.ints),
            Port("target_length", ["b"], self.ints),
            Port("input_states_1", [LAYERS, "b", H]),
            Port("input_states_2", [LAYERS, "b", H]),
        ]

    def get_outputs(self) -> list[Port]:
        return [Port("outputs", ["b", 1, 1, self.width])]

    def run(self, names: list[str], feeds: dict[str, Any]) -> list[np.ndarray]:
        self.runs += 1
        self.feeds = feeds
        frame = np.asarray(feeds["encoder_outputs"], dtype=np.float32).reshape(D)
        token = int(np.asarray(feeds["targets"]).reshape(-1)[0])
        first = np.tanh(np.asarray(feeds["input_states_1"]) * 0.5 + (token + 1) / 10.0).astype(np.float32)
        second = np.tanh(np.asarray(feeds["input_states_2"]) * 0.3 + 0.1 * (token % 5)).astype(np.float32)
        out = frame @ self.proj + self.emb[token] + self.mix * float(first.mean()) + self.bias
        return [out.astype(np.float32).reshape(1, 1, 1, -1), first, second]


def fused_ear(kind: str, blank_bias: float | None = None, config: dict | None = None, ints: str = "tensor(int32)"):
    width = V + (5 if kind == "tdt" else 0)
    bias = blank_bias if blank_bias is not None else (1.5 if kind == "tdt" else 3.0)
    files = NemoFiles(kind, Path("vocab.txt"), Path("e.onnx"), Path("dj.onnx"), config or {})
    return NemoEar(files, make_vocab(), [EncoderSession(), JointSession(width, bias, ints=ints)])


def ctc_ear(script: list[int], scale: float = 1.0, config: dict | None = None) -> tuple[NemoEar, CtcSession]:
    session = CtcSession(script, scale=scale)
    vocab = {0: "<blk>", 1: MARK + "आज", 2: "मौ", 3: "सम", 4: MARK + "है"}
    files = NemoFiles("ctc", Path("vocab.txt"), Path("model.onnx"), None, config or {})
    return NemoEar(files, vocab, [session]), session


def reference_transducer(ear: NemoEar, enc: np.ndarray, tdt: bool) -> tuple[list[int], list[int], list[float]]:
    """The published NeMo greedy rule written out on its own: one fused graph run per step, state moves on a token."""
    joint = ear._fused.session  # type: ignore[union-attr]
    shape = (LAYERS, 1, H)
    state = (np.zeros(shape, dtype=np.float32), np.zeros(shape, dtype=np.float32))
    tokens: list[int] = []
    frames: list[int] = []
    scores: list[float] = []
    t = emitted = 0
    while t < enc.shape[0]:
        previous = tokens[-1] if tokens else 0
        feeds = {
            "encoder_outputs": enc[t][None, :, None],
            "targets": [[previous]],
            "target_length": [1],
            "input_states_1": state[0],
            "input_states_2": state[1],
        }
        out, s1, s2 = joint.run([], feeds)
        out = np.squeeze(out)
        step = int(out[V:].argmax()) if tdt else -1
        logits = out[:V] if tdt else out
        token = int(logits.argmax())
        if token != 0:
            state = (s1, s2)
            tokens.append(token)
            frames.append(t)
            shifted = logits - logits.max()
            scores.append(float(shifted[token] - np.log(np.exp(shifted).sum())))
            emitted += 1
        if step > 0:
            t += step
            emitted = 0
        elif token == 0 or emitted == ear.max_tokens_per_step:
            t += 1
            emitted = 0
    return tokens, frames, scores


def reference_features(wave: np.ndarray, n_mels: int) -> tuple[np.ndarray, int]:
    """The NeMo recipe as a centred STFT: zero padding, symmetric Hann, utterance mean and variance (ddof 1)."""
    count = wave.size // 160
    boosted = wave.astype(np.float64) - 0.97 * np.concatenate(([0.0], wave[:-1].astype(np.float64)))
    padded = np.pad(boosted, (256, 256))
    window = np.pad(np.hanning(400), (56, 56))
    power = np.stack([np.abs(np.fft.rfft(padded[i * 160 : i * 160 + 512] * window)) ** 2 for i in range(count + 1)])
    logmel = np.log(power @ mel_filterbank(nemo_config(n_mels=n_mels)).T + 2.0**-24)
    real = logmel[:count]
    mean = real.mean(axis=0)
    spread = real.std(axis=0, ddof=1)
    out = np.zeros_like(logmel)
    out[:count] = (real - mean) / (spread + 1e-5)
    return out.T.astype(np.float32), count


def encoder_frames(frames: int, seed: int) -> np.ndarray:
    return np.random.default_rng(seed).normal(size=(frames, D)).astype(np.float32)


# ---- features ------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("n_mels", [80, 128])
def test_features_follow_the_nemo_recipe_written_out_independently(n_mels):
    for length in (3200, 32037, 112005):
        wave = tone(length / 16000, seed=length)[:length]
        expected, count = reference_features(wave, n_mels)
        mine, got = NemoFeatures(n_mels)(wave)
        assert got == count and mine.shape == expected.shape
        assert float(np.abs(mine - expected).max()) < 1e-3


def test_features_are_normalised_per_bin_and_the_frame_past_the_audio_is_zero():
    feats, count = NemoFeatures(80)(tone(2.0))
    assert feats.shape == (80, count + 1) and feats.dtype == np.float32 and count == 200
    real = feats[:, :count]
    assert np.abs(real.mean(axis=1)).max() < 1e-4
    assert np.allclose(real.std(axis=1, ddof=1), 1.0, atol=1e-3)
    assert not feats[:, count].any()


def test_a_clip_shorter_than_one_frame_is_refused():
    with pytest.raises(NemoEarError):
        NemoFeatures(80)(np.zeros(100, dtype=np.float32))


def test_the_symmetric_window_is_set_here_because_the_periodic_one_moves_bins():
    wave = tone(2.0)
    mine, count = NemoFeatures(80)(wave)
    config = nemo_config(n_mels=80, normalize="per_feature")
    shared = MelFrontend(config).extract(np.pad(wave, (200, 200)))[:count]
    gap = np.abs(shared - mine[:, :count].T)
    assert gap.mean() < 0.05  # the same recipe ...
    assert gap.max() > 0.05  # ... but a periodic window is not the one the model was trained with


# ---- vocabulary, files, kinds --------------------------------------------------------------------------------------


def test_the_vocabulary_is_read_with_the_word_mark_and_bad_lines_are_refused(tmp_path):
    good = tmp_path / "vocab.txt"
    good.write_text(f"<blk> 0\n{MARK}आज 1\n\nमौ 2\n", encoding="utf-8")
    assert nemo_ear.read_vocab(good) == {0: "<blk>", 1: MARK + "आज", 2: "मौ"}
    for text in ("", "x", "tok notanumber"):
        (tmp_path / "bad.txt").write_text(text, encoding="utf-8")
        with pytest.raises(NemoEarError):
            nemo_ear.read_vocab(tmp_path / "bad.txt")
    with pytest.raises(NemoEarError):
        nemo_ear.read_vocab(tmp_path / "absent.txt")


@pytest.mark.parametrize(
    ("name", "kind"),
    [("nemo-conformer-ctc", "ctc"), ("nemo-conformer-rnnt", "rnnt"), ("NEMO_CONFORMER_TDT", "tdt"), ("tdt", "tdt")],
)
def test_the_kind_comes_from_the_model_type(name, kind):
    assert nemo_ear.kind_of(name) == kind


def test_an_unknown_model_type_has_no_kind():
    assert nemo_ear.kind_of("nemo-canary-aed") is None and nemo_ear.kind_of("") is None


def _folder(root: Path, files: list[str], config: dict | None = None) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / "vocab.txt").write_text("\n".join(f"{p} {i}" for i, p in make_vocab().items()), encoding="utf-8")
    if config is not None:
        (root / "config.json").write_text(json.dumps(config), encoding="utf-8")
    for name in files:
        (root / name).write_bytes(b"x")
    return root


def test_discovery_picks_the_quantised_graph_in_either_spelling(tmp_path):
    dot = _folder(tmp_path / "a", ["model.onnx", "model.int8.onnx"])
    assert nemo_ear.discover(dot, "ctc", "int8").encoder.name == "model.int8.onnx"
    assert nemo_ear.discover(dot, "ctc", None).encoder.name == "model.onnx"
    under = _folder(tmp_path / "b", ["model_int8.onnx"])
    assert nemo_ear.discover(under, "nemo-conformer-ctc", "int8").encoder.name == "model_int8.onnx"


def test_discovery_refuses_a_missing_or_doubled_graph_and_an_unknown_kind(tmp_path):
    empty = _folder(tmp_path / "a", [])
    with pytest.raises(NemoEarError, match="missing"):
        nemo_ear.discover(empty, "ctc", "int8")
    twice = _folder(tmp_path / "b", ["model.int8.onnx", "model_int8.onnx"])
    with pytest.raises(NemoEarError, match="more than one"):
        nemo_ear.discover(twice, "ctc", "int8")
    with pytest.raises(NemoEarError, match="unknown kind"):
        nemo_ear.discover(twice, "aed", "int8")
    (tmp_path / "b" / "vocab.txt").unlink()
    with pytest.raises(NemoEarError, match="vocab"):
        nemo_ear.discover(twice, "ctc", "int8")


def test_discovery_reads_the_kind_from_config_then_from_the_files(tmp_path):
    pair = ["encoder-model.onnx", "decoder_joint-model.onnx"]
    configured = nemo_ear.discover(_folder(tmp_path / "a", pair, {"model_type": "nemo-conformer-tdt"}))
    assert configured.kind == "tdt" and configured.decoder_joint is not None
    assert configured.decoder_joint.name == "decoder_joint-model.onnx"
    assert nemo_ear.discover(_folder(tmp_path / "b", pair)).kind == "rnnt"
    single = nemo_ear.discover(_folder(tmp_path / "c", ["model.onnx"], {"features_size": 128}))
    assert single.kind == "ctc" and single.config["features_size"] == 128


def test_a_broken_config_is_an_error_not_a_crash(tmp_path):
    folder = _folder(tmp_path, ["model.onnx"])
    (folder / "config.json").write_text("{not json", encoding="utf-8")
    with pytest.raises(NemoEarError, match="config"):
        nemo_ear.discover(folder, "ctc")


def test_load_opens_the_files_it_found_through_the_session_factory(tmp_path):
    folder = _folder(tmp_path, ["model.int8.onnx"], {"features_size": 128, "subsampling_factor": 4})
    opened: list[str] = []

    def factory(path: Path) -> CtcSession:
        opened.append(path.name)
        return CtcSession([0], vocab=V)

    ear = NemoEar.load(folder, kind="nemo-conformer-ctc", quantization="int8", session_factory=factory)
    assert opened == ["model.int8.onnx"] and ear.kind == "ctc"
    assert (ear.features_size, ear.subsampling, ear.blank_id) == (128, 4, 0)
    assert ear.frame_s == pytest.approx(0.04)


@pytest.mark.parametrize("key", ["features_size", "subsampling_factor", "max_tokens_per_step"])
def test_a_config_that_would_divide_by_zero_is_refused(key):
    files = NemoFiles("ctc", Path("v"), Path("m"), None, {key: 0})
    with pytest.raises(NemoEarError, match="at least 1"):
        NemoEar(files, {0: "<blk>", 1: "a"}, [CtcSession([0])])


def test_a_vocabulary_without_a_blank_is_refused():
    files = NemoFiles("ctc", Path("v"), Path("m"), None, {})
    with pytest.raises(NemoEarError, match="blank"):
        NemoEar(files, {0: "a", 1: "b"}, [CtcSession([0])])


# ---- CTC -----------------------------------------------------------------------------------------------------------


def test_ctc_reads_pieces_times_and_scores_by_the_published_rule():
    ear, session = ctc_ear(SCRIPT)
    heard = ear.with_timestamps().recognize(SECOND)
    assert heard.tokens == [" आज", "मौ", "मौ", "सम", " है"]
    assert heard.text == "आजमौमौसम है"  # a space only where a piece carries the word mark
    assert heard.timestamps == pytest.approx([f * 0.08 for f in (1, 4, 6, 8, 11)])
    top = math.log(0.9)  # a piece's score is the sum of the best scores over its frames, up to the next piece
    assert heard.logprobs == pytest.approx([2 * top, top, 2 * top, top, top], abs=1e-5)
    assert session.seen["names"] == ["logprobs"] and session.seen["length"] == [100]
    assert session.seen["shape"] == (1, 80, 101)
    assert ear.recognize(SECOND) == heard.text


def test_ctc_hears_nothing_in_a_blank_run_and_a_line_has_no_stray_space():
    ear, _ = ctc_ear([0])
    heard = ear.with_timestamps().recognize(SECOND)
    assert (heard.text, heard.tokens, heard.timestamps, heard.logprobs) == ("", [], [], [])
    spaced, _ = ctc_ear([1, 0, 4] + [0] * 10)
    assert spaced.recognize(SECOND) == "आज है"  # one space between words, none in front


def test_hotwords_turn_the_ctc_beam_on_and_win_a_close_call():
    ear, _ = ctc_ear([0])
    rows = np.log(np.full((3, 5), 0.02, dtype=np.float32))
    rows[0, 0] = rows[2, 0] = math.log(0.92)
    rows[1, 2], rows[1, 3] = math.log(0.45), math.log(0.47)
    assert ear._read_ctc(rows, None).tokens == ["सम"]
    trie = HotwordTrie()
    trie.add_phrase([2])
    biased = ear._read_ctc(rows, trie)
    assert biased.tokens == ["मौ"] and biased.timestamps is None and biased.logprobs is None


def test_ctc_log_probs_give_rows_pieces_and_seconds_per_frame():
    ear, _ = ctc_ear(SCRIPT)
    rows, pieces, frame_s = ear.log_probs(SECOND) or (None, None, None)
    assert rows is not None and rows.shape == (13, 5) and frame_s == pytest.approx(0.08)
    assert pieces == ["<blk>", MARK + "आज", "मौ", "सम", MARK + "है"] and ear.ctc_head() == (pieces, frame_s)
    assert np.allclose(np.exp(rows).sum(axis=1), 1.0, atol=1e-4)


def test_ctc_log_probs_refuse_logits_and_a_failing_graph():
    logits, _ = ctc_ear(SCRIPT, scale=-5.0)  # the flip makes every row positive: not log probabilities
    assert logits.log_probs(SECOND) is None
    good, session = ctc_ear(SCRIPT)
    session.run = lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("graph failed"))  # type: ignore[method-assign]
    assert good.log_probs(SECOND) is None


def test_a_head_wider_than_the_vocabulary_is_an_error():
    files = NemoFiles("ctc", Path("v"), Path("m"), None, {})
    ear = NemoEar(files, {0: "<blk>", 1: "a"}, [CtcSession([0], vocab=5)])
    with pytest.raises(NemoEarError, match="wider"):
        ear.read(SECOND)


def test_audio_must_be_sixteen_khz_int16_is_scaled_and_nan_is_zeroed():
    ear, _ = ctc_ear(SCRIPT)
    with pytest.raises(NemoEarError, match="16 kHz"):
        ear.read(SECOND, 8000)
    wave = tone()
    assert ear.recognize((wave * 32767).astype(np.int16)) == ear.recognize(wave)
    poisoned = wave.copy()
    poisoned[10] = np.nan
    assert ear.recognize(poisoned) == ear.recognize(wave)


# ---- RNN-T and TDT -----------------------------------------------------------------------------------------


@pytest.mark.parametrize("kind", ["rnnt", "tdt"])
@pytest.mark.parametrize("seed", [0, 1, 2, 3, 4])
def test_the_transducer_reading_matches_the_published_greedy_rule(kind, seed):
    ear = fused_ear(kind)
    enc = encoder_frames(20 + seed * 9, seed)
    tokens, frames, scores = reference_transducer(ear, enc, kind == "tdt")
    heard = ear._read_transducer(enc, None)
    assert tokens and heard.tokens == [ear._text_piece(t) for t in tokens]  # a fixture that says something
    assert heard.timestamps == pytest.approx([f * ear.frame_s for f in frames])
    assert heard.logprobs == pytest.approx(scores, abs=1e-4)


def test_the_cap_per_frame_comes_from_the_config():
    capped = fused_ear("rnnt", blank_bias=-4.0, config={"max_tokens_per_step": 2})
    enc = encoder_frames(5, 2)
    heard = capped._read_transducer(enc, None)
    assert capped.max_tokens_per_step == 2 and len(heard.tokens or []) == 2 * enc.shape[0]


def test_one_graph_run_per_step_not_two():
    ear = fused_ear("rnnt")
    enc = encoder_frames(30, 7)
    session = ear._fused.session  # type: ignore[union-attr]
    reference_transducer(ear, enc, False)  # one run per step by the published rule
    rule = session.runs
    session.runs = 0
    ear._read_transducer(enc, None)
    assert session.runs == rule  # no state is computed twice for the token that was just emitted


def test_the_graph_gets_the_integer_width_it_declares_and_a_float_frame():
    wide = fused_ear("rnnt", ints="tensor(int64)")
    wide._read_transducer(encoder_frames(6, 1), None)
    feeds = wide._fused.session.feeds  # type: ignore[union-attr]
    assert feeds["targets"].dtype == np.int64 and feeds["encoder_outputs"].shape == (1, D, 1)
    assert feeds["encoder_outputs"].dtype == np.float32 and feeds["input_states_1"].shape == (LAYERS, 1, H)
    narrow = fused_ear("rnnt")
    narrow._read_transducer(encoder_frames(6, 1), None)
    assert narrow._fused.session.feeds["targets"].dtype == np.int32  # type: ignore[union-attr]


def test_a_joint_wider_than_the_vocabulary_makes_an_unlabelled_rnnt_a_tdt(tmp_path):
    folder = _folder(tmp_path, ["encoder-model.onnx", "decoder_joint-model.onnx"])
    sessions = {"encoder-model.onnx": EncoderSession(), "decoder_joint-model.onnx": JointSession(V + 5)}
    ear = NemoEar.load(folder, session_factory=lambda path: sessions[path.name])
    assert ear.kind == "tdt" and ear.durations == (0, 1, 2, 3, 4)
    named = NemoEar.load(folder, kind="rnnt", session_factory=lambda path: sessions[path.name])
    assert named.kind == "rnnt"  # the owner's word on the kind stands


def test_tdt_durations_come_from_the_config_when_it_lists_them():
    assert fused_ear("tdt", config={"durations": [0, 2, 4, 6, 8]}).durations == (0, 2, 4, 6, 8)
    assert fused_ear("tdt").durations == (0, 1, 2, 3, 4)


def test_a_tdt_joint_with_no_duration_scores_is_an_error():
    files = NemoFiles("tdt", Path("v"), Path("e"), Path("dj"), {})
    ear = NemoEar(files, make_vocab(), [EncoderSession(), JointSession(V)])
    with pytest.raises(NemoEarError, match="duration"):
        ear._read_transducer(encoder_frames(4, 1), None)


@pytest.mark.parametrize("kind", ["rnnt", "tdt"])
def test_hotwords_run_the_transducer_beam_through_the_lazy_state(kind):
    ear = fused_ear(kind)
    enc = encoder_frames(12, 4)
    plain = ear._read_transducer(enc, None)
    assert plain.tokens
    trie = HotwordTrie()
    trie.add_phrase([5, 6])
    beam = ear._read_transducer(enc, trie)
    assert isinstance(beam.text, str) and beam.timestamps is None and beam.logprobs is None
    assert ear._read_transducer(enc, HotwordTrie()).tokens == plain.tokens  # an empty trie is no trie


def test_a_step_that_never_met_the_joint_still_hands_on_its_state():
    fused = fused_ear("rnnt")._fused
    assert fused is not None
    step, again = fused.decoder(7, fused.zero_state)
    assert step is again and step.after is None
    assert step.state_after()[0].shape == (LAYERS, 1, H)  # a silent frame fills it in
    follow, _ = fused.decoder(9, step)
    assert follow.state is step.after


def test_a_transducer_has_no_ctc_head():
    ear = fused_ear("rnnt")
    assert ear.ctc_head() is None and ear.log_probs(SECOND) is None


def test_a_graph_without_state_inputs_is_refused():
    class Bare:
        def get_inputs(self) -> list[Port]:
            return [Port("encoder_outputs", ["b", D, 1])]

    files = NemoFiles("rnnt", Path("v"), Path("e"), Path("dj"), {})
    with pytest.raises(NemoEarError, match="input_states"):
        NemoEar(files, make_vocab(), [EncoderSession(), Bare()])


def test_a_whole_clip_goes_through_features_encoder_and_joint():
    ear = fused_ear("tdt")
    heard = ear.with_timestamps().recognize(tone(1.5))
    assert heard.tokens and len(heard.tokens) == len(heard.timestamps or []) == len(heard.logprobs or [])
    assert ear.recognize(tone(1.5)) == heard.text
