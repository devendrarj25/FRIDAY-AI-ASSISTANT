"""FRIDAY Ears: a small glossary learned from lines the owner marked as corrected (local, reversible, no weights).

When the owner corrects what FRIDAY heard, the words the ear got wrong become hotwords (``stt.py`` passes them to
faster-whisper ``hotwords`` and the CTC/transducer ``hotword_trie`` bias) and a short ``initial_prompt`` line. Nothing
else changes: no model file, no cloud call, nothing learned unless the setting ``brain.learn.glossary`` is on
(default true), and every word can be taken back.

Interface contract
------------------
* A row is ``{"source": "owner", "corrected": True, "heard": str, "text": str}`` (``text`` is the owner's corrected
  line). Only such rows teach; ``corrected`` must be the boolean ``True`` and ``source`` must be ``"owner"``. A row
  with ``untrusted`` set, or whose ``source``/``origin``/``contextKinds`` name tool, web, screen, file, email,
  calendar, MCP or transcript content, never teaches: that text is data, never training.
* ``learn_from_corrections(rows, setting_on)`` learns the words of ``text`` that are not in ``heard`` and returns the
  glossary (most-seen first, then alphabetical). With the setting off it returns ``[]`` and writes nothing.
* A line or a word the kernel privacy classifier (``privacy.classify``, the only one) rates above public is dropped,
  and a word with a digit, a symbol or more than ``MAX_WORD_CHARS`` letters is not a word (keys and numbers).
  Hindi (Devanagari with its marks), Roman and mixed Hinglish words are kept as spoken.
* ``glossary_terms``/``prompt_hint`` are the read side for the ears; ``forget(term)`` and ``forget_all()`` are undo
  (a forgotten word is not learned again). The file is ``<FRIDAY_ROOT>/glossary/learned.json``, written atomically.
"""

from __future__ import annotations

import json
import os
import threading
import unicodedata
from collections.abc import Iterable
from pathlib import Path
from typing import Any

import privacy

FILE_VERSION = 1
MAX_TERMS = 200
DEFAULT_LIMIT = 40
MAX_BLOCKED = 500
MAX_ROWS = 500
MAX_WORDS_PER_ROW = 12
MIN_WORD_CHARS = 2
MAX_WORD_CHARS = 24
PROMPT_LIMIT = 160

UNTRUSTED_KINDS = frozenset({"tool", "web", "screen", "file", "email", "calendar", "mcp", "transcript"})

_LOCK = threading.Lock()


def glossary_path(root: Path | str | None = None) -> Path:
    base = Path(root) if root else (Path(os.environ.get("FRIDAY_ROOT", "").strip() or Path.home() / ".friday"))
    return base / "glossary" / "learned.json"


# ---- the stored shape ---------------------------------------------------------------------------------------------


def _empty() -> dict[str, Any]:
    return {"v": FILE_VERSION, "seq": 0, "terms": [], "blocked": []}


def _load(path: Path) -> dict[str, Any]:
    """The stored glossary, or an empty one when the file is missing or broken (a bad file never raises)."""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return _empty()
    if not isinstance(raw, dict) or raw.get("v") != FILE_VERSION:
        return _empty()
    terms: list[dict[str, Any]] = []
    for item in raw.get("terms") or []:
        if isinstance(item, dict) and isinstance(item.get("term"), str) and item["term"]:
            terms.append(
                {
                    "term": item["term"],
                    "count": int(item["count"]) if isinstance(item.get("count"), int) else 1,
                    "seq": int(item["seq"]) if isinstance(item.get("seq"), int) else 0,
                }
            )
    blocked = [b for b in (raw.get("blocked") or []) if isinstance(b, str) and b]
    seq = raw.get("seq")
    return {
        "v": FILE_VERSION,
        "seq": seq if isinstance(seq, int) else max((t["seq"] for t in terms), default=0),
        "terms": terms,
        "blocked": blocked,
    }


def _save(path: Path, store: dict[str, Any]) -> None:
    """Write through a temp file in the same folder, then replace: a crash leaves the old file or the new one."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(store, handle, ensure_ascii=False, indent=1)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def _ordered(store: dict[str, Any]) -> list[str]:
    ranked = sorted(store["terms"], key=lambda t: (-t["count"], t["term"].casefold(), t["term"]))
    return [t["term"] for t in ranked]


# ---- from a corrected line to words -------------------------------------------------------------------------------


def _is_letter_or_mark(ch: str) -> bool:
    return unicodedata.category(ch)[0] in ("L", "M")


def _clean_word(raw: str) -> str:
    """One word as spoken, or "" when it is not a plain word (digits, symbols, a key-like or overlong string)."""
    word = unicodedata.normalize("NFC", raw)
    start, end = 0, len(word)
    while start < end and not _is_letter_or_mark(word[start]):
        start += 1
    while end > start and not _is_letter_or_mark(word[end - 1]):
        end -= 1
    word = word[start:end]
    if not (MIN_WORD_CHARS <= len(word) <= MAX_WORD_CHARS):
        return ""
    for ch in word:
        if not (_is_letter_or_mark(ch) or ch in "'’-‌‍"):
            return ""
    return word


def _public(text: str) -> bool:
    try:
        return privacy.classify(text).get("level") == "public"
    except Exception:  # noqa: BLE001 — a classifier that fails closes the gate: nothing is learned
        return False


def _trusted(row: Any) -> bool:
    if not isinstance(row, dict):
        return False
    if row.get("corrected") is not True or row.get("source") != "owner" or row.get("untrusted"):
        return False
    origin = row.get("origin")
    if isinstance(origin, str) and origin.strip().lower() in UNTRUSTED_KINDS:
        return False
    kinds = row.get("contextKinds")
    if isinstance(kinds, (list, tuple, set, frozenset)):
        if any(str(kind).strip().lower() in UNTRUSTED_KINDS for kind in kinds):
            return False
    return isinstance(row.get("heard"), str) and isinstance(row.get("text"), str)


def _new_words(row: dict[str, Any]) -> list[str]:
    """The words of the corrected line that the ear did not hear, in order, without repeats."""
    text = row["text"]
    if not text.strip() or not _public(text):
        return []
    heard = {w.casefold() for w in (_clean_word(p) for p in unicodedata.normalize("NFC", row["heard"]).split()) if w}
    words: list[str] = []
    seen: set[str] = set()
    for part in text.split():
        word = _clean_word(part)
        key = word.casefold()
        if not word or key in heard or key in seen:
            continue
        seen.add(key)
        if _public(word):
            words.append(word)
        if len(words) >= MAX_WORDS_PER_ROW:
            break
    return words


# ---- the public API -----------------------------------------------------------------------------------------------


def learn_from_corrections(
    rows: Iterable[Any],
    setting_on: bool,
    *,
    root: Path | str | None = None,
    max_terms: int = MAX_TERMS,
    limit: int = DEFAULT_LIMIT,
) -> list[str]:
    """Learn from the owner's corrected rows; return the glossary (``limit`` words at most). Off: ``[]``, no write."""
    if not setting_on:
        return []
    path = glossary_path(root)
    cap = max(1, int(max_terms))
    with _LOCK:
        store = _load(path)
        blocked = {b.casefold() for b in store["blocked"]}
        by_key = {t["term"].casefold(): t for t in store["terms"]}
        changed = False
        for index, row in enumerate(rows):
            if index >= MAX_ROWS:
                break
            if not _trusted(row):
                continue
            for word in _new_words(row):
                key = word.casefold()
                if key in blocked:
                    continue
                store["seq"] += 1
                entry = by_key.get(key)
                if entry is None:
                    entry = {"term": word, "count": 0, "seq": 0}
                    by_key[key] = entry
                    store["terms"].append(entry)
                entry["count"] += 1
                entry["seq"] = store["seq"]
                changed = True
        if len(store["terms"]) > cap:
            keep = sorted(store["terms"], key=lambda t: (-t["count"], -t["seq"], t["term"].casefold()))[:cap]
            store["terms"] = keep
            changed = True
        if changed:
            _save(path, store)
        return _ordered(store)[: max(0, int(limit))]


def glossary_terms(setting_on: bool, *, root: Path | str | None = None, limit: int = DEFAULT_LIMIT) -> list[str]:
    """The learned words for the ears (most-seen first); ``[]`` when the setting is off."""
    if not setting_on:
        return []
    with _LOCK:
        return _ordered(_load(glossary_path(root)))[: max(0, int(limit))]


def prompt_hint(setting_on: bool, *, root: Path | str | None = None, limit: int = PROMPT_LIMIT) -> str:
    """The learned words as one short ``initial_prompt`` line cut at a whole word, or "" (off or nothing learned)."""
    parts: list[str] = []
    size = 0
    for term in glossary_terms(setting_on, root=root, limit=MAX_TERMS):
        size += len(term) + (2 if parts else 0)
        if size > limit:
            break
        parts.append(term)
    return ", ".join(parts)


def forget(term: str, *, root: Path | str | None = None) -> bool:
    """Take one word back. It is not learned again. True when the word was in the glossary."""
    key = unicodedata.normalize("NFC", str(term or "")).strip().casefold()
    if not key:
        return False
    path = glossary_path(root)
    with _LOCK:
        store = _load(path)
        kept = [t for t in store["terms"] if t["term"].casefold() != key]
        found = len(kept) != len(store["terms"])
        store["terms"] = kept
        if key not in {b.casefold() for b in store["blocked"]}:
            store["blocked"] = [*store["blocked"], key][-MAX_BLOCKED:]
        _save(path, store)
        return found


def forget_all(*, root: Path | str | None = None) -> int:
    """Empty the glossary (the words are not learned again). Returns how many words were removed."""
    path = glossary_path(root)
    with _LOCK:
        store = _load(path)
        removed = len(store["terms"])
        known = {b.casefold() for b in store["blocked"]}
        fresh = [t["term"].casefold() for t in store["terms"] if t["term"].casefold() not in known]
        store["blocked"] = [*store["blocked"], *fresh][-MAX_BLOCKED:]
        store["terms"] = []
        if removed or fresh:
            _save(path, store)
        return removed
