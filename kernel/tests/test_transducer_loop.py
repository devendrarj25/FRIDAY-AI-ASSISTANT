"""FRIDAY Ears: the streaming transducer loop over fake onnxruntime sessions (exact, no model file, no network).

One real-model test at the bottom skips visibly unless FRIDAY_NEMOTRON_DIR points at the model folder
(and FRIDAY_NEMOTRON_AUDIO at a folder of NN.wav files with an index.json of {i, lang, ref}).
"""

from __future__ import annotations

import json
import os
import sys
import time
import wave
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import fake_transducer as ft  # noqa: E402
from fake_transducer import FakeModel, pcm_bytes, write_model_dir  # noqa: E402
from rnnt_decode import RnntBeamDecoder, RnntGreedyDecoder  # noqa: E402
from transducer_loop import (  # noqa: E402
    CPU,
    CUDA,
    DML,
    NemotronStream,
    PieceTokenizer,
    TransducerError,
    ids_to_text,
    ids_to_words,
    language_slot,
    load_prompt_slots,
    pick_providers,
    read_contract,
    to_float_pcm,
)

OPEN_CHROME = [(1, 1), (3, 2), (3, 3), (3, 4), (6, 5)]  # "Open" at frame 1, "Chrome," at 3, "please" at 6
ONE_SECOND = pcm_bytes(1.0, 0.3)


def opened(tmp_path: Path, model: FakeModel, **kw) -> NemotronStream:
    folder = write_model_dir(tmp_path / "m", model.dims)
    stream = NemotronStream(model.factory, available=lambda: [CPU, DML, CUDA], threads=1, **kw)
    stream.open(folder, None, "en-US")
    return stream


def run_all(stream: NemotronStream, data: bytes, step: int = 6400):
    events = []
    for i in range(0, len(data), step):
        events += stream.feed(data[i : i + step])
    return events, stream.finalize()


# ---- providers -----------------------------------------------------------------------------------------------------


def test_providers_default_to_cpu_and_cpu_is_always_last():
    assert pick_providers(None) == [CPU]
    assert pick_providers([]) == [CPU]
    assert pick_providers(["cuda", "directml"], [CPU, DML, CUDA]) == [CUDA, DML, CPU]
    assert pick_providers([CPU, DML], [CPU, DML]) == [DML, CPU]


def test_providers_drop_what_is_not_installed_and_what_is_duplicated():
    assert pick_providers(["cuda", "dml", "DmlExecutionProvider"], [CPU, DML]) == [DML, CPU]
    assert pick_providers("auto", [CPU]) == [CPU]
    assert pick_providers("auto", [CPU, DML, CUDA]) == [CUDA, DML, CPU]
    assert pick_providers(["Tensorrt"], [CPU]) == [CPU]


def test_a_provider_that_cannot_open_falls_back_to_cpu(tmp_path):
    model = FakeModel(refuse={CUDA})
    folder = write_model_dir(tmp_path / "m")
    stream = NemotronStream(model.factory, available=lambda: [CPU, CUDA], threads=1)
    info = stream.open(folder, ["cuda"], "en-US")
    assert info["providers"] == [CPU]
    assert len(model.opened) == 3 and all(p == [CPU] for _, p in model.opened)


def test_a_gpu_run_that_fails_mid_stream_moves_to_cpu_and_loses_nothing(tmp_path):
    cpu_model = FakeModel(script=OPEN_CHROME)
    cpu_stream = opened(tmp_path / "a", cpu_model)
    _, expected = run_all(cpu_stream, ONE_SECOND)

    model = FakeModel(script=OPEN_CHROME, fail_run_on={"encoder.onnx": 2})
    folder = write_model_dir(tmp_path / "b")
    stream = NemotronStream(model.factory, available=lambda: [CPU, DML], threads=1)
    stream.open(folder, ["directml"], "en-US")
    assert stream.active_providers == [DML, CPU]
    _, got = run_all(stream, ONE_SECOND)
    assert stream.active_providers == [CPU]
    assert got.text == expected.text == "Open Chrome, please"
    assert got.tokens == expected.tokens


# ---- tables --------------------------------------------------------------------------------------------------------


def test_language_slots_follow_the_prompt_dictionary(tmp_path):
    write_model_dir(tmp_path)
    table, auto = load_prompt_slots(tmp_path / "languages.json")
    assert language_slot("en-US", table, auto) == 0
    assert language_slot("hi-IN", table, auto) == 6
    assert language_slot("hi_IN", table, auto) == 6
    assert language_slot("EN-us", table, auto) == 0
    assert language_slot("hi-Latn", table, auto) == 6  # the base language
    assert language_slot("", table, auto) == 15
    assert language_slot("auto", table, auto) == 15
    with pytest.raises(TransducerError) as bad:
        language_slot("xx-YY", table, auto)
    assert bad.value.kind == "locale"
    with pytest.raises(TransducerError):
        language_slot("", table, None)


def test_text_skips_control_pieces_and_keeps_devanagari():
    v = ft.PIECES
    assert ids_to_text([0, 1, 2, 3, 4, 5], v) == "Open Chrome, please"
    assert ids_to_text([6, 7, 8, 9], v) == "आज मौसम अच्छा है"
    assert ids_to_text([], v) == ""
    assert ids_to_text([99], v) == ""  # an id the vocabulary does not hold


def test_words_carry_frame_times_and_join_pieces():
    words = ids_to_words([(1, 1), (2, 3), (3, 3), (4, 4), (5, 6)], ft.PIECES)
    assert [w.text for w in words] == ["Open", "Chrome,", "please"]
    assert [(w.start_ms, w.end_ms) for w in words] == [(80, 160), (240, 400), (480, 560)]
    lone = ids_to_words([(10, 0), (6, 1)], ft.PIECES)  # a bare word mark then a word start
    assert [w.text for w in lone] == ["आज"]


def test_piece_tokenizer_uses_the_fewest_pieces_and_refuses_the_unknown():
    tok = PieceTokenizer(ft.PIECES)
    assert tok.encode("Open") == [1]
    assert tok.encode("Open Chrome") == [1, 2, 3]
    assert tok.encode("आज मौसम") == [6, 7]
    assert tok.encode("zebra") is None
    assert tok.encode("   ") is None


# ---- contract: shapes come from the sessions ----------------------------------------------------------------------


def test_the_recorded_real_shapes_are_read_from_the_sessions():
    model = FakeModel(dims=ft.REAL_DIMS)
    enc, dec, joi = (model.factory(p, [CPU], 1) for p in ("encoder.onnx", "decoder.onnx", "joint.onnx"))
    c = read_contract(enc, dec, joi, {})  # no config.json at all
    assert (c.n_mels, c.chunk_frames, c.pre_frames, c.prompts) == (128, 32, 9, 128)
    assert (c.layers, c.attn_len, c.hidden, c.conv_len) == (24, 56, 1024, 8)
    assert (c.dec_layers, c.dec_hidden, c.vocab_size, c.blank_id) == (2, 640, 13088, 13087)
    assert c.time_major is True and c.len_dtype == np.int32 and c.float_dtype == np.float32


def test_a_symbolic_dimension_falls_back_to_the_config():
    model = FakeModel()
    enc, dec, joi = (model.factory(p, [CPU], 1) for p in ("encoder.onnx", "decoder.onnx", "joint.onnx"))
    enc.get_inputs()[0].shape = [1, 8, "frames"]
    joi.get_outputs()[0].shape = ["batch", 1, "vocab"]
    c = read_contract(enc, dec, joi, {"streaming": {"melFrames": 24}, "vocabSize": 40})
    assert c.chunk_frames == 24
    assert (c.vocab_size, c.blank_id) == (41, 40)
    c2 = read_contract(enc, dec, joi, {"vocabSize": 40, "blankTokenId": 7, "streaming": {"melFrames": 24}})
    assert c2.blank_id == 7


def test_the_model_runs_at_the_size_its_sessions_declare_not_a_constant(tmp_path):
    model = FakeModel(script=OPEN_CHROME)
    stream = opened(tmp_path, model)
    run_all(stream, ONE_SECOND)
    first = model.sessions["encoder.onnx"].calls[0]
    assert first["audio_signal"].shape == (1, 8, 16)
    assert first["cache_last_channel"].shape == (2, 1, 4, 8)
    assert first["cache_last_time"].shape == (2, 1, 8, 3)
    assert first["pre_cache"].shape == (1, 8, 3)
    assert first["language_mask"].shape == (1, 16)
    assert stream.chunk_ms == 160 * 16 * 1000 // 16000


def test_a_model_with_the_encoder_output_the_other_way_round_still_decodes(tmp_path):
    model = FakeModel(script=OPEN_CHROME, time_major=False)
    _, result = run_all(opened(tmp_path, model), ONE_SECOND)
    assert result.text == "Open Chrome, please"


def test_a_model_missing_a_tensor_is_refused_with_the_contract_kind(tmp_path):
    model = FakeModel()
    real = model._encoder

    def trimmed(providers):
        session = real(providers)
        session._ins = [t for t in session._ins if t.name != "language_mask"]
        return session

    model._encoder = trimmed  # type: ignore[method-assign]
    folder = write_model_dir(tmp_path / "m")
    with pytest.raises(TransducerError) as bad:
        NemotronStream(model.factory, threads=1).open(folder, None, "en-US")
    assert bad.value.kind == "contract" and "language_mask" in str(bad.value)


def test_missing_files_and_a_bad_locale_are_named_errors(tmp_path):
    model = FakeModel()
    folder = write_model_dir(tmp_path / "m")
    (folder / "vocab.json").unlink()
    with pytest.raises(TransducerError) as bad:
        NemotronStream(model.factory, threads=1).open(folder, None, "en-US")
    assert bad.value.kind == "files"
    folder = write_model_dir(tmp_path / "n")
    with pytest.raises(TransducerError) as bad_locale:
        NemotronStream(model.factory, threads=1).open(folder, None, "xx-YY")
    assert bad_locale.value.kind == "locale"


def test_a_failing_session_open_is_a_runtime_error_not_a_crash(tmp_path):
    def broken(path, providers, threads):
        raise OSError("no such file")

    folder = write_model_dir(tmp_path / "m")
    with pytest.raises(TransducerError) as bad:
        NemotronStream(broken, threads=1).open(folder, None, "en-US")
    assert bad.value.kind == "runtime"


# ---- the stream ----------------------------------------------------------------------------------------------------


def test_partials_grow_and_the_final_text_is_exact(tmp_path):
    model = FakeModel(script=OPEN_CHROME)
    events, result = run_all(opened(tmp_path, model), ONE_SECOND)
    texts = [e.text for e in events]
    assert texts == ["Open", "Open Chrome,", "Open Chrome, please"]
    assert all(e.kind == "partial" and e.compute_ms >= 0 for e in events)
    assert [e.audio_ms for e in events] == sorted(e.audio_ms for e in events)
    assert result.text == "Open Chrome, please"
    assert result.tokens == (1, 2, 3, 4, 5)
    assert [w.text for w in result.words] == ["Open", "Chrome,", "please"]
    assert result.audio_ms == 1000


def test_the_result_does_not_depend_on_how_the_audio_is_cut(tmp_path):
    texts = set()
    for i, step in enumerate((16000 * 2, 6400, 1000, 641, 3)):
        model = FakeModel(script=OPEN_CHROME)
        events, result = run_all(opened(tmp_path / str(i), model), ONE_SECOND[: 2 * 16000], step)
        texts.add((result.text, result.tokens, tuple(e.text for e in events), result.chunks))
    assert len(texts) == 1


def test_an_odd_byte_split_keeps_every_sample(tmp_path):
    model_a, model_b = FakeModel(script=OPEN_CHROME), FakeModel(script=OPEN_CHROME)
    _, whole = run_all(opened(tmp_path / "a", model_a), ONE_SECOND, 10**9)
    _, odd = run_all(opened(tmp_path / "b", model_b), ONE_SECOND, 1001)
    assert odd.audio_ms == whole.audio_ms == 1000
    assert odd.text == whole.text


def test_audio_arrays_int16_and_float_equal_the_bytes(tmp_path):
    raw = np.frombuffer(ONE_SECOND, dtype="<i2")
    results = []
    for i, audio in enumerate((ONE_SECOND, raw, raw.astype(np.float32) / 32768.0)):
        stream = opened(tmp_path / str(i), FakeModel(script=OPEN_CHROME))
        results.append(run_all(stream, audio, 10**9)[1] if isinstance(audio, bytes) else None)
        if not isinstance(audio, bytes):
            stream.feed(audio)
            results[-1] = stream.finalize()
    assert {r.text for r in results if r} == {"Open Chrome, please"}
    with pytest.raises(TransducerError):
        to_float_pcm(np.zeros((2, 2), np.int16), bytearray())
    assert to_float_pcm(b"", bytearray()).size == 0
    assert to_float_pcm(np.array([2.0, -2.0], np.float32), bytearray()).tolist() == [1.0, -1.0]


def test_empty_and_silent_audio_make_no_events(tmp_path):
    stream = opened(tmp_path, FakeModel(script=[]))
    assert stream.feed(b"") == []
    events, result = run_all(stream, pcm_bytes(1.0))
    assert events == [] and result.text == "" and result.words == ()


def test_the_caches_and_the_pre_cache_are_fed_back_and_the_length_is_the_chunk(tmp_path):
    model = FakeModel(script=OPEN_CHROME)
    stream = opened(tmp_path, model)
    run_all(stream, ONE_SECOND)
    calls = model.sessions["encoder.onnx"].calls
    assert len(calls) >= 6
    assert [int(c["cache_last_channel_len"][0]) for c in calls] == list(range(len(calls)))
    assert float(calls[0]["cache_last_channel"].max()) == 0.0  # the caches start at zero
    assert float(calls[3]["cache_last_channel"].min()) == 3.0  # and each call hands its output to the next
    assert float(calls[3]["cache_last_time"].min()) == 3.0
    assert all(int(c["audio_length"][0]) == 16 for c in calls)
    # new_pre_cache is the tail of the previous chunk's frames
    assert np.allclose(calls[1]["pre_cache"], calls[0]["audio_signal"][:, :, -3:])
    assert float(np.abs(calls[0]["pre_cache"]).max()) == 0.0


def test_the_language_mask_is_one_hot_at_the_locale_slot(tmp_path):
    model = FakeModel(script=OPEN_CHROME)
    stream = opened(tmp_path, model)
    run_all(stream, ONE_SECOND)
    mask = model.sessions["encoder.onnx"].calls[0]["language_mask"]
    assert mask.tolist() == [[1.0] + [0.0] * 15]
    stream.configure("hi-IN")
    run_all(stream, ONE_SECOND)
    hindi = model.sessions["encoder.onnx"].calls[-1]["language_mask"][0]
    assert hindi.tolist() == [0.0] * 6 + [1.0] + [0.0] * 9
    stream.configure("")  # no locale: the automatic slot
    assert stream._mask is not None and int(stream._mask.argmax()) == 15


def test_the_decoder_state_moves_only_on_a_token_and_the_start_token_is_the_blank(tmp_path):
    model = FakeModel(script=OPEN_CHROME)
    stream = opened(tmp_path, model)
    run_all(stream, ONE_SECOND)
    calls = model.sessions["decoder.onnx"].calls
    assert int(calls[0]["token"][0, 0]) == 11  # the blank starts the decoder
    assert [int(c["token"][0, 0]) for c in calls[1:]] == [1, 2, 3, 4, 5]  # then one call per emitted token only
    assert [float(c["h"][0, 0, 0]) for c in calls] == [0.0, 0.0, 1.0, 2.0, 3.0, 4.0]  # the blank start moved nothing


def test_at_most_ten_symbols_per_frame(tmp_path):
    model = FakeModel(script=[(0, 1)] * 14)
    _, result = run_all(opened(tmp_path, model), ONE_SECOND)
    assert len(result.tokens) == 10


def test_finalize_flushes_three_silent_chunks_and_is_stable(tmp_path):
    counts = {}
    for flush in (0, 3, 5):
        model = FakeModel(script=OPEN_CHROME)
        stream = opened(tmp_path / str(flush), model, flush_chunks=flush)
        events = []
        for i in range(0, len(ONE_SECOND), 6400):
            events += stream.feed(ONE_SECOND[i : i + 6400])
        before = len(model.sessions["encoder.onnx"].calls)
        first = stream.finalize()
        counts[flush] = len(model.sessions["encoder.onnx"].calls) - before
        again = stream.finalize()
        assert again == first
    assert counts[3] >= counts[0] + 3 and counts[5] >= counts[3] + 2
    with pytest.raises(TransducerError) as late:
        stream.feed(ONE_SECOND)
    assert late.value.kind == "finished"


def test_a_short_phrase_needs_the_flush_to_be_heard(tmp_path):
    short = ONE_SECOND[: 2 * 2000]  # 2000 samples: 12 mel frames, less than one chunk of 16
    model = FakeModel(script=[(0, 1)])
    stream = opened(tmp_path, model)
    assert stream.feed(short) == []
    assert stream.finalize().text == "Open"


def test_reset_starts_clean_and_keeps_the_sessions(tmp_path):
    model = FakeModel(script=OPEN_CHROME)
    stream = opened(tmp_path, model)
    _, first = run_all(stream, ONE_SECOND)
    stream.reset()
    assert stream.text() == "" and stream.is_open
    _, second = run_all(stream, ONE_SECOND)
    assert second.text == first.text and second.audio_ms == 1000
    assert len(model.opened) == 3  # three sessions, opened once
    encoder_calls = model.sessions["encoder.onnx"].calls
    restart = len(encoder_calls) // 2
    assert int(encoder_calls[restart]["cache_last_channel_len"][0]) == 0  # the caches began again at zero
    assert float(encoder_calls[restart]["cache_last_channel"].max()) == 0.0


def test_feeding_a_closed_stream_is_a_named_error(tmp_path):
    stream = opened(tmp_path, FakeModel())
    stream.close()
    assert not stream.is_open
    with pytest.raises(TransducerError) as closed:
        stream.feed(ONE_SECOND)
    assert closed.value.kind == "closed"
    with pytest.raises(TransducerError):
        stream.finalize()


def test_hindi_text_comes_out_in_devanagari(tmp_path):
    model = FakeModel(script=[(1, 6), (3, 7), (3, 8), (6, 9)])
    folder = write_model_dir(tmp_path / "m")
    stream = NemotronStream(model.factory, threads=1)
    stream.open(folder, None, "hi-IN")
    events, result = run_all(stream, ONE_SECOND)
    assert result.text == "आज मौसम अच्छा है"
    assert [w.text for w in result.words] == ["आज", "मौसम", "अच्छा", "है"]
    assert events[-1].text == result.text


def test_hotwords_switch_to_the_beam_and_the_text_stays_exact(tmp_path):
    model = FakeModel(script=OPEN_CHROME)
    folder = write_model_dir(tmp_path / "m")
    stream = NemotronStream(model.factory, threads=1)
    stream.open(folder, None, "en-US")
    assert isinstance(stream._decoder, RnntGreedyDecoder) and stream.hotword_count == 0
    stream.configure("en-US", ["Open Chrome", "zebra", ""])
    assert isinstance(stream._decoder, RnntBeamDecoder)
    assert stream.hotword_count == 1  # "zebra" has no pieces and is dropped
    events, result = run_all(stream, ONE_SECOND)
    assert result.text == "Open Chrome, please"
    assert events and [w.start_ms for w in result.words] == [None] * 3  # the beam keeps no frame per token
    stream.configure("en-US")
    assert isinstance(stream._decoder, RnntGreedyDecoder)


def test_hotwords_lift_a_close_second_choice(tmp_path):
    """Two pieces nearly tie at one frame: with the phrase as a hotword the beam picks it."""
    model = FakeModel(script=[(1, 1)])
    real = model._joint

    def tie(providers):
        session = real(providers)
        inner = session._fn

        def run(feeds, call, provs):
            out = inner(feeds, call, provs)
            if (
                int(round(float(feeds["decoder_output"][0, 0, 0]))) == 0
                and int(round(float(feeds["encoder_output"][0, 0, 0]))) == 1
            ):
                out["logits"][0, 0, 1] = 4.0  # "Open" is the plain winner at 4.0
                out["logits"][0, 0, 6] = 3.8  # "आज" is a close second
            return out

        session._fn = run
        return session

    model._joint = tie  # type: ignore[method-assign]
    folder = write_model_dir(tmp_path / "m")
    plain = NemotronStream(model.factory, threads=1)
    plain.open(folder, None, "en-US")
    assert run_all(plain, ONE_SECOND)[1].text == "Open"
    boosted = NemotronStream(model.factory, threads=1)
    boosted.open(folder, None, "en-US", ["आज"])
    assert run_all(boosted, ONE_SECOND)[1].text.startswith("आज")


# ---- the real model (skips visibly without FRIDAY_NEMOTRON_DIR) --------------------------------------------------


REAL_DIR = os.environ.get("FRIDAY_NEMOTRON_DIR", "").strip()
REAL_AUDIO = os.environ.get("FRIDAY_NEMOTRON_AUDIO", "").strip()


def _read_wav(path: Path) -> bytes:
    with wave.open(str(path)) as w:
        assert w.getframerate() == 16000 and w.getsampwidth() == 2 and w.getnchannels() == 1
        return w.readframes(w.getnframes())


@pytest.mark.skipif(
    not REAL_DIR, reason="FRIDAY_NEMOTRON_DIR is not set: the real Nemotron model is not on this machine"
)
def test_the_real_model_loads_streams_and_reads_its_own_shapes():
    ort = pytest.importorskip("onnxruntime")
    assert ort
    stream = NemotronStream()
    info = stream.open(REAL_DIR, None, "en-US")
    assert info["providers"] == [CPU] and info["chunkMs"] == 320 and info["blankId"] == 13087
    c = stream.contract
    assert c is not None and (c.n_mels, c.chunk_frames, c.layers, c.hidden) == (128, 32, 24, 1024)
    silence = pcm_bytes(2.0)
    started = time.perf_counter()
    events = stream.feed(silence)
    result = stream.finalize()
    assert result.text == "" and events == []
    assert result.compute_ms > 0 and time.perf_counter() - started < 60

    folder = Path(REAL_AUDIO) if REAL_AUDIO else None
    if folder is None or not (folder / "index.json").is_file():
        pytest.skip("FRIDAY_NEMOTRON_AUDIO is not set: silence ran, the word error rate did not")
    from stt_bench import wer

    rows = json.loads((folder / "index.json").read_text(encoding="utf-8"))
    errors: dict[str, list[float]] = {"en": [], "hi": []}
    compute = audio = 0.0
    first_ms: list[int] = []
    for row in rows:
        lang = "hi" if row["lang"] == "hi" else "en"
        if row["lang"] not in {"en", "hi"}:
            continue
        stream.configure("hi-IN" if lang == "hi" else "en-US")
        data = _read_wav(folder / f"{int(row['i']):02d}.wav")
        events = []
        for i in range(0, len(data), 6400):
            events += stream.feed(data[i : i + 6400])
        result = stream.finalize()
        errors[lang].append(wer(row["ref"], result.text))
        compute += result.compute_ms
        audio += result.audio_ms
        if events:
            first_ms.append(events[0].audio_ms)
    rtf = compute / max(1.0, audio)
    print(
        f"REAL nemotron (Linux sandbox): en WER {np.mean(errors['en']):.3f}, "
        f"hi WER {np.mean(errors['hi']):.3f}, RTF {rtf:.3f}"
    )
    assert np.mean(errors["en"]) <= 0.2 and np.mean(errors["hi"]) <= 0.3
    assert rtf < 2.0  # a loaded 4-core sandbox measured 0.85 with the three-chunk flush counted
    assert first_ms and max(first_ms) <= 1600  # first words show within 1.6 s of audio (lead silence included)
