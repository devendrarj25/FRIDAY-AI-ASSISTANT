"""Hindi memory on the local index: Devanagari words, matras and inflected forms must hash to real vectors, so a
fact stored in Devanagari comes back for a Devanagari query, and an old vector file built by the ASCII-only
tokenizer is rebuilt instead of trusted."""

import importlib
import sys
import tempfile
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

memory = importlib.import_module("memory")
NumpyIndex = memory.NumpyIndex

TEA = "मुझे चाय पसंद है"
NAME = "मेरा नाम देवेंद्र है"


def test_a_devanagari_sentence_embeds_to_a_non_zero_vector():
    assert sum(abs(v) for v in memory.embed(TEA)) > 0


def test_tokens_keep_matras_whole_and_drop_the_danda_and_hindi_stop_words():
    tokens = memory._tokens("मुझे चाय पसंद है। और कॉफ़ी")
    assert "चाय" in tokens and "पसंद" in tokens
    assert "है" not in tokens and "और" not in tokens and "मुझे" not in tokens
    # No token is a lone matra or carries the danda.
    assert all("।" not in t for t in tokens)
    assert not any(len(t) == 1 and unicodedata.category(t) in ("Mn", "Mc") for t in tokens)


def test_nfc_makes_the_nukta_forms_one_key():
    composed = memory._tokens("क़")  # the precomposed letter; NFC splits it into base plus nukta
    split = memory._tokens("क़")
    assert composed == split and composed


def test_store_in_devanagari_then_recall_in_devanagari():
    with tempfile.TemporaryDirectory() as tmp:
        idx = NumpyIndex(Path(tmp))
        idx.add(NAME, kind="semantic", title="name", record_id="n1")
        idx.add(TEA, kind="semantic", title="tea", record_id="t1")
        hits = idx.search("मेरा नाम क्या है", k=3)
        assert hits and hits[0]["id"] == "n1"
        hits = idx.search("चाय", k=3)
        assert hits and hits[0]["id"] == "t1"


def test_an_inflected_form_still_matches_through_character_trigrams():
    with tempfile.TemporaryDirectory() as tmp:
        idx = NumpyIndex(Path(tmp))
        idx.add("देवेंद्र जयपुर में रहता है", kind="semantic", title="city", record_id="c1")
        idx.add("चाय पसंद है", kind="semantic", title="tea", record_id="t1")
        hits = idx.search("जयपुरवासी", k=3)
        assert hits and hits[0]["id"] == "c1"


def test_mixed_script_text_keeps_both_halves_searchable():
    with tempfile.TemporaryDirectory() as tmp:
        idx = NumpyIndex(Path(tmp))
        idx.add("मेरी meeting कल सुबह दस बजे है", kind="episodic", title="meeting", record_id="m1")
        assert idx.search("meeting", k=2)[0]["id"] == "m1"
        assert idx.search("सुबह दस बजे", k=2)[0]["id"] == "m1"


def test_an_old_vector_file_without_the_current_version_is_rebuilt():
    with tempfile.TemporaryDirectory() as tmp:
        idx = NumpyIndex(Path(tmp))
        idx.add(NAME, kind="semantic", title="name", record_id="n1")
        idx._persist_matrix()
        # Simulate a matrix written by the old tokenizer: same shape, all zero, no version stamp.
        if idx._np is not None:
            idx._np.save(idx.matrix_file, idx._np.zeros((1, memory.EMBED_DIM), dtype="float32"))
        for stamp in Path(tmp).glob("vectors.*version*"):
            stamp.unlink()
        fresh = NumpyIndex(Path(tmp))
        fresh.load()
        assert sum(abs(v) for v in fresh.vectors[0]) > 0
        assert fresh.search("नाम", k=1)[0]["id"] == "n1"
