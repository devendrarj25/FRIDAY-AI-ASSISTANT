import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import stt_bench  # noqa: E402


def test_the_normaliser_is_fixed_and_forgiving_about_case_punctuation_and_digits():
    assert stt_bench.normalise("  Namaste,  DUNIYA!  ") == "namaste duniya"
    assert stt_bench.normalise("मेरे २ दोस्त हैं।") == "मेरे 2 दोस्त हैं"
    assert stt_bench.normalise("kal ki meeting — 5 baje") == "kal ki meeting 5 baje"


def test_error_rates_count_edits_per_reference_word_or_character():
    assert stt_bench.wer("kal meeting hai", "kal meeting hai") == 0
    assert stt_bench.wer("kal meeting hai", "kal hai") == 1 / 3
    assert stt_bench.wer("kal meeting hai", "aaj meeting nahi hai") > 0.5
    assert stt_bench.wer("", "") == 0 and stt_bench.wer("", "x") == 1
    assert 0 < stt_bench.cer("meeting", "meating") < 0.2


def test_pairs_need_a_text_file_with_the_same_name(tmp_path):
    (tmp_path / "a.wav").write_bytes(b"x")
    (tmp_path / "a.txt").write_text("hello there", encoding="utf-8")
    (tmp_path / "b.wav").write_bytes(b"x")  # no text: skipped
    (tmp_path / "c.txt").write_text("orphan", encoding="utf-8")
    rows = stt_bench.pairs(tmp_path)
    assert [(p.name, t) for p, t in rows] == [("a.wav", "hello there")]


def test_models_are_ranked_by_error_with_failures_counted_not_hidden(tmp_path):
    rows = [(tmp_path / "a.wav", "kal meeting hai"), (tmp_path / "b.wav", "chai pee lo")]
    heard = {
        "small": {"a.wav": "kal meeting hai", "b.wav": "chai pee lo"},
        "tiny": {"a.wav": "kal hai", "b.wav": "chai lo"},
        "broken": {},
    }

    def hear(path, model):
        return heard[model][path.name]

    ticks = iter(range(0, 100, 2))
    out = stt_bench.score(rows, ["tiny", "small", "broken"], hear, clock=lambda: float(next(ticks)))
    assert [r["model"] for r in out] == ["small", "tiny", "broken"]
    assert out[0]["wer"] == 0 and out[1]["wer"] > 0
    assert out[2]["wer"] is None and out[2]["failed"] == 2 and out[2]["scored"] == 0


def test_the_shared_text_fixture_agrees_with_the_hand_set_edit_counts():
    import json

    fixture = json.loads(
        (Path(__file__).resolve().parents[2] / "core" / "fixtures" / "voice-wer-cases.json").read_text(encoding="utf-8")
    )
    assert len(fixture["cases"]) >= 24
    for case in fixture["cases"]:
        words = len(stt_bench.normalise(case["reference"]).split())
        assert words == case["refWords"], case["id"]
        got = stt_bench.wer(case["reference"], case["hypothesis"]) * words
        assert round(got) == case["wordEdits"], case["id"]


def test_the_roman_normaliser_folds_spelling_but_never_transliterates():
    assert stt_bench.normalise_roman("Aaj,  ka MAUSAM!") == "aj ka mausam"
    assert stt_bench.normalise_roman("āj garmī") == stt_bench.normalise_roman("aaj garmi") == "aj garmi"
    assert stt_bench.normalise_roman("kaam") == stt_bench.normalise_roman("kam")
    assert stt_bench.normalise_roman("chai") != stt_bench.normalise_roman("chaay")
    assert stt_bench.normalise_roman("मुझे चाय") == stt_bench.normalise("मुझे चाय")  # Devanagari is left as it is
    assert stt_bench.wer("mujhe chai chahiye", "मुझे चाय चाहिए", roman=True) == 1.0
    assert stt_bench.wer("mujhe kaam hai", "mujhe kam hai") == 1 / 3
    assert stt_bench.wer("mujhe kaam hai", "mujhe kam hai", roman=True) == 0
    assert stt_bench.cer("kaam", "kam", roman=True) == 0 and stt_bench.cer("kaam", "kam") > 0


def test_models_are_scored_with_the_roman_normaliser_when_asked(tmp_path):
    rows = [(tmp_path / "a.wav", "mujhe kaam hai")]

    def hear(path, model):
        return "mujhe kam hai"

    assert stt_bench.score(rows, ["m"], hear)[0]["wer"] > 0
    assert stt_bench.score(rows, ["m"], hear, roman=True)[0]["wer"] == 0


def test_the_roman_fixture_cases_agree_under_both_normalisers():
    import json

    fixture = json.loads(
        (Path(__file__).resolve().parents[2] / "core" / "fixtures" / "voice-wer-cases.json").read_text(encoding="utf-8")
    )
    roman = [case for case in fixture["cases"] if case.get("script") == "roman"]
    assert len(roman) >= 6
    for case in roman:
        words = len(stt_bench.normalise(case["reference"]).split())
        assert (
            round(stt_bench.wer(case["reference"], case["hypothesis"], roman=True) * words) == case["romanWordEdits"]
        ), case["id"]
        assert round(stt_bench.wer(case["reference"], case["hypothesis"]) * words) == case["wordEdits"], case["id"]
