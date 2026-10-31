"""Untrusted text, cut down before a model reads it.

A tool the model calls can bring back text somebody else wrote: a file, a spreadsheet cell, a page, a transcript.
Some of it will be written to look like an order to the assistant. This cuts the sentences that read as orders
to an AI (the patterns are in ``config/quarantine-rules.json``, shared with the desktop's reader so the two
cannot drift), counts what it cut, and leaves everything else as it was. It runs on a tool result on its way
to the model, in one place (``Tools.execute_for_model``), so every model wire gets it. The original result is
unchanged on disk and in the audit record; only the copy the model sees is cleaned.

It lowers a risk and does not remove it: the approval gate and the argument policy still stand behind it.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

_RULES_PATH = Path(__file__).resolve().parents[1] / "config" / "quarantine-rules.json"
MIN_LENGTH = 24  # a short value (a name, a number) is never an instruction


def _load() -> tuple[list[re.Pattern[str]], str]:
    try:
        rules = json.loads(_RULES_PATH.read_text(encoding="utf-8"))
        flags = re.IGNORECASE if "i" in str(rules.get("flags", "")) else 0
        return [re.compile(p, flags) for p in rules["orders"]], str(rules["removedLine"])
    except (OSError, ValueError, KeyError, re.error):
        # Fail closed: without the rules, nothing is passed through as plain data without a label.
        return [], "[the order-detection rules could not be loaded]"


ORDERS, REMOVED = _load()
RULES_LOADED = bool(ORDERS)


def _pieces(text: str) -> list[str]:
    return [p for p in re.split(r"(?<=[.!?])\s+|\n+", text) if p.strip()]


def clean_text(text: str) -> tuple[str, int]:
    """(text with order-like sentences replaced by one marker, how many were cut)."""
    if len(text) < MIN_LENGTH:
        return text, 0
    kept: list[str] = []
    cut = 0
    for piece in _pieces(text):
        if any(rule.search(piece) for rule in ORDERS):
            cut += 1
            if cut == 1:
                kept.append(REMOVED)
            continue
        kept.append(piece)
    return (" ".join(kept) if cut else text), cut


def clean_value(value: Any) -> tuple[Any, int]:
    """Walk a JSON-like result and clean every long string in it."""
    if isinstance(value, str):
        return clean_text(value)
    if isinstance(value, list):
        total = 0
        out = []
        for item in value:
            cleaned, n = clean_value(item)
            out.append(cleaned)
            total += n
        return out, total
    if isinstance(value, dict):
        total = 0
        result = {}
        for key, item in value.items():
            cleaned, n = clean_value(item)
            result[key] = cleaned
            total += n
        return result, total
    return value, 0


def for_model(result: dict) -> dict:
    """The copy of a tool result a model may read: labelled as data, with order-like lines cut."""
    cleaned, cut = clean_value(result)
    if not isinstance(cleaned, dict):
        return result
    cleaned["_untrusted_data"] = True
    if cut:
        cleaned["_lines_removed"] = cut
    return cleaned
