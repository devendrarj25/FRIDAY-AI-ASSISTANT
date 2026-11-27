"""FRIDAY Ear Quick: the runner around the Moonshine graphs, with tiny fake sessions (no weights, no onnxruntime).

The fake decoder replays a script of token ids and records every feed, so these tests pin the rules of the loop:
start token, the cache branch flag, the growing decoder cache, the fixed encoder cache, the end token, the runaway
cap, the 25 s windows, and the byte-fallback text.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import ear_quick  # noqa: E402
import friday_runtime  # noqa: E402

VOCAB_SIZE = 16
HEADS, DIM, LAYERS = 2, 3, 2


def _spec(name: str, shape: list | None = None) -> SimpleNamespace:
    return SimpleNamespace(name=name, shape=shape or [])


class FakeEncoder:
    def __init__(self) -> None:
        self.calls: list[np.ndarray] = []

    def get_inputs(self) -> list[SimpleNamespace]:
        return [_spec("input_values")]

    def run(self, _outputs, feed):
        samples = feed["input_values"]
        self.calls.append(samples)
        return [np.full((1, 4, 5), len(self.calls), dtype=np.float32)]


class FakeDecoder:
    """Emits ``script`` one id per call; the last id repeats if the loop runs on."""

    def __init__(self, script: list[int], merged: bool = True) -> None:
        self.script = script
        self.feeds: list[dict] = []
        self.merged = merged

    def get_inputs(self) -> list[SimpleNamespace]:
        names = [_spec("input_ids"), _spec("encoder_hidden_states")]
        for layer in range(LAYERS):
            for part in ("decoder.key", "decoder.value", "encoder.key", "encoder.value"):
                names.append(_spec(f"past_key_values.{layer}.{part}", ["batch", HEADS, "steps", DIM]))
        if self.merged:
            names.append(_spec("use_cache_branch"))
        return names

    def get_outputs(self) -> list[SimpleNamespace]:
        names = [_spec("logits")]
        for layer in range(LAYERS):
            for part in ("decoder.key", "decoder.value", "encoder.key", "encoder.value"):
                names.append(_spec(f"present.{layer}.{part}"))
        return names

    def run(self, _outputs, feed):
        step = len(self.feeds)
        self.feeds.append(dict(feed))
        want = self.script[min(step, len(self.script) - 1)]
        logits = np.zeros((1, 1, VOCAB_SIZE), dtype=np.float32)
        logits[0, 0, want] = 1.0
        out = [logits]
        for _layer in range(LAYERS):
            decoder_side = np.full((1, HEADS, step + 1, DIM), float(step + 1), dtype=np.float32)
            # the merged graph returns a fresh (here: different) encoder cache on every step; only step 0 is real
            encoder_side = np.full((1, HEADS, 4, DIM), 7.0 if step == 0 else -1.0, dtype=np.float32)
            out += [decoder_side, decoder_side, encoder_side, encoder_side]
        return out


def _tokenizer(tmp_path: Path) -> Path:
    vocab = {"<unk>": 0, "<s>": 1, "</s>": 2, "▁hello": 3, "▁world": 4, "!": 5, "<0xC3>": 6, "<0xA9>": 7}
    vocab.update({"▁caf": 8, "<0xFF>": 9})
    data = {
        "added_tokens": [
            {"id": 0, "content": "<unk>", "special": True},
            {"id": 1, "content": "<s>", "special": True},
            {"id": 2, "content": "</s>", "special": True},
            {"id": 12, "content": "<<ST_0>>", "special": True},
        ],
        "model": {"type": "BPE", "vocab": vocab, "merges": []},
    }
    path = tmp_path / "tokenizer.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


@pytest.fixture
def tokens(tmp_path: Path) -> ear_quick.Detokenizer:
    return ear_quick.Detokenizer.from_file(_tokenizer(tmp_path))


def _ear(tokens, script, merged=True):
    encoder, decoder = FakeEncoder(), FakeDecoder(script, merged)
    return ear_quick.EarQuick(encoder, decoder, tokens), encoder, decoder


def _seconds(count: float) -> np.ndarray:
    return np.zeros(int(count * ear_quick.SAMPLE_RATE), dtype=np.float32)


def test_detokenizer_joins_words_skips_specials_and_strips_the_leading_space(tokens):
    assert tokens.decode([1, 3, 4, 5, 12, 2]) == "hello world!"


def test_detokenizer_assembles_byte_fallback_into_utf8(tokens):
    assert tokens.decode([8, 6, 7]) == "café"


def test_detokenizer_keeps_a_broken_byte_as_a_replacement_and_ignores_unknown_ids(tokens):
    assert tokens.decode([3, 9, 999]) == "hello�"
    assert tokens.decode([]) == ""


def test_detokenizer_reports_a_missing_or_wrong_file(tmp_path):
    with pytest.raises(ear_quick.EarQuickError):
        ear_quick.Detokenizer.from_file(tmp_path / "none.json")
    bad = tmp_path / "bad.json"
    bad.write_text("{}", encoding="utf-8")
    with pytest.raises(ear_quick.EarQuickError):
        ear_quick.Detokenizer.from_file(bad)


def test_transcribe_runs_until_the_end_token_and_returns_the_text(tokens):
    ear, encoder, decoder = _ear(tokens, [3, 4, 2])
    assert ear.transcribe(_seconds(2)) == "hello world"
    assert len(encoder.calls) == 1 and encoder.calls[0].shape == (1, 32000)
    assert len(decoder.feeds) == 3


def test_the_first_step_is_the_start_token_without_the_cache_branch_then_each_token_is_fed_back(tokens):
    ear, _, decoder = _ear(tokens, [3, 4, 2])
    ear.transcribe(_seconds(2))
    assert [int(f["input_ids"][0, 0]) for f in decoder.feeds] == [1, 3, 4]
    assert [bool(f["use_cache_branch"][0]) for f in decoder.feeds] == [False, True, True]
    first = decoder.feeds[0]
    assert first["past_key_values.0.decoder.key"].shape == (1, HEADS, 0, DIM)
    assert first["input_ids"].dtype == np.int64


def test_the_decoder_cache_grows_each_step_and_the_encoder_cache_stays_from_step_one(tokens):
    ear, _, decoder = _ear(tokens, [3, 4, 5, 2])
    ear.transcribe(_seconds(2))
    steps = [f["past_key_values.1.decoder.key"].shape[2] for f in decoder.feeds]
    assert steps == [0, 1, 2, 3]
    for later in decoder.feeds[1:]:
        assert float(later["past_key_values.1.encoder.value"].max()) == 7.0  # never replaced by a later output


def test_the_encoder_output_goes_to_every_decoder_step(tokens):
    ear, _, decoder = _ear(tokens, [3, 2])
    ear.transcribe(_seconds(2))
    assert all(float(f["encoder_hidden_states"][0, 0, 0]) == 1.0 for f in decoder.feeds)


def test_a_decoder_without_the_cache_branch_input_is_fed_no_flag(tokens):
    ear, _, decoder = _ear(tokens, [3, 2], merged=False)
    ear.transcribe(_seconds(2))
    assert all("use_cache_branch" not in f for f in decoder.feeds)


def test_a_runaway_decoder_stops_at_the_length_cap(tokens):
    ear, _, decoder = _ear(tokens, [3])  # never emits the end token
    text = ear.transcribe(_seconds(2))
    assert len(decoder.feeds) == int(2 * ear_quick.TOKENS_PER_SECOND) + 4
    assert text.startswith("hello")


def test_audio_shorter_than_a_tenth_of_a_second_is_not_sent_to_the_graphs(tokens):
    ear, encoder, decoder = _ear(tokens, [3, 2])
    assert ear.transcribe(np.zeros(ear_quick.MIN_SAMPLES - 1, dtype=np.float32)) == ""
    assert ear.transcribe([]) == ""
    assert not encoder.calls and not decoder.feeds


def test_long_audio_is_cut_into_windows_and_the_texts_are_joined(tokens):
    ear, encoder, decoder = _ear(tokens, [3, 2, 4, 2])
    assert ear.transcribe(_seconds(30)) == "hello world"  # 25 s and a 5 s tail
    assert [c.shape[1] for c in encoder.calls] == [25 * 16000, 5 * 16000]
    assert len(decoder.feeds) == 4


def test_a_tiny_tail_window_is_dropped(tokens):
    ear, encoder, _ = _ear(tokens, [3, 2])
    ear.transcribe(np.zeros(25 * 16000 + 100, dtype=np.float32))
    assert len(encoder.calls) == 1


def test_int16_pcm_is_scaled_and_a_list_is_accepted(tokens):
    ear, encoder, _ = _ear(tokens, [3, 2])
    ear.transcribe(np.full(16000, 16384, dtype=np.int16))
    assert encoder.calls[0].dtype == np.float32 and float(encoder.calls[0][0, 0]) == pytest.approx(0.5)
    ear.transcribe([0.0] * 16000)
    assert len(encoder.calls) == 2


def test_another_sample_rate_is_refused_not_guessed(tokens):
    ear, _, _ = _ear(tokens, [3, 2])
    with pytest.raises(ear_quick.EarQuickError):
        ear.transcribe(_seconds(1), sample_rate=48000)


def test_a_decoder_without_cache_inputs_is_refused(tokens):
    class Bare(FakeDecoder):
        def get_inputs(self):
            return [_spec("input_ids")]

    with pytest.raises(ear_quick.EarQuickError):
        ear_quick.EarQuick(FakeEncoder(), Bare([2]), tokens)


def test_load_opens_both_graphs_through_the_runtime_door_with_the_asr_final_role(tmp_path, monkeypatch):
    _tokenizer(tmp_path)
    opened: list[dict] = []

    def fake_open(path, role, phase=None, **kwargs):
        opened.append({"path": Path(path), "role": role, **kwargs})
        return FakeEncoder() if Path(path).name == ear_quick.ENCODER_FILE else FakeDecoder([3, 2])

    monkeypatch.setattr(friday_runtime, "open_session", fake_open)
    pins = {ear_quick.ENCODER_FILE: "a" * 64, ear_quick.DECODER_FILE: "b" * 64}
    ear = ear_quick.EarQuick.load(tmp_path, quantized=False, sha256=pins, intra=3)
    assert [(o["path"].parent.name, o["path"].name, o["role"]) for o in opened] == [
        ("float", ear_quick.ENCODER_FILE, "asr_final"),
        ("float", ear_quick.DECODER_FILE, "asr_final"),
    ]
    assert [o["sha256"] for o in opened] == ["a" * 64, "b" * 64] and all(o["intra"] == 3 for o in opened)
    assert ear.transcribe(_seconds(1)) == "hello"
    ear_quick.EarQuick.load(tmp_path)
    assert opened[-1]["path"].parent.name == "quantized"


def test_load_turns_a_runtime_error_into_the_module_error(tmp_path, monkeypatch):
    _tokenizer(tmp_path)

    def refuse(*_args, **_kwargs):
        raise friday_runtime.FridayRuntimeError("does not match its pinned SHA-256")

    monkeypatch.setattr(friday_runtime, "open_session", refuse)
    with pytest.raises(ear_quick.EarQuickError, match="SHA-256"):
        ear_quick.EarQuick.load(tmp_path)


def test_the_module_never_builds_a_session_itself():
    source = Path(ear_quick.__file__).read_text(encoding="utf-8")
    assert "InferenceSession" not in source and "tokenizers" not in source.replace("tokenizer.json", "")
