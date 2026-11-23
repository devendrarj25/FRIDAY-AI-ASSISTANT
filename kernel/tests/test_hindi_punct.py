"""Hindi punctuation restoration: optional, only with its pinned files on disk, never changes a word.

No weights and no network: the runtime (sentencepiece plus the onnxruntime graph) is replaced by a fake that
speaks the same small interface, so these tests pin the rules around the model, not the model itself.
"""

from __future__ import annotations

import json
import random
import re
import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "kernel"))

import hindi_ear  # noqa: E402
import hindi_punct  # noqa: E402
import stt_bench  # noqa: E402
import voice_runtime  # noqa: E402

LABELS = list(hindi_punct.DEFAULT_POST_LABELS)
IDX = {label: index for index, label in enumerate(LABELS)}
PUNCT_MARKS = re.compile(r"[।.,?!;]")


def _stage(root: Path, big: bool = True, config: str | None = None) -> Path:
    folder = root / "models" / hindi_punct.MODEL_DIR
    folder.mkdir(parents=True)
    (folder / hindi_punct.SPM_FILE).write_bytes(b"spm")
    text = config if config is not None else "max_length: 128\n"
    (folder / hindi_punct.CONFIG_FILE).write_text(text, encoding="utf-8")
    with (folder / hindi_punct.MODEL_FILE).open("wb") as handle:
        handle.truncate(hindi_punct.MIN_MODEL_BYTES + 1 if big else 10)  # sparse: no real bytes written
    return folder


class FakeRuntime:
    """One piece per word, and a label chosen by a rule from the word and its place."""

    max_length = 128

    def __init__(self, rule):
        self.rule = rule
        self.calls: list[int] = []
        self.labels = LABELS

    def encode(self, text):
        words = text.split()
        return list(range(10, 10 + len(words))), ["▁" + word for word in words]

    def predict(self, ids):
        self.calls.append(len(ids))
        return [self.rule(index, len(ids), ids[index]) for index in range(len(ids))]


def _last_danda(index, size, _id):
    return IDX["।"] if index == size - 1 else 0


@pytest.fixture(autouse=True)
def _fresh(monkeypatch, tmp_path):
    monkeypatch.setenv("FRIDAY_ROOT", str(tmp_path))
    monkeypatch.delenv("FRIDAY_HINDI_PUNCT", raising=False)
    monkeypatch.setattr(hindi_punct, "_runtime", None)
    monkeypatch.setattr(hindi_punct, "_runtime_dir", "")
    monkeypatch.setattr(hindi_punct, "_failed_dir", "")


def _use(monkeypatch, runtime):
    loads: list[str] = []
    monkeypatch.setattr(hindi_punct, "_runtime", None)  # a new fake replaces the one kept from the last call

    def load(folder):
        loads.append(str(folder))
        return runtime

    monkeypatch.setattr(hindi_punct, "_load_runtime", load)
    return loads


def test_it_is_ready_only_with_all_three_files_and_a_whole_model(tmp_path):
    assert hindi_punct.model_dir() is None and hindi_punct.ready() is False
    folder = _stage(tmp_path, big=False)
    assert hindi_punct.ready() is False  # a partial download is not ready
    with (folder / hindi_punct.MODEL_FILE).open("wb") as handle:
        handle.truncate(hindi_punct.MIN_MODEL_BYTES + 1)
    assert hindi_punct.ready() is True
    (folder / hindi_punct.SPM_FILE).unlink()
    assert hindi_punct.ready() is False


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("आज मौसम अच्छा है", True),
        ("आज मौसम अच्छा है।", False),
        ("आज, मौसम अच्छा है", False),
        ("क्या आप आ रहे हैं?", False),
        ("hello there", False),  # not Hindi: nothing to restore
        ("", False),
        ("   ", False),
        ("हाँ", False),  # one word is left alone
    ],
)
def test_it_restores_only_text_without_any_punctuation(text, expected):
    assert hindi_punct.needs_punctuation(text) is expected


def test_it_puts_punctuation_between_words_and_never_changes_a_word(monkeypatch, tmp_path):
    _stage(tmp_path)

    def rule(index, size, _id):
        if index == 1:
            return IDX[","]
        return IDX["।"] if index == size - 1 else 0

    _use(monkeypatch, FakeRuntime(rule))
    assert hindi_punct.punctuate("मेरा नाम राहुल है") == "मेरा नाम, राहुल है।"


def test_every_label_the_model_knows_is_mapped_to_hindi_marks(monkeypatch, tmp_path):
    _stage(tmp_path)
    expected = {
        ".": "।",  # Devanagari word: the danda, not a Latin full stop
        "।": "।",
        "。": "।",
        ",": ",",
        "，": ",",
        "،": ",",
        "、": ",",
        ";": ",",
        "?": "?",
        "？": "?",
        "؟": "?",
        "・": "",  # not Hindi punctuation: nothing is written
        "።": "",
        "፣": "",
        "፧": "",
        "<NULL>": "",
    }
    for label, mark in expected.items():
        _use(monkeypatch, FakeRuntime(lambda index, size, _id, label=label: IDX[label] if index == size - 1 else 0))
        assert hindi_punct.punctuate("आप कैसे हैं") == f"आप कैसे हैं{mark}", label


def test_a_latin_word_gets_a_full_stop_not_a_danda(monkeypatch, tmp_path):
    _stage(tmp_path)
    _use(monkeypatch, FakeRuntime(lambda index, size, _id: IDX["।"] if index == size - 1 else 0))
    assert hindi_punct.punctuate("यह एक test") == "यह एक test."


def test_the_words_never_change_whatever_the_model_says(monkeypatch, tmp_path):
    _stage(tmp_path)
    rng = random.Random(7)  # noqa: S311 — a repeatable test sequence, not a secret
    text = "मेरा नाम राहुल है और मैं दिल्ली में रहता हूँ क़ीमत ख़ास ज़रूर hello 123 आज"
    words = text.split()
    for _ in range(50):
        picks = [rng.randrange(len(LABELS)) for _ in words]
        _use(monkeypatch, FakeRuntime(lambda index, size, _id, picks=picks: picks[index]))
        out = hindi_punct.punctuate(text)
        assert out is not None
        assert PUNCT_MARKS.sub("", out).split() == words
        assert out.count(" ") == len(words) - 1  # no extra space, no lost space


def test_the_word_error_rate_does_not_move_when_marks_are_added(monkeypatch, tmp_path):
    """The scorer ignores marks, so the punctuation pass can never make the Hindi ear look better or worse."""
    _stage(tmp_path)
    cases = json.loads((Path(__file__).resolve().parents[2] / "core/fixtures/voice-wer-cases.json").read_text("utf-8"))
    rng = random.Random(3)  # noqa: S311 — a repeatable test sequence, not a secret
    seen = 0
    for case in cases["cases"]:
        heard = case["hypothesis"]
        if case["lang"] != "hi" or not hindi_punct.needs_punctuation(heard):
            continue
        picks = [rng.randrange(len(LABELS)) for _ in heard.split()]
        _use(monkeypatch, FakeRuntime(lambda index, size, _id, picks=picks: picks[index]))
        marked = hindi_punct.punctuate(heard)
        assert marked is not None
        assert stt_bench.wer(case["reference"], marked) == stt_bench.wer(case["reference"], heard), case["id"]
        assert stt_bench.cer(case["reference"], marked) == stt_bench.cer(case["reference"], heard), case["id"]
        seen += 1
    assert seen >= 5  # the fixture's Hindi lines in Devanagari


def test_a_word_that_already_ends_in_a_mark_gets_no_second_mark(monkeypatch, tmp_path):
    _stage(tmp_path)
    _use(monkeypatch, FakeRuntime(lambda index, size, _id: IDX["।"] if index in (0, size - 1) else 0))
    assert hindi_punct.punctuate("एक, दो तीन") == "एक, दो तीन।"


def test_a_failing_runtime_leaves_the_text_alone_and_is_not_retried(monkeypatch, tmp_path):
    _stage(tmp_path)
    attempts: list[str] = []

    def boom(folder):
        attempts.append(str(folder))
        raise RuntimeError("the runtime failed to open")

    monkeypatch.setattr(hindi_punct, "_load_runtime", boom)
    assert hindi_punct.punctuate("आज मौसम अच्छा है") is None
    assert hindi_punct.apply("आज मौसम अच्छा है") == "आज मौसम अच्छा है"
    assert len(attempts) == 1  # a broken model is remembered for the session, never loaded per utterance


def test_a_failing_prediction_gives_no_punctuation(monkeypatch, tmp_path):
    _stage(tmp_path)

    class Broken(FakeRuntime):
        def predict(self, ids):
            raise RuntimeError("bad run")

    _use(monkeypatch, Broken(_last_danda))
    assert hindi_punct.apply("आज मौसम अच्छा है") == "आज मौसम अच्छा है"


def test_a_tokeniser_that_disagrees_about_the_words_changes_nothing(monkeypatch, tmp_path):
    _stage(tmp_path)

    class Odd(FakeRuntime):
        def encode(self, text):
            return [10, 11], ["▁आज", "▁मौसम"]  # two word groups for three words

    _use(monkeypatch, Odd(_last_danda))
    assert hindi_punct.punctuate("आज मौसम अच्छा") is None


def test_a_label_list_shorter_than_the_prediction_is_not_trusted(monkeypatch, tmp_path):
    _stage(tmp_path)
    _use(monkeypatch, FakeRuntime(lambda index, size, _id: 99))
    assert hindi_punct.apply("आज मौसम अच्छा है") == "आज मौसम अच्छा है"


def test_a_long_reply_runs_in_overlapping_windows_and_keeps_every_word(monkeypatch, tmp_path):
    _stage(tmp_path)
    runtime = FakeRuntime(lambda index, size, ident: IDX[","] if ident % 50 == 0 else 0)
    _use(monkeypatch, runtime)
    words = [f"शब्द{index}" for index in range(400)]
    out = hindi_punct.punctuate(" ".join(words))
    assert out is not None
    assert PUNCT_MARKS.sub("", out).split() == words
    window = runtime.max_length - 2
    assert len(runtime.calls) >= 400 // window  # several windows
    assert max(runtime.calls) <= window  # none longer than the model takes
    # Each comma-id word got exactly one comma, whichever window saw it (the overlap is not counted twice).
    commas = out.count(",")
    assert commas == len([index for index in range(400) if (10 + index) % 50 == 0])


def test_apply_changes_nothing_when_not_installed_or_already_punctuated_or_switched_off(monkeypatch, tmp_path):
    text = "आज मौसम अच्छा है"
    assert hindi_punct.apply(text) == text  # not installed
    _stage(tmp_path)
    loads = _use(monkeypatch, FakeRuntime(_last_danda))
    assert hindi_punct.apply("आज मौसम अच्छा है।") == "आज मौसम अच्छा है।"
    assert loads == []  # an already punctuated line never even opens the model
    monkeypatch.setenv("FRIDAY_HINDI_PUNCT", "0")
    assert hindi_punct.apply(text) == text
    monkeypatch.delenv("FRIDAY_HINDI_PUNCT")
    assert hindi_punct.apply(text) == "आज मौसम अच्छा है।"


def test_the_label_list_is_read_from_the_pinned_config_when_it_is_there(monkeypatch, tmp_path):
    config = 'max_length: 64\npost_labels: [\n  "<NULL>",\n  "।",\n]\n'
    _stage(tmp_path, config=config)
    folder = hindi_punct.model_dir()
    assert folder is not None
    labels, max_length = hindi_punct.read_config(folder)
    assert labels == ["<NULL>", "।"] and max_length == 64
    (folder / hindi_punct.CONFIG_FILE).write_text("nothing useful", encoding="utf-8")
    labels, max_length = hindi_punct.read_config(folder)
    assert labels == LABELS and max_length == 128  # the pinned defaults when the file cannot be read


def test_the_hindi_ear_punctuates_only_its_own_unpunctuated_output(monkeypatch, tmp_path):
    folder = tmp_path / "models" / hindi_ear.MODEL_DIR
    folder.mkdir(parents=True)
    for name in ("vocab.txt", "config.json"):
        (folder / name).write_text("x", encoding="utf-8")
    with (folder / hindi_ear.MODEL_FILE).open("wb") as handle:
        handle.truncate(hindi_ear.MIN_MODEL_BYTES + 1)
    monkeypatch.setattr(hindi_ear, "_model", None)
    monkeypatch.setattr(hindi_ear, "_model_dir", "")
    heard = {"text": "आज मौसम अच्छा है"}

    class Model:
        def recognize(self, audio, sample_rate=16000):
            return heard["text"]

    monkeypatch.setitem(sys.modules, "onnx_asr", types.SimpleNamespace(load_model=lambda *a, **k: Model()))
    samples = [0.0] * 16000
    assert hindi_ear.transcribe(samples) == "आज मौसम अच्छा है"  # punctuation model absent: text as heard
    _stage(tmp_path)
    _use(monkeypatch, FakeRuntime(_last_danda))
    assert hindi_ear.transcribe(samples) == "आज मौसम अच्छा है।"
    heard["text"] = "आज मौसम, अच्छा है"
    assert hindi_ear.transcribe(samples) == "आज मौसम, अच्छा है"  # the ear already wrote a mark: untouched

    def boom(folder):
        raise RuntimeError("broken")

    heard["text"] = "कल बारिश होगी"
    monkeypatch.setattr(hindi_punct, "_runtime", None)
    monkeypatch.setattr(hindi_punct, "_failed_dir", "")
    monkeypatch.setattr(hindi_punct, "_load_runtime", boom)
    assert hindi_ear.transcribe(samples) == "कल बारिश होगी"  # a failing punctuation model never loses the utterance


def test_the_voice_check_line_says_installed_missing_or_broken(monkeypatch, tmp_path):
    assert voice_runtime._hindi_punct_line() == "OPTIONAL hindi-punct optional - not installed"
    _stage(tmp_path)
    monkeypatch.setattr("importlib.util.find_spec", lambda name, *a, **k: None if name == "sentencepiece" else object())
    assert voice_runtime._hindi_punct_line().startswith("FAIL hindi-punct the weights are on disk but")
    monkeypatch.setattr("importlib.util.find_spec", lambda name, *a, **k: object())
    assert voice_runtime._hindi_punct_line() == "PASS hindi-punct pinned weights present"
    assert any(line.startswith(("OPTIONAL hindi-punct", "PASS hindi-punct")) for line in voice_runtime.check_lines())
