"""Numbered click overlay built from one UI Automation perception. Pure data: nothing here calls Windows or clicks.

Auto mode only. The overlay lists at most 30 safe controls so a spoken "click 3" can name one of them. A click is
never made from here: the caller re-finds the control in a fresh tree (``control.invoke_pattern``), which is an exec
risk and goes through the owner's approval dial. The screen text is data, never instructions. UAC, the secure
desktop, a credential prompt, a captcha, a payment and a password field are never listed. How this looks on a real
Windows desktop (UIA tree, DPI, several monitors) is UNVERIFIED.
"""

from __future__ import annotations

import re
from typing import Any

from uia_tree import prefer_pattern

MAX_TARGETS = 30
TTL_MS = 15_000
NAME_CHARS = 40
ROW_TOLERANCE = 8.0

_INTENT = {"Invoke": "click", "Toggle": "toggle", "SelectionItem": "select", "ExpandCollapse": "expand"}
_SECRET_NAME = re.compile(
    r"card\s*number|credit\s*card|\bcvv\b|\bcvc\b|security\s*code|\bpin\b|\botp\b|one[\s-]*time|pay\s*now"
    r"|place\s*(?:your\s*)?order|pass(?:word|code)|captcha",
    re.I,
)
_LONG_NUMBER = re.compile(r"\d{6,}")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]+")
_SPACES = re.compile(r"\s+")

_NOUN = {
    "en": {"click": "button", "toggle": "checkbox", "select": "item", "expand": "dropdown"},
    "hi": {"click": "बटन", "toggle": "चेकबॉक्स", "select": "आइटम", "expand": "ड्रॉपडाउन"},
}


def _refused(reason: str, now_ms: int, ttl_ms: int, handoff: str | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {
        "ok": False,
        "reason": reason,
        "freshAt": int(now_ms),
        "expiresAt": int(now_ms) + ttl_ms,
        "targets": [],
    }
    if handoff:
        out["handoff"] = handoff
    return out


def _scrub(name: Any) -> str:
    text = _SPACES.sub(" ", _CONTROL.sub(" ", str(name or ""))).strip()
    return _LONG_NUMBER.sub("[number]", text)[:NAME_CHARS].rstrip()


def _offer(control: dict[str, Any]) -> str | None:
    """The intent a control may be numbered for, or None when it must not be offered."""
    if str(control.get("role") or "") == "password":
        return None
    if _SECRET_NAME.search(str(control.get("name") or "")):
        return None
    choice = prefer_pattern(control, "click")  # disabled, offscreen and handoff roles never get a pattern
    if choice["via"] != "pattern":
        return None
    return _INTENT.get(choice["pattern"])


def _ordered(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Top to bottom in rows (8 px tolerance), left to right inside a row; equal input gives equal order."""
    rows = sorted(rows, key=lambda r: (r["bounds"]["y"], r["bounds"]["x"], r["selector"]))
    out: list[dict[str, Any]] = []
    row: list[dict[str, Any]] = []
    anchor = 0.0
    for item in rows:
        y = item["bounds"]["y"]
        if row and y - anchor > ROW_TOLERANCE:
            out.extend(sorted(row, key=lambda r: (r["bounds"]["x"], r["selector"])))
            row = []
        if not row:
            anchor = y
        row.append(item)
    out.extend(sorted(row, key=lambda r: (r["bounds"]["x"], r["selector"])))
    return out


def build_overlay(
    perception: dict[str, Any] | None,
    now_ms: int,
    auto_mode: bool,
    limit: int = MAX_TARGETS,
    ttl_ms: int = TTL_MS,
) -> dict[str, Any]:
    if not auto_mode:
        return _refused("auto-mode-only", now_ms, ttl_ms)
    if not isinstance(perception, dict) or perception.get("ok") is not True:
        return _refused("no-perception", now_ms, ttl_ms)
    if perception.get("handoff"):
        return _refused("handoff", now_ms, ttl_ms, str(perception["handoff"]))
    cap = max(0, min(int(limit), MAX_TARGETS))
    windows = [w for w in perception.get("windows") or [] if isinstance(w, dict)]
    windows.sort(key=lambda w: 0 if w.get("focused") else 1)  # stable: the rest keep their order
    fresh = perception.get("freshAt")
    fresh_at = int(fresh) if isinstance(fresh, (int, float)) and not isinstance(fresh, bool) else int(now_ms)
    targets: list[dict[str, Any]] = []
    for win in windows:
        rows: list[dict[str, Any]] = []
        for control in win.get("controls") or []:
            if not isinstance(control, dict):
                continue
            intent = _offer(control)
            if intent is None:
                continue
            raw_bounds = control.get("bounds")
            bounds: dict[str, Any] = raw_bounds if isinstance(raw_bounds, dict) else {}
            rows.append(
                {
                    "selector": str(control.get("selector") or control.get("id") or ""),
                    "name": _scrub(control.get("name")),
                    "role": str(control.get("role") or "button"),
                    "bounds": {k: float(bounds.get(k) or 0) for k in ("x", "y", "w", "h")},
                    "intent": intent,
                    "window": str(win.get("id") or ""),
                }
            )
        for item in _ordered(rows):
            if len(targets) >= cap:
                break
            targets.append({"n": len(targets) + 1, **item})
    return {"ok": True, "freshAt": fresh_at, "expiresAt": fresh_at + ttl_ms, "ttlMs": ttl_ms, "targets": targets}


def resolve_target(
    overlay: dict[str, Any] | None,
    n: Any,
    now_ms: int,
    focused_window: str | None = None,
) -> dict[str, Any]:
    """Look a spoken number up. Never returns a target from an expired overlay or a window that lost focus."""
    if not isinstance(overlay, dict) or overlay.get("ok") is not True:
        return {"via": "missing"}
    if int(now_ms) > int(overlay.get("expiresAt") or 0):
        return {"via": "expired"}  # the caller must collect a fresh tree, never click a stale number
    if isinstance(n, bool) or not isinstance(n, int):
        return {"via": "missing"}
    target = next((t for t in overlay.get("targets") or [] if t.get("n") == n), None)
    if target is None:
        return {"via": "missing"}
    if focused_window is not None and target.get("window") and target["window"] != focused_window:
        return {"via": "stale-window"}
    return {"via": "ok", "target": target}


def speak_label(target: dict[str, Any], lang: str = "en") -> str:
    """A short line such as "3: Save button" (Hindi in Devanagari, Hinglish in Latin)."""
    nouns = _NOUN["hi" if lang == "hi" else "en"]
    noun = nouns.get(str(target.get("intent") or "click"), nouns["click"])
    name = str(target.get("name") or "")
    n = target.get("n")
    head = f"{n} number:" if lang == "hinglish" else f"{n}:"
    return f"{head} {name} {noun}" if name else f"{head} {noun}"
