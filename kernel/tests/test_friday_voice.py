"""FRIDAY Voice engine: the text steps, voice blending and the synthesis loop, with stand-in graphs (no model file)."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import friday_voice as fv  # noqa: E402

CONFIG = {"ae": {"sample_rate": 44100, "base_chunk_size": 512}, "ttl": {"chunk_compress_factor": 6, "latent_dim": 24}}
INDEXER = [-1] * 65536
for _i, _ch in enumerate("<>/abcdefghijklmnopqrstuvwxyz .,!?'\"-nahi"):
    INDEXER[ord(_ch)] = _i + 1
for _ch in "नमस्ते।":
    INDEXER[ord(_ch)] = 200 + ord(_ch) % 50


class Graph:
    """A stand-in session: records what it was asked and answers with fixed shapes."""

    def __init__(self, answer):
        self.answer = answer
        self.calls: list[dict] = []

    def run(self, _outputs, feed):
        self.calls.append({k: np.array(v, copy=True) for k, v in feed.items()})
        return [self.answer(feed)]


def make_voice(seconds: float = 0.5, wav_value: float = 0.25):
    sessions = {
        "duration": Graph(lambda feed: np.asarray([seconds], dtype=np.float32)),
        "text": Graph(lambda feed: np.ones((1, 8, feed["text_ids"].shape[1]), dtype=np.float32)),
        "estimator": Graph(lambda feed: feed["noisy_latent"] * np.float32(0.5)),
        "vocoder": Graph(lambda feed: np.full((1, int(feed["latent"].shape[2]) * 3072), wav_value, dtype=np.float32)),
    }
    voice = fv.FridayVoice(None, sessions=sessions, config=CONFIG, indexer=INDEXER)
    return voice, sessions


def style(value: float = 1.0) -> fv.Style:
    return fv.Style(np.full((1, 4, 6), value, dtype=np.float32), np.full((1, 2, 5), value, dtype=np.float32))


def test_clean_text_adds_a_stop_and_language_tags():
    assert fv.clean_text("hello world") == "hello world."
    assert fv.clean_text("hello world", "en") == "<en>hello world.</en>"
    assert fv.clean_text("kya haal hai?", "na") == "<na>kya haal hai?</na>"
    with pytest.raises(ValueError):
        fv.clean_text("x", "xx")


def test_clean_text_removes_pictographs_decoration_and_stray_spaces():
    assert fv.clean_text("hi \U0001f600 there \u2665") == "hi there."
    assert fv.clean_text("a , b") == "a, b."
    assert fv.clean_text("mail me @ home") == "mail me at home."
    assert fv.clean_text("") == ""


def test_the_danda_is_not_taken_as_a_stop_so_the_text_matches_the_old_engine():
    assert fv.clean_text("मैं हूँ।").endswith("।.")


def test_encode_leaves_out_what_the_table_does_not_know():
    ids = fv.encode("a☃b", INDEXER)
    assert ids.dtype == np.int64
    assert ids.tolist() == [INDEXER[ord("a")], INDEXER[ord("b")]]


def test_blend_is_a_weighted_mean_and_never_changes_the_inputs():
    a, b = style(1.0), style(3.0)
    mixed = fv.blend_styles([a, b], [3, 1])
    assert np.allclose(mixed.ttl, 1.5) and np.allclose(mixed.dp, 1.5)
    assert np.allclose(a.ttl, 1.0) and np.allclose(b.ttl, 3.0)
    assert np.allclose(fv.blend_styles([a, b]).ttl, 2.0)
    assert fv.blend_styles([a]).ttl.dtype == np.float32


@pytest.mark.parametrize("weights", [[1], [-1, 2], [0, 0], [float("nan"), 1]])
def test_blend_refuses_bad_weights(weights):
    with pytest.raises(ValueError):
        fv.blend_styles([style(1), style(2)], weights)


def test_blend_refuses_other_shapes_and_nothing():
    odd = fv.Style(np.zeros((1, 5, 6), dtype=np.float32), np.zeros((1, 2, 5), dtype=np.float32))
    with pytest.raises(ValueError):
        fv.blend_styles([style(), odd])
    with pytest.raises(ValueError):
        fv.blend_styles([])


def test_load_style_reads_the_file_layout(tmp_path):
    path = tmp_path / "x.json"
    path.write_text(
        json.dumps(
            {"style_ttl": {"dims": [1, 2, 3], "data": list(range(6))}, "style_dp": {"dims": [1, 1, 2], "data": [5, 6]}}
        )
    )
    got = fv.load_style(path)
    assert got.ttl.shape == (1, 2, 3) and got.dp.shape == (1, 1, 2) and got.ttl[0, 1, 2] == 5.0


def test_synth_runs_the_four_graphs_in_order_and_trims_to_the_duration():
    voice, graphs = make_voice(seconds=0.5)
    audio = voice.synth("hello", "en", style(), steps=3, speed=1.0, seed=3)
    assert audio.dtype == np.float32 and audio.ndim == 1
    assert len(audio) == int(0.5 * 44100)
    assert len(graphs["duration"].calls) == 1 and len(graphs["text"].calls) == 1
    assert len(graphs["estimator"].calls) == 3 and len(graphs["vocoder"].calls) == 1
    steps = [float(c["current_step"][0]) for c in graphs["estimator"].calls]
    assert steps == [0.0, 1.0, 2.0] and float(graphs["estimator"].calls[0]["total_step"][0]) == 3.0


def test_speed_divides_the_duration_the_noise_is_sized_by():
    voice, graphs = make_voice(seconds=1.0)
    voice.synth("hello", "en", style(), steps=1, speed=2.0, seed=1)
    frames = graphs["vocoder"].calls[0]["latent"].shape[2]
    assert frames == (int(0.5 * 44100) + 3071) // 3072


def test_the_same_seed_repeats_and_another_seed_differs():
    voice, graphs = make_voice()
    voice.synth("hello", "en", style(), steps=1, seed=11)
    voice.synth("hello", "en", style(), steps=1, seed=11)
    voice.synth("hello", "en", style(), steps=1, seed=12)
    first, again, other = (c["noisy_latent"] for c in graphs["estimator"].calls)
    assert np.array_equal(first, again) and not np.array_equal(first, other)


def test_empty_or_unreadable_text_makes_no_audio_and_calls_nothing():
    voice, graphs = make_voice()
    assert voice.synth("", "en", style()).size == 0
    assert voice.synth("☃☃", "en", style()).size == 0
    assert graphs["duration"].calls == []


@pytest.mark.parametrize("speed,steps", [(0.5, 5), (2.5, 5), (1.0, 0), (1.0, 99)])
def test_out_of_range_speed_or_steps_are_refused(speed, steps):
    voice, _ = make_voice()
    with pytest.raises(ValueError):
        voice.synth("hello", "en", style(), steps=steps, speed=speed)


def test_a_non_finite_answer_never_reaches_the_speaker():
    voice, _ = make_voice(wav_value=float("nan"))
    assert np.all(np.isfinite(voice.synth("hello", "en", style(), steps=1, seed=1)))


def test_text_is_capped_so_one_call_stays_bounded():
    voice, graphs = make_voice()
    voice.synth("a" * 5000, "en", style(), steps=1, seed=1)
    assert graphs["text"].calls[0]["text_ids"].shape[1] <= fv.MAX_CLAUSE_CHARS + 16


def test_an_incomplete_config_is_a_clear_error():
    with pytest.raises(ValueError):
        fv.FridayVoice(None, sessions={}, config={"ae": {}}, indexer=INDEXER)


def test_open_voice_is_none_for_a_missing_or_partial_folder(tmp_path):
    fv.forget()
    assert fv.open_voice(None) is None
    assert fv.open_voice(tmp_path / "nope") is None
    (tmp_path / "onnx").mkdir()
    (tmp_path / "onnx" / "tts.json").write_text("{}")
    assert not fv.complete(tmp_path) and fv.open_voice(tmp_path) is None


def test_presets_are_only_the_ten_known_names():
    voice, _ = make_voice()
    assert fv.PRESETS == ("F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5")
    with pytest.raises(KeyError):
        voice.style("../../etc/passwd")


REAL = os.environ.get("FRIDAY_TTS_MODEL_DIR", "")


def test_real_model_makes_speech_when_the_folder_is_given():
    if not REAL or not fv.complete(REAL):
        print("real-model check not run: set FRIDAY_TTS_MODEL_DIR to a complete voice folder")
        return
    engine = fv.open_voice(REAL)
    assert engine is not None
    audio = engine.synth("Hello, I am Friday.", "en", engine.style("F2"), steps=5, seed=7)
    assert audio.size > engine.sample_rate and float(np.max(np.abs(audio))) > 0.01


def test_real_model_matches_the_old_package_sample_for_sample_when_both_are_present():
    if not REAL or not fv.complete(REAL):
        print("parity check not run: set FRIDAY_TTS_MODEL_DIR to a complete voice folder")
        return
    try:
        from supertonic import TTS  # type: ignore
    except Exception:  # noqa: BLE001 - the old package is optional
        print("parity check not run: the old package is not installed")
        return
    old = TTS(model="supertonic-3", model_dir=str(REAL), auto_download=False)
    engine = fv.open_voice(REAL)
    assert engine is not None
    for text, lang in (
        ("Hello, I am Friday.", "en"),
        ("नमस्ते, मैं फ्राइडे हूँ।", "hi"),
        ("Haan boss, meeting kal hai.", "na"),
    ):
        np.random.seed(7)
        wav, _ = old.model([text], old.get_voice_style("F2"), 5, 1.0, lang)
        theirs = np.asarray(wav, dtype=np.float32).reshape(-1)
        mine = engine.synth(text, lang, engine.style("F2"), steps=5, speed=1.0, seed=7)
        n = min(len(theirs), len(mine))
        assert n > 0 and float(np.max(np.abs(theirs[:n] - mine[:n]))) < 1e-6
