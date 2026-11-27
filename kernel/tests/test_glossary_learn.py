"""FRIDAY Ears: learning glossary hotwords from lines the owner marked as corrected (pure logic, temp data root)."""

from __future__ import annotations

import json
import re
import sqlite3
import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import glossary_learn  # noqa: E402
import privacy  # noqa: E402


def row(heard: Any, corrected: Any, **extra: Any) -> dict[str, Any]:
    return {"source": "owner", "corrected": True, "heard": heard, "text": corrected, **extra}


def test_only_the_words_the_ear_got_wrong_are_learned(tmp_path):
    rows = [row("open the pro jet fry day", "open the Project Friday today")]
    terms = glossary_learn.learn_from_corrections(rows, True, root=tmp_path)
    assert "Project" in terms and "Friday" in terms
    assert "open" not in terms and "the" not in terms  # heard right: nothing to bias


def test_setting_off_learns_nothing_returns_nothing_and_writes_nothing(tmp_path):
    rows = [row("kya hal hai", "Devendra ka hal")]
    assert glossary_learn.learn_from_corrections(rows, False, root=tmp_path) == []
    assert not glossary_learn.glossary_path(tmp_path).exists()
    glossary_learn.learn_from_corrections(rows, True, root=tmp_path)
    assert glossary_learn.glossary_terms(False, root=tmp_path) == []  # off hides what was stored
    assert "Devendra" in glossary_learn.glossary_terms(True, root=tmp_path)


def test_rows_not_marked_corrected_or_not_the_owners_are_ignored(tmp_path):
    rows = [
        {"source": "owner", "corrected": False, "heard": "a", "text": "Zorblax"},
        {"source": "model", "corrected": True, "heard": "a", "text": "Quuxify"},
        {"corrected": True, "heard": "a", "text": "Nosource"},
        {"source": "owner", "corrected": "yes", "heard": "hi", "text": "Hello Valid"},  # only a real True counts
    ]
    assert glossary_learn.learn_from_corrections(rows, True, root=tmp_path) == []


@pytest.mark.parametrize(
    "extra",
    [
        {"source": "tool"},
        {"source": "web"},
        {"untrusted": True},
        {"contextKinds": ["owner", "screen"]},
        {"contextKinds": ["mcp"]},
        {"origin": "email"},
    ],
)
def test_untrusted_context_never_teaches_the_ears(tmp_path, extra):
    rows = [row("x", "Injected Phrase", **extra)]
    assert glossary_learn.learn_from_corrections(rows, True, root=tmp_path) == []


def test_sensitive_and_secret_looking_terms_are_dropped_through_the_kernel_classifier(tmp_path, monkeypatch):
    seen: list[str] = []
    real = privacy.classify

    def spy(content):
        seen.append(str(content))
        return real(content)

    monkeypatch.setattr(privacy, "classify", spy)
    rows = [
        row("my key", "my key sk9a8b7c6d5e4f3g2h1i0j9k8l7m6n5o4p3 Quillbert"),
        row("mail", "mail me at someone@example.com Zanzibar"),
        row("card", "card 4111 1111 1111 1111 Fabrikam"),
    ]
    terms = glossary_learn.learn_from_corrections(rows, True, root=tmp_path)
    assert seen, "the one kernel privacy classifier must be consulted"
    joined = " ".join(terms)
    assert "someone@example.com" not in joined and "4111" not in joined and "sk9a8b7" not in joined
    assert "Quillbert" in terms  # an innocent word beside a secret is still learned


def test_a_private_line_teaches_nothing(tmp_path):
    rows = [row("send it", "send it to C:\\Users\\dev\\Secrets Plutonium")]
    assert glossary_learn.learn_from_corrections(rows, True, root=tmp_path) == []


def test_hindi_roman_and_hinglish_terms_are_kept_as_spoken(tmp_path):
    rows = [
        row("mera naam", "मेरा नाम देवेंद्र है Devendra"),
        row("kal ka plan", "kal ka Hinglish plan बनाओ"),
    ]
    terms = glossary_learn.learn_from_corrections(rows, True, root=tmp_path)
    assert "देवेंद्र" in terms  # matras survive intact
    assert "Devendra" in terms and "बनाओ" in terms and "Hinglish" in terms


def test_digit_words_punctuation_and_overlong_words_are_not_terms(tmp_path):
    rows = [row("a", "Alpha123 ok, Bravo! averyveryveryverylongwordthatisnotaword 2026 Delta-Force it's")]
    terms = glossary_learn.learn_from_corrections(rows, True, root=tmp_path)
    assert "Bravo" in terms and "Delta-Force" in terms
    assert not any(any(ch.isdigit() for ch in t) for t in terms)
    assert not any(len(t) > 40 for t in terms)
    assert "averyveryveryverylongwordthatisnotaword" not in terms


def test_dedupe_ignores_case_and_counts_repeats_into_the_order(tmp_path):
    rows = [row("a", "Zebra"), row("a", "Apple"), row("a", "zebra")]
    glossary_learn.learn_from_corrections(rows, True, root=tmp_path)
    terms = glossary_learn.glossary_terms(True, root=tmp_path)
    assert [t.casefold() for t in terms].count("zebra") == 1
    assert terms[0].casefold() == "zebra"  # seen twice, ranks first
    assert terms[1] == "Apple"


def test_order_is_deterministic_for_equal_counts(tmp_path):
    rows = [row("x", "Mango Banana Cherry")]
    a = glossary_learn.learn_from_corrections(rows, True, root=tmp_path / "a")
    b = glossary_learn.learn_from_corrections(list(rows), True, root=tmp_path / "b")
    assert a == b == sorted(a, key=lambda t: (t.casefold(), t))


def test_the_list_is_capped_and_the_least_seen_term_leaves_first(tmp_path):
    frequent = row("x", "Keeper")
    glossary_learn.learn_from_corrections([frequent, frequent, frequent], True, root=tmp_path)
    letters = "abcdefghij"
    many = [row("x", f"Qux{letters[i // 10]}{letters[i % 10]}") for i in range(60)]
    for i in range(0, 60, 10):
        glossary_learn.learn_from_corrections(many[i : i + 10], True, root=tmp_path, max_terms=20)
    terms = glossary_learn.glossary_terms(True, root=tmp_path, limit=100)
    assert len(terms) == 20
    assert "Keeper" in terms


def test_forget_removes_one_term_and_it_is_not_relearned(tmp_path):
    rows = [row("x", "Alpha Beta")]
    glossary_learn.learn_from_corrections(rows, True, root=tmp_path)
    assert glossary_learn.forget("alpha", root=tmp_path) is True
    assert glossary_learn.forget("alpha", root=tmp_path) is False
    assert glossary_learn.learn_from_corrections(rows, True, root=tmp_path) == ["Beta"]


def test_forget_all_empties_the_glossary_and_old_rows_do_not_bring_it_back(tmp_path):
    rows = [row("x", "Alpha Beta")]
    glossary_learn.learn_from_corrections(rows, True, root=tmp_path)
    assert glossary_learn.forget_all(root=tmp_path) == 2
    assert glossary_learn.glossary_terms(True, root=tmp_path) == []
    assert glossary_learn.learn_from_corrections(rows, True, root=tmp_path) == []


def test_the_file_is_written_atomically_and_a_broken_file_reads_as_empty(tmp_path):
    glossary_learn.learn_from_corrections([row("x", "Alpha")], True, root=tmp_path)
    path = glossary_learn.glossary_path(tmp_path)
    assert json.loads(path.read_text(encoding="utf-8"))["terms"][0]["term"] == "Alpha"
    assert [p.name for p in path.parent.iterdir()] == [path.name]  # no temp file left behind
    path.write_text("{ not json", encoding="utf-8")
    assert glossary_learn.glossary_terms(True, root=tmp_path) == []
    assert glossary_learn.learn_from_corrections([row("x", "Beta")], True, root=tmp_path) == ["Beta"]


def test_prompt_hint_is_short_and_empty_when_off_or_empty(tmp_path):
    assert glossary_learn.prompt_hint(True, root=tmp_path) == ""
    glossary_learn.learn_from_corrections([row("x", "Alpha Beta Gamma")], True, root=tmp_path)
    hint = glossary_learn.prompt_hint(True, root=tmp_path, limit=20)
    assert hint and len(hint) <= 20 and "Alpha" in hint
    assert glossary_learn.prompt_hint(False, root=tmp_path) == ""


def test_garbage_rows_never_raise(tmp_path):
    rows = [None, 5, "text", {}, {"corrected": True, "source": "owner", "text": None}, row(None, ["x"])]
    assert glossary_learn.learn_from_corrections(rows, True, root=tmp_path) == []


# ---- approval and stop words, command verbs, the owner's stored setting ---------------------------------------------


def _confirm_phrases() -> list[str]:
    """Every yes, no and unclear phrase of the one table in voice-session.ts (read from the source file)."""
    src = (Path(__file__).resolve().parents[2] / "src" / "lib" / "friday" / "voice-session.ts").read_text(
        encoding="utf-8"
    )
    start = src.index("export const CONFIRM_WORDS")
    body = src[start : src.index("fillers:", start)]
    phrases: list[str] = []
    for name in ("yes", "no", "unclear"):
        block = body[body.index(f"{name}: [") :]
        block = block[block.index("[") + 1 : block.index("]")]
        phrases += re.findall(r'"([^"]+)"', block)
    return phrases


def test_blocked_words_cover_every_confirm_and_stop_token_of_the_voice_session_table():
    phrases = _confirm_phrases()
    assert len(phrases) > 100  # the parse found the table
    tokens = {glossary_learn._fold(tok) for phrase in phrases for tok in phrase.split()}
    assert tokens - glossary_learn.BLOCKED_WORDS == set()


@pytest.mark.parametrize(
    "word", ["haan", "yes", "confirm", "OK", "theek", "kar", "हाँ", "हां", "ठीक", "बिल्कुल", "ज़रूर", "stop"]
)
def test_approval_and_stop_words_are_never_learned(tmp_path, word):
    terms = glossary_learn.learn_from_corrections([row("zz qq", f"{word} Zorblax")], True, root=tmp_path)
    assert terms == ["Zorblax"]


def test_command_verbs_are_not_learned(tmp_path):
    terms = glossary_learn.learn_from_corrections([row("zz", "delete sudo Zorblax")], True, root=tmp_path)
    assert terms == ["Zorblax"]


def test_an_old_file_with_an_approval_word_does_not_reach_the_ears(tmp_path):
    path = glossary_learn.glossary_path(tmp_path)
    path.parent.mkdir(parents=True)
    terms = [{"term": "haan", "count": 9, "seq": 1}, {"term": "Zorblax", "count": 1, "seq": 2}]
    path.write_text(json.dumps({"v": 1, "seq": 2, "terms": terms}), encoding="utf-8")
    assert glossary_learn.glossary_terms(True, root=tmp_path) == ["Zorblax"]
    assert "haan" not in glossary_learn.prompt_hint(True, root=tmp_path)


def test_setting_on_reads_the_settings_dict_default_true_only_when_never_set():
    assert glossary_learn.setting_on({}) is True
    assert glossary_learn.setting_on({"brain.learn.glossary": True}) is True
    assert glossary_learn.setting_on({"brain.learn.glossary": False}) is False
    assert glossary_learn.setting_on({"brain.learn.glossary": "false"}) is False


def _db(path: Path, value: Any | None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    if value is not None:
        con.execute("INSERT INTO settings VALUES(?,?)", (glossary_learn.SETTING_KEY, json.dumps(value)))
    con.commit()
    con.close()


def _only_friday_root(tmp_path, monkeypatch) -> Path:
    for name in ("FRIDAY_WORKSPACE_ROOT", "FRIDAY_DATA_DIR"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("FRIDAY_ROOT", str(tmp_path))
    return tmp_path / "database" / "friday.sqlite3"


def test_setting_on_reads_the_kernel_database_from_the_friday_folder(tmp_path, monkeypatch):
    db = _only_friday_root(tmp_path, monkeypatch)
    assert glossary_learn.setting_on() is True  # no database yet: never set
    _db(db, None)
    assert glossary_learn.setting_on() is True  # a database without the key: never set
    db.unlink()
    _db(db, False)
    assert glossary_learn.setting_on() is False


def test_an_unreadable_settings_file_counts_as_off(tmp_path, monkeypatch):
    db = _only_friday_root(tmp_path, monkeypatch)
    db.parent.mkdir()
    db.write_bytes(b"not a database at all" * 50)
    assert glossary_learn.setting_on() is False
