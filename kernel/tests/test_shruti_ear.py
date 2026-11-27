"""FRIDAY Ear Swift (Shruti): beam order, tags, detokenising, windows, silence guard, loop cut, module surface.

Every graph here is a tiny fake: a decoder that answers from a table keyed on the last token, an encoder and a frontend
that only record what they were given. Nothing opens onnxruntime, a model file or the network.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "kernel"))

import friday_runtime  # noqa: E402
import shruti_ear  # noqa: E402
import stt_bench  # noqa: E402

PAD, BOS, EOS, A, B, C, E0, A4, X85, UPPER_A, PLAIN, KAL = range(12)
VOCAB = ["<pad>", "<s>", "</s>", "\u2581a", "\u2581b", "\u2581c"]
VOCAB += ["<0xE0>", "<0xA4>", "<0x85>", "<0x41>", "x", "\u2581kal"]
TEXT = len(VOCAB)  # ids from here on are language tags
HI, EN = TEXT, TEXT + 1
WIDTH = TEXT + 2
META = {
    "vocab": VOCAB,
    "config": {"text": TEXT, "bos": BOS, "eos": EOS, "hop": 160, "max_tokens": 64, "languages": ["hi", "en"]},
}


def row(logits: dict[int, float]) -> np.ndarray:
    """One decoder row of raw scores: every token far down, the given ones set."""
    out = np.full(WIDTH, -20.0, np.float32)
    for token, value in logits.items():
        out[token] = value
    return out


def log_odds(p: dict[int, float]) -> np.ndarray:
    out = np.full(WIDTH, -20.0, np.float32)
    for token, prob in p.items():
        out[token] = np.log(prob)
    return out


class Spec:
    def __init__(self, name: str, shape: list[Any]) -> None:
        self.name, self.shape = name, shape


class FakeFrontend:
    def __init__(self) -> None:
        self.lengths: list[int] = []

    def run(self, _names: Any, feeds: dict[str, np.ndarray]) -> list[np.ndarray]:
        audio = feeds["audio"]
        self.lengths.append(int(audio.shape[1]))
        return [audio.reshape(1, -1, 1)]


class FakeEncoder:
    def __init__(self) -> None:
        self.frames: list[int] = []

    def run(self, _names: Any, feeds: dict[str, np.ndarray]) -> list[np.ndarray]:
        self.frames.append(int(feeds["frames"][0]))
        return [np.zeros((1, 4, 2), np.float32)]


class FakeDecoder:
    """Answers from ``table[last token]`` (the unlisted rows end the line) and keeps a state like the real graph."""

    def __init__(self, table: dict[int, np.ndarray]) -> None:
        self.table = table
        self.feeds: list[np.ndarray] = []  # the tokens of each call
        self.batches: list[int] = []

    def get_inputs(self) -> list[Spec]:
        return [Spec("tokens", ["b", "t"]), Spec("cross", ["b", "n", 2]), Spec("pos", [1]), Spec("hist", ["b", 4])]

    def run(self, _names: Any, feeds: dict[str, np.ndarray]) -> list[np.ndarray]:
        tokens = feeds["tokens"]
        self.feeds.append(tokens.copy())
        self.batches.append(int(tokens.shape[0]))
        end = row({EOS: 10.0, PAD: 0.0})
        logits = np.stack([self.table.get(int(t[-1]), end) for t in tokens])[:, None, :]
        hist = np.concatenate([feeds["hist"][:, 1:], tokens[:, -1:]], axis=1)  # the last four tokens, per beam
        return [logits, feeds["pos"] + 1, hist]


def runner_with(table: dict[int, np.ndarray]) -> tuple[shruti_ear.ShrutiRunner, FakeFrontend, FakeEncoder, FakeDecoder]:
    frontend, encoder, decoder = FakeFrontend(), FakeEncoder(), FakeDecoder(table)
    return shruti_ear.ShrutiRunner(frontend, encoder, decoder, META), frontend, encoder, decoder


def speech(seconds: float = 1.0) -> np.ndarray:
    return np.random.default_rng(7).uniform(-0.3, 0.3, int(16000 * seconds)).astype(np.float32)


# The greedy road (a, then c) is likelier at each step; the beam finds that "b" then stop is likelier overall.
FORK = {
    HI: log_odds({A: 0.6, B: 0.4}),
    EN: log_odds({A: 0.6, B: 0.4}),
    A: log_odds({C: 0.34, B: 0.33, EOS: 0.33}),
    B: log_odds({EOS: 0.95, C: 0.05}),
    C: log_odds({EOS: 0.9, A: 0.1}),
}


# ---- the search ------------------------------------------------------------------------------------------------------


def test_beam_search_beats_greedy_on_a_fork():
    runner, *_ = runner_with(FORK)
    greedy = runner.transcribe(speech(), language="hi", beams=1)
    beam = runner.transcribe(speech(), language="hi", beams=5)
    assert greedy["tokens"] == [A, C]
    assert beam["tokens"] == [B]
    assert beam["text"] == "b"
    assert greedy["text"] == "a c"


def test_beam_scores_are_length_normalised_not_raw():
    # Raw, the short line "b" (p .495) beats "a c x" (p .437); per token the long line (-0.21) beats it (-0.35).
    table = {
        HI: log_odds({B: 0.5, A: 0.45, C: 0.05}),
        B: log_odds({EOS: 0.99, C: 0.01}),
        A: log_odds({C: 0.99, EOS: 0.01}),
        C: log_odds({PLAIN: 0.99, EOS: 0.01}),
        PLAIN: log_odds({EOS: 0.99, A: 0.01}),
    }
    runner, *_ = runner_with(table)
    best = runner.transcribe(speech(), language="hi", beams=5)
    assert best["tokens"] == [A, C, PLAIN]
    assert best["text"] == "a cx"


def test_a_language_tag_is_never_written_into_the_text():
    table = {HI: row({A: 1.0, B: 0.0, EN: 60.0}), A: row({EOS: 5.0})}  # a huge score on the English tag
    runner, *_ = runner_with(table)
    for beams in (1, 5):
        out = runner.transcribe(speech(), language="hi", beams=beams)
        assert all(t < TEXT for t in out["tokens"])
        assert out["tokens"][:1] == [A]


def test_beam_state_follows_the_beams_in_the_decoder_batch():
    runner, _f, _e, decoder = runner_with(FORK)
    runner.transcribe(speech(), language="hi", beams=5)
    assert decoder.batches[0] == 1  # the prompt is one row
    assert max(decoder.batches) <= 5 and max(decoder.batches) > 1
    assert decoder.feeds[0].tolist() == [[BOS, HI]]


def test_the_language_is_chosen_by_the_first_step_when_not_given():
    table = {BOS: row({HI: 1.0, EN: 3.0}), EN: log_odds({B: 0.9, EOS: 0.1}), HI: log_odds({A: 0.9, EOS: 0.1})}
    runner, _f, _e, decoder = runner_with(table)
    out = runner.transcribe(speech(), language=None, beams=5)
    assert out["language"] == "en"
    assert out["text"] == "b"
    assert decoder.feeds[0].tolist() == [[BOS]]
    assert decoder.feeds[1].tolist() == [[EN]]
    table[BOS] = row({HI: 3.0, EN: 1.0})
    assert runner.transcribe(speech(), language=None)["language"] == "hi"


def test_a_language_outside_the_model_is_refused():
    runner, *_ = runner_with(FORK)
    with pytest.raises(ValueError, match="language"):
        runner.transcribe(speech(), language="ta")


def test_confidence_is_a_mean_log_probability_for_a_beam_read():
    runner, *_ = runner_with(FORK)
    out = runner.transcribe(speech(), language="hi", beams=5)
    assert out["confidence"] is not None and out["confidence"] < 0
    assert runner.confidence == out["confidence"]
    assert runner.transcribe(speech(), language="hi", beams=1)["confidence"] is None


# ---- detokenising ----------------------------------------------------------------------------------------------------


def test_detok_joins_raw_utf8_byte_pieces_and_spaces():
    runner, *_ = runner_with({})
    # E0 A4 85 is one Devanagari letter split over three pieces; 41 is "A"; the control pieces vanish.
    assert runner.detok([BOS, E0, A4, X85, A, UPPER_A, PLAIN, PAD, EOS]) == "\u0905 aAx"


def test_detok_drops_a_broken_byte_run_and_strips_the_edges():
    runner, *_ = runner_with({})
    assert runner.detok([E0, A]) == "a"  # a lone lead byte decodes to nothing
    assert runner.detok([A, B, C]) == "a b c"
    assert runner.detok([E0, A4]) == ""
    assert runner.detok([999, -1, A]) == "a"  # an id outside the vocabulary is ignored, never an exception


# ---- windows and the silence guard -----------------------------------------------------------------------------------


def test_long_audio_is_cut_into_equal_windows_of_at_most_30_seconds():
    table = {HI: log_odds({B: 0.99, EOS: 0.01}), B: log_odds({EOS: 0.99, C: 0.01})}
    runner, frontend, encoder, _d = runner_with(table)
    audio = speech(70.0)
    out = runner.transcribe(audio, language="hi")
    assert len(frontend.lengths) == 3
    assert sum(frontend.lengths) == audio.size
    assert max(frontend.lengths) <= 30 * 16000
    assert max(frontend.lengths) - min(frontend.lengths) <= 1
    assert encoder.frames == [n // 160 for n in frontend.lengths]
    assert out["text"] == "b b b"
    assert out["tokens"] == [B, B, B]


def test_audio_up_to_30_seconds_is_one_pass():
    runner, frontend, *_ = runner_with(FORK)
    runner.transcribe(speech(30.0), language="hi")
    assert frontend.lengths == [30 * 16000]


@pytest.mark.parametrize(
    "audio", [np.zeros(16000, np.float32), np.full(16000, 5e-5, np.float32), np.zeros(0, np.float32)]
)
def test_digital_silence_is_empty_and_no_graph_runs(audio):
    runner, frontend, encoder, decoder = runner_with(FORK)
    out = runner.transcribe(audio, language="hi")
    assert out["text"] == "" and out["tokens"] == []
    assert frontend.lengths == [] and encoder.frames == [] and decoder.feeds == []


# ---- the repetition cut ----------------------------------------------------------------------------------------------


def test_cut_loops_keeps_the_first_copy_of_a_repeated_pattern():
    assert shruti_ear.cut_loops([1, 2, 3, 3, 3, 3, 4]) == [1, 2, 3]
    assert shruti_ear.cut_loops([5, 3, 4, 3, 4, 3, 4, 3, 4]) == [5, 3, 4]
    assert shruti_ear.cut_loops([3, 3, 4, 4, 5, 5]) == [3, 3, 4, 4, 5, 5]  # twice is speech, not a loop
    assert shruti_ear.cut_loops([]) == []
    big = list(range(100))
    assert shruti_ear.cut_loops(big) == big
    nine = [1, 2, 3, 4, 5, 6, 7, 8, 9] * 3
    assert shruti_ear.cut_loops(nine) == nine  # a period of nine is longer than a loop is allowed to be


def test_a_runaway_decoder_is_cut_to_one_copy_and_left_alone_when_off():
    table = {HI: log_odds({A: 1.0}), A: log_odds({B: 1.0}), B: log_odds({A: 1.0})}  # a, b, a, b, ... never stops
    runner, *_ = runner_with(table)
    cut = runner.transcribe(speech(), language="hi", beams=1)
    raw = runner.transcribe(speech(), language="hi", beams=1, loops="off")
    assert cut["tokens"] == [A, B]
    assert len(raw["tokens"]) > 6 and raw["tokens"][:4] == [A, B, A, B]
    beam = runner.transcribe(speech(), language="hi", beams=5)
    assert beam["tokens"] == [A, B]


def test_the_token_cap_grows_with_the_audio_and_stays_under_the_model_limit():
    table = {HI: log_odds({A: 1.0}), A: log_odds({B: 1.0}), B: log_odds({C: 1.0}), C: log_odds({A: 0.5, B: 0.5})}
    runner, _f, _e, decoder = runner_with(table)
    runner.transcribe(speech(1.0), language="hi", beams=1, loops="off")
    assert len(decoder.feeds) <= 1 + int(1.0 * 12 + 8)
    decoder.feeds.clear()
    runner.transcribe(speech(30.0), language="hi", beams=1, loops="off")
    assert len(decoder.feeds) <= 1 + META["config"]["max_tokens"] - 2


# ---- the module surface ----------------------------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def clean_module(monkeypatch):
    shruti_ear.unload()
    shruti_ear._broken.clear()
    monkeypatch.setattr(shruti_ear, "admit_hook", shruti_ear.admit_all)
    monkeypatch.setattr(shruti_ear, "threads", None)
    yield
    shruti_ear.unload()
    shruti_ear._broken.clear()


def stage(root: Path, big: bool = True) -> Path:
    folder = root / "models" / shruti_ear.MODEL_DIR
    folder.mkdir(parents=True)
    (folder / shruti_ear.VOCAB).write_text(json.dumps(META), encoding="utf-8")
    for name in (shruti_ear.FRONTEND, shruti_ear.ENCODER, shruti_ear.DECODER):
        with (folder / name).open("wb") as handle:
            handle.truncate(shruti_ear.MIN_BYTES.get(name, 1) + 1 if big else 10)  # sparse: no real bytes written
    return folder


def fake_open(table: dict[int, np.ndarray], opened: list[str] | None = None):
    def opener(path: Path) -> Any:
        if opened is not None:
            opened.append(path.name)
        return {
            shruti_ear.FRONTEND: FakeFrontend(),
            shruti_ear.ENCODER: FakeEncoder(),
            shruti_ear.DECODER: FakeDecoder(table),
        }[path.name]

    return opener


@pytest.fixture
def root(tmp_path, monkeypatch):
    monkeypatch.setenv("FRIDAY_ROOT", str(tmp_path))
    return tmp_path


def test_not_ready_without_the_files_or_with_a_partial_download(root):
    assert shruti_ear.model_dir() is None and not shruti_ear.ready()
    assert shruti_ear.transcribe(speech()) is None
    stage(root, big=False)
    assert shruti_ear.model_dir() is None and not shruti_ear.ready()
    assert shruti_ear.error() is None


def test_a_staged_folder_is_ready_and_answers(root, monkeypatch):
    stage(root)
    monkeypatch.setattr(shruti_ear, "_open", fake_open(FORK))
    assert shruti_ear.ready() and shruti_ear.error() is None
    text = shruti_ear.transcribe(speech(), language="hi")
    assert text == "b"
    assert shruti_ear.last_language() == "hi" and shruti_ear.last_skip() == ""
    assert shruti_ear.last_confidence() is not None and shruti_ear.loaded()
    assert shruti_ear.unload() is True and not shruti_ear.loaded() and shruti_ear.unload() is False


def test_the_model_opens_once_and_each_graph_once(root, monkeypatch):
    stage(root)
    opened: list[str] = []
    monkeypatch.setattr(shruti_ear, "_open", fake_open(FORK, opened))
    shruti_ear.transcribe(speech(), language="hi")
    shruti_ear.transcribe(speech(), language="hi")
    assert sorted(opened) == sorted([shruti_ear.FRONTEND, shruti_ear.ENCODER, shruti_ear.DECODER])


def test_the_worker_can_refuse_the_load_for_memory(root, monkeypatch):
    stage(root)
    asked: list[tuple[str, float]] = []

    def refuse(kind: str, mb: float) -> bool:
        asked.append((kind, mb))
        return False

    monkeypatch.setattr(shruti_ear, "admit_hook", refuse)
    monkeypatch.setattr(shruti_ear, "_open", fake_open(FORK))
    assert shruti_ear.transcribe(speech(), language="hi") is None
    assert shruti_ear.last_skip() == "low-memory"
    assert asked == [("shruti-ear", shruti_ear.LOAD_MB)]
    assert shruti_ear.ready() and shruti_ear.error() is None  # a refusal is not a broken folder
    monkeypatch.setattr(shruti_ear, "admit_hook", shruti_ear.admit_all)
    assert shruti_ear.transcribe(speech(), language="hi") == "b" and shruti_ear.last_skip() == ""


def test_a_folder_the_runtime_cannot_open_is_remembered_and_tried_once(root, monkeypatch):
    stage(root)
    calls = []

    def broken(_path: Path) -> Any:
        calls.append(1)
        raise RuntimeError("cannot open C:\\secret\\place\\decoder.onnx")

    monkeypatch.setattr(shruti_ear, "_open", broken)
    assert shruti_ear.transcribe(speech()) is None
    assert shruti_ear.last_skip() == "broken"
    assert not shruti_ear.ready()
    assert shruti_ear.error()
    assert "secret" not in str(shruti_ear.error())
    assert shruti_ear.transcribe(speech()) is None and shruti_ear.last_skip() == "broken"
    assert len(calls) == 1


def test_a_new_download_is_tried_again(root, monkeypatch):
    folder = stage(root)
    monkeypatch.setattr(shruti_ear, "_open", lambda _p: (_ for _ in ()).throw(RuntimeError("bad")))
    shruti_ear.transcribe(speech())
    assert not shruti_ear.ready()
    with (folder / shruti_ear.DECODER).open("ab") as handle:  # the file changed size: a re-download
        handle.truncate(shruti_ear.MIN_BYTES[shruti_ear.DECODER] + 77)
    assert shruti_ear.ready()


def test_short_audio_and_silence_return_none_without_loading(root, monkeypatch):
    stage(root)
    opened: list[str] = []
    monkeypatch.setattr(shruti_ear, "_open", fake_open(FORK, opened))
    assert shruti_ear.transcribe(speech(0.1)) is None
    assert opened == []
    assert shruti_ear.transcribe(np.zeros(16000, np.float32)) is None
    assert shruti_ear.last_language() == ""


def test_a_decoder_failure_returns_none_so_the_other_ear_answers(root, monkeypatch):
    stage(root)

    class Boom(FakeDecoder):
        def run(self, _names: Any, feeds: dict[str, np.ndarray]) -> list[np.ndarray]:
            raise RuntimeError("graph failed")

    def opener(path: Path) -> Any:
        return Boom({}) if path.name == shruti_ear.DECODER else fake_open({})(path)

    monkeypatch.setattr(shruti_ear, "_open", opener)
    assert shruti_ear.transcribe(speech(), language="hi") is None


def test_an_unknown_language_wish_means_detect(root, monkeypatch):
    stage(root)
    table = {BOS: row({HI: 1.0, EN: 3.0}), EN: log_odds({B: 0.9, EOS: 0.1})}
    monkeypatch.setattr(shruti_ear, "_open", fake_open(table))
    assert shruti_ear.transcribe(speech(), language="fr") == "b"
    assert shruti_ear.last_language() == "en"


def test_the_text_goes_through_the_script_policy(root, monkeypatch):
    stage(root)
    table = {
        HI: log_odds({KAL: 0.9, EOS: 0.1}),
        EN: log_odds({KAL: 0.9, EOS: 0.1}),
        KAL: log_odds({EOS: 0.99, A: 0.01}),
    }
    monkeypatch.setattr(shruti_ear, "_open", fake_open(table))
    heard = shruti_ear.transcribe(speech(), language="hi")
    assert heard == stt_bench.fix_script("kal", "codemix") == "\u0915\u0932"  # Roman Hindi becomes Devanagari
    english = shruti_ear.transcribe(speech(), language="en")
    assert english == stt_bench.fix_script("kal", "english") == "kal"  # English stays as heard


def test_the_runtime_door_opens_each_graph_in_the_asr_final_budget(monkeypatch):
    seen: list[tuple[Any, ...]] = []

    def door(path: Any, role: str, *args: Any, **kwargs: Any) -> str:
        seen.append((Path(path).name, role, kwargs.get("intra")))
        return "session"

    monkeypatch.setattr(friday_runtime, "open_session", door)
    monkeypatch.setattr(shruti_ear, "threads", 3)
    assert shruti_ear._open(Path("decoder.onnx")) == "session"
    assert seen == [("decoder.onnx", "asr_final", 3)]


def test_the_module_never_opens_a_session_itself_or_downloads():
    source = (Path(shruti_ear.__file__)).read_text(encoding="utf-8")
    assert "InferenceSession(" not in source
    for banned in ("huggingface_hub", "soxr", "udgam_textnorm", "import torch", "urllib", "requests"):
        assert f"import {banned}" not in source and f"from {banned}" not in source
