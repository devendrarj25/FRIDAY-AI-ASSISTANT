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
