"""FRIDAY Ears: LocalAgreement-2 committer and the partial stabiliser (pure Python, no dependencies).

Interface contract
------------------
A streaming recogniser re-decodes a rolling window of audio again and again. Each decode is a *hypothesis*: a list
of words (``Word`` or plain ``str``; timestamps optional, in seconds on the session clock). A word is committed
(never revised, safe to send on) once two hypotheses in a row agree on it, which is LocalAgreement-2.

``LocalAgreementCommitter``
* ``insert(hypothesis)`` stores the newest hypothesis, minus what is already committed.
  - With timestamps: words that start before the end of the last committed word (minus ``time_tolerance_s``)
    are dropped, and a repeated n-gram (up to 5 words) at the seam is dropped.
  - Without timestamps: the hypothesis must cover the window from ``window_start``, so the first
    ``len(committed in window)`` words are dropped.
* ``flush()`` commits the words at the front of the new hypothesis that equal the front of the previous one
  (case, edge punctuation and spacing ignored) and returns them. The committed text is the newer spelling.
* ``finalize()`` commits everything still pending (end of turn) and returns it.
* ``trim_at(seconds)`` rolls the window forward. Pending words that end by ``seconds`` are committed first so a
  trim never loses a word; committed words before it leave the window and feed ``prompt()``. Without timestamps
  call it only after ``flush`` or ``finalize``; pending words are then dropped.
* ``suggest_trim(audio_end_s)`` is ``None`` while the window is within ``max_window_s`` (12 s), else the time to
  pass to ``trim_at`` (a word boundary when one is known).
* ``prompt()`` is the committed text that left the window, at most ``prompt_chars`` (200) characters, whole words
  (a single longer word is cut from its tail). Pass it to the model as the carry-over prompt.
* ``reset()`` starts a new turn.

``PartialStabiliser`` wraps a committer and says what a screen may show: ``committed`` (final), ``stable`` (words
the last two hypotheses agree on that sit after a disagreement, so they cannot be committed yet) and ``volatile``
(the rest); ``tail`` holds both in spoken order and ``text`` is committed plus tail. ``revision`` rises only
when what is shown changes, so a caller can skip a redundant repaint.
"""

from __future__ import annotations

import unicodedata
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from difflib import SequenceMatcher

MAX_WINDOW_S = 12.0
PROMPT_CHARS = 200
MAX_KEPT_WORDS = 2000
SEAM_NGRAM = 5


@dataclass(frozen=True)
class Word:
    text: str
    start: float | None = None
    end: float | None = None

    @property
    def key(self) -> str:
        return word_key(self.text)

    @property
    def stamp(self) -> float | None:
        """When the word is over (its end, else its start)."""
        return self.end if self.end is not None else self.start


WordLike = Word | str | tuple[str, float | None, float | None]


def word_key(text: str) -> str:
    """Comparison form: case-folded, edge punctuation removed. Apostrophes inside a word stay."""
    folded = unicodedata.normalize("NFKC", text).casefold().strip()
    start, stop = 0, len(folded)
    while start < stop and unicodedata.category(folded[start])[0] in "PS":
        start += 1
    while stop > start and unicodedata.category(folded[stop - 1])[0] in "PS":
        stop -= 1
    return folded[start:stop]


def to_words(items: Iterable[WordLike]) -> list[Word]:
    out: list[Word] = []
    for item in items:
        word = item if isinstance(item, Word) else Word(item) if isinstance(item, str) else Word(*item)
        if word.key:
            out.append(word)
    return out


def words_from_text(text: str) -> list[Word]:
    return to_words(text.split())


def join_words(words: Sequence[Word]) -> str:
    return " ".join(w.text for w in words)


class LocalAgreementCommitter:
    def __init__(
        self,
        *,
        max_window_s: float = MAX_WINDOW_S,
        prompt_chars: int = PROMPT_CHARS,
        time_tolerance_s: float = 0.1,
        max_kept_words: int = MAX_KEPT_WORDS,
    ) -> None:
        if max_window_s <= 0 or prompt_chars <= 0 or max_kept_words <= 0:
            raise ValueError("max_window_s, prompt_chars and max_kept_words must be positive")
        self.max_window_s = max_window_s
        self.prompt_chars = prompt_chars
        self.time_tolerance_s = time_tolerance_s
        self.max_kept_words = max_kept_words
        self.reset()

    def reset(self) -> None:
        self.window_start = 0.0
        self._all: list[Word] = []  # everything committed this turn, in order
        self._left = 0  # how many of _all have left the window
        self._previous: list[Word] = []  # pending words after the last flush
        self._new: list[Word] = []
        self._inserted = False

    @property
    def committed(self) -> tuple[Word, ...]:
        """Committed words still inside the window."""
        return tuple(self._all[self._left :])

    @property
    def all_committed(self) -> tuple[Word, ...]:
        return tuple(self._all)

    @property
    def pending(self) -> tuple[Word, ...]:
        """Words of the newest hypothesis that are not committed yet."""
        return tuple(self._previous)

    def _last_stamp(self) -> float | None:
        return self._all[-1].stamp if self._all else None

    def insert(self, hypothesis: Iterable[WordLike]) -> None:
        words = to_words(hypothesis)
        in_window = self._all[self._left :]
        last = self._last_stamp()
        if words and all(w.start is not None for w in words) and (not self._all or last is not None):
            if last is not None:
                floor = last - self.time_tolerance_s
                words = [w for w in words if w.start is not None and w.start >= floor]
                words = self._drop_seam_repeat(words)
        else:
            words = words[len(in_window) :]
        self._new = words
        self._inserted = True

    def _drop_seam_repeat(self, words: list[Word]) -> list[Word]:
        for size in range(min(SEAM_NGRAM, len(words), len(self._all)), 0, -1):
            if [w.key for w in self._all[-size:]] == [w.key for w in words[:size]]:
                return words[size:]
        return words

    def flush(self) -> list[Word]:
        agreed: list[Word] = []
        if not self._inserted:
            return agreed
        new, previous = self._new, self._previous
        while new and previous and new[0].key == previous[0].key:
            agreed.append(new[0])
            new, previous = new[1:], previous[1:]
        self._commit(agreed)
        self._previous = new
        self._new = []
        self._inserted = False
        return agreed

    def finalize(self) -> list[Word]:
        rest = self._new if self._inserted else self._previous
        self._previous, self._new, self._inserted = [], [], False
        self._commit(rest)
        return list(rest)

    def _commit(self, words: list[Word]) -> None:
        self._all.extend(words)
        overflow = len(self._all) - self.max_kept_words
        if overflow > 0:
            del self._all[:overflow]
            self._left = max(0, self._left - overflow)

    def trim_at(self, seconds: float) -> list[Word]:
        forced: list[Word] = []
        while self._previous:
            stamp = self._previous[0].stamp
            if stamp is None or stamp > seconds:
                break
            forced.append(self._previous.pop(0))
        self._commit(forced)
        if self._previous and self._previous[0].stamp is None:
            self._previous = []  # no timestamps: the next hypothesis starts from the new window
        self._new = []
        self._inserted = False
        while self._left < len(self._all):
            stamp = self._all[self._left].stamp
            if stamp is not None and stamp > seconds:
                break
            self._left += 1
        self.window_start = max(self.window_start, seconds)
        return forced

    def suggest_trim(self, audio_end_s: float) -> float | None:
        if audio_end_s - self.window_start <= self.max_window_s:
            return None
        floor = audio_end_s - self.max_window_s
        ends = [w.stamp for w in (*self._all[self._left :], *self._previous) if w.stamp is not None]
        later = [e for e in ends if e >= floor]
        return min(later) if later else floor

    def prompt(self) -> str:
        words = [w.text for w in self._all[: self._left]]
        picked: list[str] = []
        size = 0
        for text in reversed(words):
            extra = len(text) + (1 if picked else 0)
            if size + extra > self.prompt_chars:
                break
            picked.append(text)
            size += extra
        if not picked and words:
            return words[-1][-self.prompt_chars :]
        return " ".join(reversed(picked))


@dataclass(frozen=True)
class Partial:
    committed: tuple[Word, ...]
    stable: tuple[Word, ...]
    volatile: tuple[Word, ...]
    revision: int
    newly_committed: tuple[Word, ...] = ()
    tail: tuple[Word, ...] = ()  # stable and volatile words in spoken order

    @property
    def text(self) -> str:
        return join_words((*self.committed, *self.tail))


class PartialStabiliser:
    def __init__(self, committer: LocalAgreementCommitter | None = None) -> None:
        self.committer = committer or LocalAgreementCommitter()
        self.revision = 0
        self._shown: tuple[tuple[str, ...], tuple[str, ...], tuple[str, ...]] = ((), (), ())
        self._previous_tail: list[Word] = []

    def reset(self) -> None:
        self.committer.reset()
        self.revision = 0
        self._shown = ((), (), ())
        self._previous_tail = []

    def update(self, hypothesis: Iterable[WordLike]) -> Partial:
        self.committer.insert(hypothesis)
        newly = self.committer.flush()
        tail = list(self.committer.pending)
        earlier = self._previous_tail[len(newly) :]
        matcher = SequenceMatcher(a=[w.key for w in earlier], b=[w.key for w in tail], autojunk=False)
        agreed = {j for block in matcher.get_matching_blocks() for j in range(block.b, block.b + block.size)}
        stable = tuple(w for j, w in enumerate(tail) if j in agreed)
        volatile = tuple(w for j, w in enumerate(tail) if j not in agreed)
        self._previous_tail = tail
        return self._publish(stable, volatile, newly, tuple(tail))

    def finalize(self) -> Partial:
        newly = self.committer.finalize()
        self._previous_tail = []
        return self._publish((), (), newly, ())

    def trim_at(self, seconds: float) -> Partial:
        forced = self.committer.trim_at(seconds)
        self._previous_tail = list(self.committer.pending)
        tail = tuple(self._previous_tail)
        return self._publish((), tail, forced, tail)

    def _publish(
        self,
        stable: tuple[Word, ...],
        volatile: tuple[Word, ...],
        newly: Sequence[Word],
        tail: tuple[Word, ...],
    ) -> Partial:
        committed = self.committer.all_committed
        shown = (
            tuple(w.key for w in committed),
            tuple(w.key for w in stable),
            tuple(w.key for w in volatile),
        )
        if shown != self._shown:
            self.revision += 1
            self._shown = shown
        return Partial(committed, stable, volatile, self.revision, tuple(newly), tail)
