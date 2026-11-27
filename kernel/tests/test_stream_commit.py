"""FRIDAY Ears: LocalAgreement-2 commits and the partial stabiliser (pure logic)."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from stream_commit import (  # noqa: E402
    LocalAgreementCommitter,
    PartialStabiliser,
    Word,
    join_words,
    to_words,
    word_key,
    words_from_text,
)


def texts(words) -> list[str]:
    return [w.text for w in words]


def feed(committer: LocalAgreementCommitter, hypothesis) -> list[str]:
    committer.insert(hypothesis)
    return texts(committer.flush())


def timed(*items: tuple[str, float, float]) -> list[Word]:
    return [Word(t, s, e) for t, s, e in items]


def test_two_agreeing_hypotheses_commit_the_shared_prefix_only():
    c = LocalAgreementCommitter()
    assert feed(c, "turn on the".split()) == []  # one hypothesis agrees with nothing yet
    assert feed(c, "turn on the lights".split()) == ["turn", "on", "the"]
    assert texts(c.pending) == ["lights"]
    assert feed(c, "turn on the lights please".split()) == ["lights"]
    assert texts(c.committed) == ["turn", "on", "the", "lights"]


def test_a_changed_word_stops_the_commit_at_the_disagreement():
    c = LocalAgreementCommitter()
    feed(c, "turn on the lights".split())
    assert feed(c, "turn off the lights".split()) == ["turn"]
    assert texts(c.pending) == ["off", "the", "lights"]


def test_agreement_ignores_case_and_edge_punctuation_and_keeps_the_newer_spelling():
    c = LocalAgreementCommitter()
    feed(c, ["Hello,", "World"])
    assert feed(c, ["hello", "world.", "again"]) == ["hello", "world."]
    assert word_key("Don't!") == "don't" and word_key("।नमस्ते।") == "नमस्ते"


def test_hindi_words_commit_like_any_other():
    c = LocalAgreementCommitter()
    feed(c, words_from_text("मुझे बताओ आज"))
    assert feed(c, words_from_text("मुझे बताओ आज मौसम")) == ["मुझे", "बताओ", "आज"]


def test_timestamped_hypotheses_drop_what_is_already_committed():
    c = LocalAgreementCommitter()
    h1 = timed(("open", 0.0, 0.4), ("the", 0.4, 0.5), ("door", 0.5, 1.0))
    h2 = h1 + timed(("now", 1.0, 1.3))
    feed(c, h1)
    assert feed(c, h2) == ["open", "the", "door"]
    h3 = h2 + timed(("please", 1.3, 1.8))
    assert feed(c, h3) == ["now"]  # earlier words were filtered by time, not recommitted
    assert texts(c.committed) == ["open", "the", "door", "now"]


def test_a_repeated_ngram_at_the_seam_is_not_committed_twice():
    c = LocalAgreementCommitter()
    feed(c, timed(("good", 0.0, 0.3), ("morning", 0.3, 0.8)))
    feed(c, timed(("good", 0.0, 0.3), ("morning", 0.3, 0.8), ("sir", 0.8, 1.1)))
    # the model re-emits "morning sir" with starts a hair before the last committed end
    assert feed(c, timed(("morning", 0.75, 0.9), ("sir", 0.9, 1.1), ("how", 1.1, 1.3))) == ["sir"]
    assert feed(c, timed(("sir", 0.9, 1.1), ("how", 1.1, 1.3), ("are", 1.3, 1.5))) == ["how"]
    assert texts(c.committed) == ["good", "morning", "sir", "how"]


def test_finalize_commits_the_rest_at_the_end_of_the_turn():
    c = LocalAgreementCommitter()
    feed(c, "call mom".split())
    assert feed(c, "call mom now".split()) == ["call", "mom"]
    assert texts(c.finalize()) == ["now"]
    assert c.pending == () and texts(c.all_committed) == ["call", "mom", "now"]
    d = LocalAgreementCommitter()
    d.insert("x y".split())  # a hypothesis never flushed is committed whole by finalize
    assert texts(d.finalize()) == ["x", "y"]


def test_flush_without_an_insert_keeps_the_pending_words():
    c = LocalAgreementCommitter()
    feed(c, "a b".split())
    assert c.flush() == []
    assert texts(c.pending) == ["a", "b"]


def test_trim_force_commits_pending_words_it_would_cut_and_feeds_the_prompt():
    c = LocalAgreementCommitter()
    feed(c, timed(("one", 0.0, 1.0), ("two", 1.0, 2.0), ("three", 2.0, 3.0)))
    feed(c, timed(("one", 0.0, 1.0), ("two", 1.0, 2.0), ("three", 2.0, 3.0), ("four", 3.0, 4.0)))
    assert texts(c.committed) == ["one", "two", "three"] and texts(c.pending) == ["four"]
    forced = c.trim_at(4.0)
    assert texts(forced) == ["four"]  # nothing is lost to a trim
    assert c.committed == () and c.window_start == 4.0
    assert c.prompt() == "one two three four"
    assert texts(c.all_committed) == ["one", "two", "three", "four"]


def test_trim_keeps_words_after_the_cut_in_the_window():
    c = LocalAgreementCommitter()
    h = timed(("a", 0.0, 1.0), ("b", 1.0, 2.0), ("c", 2.0, 3.0))
    feed(c, h)
    feed(c, h)
    c.trim_at(2.0)
    assert texts(c.committed) == ["c"] and c.prompt() == "a b"


def test_prompt_is_capped_at_200_chars_on_word_boundaries():
    c = LocalAgreementCommitter()
    words = [f"word{i:03d}" for i in range(100)]  # 7 chars each
    h = [Word(w, float(i), i + 0.5) for i, w in enumerate(words)]
    feed(c, h)
    feed(c, h)
    c.trim_at(100.0)
    prompt = c.prompt()
    assert len(prompt) <= 200 and prompt.split()[-1] == "word099"
    assert all(len(p) == 7 for p in prompt.split())  # never a cut word
    assert len(prompt) > 190
    one = LocalAgreementCommitter()
    giant = [Word("x" * 500, 0.0, 1.0)]
    feed(one, giant)
    feed(one, giant)
    one.trim_at(2.0)
    assert one.prompt() == "x" * 200


def test_window_cap_suggests_a_word_boundary_trim_after_12_seconds():
    c = LocalAgreementCommitter()
    assert c.suggest_trim(11.9) is None and c.suggest_trim(12.0) is None
    h = [Word(f"w{i}", i * 1.0, i + 0.9) for i in range(14)]
    feed(c, h)
    feed(c, h)
    cut = c.suggest_trim(14.0)
    assert cut is not None and cut >= 2.0 and 14.0 - cut <= 12.0
    assert cut == pytest.approx(2.9)  # first known word end at or after audio_end - 12
    c.trim_at(cut)
    assert c.suggest_trim(14.0) is None
    empty = LocalAgreementCommitter()
    assert empty.suggest_trim(20.0) == pytest.approx(8.0)  # no words known: cut exactly at the cap


def test_text_only_mode_expects_the_hypothesis_to_cover_the_window():
    c = LocalAgreementCommitter()
    feed(c, "hello there".split())
    assert feed(c, "hello there friend".split()) == ["hello", "there"]
    assert feed(c, "hello there friend how".split()) == ["friend"]
    c.trim_at(5.0)  # no timestamps: everything committed leaves the window, pending is dropped
    assert c.committed == () and c.pending == ()
    assert c.prompt() == "hello there friend"
    assert feed(c, "are you".split()) == []
    assert feed(c, "are you well".split()) == ["are", "you"]


def test_empty_and_blank_hypotheses_are_harmless():
    c = LocalAgreementCommitter()
    assert feed(c, []) == [] and feed(c, ["", "  ", "..."]) == []
    assert to_words(["", "ok"]) == [Word("ok")]
    assert c.prompt() == "" and c.finalize() == []


def test_tuples_are_accepted_as_words_and_bad_arguments_refused():
    assert to_words([("hi", 0.0, 0.5)]) == [Word("hi", 0.0, 0.5)]
    with pytest.raises(ValueError):
        LocalAgreementCommitter(max_window_s=0)


def test_kept_words_are_bounded():
    c = LocalAgreementCommitter(max_kept_words=5)
    h = [f"w{i}" for i in range(20)]
    feed(c, h)
    feed(c, h)
    assert len(c.all_committed) == 5 and texts(c.all_committed)[-1] == "w19"


def test_reset_starts_a_new_turn():
    c = LocalAgreementCommitter()
    feed(c, ["a"])
    feed(c, ["a", "b"])
    c.reset()
    assert c.all_committed == () and c.pending == () and c.window_start == 0.0


# ---- stabiliser ---------------------------------------------------------------------------------------------------


def test_stabiliser_splits_committed_stable_and_volatile():
    s = PartialStabiliser()
    p1 = s.update("turn on the lights".split())
    assert (texts(p1.committed), texts(p1.stable), texts(p1.volatile)) == ([], [], ["turn", "on", "the", "lights"])
    p2 = s.update("turn off the lights".split())
    assert texts(p2.committed) == ["turn"]
    assert texts(p2.stable) == ["the", "lights"]  # agreed with the last hypothesis but after a disagreement
    assert texts(p2.volatile) == ["off"]
    assert p2.text == "turn off the lights" and texts(p2.newly_committed) == ["turn"]
    p3 = s.update("turn off the lights now".split())
    assert texts(p3.committed) == ["turn", "off", "the", "lights"] and texts(p3.volatile) == ["now"]


def test_revision_rises_only_when_the_display_changes():
    s = PartialStabiliser()
    r1 = s.update(["hello"]).revision
    r2 = s.update(["hello", "world"]).revision
    assert r2 > r1
    r3 = s.update(["hello", "world"]).revision  # same words again: "world" becomes committed -> a change
    assert r3 > r2
    r4 = s.update(["hello", "world"]).revision
    assert r4 == r3  # nothing moved
    assert s.revision == r4


def test_finalize_makes_everything_committed_and_reset_clears():
    s = PartialStabiliser()
    s.update("a b c".split())
    done = s.finalize()
    assert texts(done.committed) == ["a", "b", "c"] and done.stable == () and done.volatile == ()
    s.reset()
    again = s.update(["z"])
    assert again.revision == 1 and texts(again.volatile) == ["z"]


def test_stabiliser_trim_publishes_force_committed_words():
    s = PartialStabiliser()
    h = timed(("a", 0.0, 1.0), ("b", 1.0, 2.0))
    s.update(h)
    s.update(h)
    out = s.trim_at(2.0)
    assert texts(out.committed) == ["a", "b"] and out.volatile == ()


def test_join_words():
    assert join_words(words_from_text("a  b")) == "a b"
