"""LocalAgreement-2 partials over re-decoding ears: the committed prefix only grows, the window rolls, hotwords bias."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "kernel"))

from hotword_trie import WORD_MARK, tokenize_phrase, trie_for_words  # noqa: E402
from la2_partials import CtcChunkReader, La2Partials, snap_hotwords  # noqa: E402
from stream_commit import Word  # noqa: E402

RATE = 16000
SCRIPT = "aaj ka mausam kaisa hai aur kal ki meeting kab hai".split()


class SpeakingReader:
    """A fake ear: it hears one word per 0.4 s of audio, and its last word flickers between two spellings."""

    def __init__(self, words=SCRIPT, per_word=0.4):
        self.words, self.per_word, self.calls, self.prompts, self.sizes = words, per_word, 0, [], []

    def __call__(self, window, prompt):
        self.calls += 1
        self.prompts.append(prompt)
        self.sizes.append(len(window))
        offset = self.offset
        heard = []
        t = 0.0
        while t + self.per_word <= len(window) / RATE + 1e-9:
            index = int(round((offset + t) / self.per_word))
            if index >= len(self.words):
                break
            text = self.words[index]
            if t + 2 * self.per_word > len(window) / RATE and self.calls % 2:
                text = text.upper() + "x"  # the newest word is still unsure
            heard.append(Word(text, round(t, 3), round(t + self.per_word, 3)))
            t += self.per_word
        return heard

    offset = 0.0


def _run(reader, la2, seconds, chunk_s=0.24):
    snaps = []
    chunk = np.zeros(int(chunk_s * RATE), dtype=np.float32)
    for _ in range(int(seconds / chunk_s)):
        reader.offset = la2._offset
        part = la2.push(chunk)
        if part is not None:
            snaps.append(part)
    return snaps


def test_the_committed_prefix_never_retracts_and_partials_are_monotone():
    reader = SpeakingReader()
    la2 = La2Partials(reader, hop_s=0.48)
    snaps = _run(reader, la2, 4.8)
    assert len(snaps) >= 8 and reader.calls == len(snaps)
    for before, after in zip(snaps, snaps[1:], strict=False):
        assert after.committed[: len(before.committed)] == before.committed
        assert after.revision >= before.revision
    committed = [w.text for w in snaps[-1].committed]
    assert committed and committed == SCRIPT[: len(committed)]  # nothing unsure was ever committed
    final = la2.finalize()
    assert [w.text for w in final.committed][: len(committed)] == committed


def test_nothing_is_read_before_a_hop_of_new_audio():
    reader = SpeakingReader()
    la2 = La2Partials(reader, hop_s=0.5)
    assert la2.push(np.zeros(int(0.2 * RATE), dtype=np.float32)) is None
    assert la2.push(np.zeros(int(0.2 * RATE), dtype=np.float32)) is None
    assert reader.calls == 0
    assert la2.push(np.zeros(int(0.2 * RATE), dtype=np.float32)) is not None
    assert reader.calls == 1


def test_the_window_rolls_and_the_text_that_left_it_becomes_the_prompt():
    words = [f"w{i}" for i in range(80)]
    reader = SpeakingReader(words, per_word=0.3)
    la2 = La2Partials(reader, hop_s=0.6, max_window_s=3.0)
    _run(reader, la2, 12.0, chunk_s=0.3)
    assert max(reader.sizes) <= int(3.0 * RATE) + int(1.0 * RATE)  # never far past the window
    assert la2._offset > 0  # the window moved forward
    assert any(prompt.startswith("w0") or " w" in prompt for prompt in reader.prompts if prompt)
    committed = [w.text for w in la2.stabiliser.committer.all_committed]
    assert committed == words[: len(committed)] and len(committed) >= 20


def test_finalize_reads_the_unread_tail_and_commits_everything():
    reader = SpeakingReader(["namaste", "friday"], per_word=0.4)
    la2 = La2Partials(reader, hop_s=10.0, min_audio_s=0.3)
    assert la2.push(np.zeros(int(0.8 * RATE), dtype=np.float32)) is None
    final = la2.finalize()
    assert reader.calls == 1 and [w.text for w in final.committed] in (["namaste", "friday"], ["namaste", "FRIDAYx"])
    assert la2.audio_s == pytest.approx(0.8) and la2.turn_start_s == 0.0


def test_the_turn_buffer_is_capped_and_says_where_it_starts():
    la2 = La2Partials(lambda w, p: [], hop_s=100.0, max_turn_s=1.0)
    la2.push(np.zeros(int(2.5 * RATE), dtype=np.float32))
    assert la2.turn_audio().size == RATE and la2.turn_start_s == pytest.approx(1.5)


def test_bad_settings_are_refused():
    with pytest.raises(ValueError):
        La2Partials(lambda w, p: [], hop_s=0)


# ---- chunked CTC with hotwords -------------------------------------------------------------------------------------

PIECES = ["<blank>", f"{WORD_MARK}de", f"{WORD_MARK}di", "vendra", "dra", f"{WORD_MARK}call"]


def _frames(rows):
    probs = np.full((len(rows), len(PIECES)), 1e-4)
    for t, row in enumerate(rows):
        for token, p in row.items():
            probs[t, token] = p
    probs /= probs.sum(axis=1, keepdims=True)
    return np.log(probs)


def test_a_hotword_tips_a_close_ctc_call_and_words_are_timed():
    # Frame 1 is a near tie between "de" and "di"; frame 2 a near tie between "vendra" and "dra".
    lp = _frames([{5: 0.9}, {0: 0.9}, {1: 0.45, 2: 0.5}, {3: 0.45, 4: 0.5}, {0: 0.9}])
    plain = CtcChunkReader(lambda audio: lp, PIECES, frame_s=0.08)
    biased = CtcChunkReader(lambda audio: lp, PIECES, frame_s=0.08, hotwords=["devendra"])
    assert [w.text for w in plain(None)] == ["call", "didra"]
    words = biased(None)
    assert [w.text for w in words] == ["call", "devendra"]
    assert words[0].start == 0.0 and words[1].start == pytest.approx(0.16) and words[1].end == pytest.approx(0.4)


def test_a_far_hotword_cannot_invent_words():
    lp = _frames([{5: 0.98}, {0: 0.98}])
    reader = CtcChunkReader(lambda audio: lp, PIECES, frame_s=0.08, hotwords=["devendra"])
    assert [w.text for w in reader(None)] == ["call"]
    empty = CtcChunkReader(lambda audio: np.zeros((0, len(PIECES))), PIECES, frame_s=0.08)
    assert empty(None) == []


def test_phrases_are_tokenized_by_longest_match_or_skipped():
    vocab = {piece: i for i, piece in enumerate(PIECES)}
    assert tokenize_phrase("devendra", vocab) == [1, 3]
    assert tokenize_phrase("call didra", vocab) == [5, 2, 4]
    assert tokenize_phrase("zebra", vocab) == []  # cannot be spelled: never half-boosted
    assert trie_for_words(["zebra"], vocab) is None
    trie = trie_for_words(["devendra", "zebra"], vocab)
    assert trie is not None and len(trie) == 1


# ---- word-level hotwords for an ear that gives only text ----------------------------------------------------------


def test_near_words_take_the_owners_spelling_far_and_exact_ones_stay():
    heard = [Word("call", 0.0, 0.3), Word("devendar", 0.3, 0.8), Word("now.", 0.8, 1.0)]
    out = snap_hotwords(heard, ["Devendra", "Jarvis"])
    assert [w.text for w in out] == ["call", "Devendra", "now."]
    assert out[1].start == 0.3 and out[1].end == 0.8
    assert snap_hotwords(heard, []) == heard
    assert [w.text for w in snap_hotwords(heard, ["devendar"])] == ["call", "devendar", "now."]  # exact: unchanged


def test_two_heard_words_can_become_one_phrase_and_keep_the_danda():
    heard = [Word("मुझे", 0.0, 0.4), Word("फ्राइडे", 0.4, 0.8), Word("एआई।", 0.8, 1.2)]
    out = snap_hotwords(heard, ["फ्राइडे एआइ"])
    assert [w.text for w in out] == ["मुझे", "फ्राइडे", "एआइ।"]
    assert snap_hotwords(heard, ["friday ai"]) == heard  # another script is never snapped
