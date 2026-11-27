"""FRIDAY Ears: language id for the automatic locale. The first 15 encoder frames (1.2 s) decode in the auto slot, then
the slot is locked for the rest of the turn. Fake sessions only: exact, no model file, no clock, no network."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fake_transducer import FakeModel, pcm_bytes, write_model_dir  # noqa: E402
from transducer_loop import CPU, LANG_ID_FRAMES, LANG_ID_MIN_WORDS, NemotronStream, identify_language  # noqa: E402

AUTO, EN, HI = 15, 0, 6  # the prompt slots of the fake languages.json
FRAMES_PER_CHUNK = 2  # the fake encoder returns 2 frames per chunk
LOCK_CALL = 8  # the first chunk boundary at or after 15 frames: 8 chunks of 2 frames

VOCAB = {
    0: "<unk>",
    1: "▁mujhe",
    2: "▁file",
    3: "▁kholo",
    4: "▁open",
    5: "▁the",
    6: "▁आज",
    7: "▁मौसम",
    8: "▁अच्छा",
    9: "▁है",
    10: "▁",
}
MUJHE_FILE_KHOLO = [(2, 1), (5, 2), (9, 3)]
OPEN_THE_FILE = [(2, 4), (5, 5), (9, 2)]
AAJ_MAUSAM = [(2, 6), (5, 7), (9, 8)]


def opened(tmp_path: Path, script: list[tuple[int, int]], locale: str = "auto") -> tuple[NemotronStream, FakeModel]:
    model = FakeModel(script=script)
    folder = write_model_dir(tmp_path / "m", model.dims, vocab=VOCAB)
    stream = NemotronStream(model.factory, available=lambda: [CPU], threads=1)
    stream.open(folder, None, locale)
    return stream, model


def slots(model: FakeModel) -> list[int]:
    """The language slot each encoder call ran with."""
    return [int(c["language_mask"][0].argmax()) for c in model.sessions["encoder.onnx"].calls]


def drive(stream: NemotronStream, model: FakeModel, seconds: float = 3.0) -> list[tuple[int, bool]]:
    """Feed 100 ms slices; after each, record (encoder calls so far, locked)."""
    seen: list[tuple[int, bool]] = []
    data = pcm_bytes(seconds, 0.3)
    for i in range(0, len(data), 3200):
        stream.feed(data[i : i + 3200])
        seen.append((len(model.sessions["encoder.onnx"].calls), stream.lang_locked))
    return seen


def first_locked(seen: list[tuple[int, bool]]) -> int:
    return next(calls for calls, locked in seen if locked)


def test_the_constants_are_the_spec():
    assert LANG_ID_FRAMES == 15
    assert LANG_ID_MIN_WORDS == 3
    assert LOCK_CALL * FRAMES_PER_CHUNK >= LANG_ID_FRAMES > (LOCK_CALL - 1) * FRAMES_PER_CHUNK


def test_roman_hindi_locks_hi_at_frame_15(tmp_path):
    stream, model = opened(tmp_path, MUJHE_FILE_KHOLO)
    assert (stream.lang, stream.lang_conf, stream.lang_locked) == ("auto", 0.0, False)
    seen = drive(stream, model)
    assert first_locked(seen) == LOCK_CALL  # not at frame 14, locked at the chunk that reaches frame 15
    assert not any(locked for calls, locked in seen if calls < LOCK_CALL)
    assert stream.lang == "hi" and stream.lang_locked
    assert 0.3 <= stream.lang_conf <= 1.0
    ran = slots(model)
    assert ran[:LOCK_CALL] == [AUTO] * LOCK_CALL
    assert ran[LOCK_CALL:] and set(ran[LOCK_CALL:]) == {HI}
    assert stream.text() == "mujhe file kholo"  # the words decoded in the auto slot are kept


def test_english_locks_en_at_frame_15(tmp_path):
    stream, model = opened(tmp_path, OPEN_THE_FILE)
    seen = drive(stream, model)
    assert first_locked(seen) == LOCK_CALL
    assert stream.lang == "en" and stream.lang_locked
    assert 0.5 < stream.lang_conf <= 1.0
    ran = slots(model)
    assert ran[:LOCK_CALL] == [AUTO] * LOCK_CALL and set(ran[LOCK_CALL:]) == {EN}


def test_devanagari_in_the_partial_locks_hi(tmp_path):
    stream, model = opened(tmp_path, AAJ_MAUSAM)
    drive(stream, model)
    assert stream.lang == "hi" and stream.lang_locked
    assert set(slots(model)[LOCK_CALL:]) == {HI}


def test_fewer_than_three_words_stays_auto(tmp_path):
    stream, model = opened(tmp_path, [(2, 1), (5, 3)])  # "mujhe kholo"
    drive(stream, model)
    assert (stream.lang, stream.lang_conf, stream.lang_locked) == ("auto", 0.0, False)
    assert set(slots(model)) == {AUTO}
    stream.finalize()
    assert not stream.lang_locked and set(slots(model)) == {AUTO}


def test_a_late_third_word_locks_once_it_arrives(tmp_path):
    stream, model = opened(tmp_path, [(2, 4), (5, 5), (21, 2)])  # the third word lands at frame 21
    seen = drive(stream, model)
    assert stream.lang == "en" and stream.lang_locked
    assert first_locked(seen) == 11  # frame 21 is in chunk 11 (frames 20 and 21)
    assert set(slots(model)[:11]) == {AUTO} and set(slots(model)[11:]) == {EN}


def test_no_relock_inside_a_turn(tmp_path):
    # English first, then a run of Hindi words: the slot and the label stay English for the rest of the turn.
    script = [*OPEN_THE_FILE, (20, 6), (22, 7), (24, 8), (26, 9), (28, 1), (30, 3)]
    stream, model = opened(tmp_path, script)
    drive(stream, model, 4.0)
    assert "आज" in stream.text() and "mujhe" in stream.text()  # Hindi is heard after the lock
    assert stream.lang == "en" and stream.lang_locked
    assert set(slots(model)[LOCK_CALL:]) == {EN}


def test_a_turn_reset_clears_the_lock(tmp_path):
    stream, model = opened(tmp_path, MUJHE_FILE_KHOLO)
    drive(stream, model)
    assert stream.lang_locked
    stream.reset()
    assert (stream.lang, stream.lang_conf, stream.lang_locked) == ("auto", 0.0, False)
    before = len(model.sessions["encoder.onnx"].calls)
    drive(stream, model)
    assert slots(model)[before : before + LOCK_CALL] == [AUTO] * LOCK_CALL  # back to the auto slot
    assert stream.lang == "hi" and stream.lang_locked  # and it locks again on the new turn


def test_configure_clears_the_lock_too(tmp_path):
    stream, model = opened(tmp_path, OPEN_THE_FILE)
    drive(stream, model)
    assert stream.lang_locked
    stream.configure("auto")
    assert (stream.lang, stream.lang_locked) == ("auto", False) and stream.lang_auto


def test_a_fixed_locale_is_not_detected_and_never_changes_slot(tmp_path):
    stream, model = opened(tmp_path, MUJHE_FILE_KHOLO, locale="en-US")
    drive(stream, model)
    assert not stream.lang_auto
    assert (stream.lang, stream.lang_conf, stream.lang_locked) == ("en", 1.0, True)  # the declared language
    assert set(slots(model)) == {EN}


def test_the_same_audio_gives_the_same_lock(tmp_path):
    runs = []
    for name in ("a", "b"):
        stream, model = opened(tmp_path / name, MUJHE_FILE_KHOLO)
        seen = drive(stream, model)
        runs.append((seen, stream.lang, stream.lang_conf, slots(model)))
    assert runs[0] == runs[1]


@pytest.mark.parametrize(
    ("text", "lang"),
    [
        ("mujhe file kholo", "hi"),
        ("open the file", "en"),
        ("आज मौसम अच्छा है", "hi"),
        ("please खोलो the file", "hi"),  # both scripts: Hinglish reads as Hindi for the slot
        ("one two", "auto"),  # under three words
        ("", "auto"),
        ("   ", "auto"),
    ],
)
def test_identify_language(text, lang):
    got, conf = identify_language(text)
    assert got == lang
    assert 0.0 <= conf <= 1.0
    assert (conf == 0.0) == (lang == "auto")


def test_identify_language_keeps_english_with_a_few_loan_words():
    got, conf = identify_language("open the file and send it to my friend today")
    assert got == "en" and conf > 0.7
