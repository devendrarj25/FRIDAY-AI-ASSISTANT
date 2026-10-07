"""FRIDAY · privacy / data-egress authority inside the kernel.

The desktop already owns the privacy decision (``electron/privacy-firewall.cjs``).
This module is NOT a second authority: it is the same two-tier rule set, mirrored
in Python, so that every request that leaves the kernel — chat, planner, agent,
companion/phone, skill-forge ``chat.complete`` — passes the identical final check
before any HTTP call is made.

TWO TIERS (deliberate, same as the desktop):

  1. SENSITIVE — credentials, named passwords/secrets, PIN/passcode/OTP,
     financial or identity numbers. Always ask. No remembered grant.
  2. EVERYTHING ELSE to a provider the owner already connected — sent
     automatically. Local inference is never gated.

Pure logic only (no I/O, no httpx) so it can be unit tested on its own.
"""

from __future__ import annotations

import json
import re
from typing import Any

LEVELS = ("sensitive", "private", "internal", "public")
SENSITIVE = "sensitive"

# Same signals, same order, as electron/privacy-firewall.cjs.
SIGNALS: tuple[dict[str, Any], ...] = (
    {
        "level": "sensitive",
        "label": "credential or key material",
        "re": re.compile(
            r"\b(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|"
            r"AIza[0-9A-Za-z_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)"
        ),
    },
    {
        "level": "sensitive",
        "label": "password or secret named in the text",
        "re": re.compile(
            r"\b(password|passwd|secret|api[ _-]?key|access[ _-]?token|private key|seed phrase)\b"
            r"(?:\s*[:=]\s*|\s+is\s+|\s+(?=\S*\d))\S+",
            re.I,
        ),
    },
    {
        "level": "sensitive",
        "label": "PIN, passcode or one-time code named in the text",
        "re": re.compile(
            r"\b(?:(?:my|the)\s+)?(pin|passcode|otp|one[ -]?time(?:\s+(?:code|password|passcode))?|cvv|cvc)\b"
            r"(?:\s*(?:is|:|=)\s*|\s+(?=\d{4,}))\S+",
            re.I,
        ),
    },
    {
        "level": "sensitive",
        "label": "financial or identity number",
        "re": re.compile(
            r"\b(?:\d[ -]?){13,19}\b|\b(aadhaar|pan card|passport|ssn|social security)\b",
            re.I,
        ),
    },
    {
        "level": "sensitive",
        "label": "business ledger or bank-account figures",
        "re": re.compile(
            r"\bFRIDAY_LEDGER\b|\b(IFSC|IBAN)\b[-\s:]*[A-Z0-9]{6,}|"
            r"\b(account (number|no\.?)|a/c)\s*[:#]?\s*\d{8,}",
            re.I,
        ),
    },
    {
        "level": "private",
        "label": "a personal contact detail",
        "re": re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b|\b\+?\d{1,3}[ -]?\d{5}[ -]?\d{5}\b"),
    },
    {
        "level": "private",
        "label": "a path or file from this PC",
        "re": re.compile(r"\b[A-Za-z]:\\[^\s\"']+|(?:^|\s)/(?:home|users|mnt|etc)/[^\s\"']+", re.I),
    },
    {
        "level": "internal",
        "label": "FRIDAY's own source or configuration",
        "re": re.compile(
            r"\b(electron/|src/lib/friday|kernel/|package\.json|\.env\b|FRIDAY_ROOT)\b", re.I
        ),
    },
    {
        "level": "internal",
        "label": "machine or network detail",
        "re": re.compile(
            r"\b(hostname|localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|process\.env)\b",
            re.I,
        ),
    },
)

# Mirrors electron/billing-firewall.cjs LOCAL_KINDS used by the JS firewall.
LOCAL_KINDS = {
    "local",
    "ollama",
    "llama.cpp",
    "llamacpp",
    "lmstudio",
    "vllm",
    "localai",
    "jan",
    "mlx",
}


class PrivacyBlocked(RuntimeError):
    """Raised at the provider boundary when data may not leave this PC."""


def _safe_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value)
    except Exception:  # noqa: BLE001 — classifier must never throw
        return ""


def classify(content: Any) -> dict[str, Any]:
    text = content if isinstance(content, str) else _safe_text(content)
    if not str(text).strip():
        return {"level": "public", "reasons": [], "sample": 0}
    reasons: list[str] = []
    rank = LEVELS.index("public")
    for signal in SIGNALS:
        if not signal["re"].search(text):
            continue
        reasons.append(signal["label"])
        rank = min(rank, LEVELS.index(signal["level"]))
    return {"level": LEVELS[rank], "reasons": reasons, "sample": len(text)}


def is_local_kind(model: Any) -> bool:
    options = getattr(model, "options", None)
    if not isinstance(options, dict):
        options = model if isinstance(model, dict) else {}
    kind = str(
        options.get("type")
        or getattr(model, "type", "")
        or getattr(model, "kind", "")
        or (model.get("type") if isinstance(model, dict) else "")
        or ""
    ).lower()
    return kind in LOCAL_KINDS


def user_content(messages: Any) -> str:
    """Owner-authored turns only — system persona is not classified."""
    if isinstance(messages, str):
        return messages
    if not isinstance(messages, list):
        return _safe_text(messages)
    parts: list[str] = []
    for item in messages:
        if not isinstance(item, dict):
            continue
        if str(item.get("role") or "") == "system":
            continue
        parts.append(_safe_text(item.get("content")))
    return "\n".join(parts)


def auto_sendable(*, level: str, connected: bool, external: bool) -> bool:
    return bool(external) and level != SENSITIVE and bool(connected)


def guard_egress(
    model: Any = None,
    content: Any = "",
    destination: str | None = None,
    connected: bool = False,
) -> dict[str, Any]:
    external = (not is_local_kind(model)) or bool(destination)
    classification = classify(content)
    if not external:
        return {
            "external": False,
            "requiresConfirmation": False,
            "autoAllowed": True,
            "classification": classification,
            "reason": "runs locally on this PC — nothing leaves the machine",
        }
    auto = auto_sendable(level=classification["level"], connected=connected, external=external)
    where = destination or getattr(model, "label", None) or getattr(model, "id", None)
    if not where and isinstance(model, dict):
        where = model.get("label") or model.get("id")
    where = where or "an external service"
    reasons = classification["reasons"]
    return {
        "external": True,
        "requiresConfirmation": not auto,
        "autoAllowed": auto,
        "classification": classification,
        "reason": (
            f"{classification['level'].upper()} content to {where}, a provider you already connected — sent automatically"
            if auto
            else (
                f"SENSITIVE content ({'; '.join(reasons) or 'credential-like'}) would be sent to {where}"
                if classification["level"] == SENSITIVE
                else f"data would be sent to {where}, which is not a provider you have connected"
            )
        ),
    }


def describe_block(decision: dict[str, Any], model: Any = None) -> str:
    reason = decision.get("reason")
    if reason:
        return str(reason)
    where = getattr(model, "label", None) or getattr(model, "id", None) or "an external service"
    return f"This data was not sent to {where}."
