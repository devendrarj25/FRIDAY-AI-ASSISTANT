"""FRIDAY Ears: hotword biasing as an Aho-Corasick automaton over token ids (pure Python, no dependencies).

Interface contract
------------------
* Build once: ``trie = HotwordTrie(); trie.add_phrase([12, 7, 99]); trie.add_phrase(..., bonus=2.0)``.
* Use in a beam: keep one integer ``state`` per hypothesis (start at ``HotwordTrie.ROOT``). When the hypothesis
  appends a NON-blank token call ``state, delta = trie.step(state, token)`` and add ``delta`` to that hypothesis'
  bonus. Blank frames and repeated blanks never call ``step``. ``step`` returns the new state and the change in
  bonus; the bonus of a hypothesis is therefore the score of its current partial match.
* A partial match that breaks gives its bonus back (delta < 0), so a hotword that is not finished earns nothing.
  A finished phrase is banked: leaving its final state keeps the bonus.
* Insertion guard: the bonus per token is at most ``max_token_bonus`` and the bonus of a whole phrase is at most
  ``max_phrase_bonus`` however large a boost is asked for, so a boost can tip a close call but cannot invent
  words the audio does not support. A decoder ranks by acoustic score plus bonus, so a token the model gave
  almost no probability to still loses to the alternatives.
* At the end of an utterance call ``pending_bonus(state)`` and subtract it: a phrase left half-matched earns nothing.

The automaton is built lazily on the first ``step`` and rebuilt after ``add_phrase``.

``tokenize_phrase`` turns an owner's word into token ids by longest match over a SentencePiece-style vocabulary (a
word the vocabulary cannot spell gives ``[]``); ``trie_for_words`` builds the trie from such words, or None.
"""

from __future__ import annotations

from collections import deque
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field

DEFAULT_BONUS = 1.5
MAX_TOKEN_BONUS = 3.0
MAX_PHRASE_BONUS = 8.0


@dataclass
class _Node:
    depth: int = 0
    children: dict[int, int] = field(default_factory=dict)
    fail: int = 0
    per_token: float = 0.0  # best capped per-token bonus among phrases through this node
    terminal: bool = False
    score: float = 0.0  # bonus of the partial match this node stands for


class HotwordTrie:
    ROOT = 0

    def __init__(
        self,
        *,
        bonus: float = DEFAULT_BONUS,
        max_token_bonus: float = MAX_TOKEN_BONUS,
        max_phrase_bonus: float = MAX_PHRASE_BONUS,
    ) -> None:
        if max_token_bonus < 0 or max_phrase_bonus < 0:
            raise ValueError("bonus caps must be >= 0")
        self.bonus = bonus
        self.max_token_bonus = max_token_bonus
        self.max_phrase_bonus = max_phrase_bonus
        self._nodes: list[_Node] = [_Node()]
        self._phrases = 0
        self._built = True

    def __len__(self) -> int:
        return self._phrases

    def __bool__(self) -> bool:
        return self._phrases > 0

    def effective_bonus(self, length: int, bonus: float | None = None) -> float:
        """The per-token bonus a phrase of ``length`` tokens really gets after both caps (never negative)."""
        asked = self.bonus if bonus is None else bonus
        if length <= 0 or asked <= 0:
            return 0.0
        return min(asked, self.max_token_bonus, self.max_phrase_bonus / length)

    def add_phrase(self, tokens: Sequence[int], bonus: float | None = None) -> bool:
        """Add one phrase. An empty phrase or a non-positive bonus adds nothing and returns False."""
        ids = [int(t) for t in tokens]
        per_token = self.effective_bonus(len(ids), bonus)
        if not ids or per_token <= 0.0:
            return False
        node = self.ROOT
        for token in ids:
            nxt = self._nodes[node].children.get(token)
            if nxt is None:
                self._nodes.append(_Node(depth=self._nodes[node].depth + 1))
                nxt = len(self._nodes) - 1
                self._nodes[node].children[token] = nxt
            node = nxt
            self._nodes[node].per_token = max(self._nodes[node].per_token, per_token)
        self._nodes[node].terminal = True
        self._phrases += 1
        self._built = False
        return True

    def _build(self) -> None:
        nodes = self._nodes
        queue: deque[int] = deque()
        for child in nodes[self.ROOT].children.values():
            nodes[child].fail = self.ROOT
            queue.append(child)
        while queue:
            current = queue.popleft()
            for token, child in nodes[current].children.items():
                fallback = nodes[current].fail
                while fallback != self.ROOT and token not in nodes[fallback].children:
                    fallback = nodes[fallback].fail
                target = nodes[fallback].children.get(token, self.ROOT)
                nodes[child].fail = target if target != child else self.ROOT
                queue.append(child)
        for node in nodes:
            node.score = node.depth * node.per_token
        self._built = True

    def is_terminal(self, state: int) -> bool:
        return self._nodes[state].terminal

    def step(self, state: int, token: int) -> tuple[int, float]:
        """Advance by one emitted token. Returns ``(new_state, bonus_delta)``."""
        if not self._built:
            self._build()
        nodes = self._nodes
        cur = nodes[state]
        probe = state
        while probe != self.ROOT and token not in nodes[probe].children:
            probe = nodes[probe].fail
        nxt = nodes[probe].children.get(token, self.ROOT)
        # Leaving a finished phrase keeps what it earned; leaving a half match gives it back.
        base = 0.0 if (cur.terminal and nxt not in cur.children.values()) else cur.score
        return nxt, nodes[nxt].score - base

    def pending_bonus(self, state: int) -> float:
        """Bonus a hypothesis holds for a match that is still open in ``state`` (0 when finished or at the root)."""
        if not self._built:
            self._build()
        node = self._nodes[state]
        return 0.0 if node.terminal else node.score

    def sequence_bonus(self, tokens: Sequence[int]) -> float:
        """The total bonus a token sequence earns when run through ``step`` from the root (for tests and tools)."""
        state, total = self.ROOT, 0.0
        for token in tokens:
            state, delta = self.step(state, int(token))
            total += delta
        return total


# ---- from the owner's words to token ids --------------------------------------------------------------------------

WORD_MARK = "▁"  # the SentencePiece word-start mark


def tokenize_phrase(text: str, vocab: Mapping[str, int], word_mark: str = WORD_MARK) -> list[int]:
    """Token ids for ``text`` by greedy longest match over a SentencePiece-style vocabulary, or [] when a piece of a
    word has no token (a phrase the model cannot spell is skipped, never half-boosted)."""
    ids: list[int] = []
    for word in text.split():
        rest, first = word, True
        while rest:
            for size in range(len(rest), 0, -1):
                piece = (word_mark if first else "") + rest[:size]
                token = vocab.get(piece)
                if token is None and first and size == len(rest):
                    token = vocab.get(rest)  # a vocabulary without word marks
                if token is not None:
                    ids.append(int(token))
                    rest, first = rest[size:], False
                    break
            else:
                return []
    return ids


def trie_for_words(
    words: Sequence[str], vocab: Mapping[str, int], *, bonus: float | None = None, word_mark: str = WORD_MARK
) -> HotwordTrie | None:
    """A trie of every phrase the vocabulary can spell, or None when none can be (so a decoder skips biasing)."""
    trie = HotwordTrie() if bonus is None else HotwordTrie(bonus=bonus)
    for phrase in words:
        trie.add_phrase(tokenize_phrase(str(phrase).strip(), vocab, word_mark))
    return trie if trie else None
