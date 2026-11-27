"""FRIDAY Ears: contextual biasing graph with backoff (Aho-Corasick over token ids, pure Python, no dependencies).

Interface contract
------------------
* Build once: ``graph = ContextGraph(); graph.add_phrase([12, 7, 99], boost=2.0, label="Friday")``. A phrase is a list
  of token ids; ``boost`` is the bonus per token (``None`` takes the graph default). Every phrase has its own boost.
* Use in a beam, the same way as ``hotword_trie.HotwordTrie`` (both satisfy ``TokenBias``): keep one integer
  ``state`` per hypothesis (start at ``ContextGraph.ROOT``). When the hypothesis appends a NON-blank token call
  ``state, delta = graph.step(state, token)`` and add ``delta`` to its bonus. Blank frames never call ``step``.
  At the end of the utterance subtract ``graph.pending_bonus(state)``: a phrase left half-matched earns nothing.
* Backoff without leaks: on a mismatch the state falls back along the failure links to the longest suffix that still
  matches, and the credit for the half-matched part is given back, but a phrase that was already completed on the
  way keeps its bonus (a short hotword inside a longer, failed one is not lost). The bonus of a hypothesis is always
  the credit of the phrases it finished plus the credit of its current partial match.
* ``partial_weight`` (0..1, default 1) scales the credit of an unfinished phrase, like a partial-word score: lower it
  to make a started hotword worth less until it completes. A finished phrase always earns its full boost.
* Fuzzy hotwords: ``confusions`` maps a token id to look-alike ids (for example a Devanagari piece and its Latin
  spelling). Each phrase also gets variants with ONE token swapped for a look-alike, at ``fuzzy_weight`` of its
  boost, so a near-miss spelling is still helped but less than the exact one.
* Insertion guard: the bonus per token is at most ``max_token_boost`` and the bonus of a whole phrase at most
  ``max_phrase_boost``, however large a boost is asked for, so a boost can tip a close call but cannot invent a word
  the audio does not support (a decoder ranks by acoustic score plus bonus).
* ``scan(tokens)`` reports which phrases a finished token sequence contains and where (token spans).

The automaton is built lazily on the first ``step`` and rebuilt after ``add_phrase``. No import side effects.
"""

from __future__ import annotations

from collections import deque
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Protocol

from hotword_trie import WORD_MARK, tokenize_phrase

DEFAULT_BOOST = 1.5
MAX_TOKEN_BOOST = 3.0
MAX_PHRASE_BOOST = 8.0
DEFAULT_FUZZY_WEIGHT = 0.5
MAX_VARIANTS = 64


class TokenBias(Protocol):
    """What the CTC beam needs from a biasing structure: ``ContextGraph`` and ``HotwordTrie`` both fit."""

    @property
    def ROOT(self) -> int: ...

    def step(self, state: int, token: int) -> tuple[int, float]: ...

    def pending_bonus(self, state: int) -> float: ...


@dataclass(frozen=True)
class ContextMatch:
    label: str
    start: int  # first token of the phrase in the scanned sequence
    end: int  # one past its last token


@dataclass
class _Node:
    parent: int = 0
    depth: int = 0
    children: dict[int, int] = field(default_factory=dict)
    fail: int = 0
    output: int = -1  # nearest finished phrase along the failure links, -1 for none
    edge: float = 0.0  # best capped per-token boost of the phrases through this edge
    cap: float = 0.0  # best capped whole-phrase boost of the phrases through this node
    terminal: bool = False
    label: str = ""
    label_boost: float = 0.0
    acc: float = 0.0  # credit of the exact match that ends here
    bank: float = 0.0  # credit of the longest finished phrase on the path to here (acc when terminal)
    score: float = 0.0  # credit a hypothesis holds in this state, finished parts included


class ContextGraph:
    ROOT = 0

    def __init__(
        self,
        *,
        boost: float = DEFAULT_BOOST,
        max_token_boost: float = MAX_TOKEN_BOOST,
        max_phrase_boost: float = MAX_PHRASE_BOOST,
        partial_weight: float = 1.0,
        fuzzy_weight: float = DEFAULT_FUZZY_WEIGHT,
        confusions: Mapping[int, Sequence[int]] | None = None,
        max_variants: int = MAX_VARIANTS,
    ) -> None:
        if max_token_boost < 0 or max_phrase_boost < 0:
            raise ValueError("boost caps must be >= 0")
        if not 0.0 <= partial_weight <= 1.0 or not 0.0 <= fuzzy_weight <= 1.0:
            raise ValueError("partial_weight and fuzzy_weight must be between 0 and 1")
        self.boost = boost
        self.max_token_boost = max_token_boost
        self.max_phrase_boost = max_phrase_boost
        self.partial_weight = partial_weight
        self.fuzzy_weight = fuzzy_weight
        self.max_variants = max(0, max_variants)
        self._confusions: dict[int, tuple[int, ...]] = {
            int(k): tuple(int(v) for v in vs if int(v) != int(k)) for k, vs in (confusions or {}).items()
        }
        self._nodes: list[_Node] = [_Node()]
        self._phrases = 0
        self._built = True

    def __len__(self) -> int:
        return self._phrases

    def __bool__(self) -> bool:
        return self._phrases > 0

    def effective_boost(self, length: int, boost: float | None = None) -> float:
        """The per-token boost a phrase of ``length`` tokens really gets after both caps (never negative)."""
        asked = self.boost if boost is None else boost
        if length <= 0 or asked <= 0:
            return 0.0
        return min(asked, self.max_token_boost, self.max_phrase_boost / length)

    def add_phrase(
        self, tokens: Sequence[int], boost: float | None = None, label: str | None = None, *, fuzzy: bool = True
    ) -> bool:
        """Add one phrase (and its look-alike variants). An empty phrase or a non-positive boost adds nothing."""
        ids = [int(t) for t in tokens]
        per_token = self.effective_boost(len(ids), boost)
        if not ids or per_token <= 0.0:
            return False
        name = label if label is not None else "-".join(str(t) for t in ids)
        self._insert(ids, per_token, name)
        if fuzzy and self._confusions and self.fuzzy_weight > 0.0:
            for variant in self._variants(ids):
                self._insert(variant, per_token * self.fuzzy_weight, name)
        self._phrases += 1
        self._built = False
        return True

    def _variants(self, ids: list[int]) -> list[list[int]]:
        out: list[list[int]] = []
        for position, token in enumerate(ids):
            for alt in self._confusions.get(token, ()):
                if len(out) >= self.max_variants:
                    return out
                out.append(ids[:position] + [alt] + ids[position + 1 :])
        return out

    def _insert(self, ids: list[int], per_token: float, label: str) -> None:
        nodes = self._nodes
        node = self.ROOT
        total = per_token * len(ids)
        for token in ids:
            nxt = nodes[node].children.get(token)
            if nxt is None:
                nodes.append(_Node(parent=node, depth=nodes[node].depth + 1))
                nxt = len(nodes) - 1
                nodes[node].children[token] = nxt
            node = nxt
            nodes[node].edge = max(nodes[node].edge, per_token)
            nodes[node].cap = max(nodes[node].cap, total)
        end = nodes[node]
        end.terminal = True
        if per_token >= end.label_boost:
            end.label, end.label_boost = label, per_token

    def _build(self) -> None:
        nodes = self._nodes
        order: list[int] = []
        queue: deque[int] = deque()
        for child in nodes[self.ROOT].children.values():
            nodes[child].fail = self.ROOT
            queue.append(child)
        while queue:
            current = queue.popleft()
            order.append(current)
            for token, child in nodes[current].children.items():
                fallback = nodes[current].fail
                while fallback != self.ROOT and token not in nodes[fallback].children:
                    fallback = nodes[fallback].fail
                target = nodes[fallback].children.get(token, self.ROOT)
                nodes[child].fail = target if target != child else self.ROOT
                queue.append(child)
        for index in order:  # shallow before deep, so a parent and a failure target are always ready
            node = nodes[index]
            parent = nodes[node.parent]
            node.acc = max(parent.acc, min(parent.acc + node.edge, node.cap))
            node.bank = node.acc if node.terminal else parent.bank
            node.score = node.acc if node.terminal else max(node.bank, self.partial_weight * node.acc)
            target = nodes[node.fail]
            node.output = node.fail if target.terminal else target.output
        self._built = True

    def is_terminal(self, state: int) -> bool:
        if not self._built:
            self._build()
        return self._nodes[state].terminal

    def step(self, state: int, token: int) -> tuple[int, float]:
        """Advance by one emitted token. Returns ``(new_state, bonus_delta)``."""
        if not self._built:
            self._build()
        nodes = self._nodes
        cur = nodes[state]
        child = cur.children.get(token)
        if child is not None:
            return child, nodes[child].score - cur.score
        if state == self.ROOT:
            return self.ROOT, 0.0
        probe = cur.fail
        while probe != self.ROOT and token not in nodes[probe].children:
            probe = nodes[probe].fail
        nxt = nodes[probe].children.get(token, self.ROOT)
        # Backoff: hand back the unfinished part, keep the finished phrases (``bank``), start from the new suffix.
        return nxt, cur.bank + nodes[nxt].score - cur.score

    def pending_bonus(self, state: int) -> float:
        """Credit a hypothesis holds for a match still open in ``state`` (0 when finished or at the root)."""
        if not self._built:
            self._build()
        node = self._nodes[state]
        return node.score - node.bank

    def sequence_bonus(self, tokens: Sequence[int], *, finish: bool = False) -> float:
        """The total bonus a token sequence earns through ``step`` from the root (``finish`` drops an open match)."""
        state, total = self.ROOT, 0.0
        for token in tokens:
            state, delta = self.step(state, int(token))
            total += delta
        return total - self.pending_bonus(state) if finish else total

    def scan(self, tokens: Sequence[int]) -> list[ContextMatch]:
        """Every phrase (look-alike variants report their phrase's label) that ``tokens`` contains, in order."""
        if not self._built:
            self._build()
        nodes = self._nodes
        found: list[ContextMatch] = []
        state = self.ROOT
        for index, token in enumerate(tokens):
            state, _ = self.step(state, int(token))
            node = state if nodes[state].terminal else nodes[state].output
            while node > self.ROOT:
                found.append(ContextMatch(nodes[node].label, index + 1 - nodes[node].depth, index + 1))
                node = nodes[node].output
        return found


def graph_for_words(
    words: Sequence[str | tuple[str, float]],
    vocab: Mapping[str, int],
    *,
    boost: float | None = None,
    word_mark: str = WORD_MARK,
    confusions: Mapping[int, Sequence[int]] | None = None,
    partial_weight: float = 1.0,
) -> ContextGraph | None:
    """A graph of every phrase the vocabulary can spell, or None when none can be (so a decoder skips biasing).

    An entry is a word, or ``(word, boost)`` for a boost of its own."""
    graph = ContextGraph(partial_weight=partial_weight, confusions=confusions)
    for entry in words:
        text, own = (entry, None) if isinstance(entry, str) else (entry[0], entry[1])
        phrase = str(text).strip()
        graph.add_phrase(tokenize_phrase(phrase, vocab, word_mark), own if own is not None else boost, phrase)
    return graph if graph else None
