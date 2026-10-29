"""Failure classification and a JSON migration that keeps the previous file.

A schema change on the SQLite store is backed up in ``db.Storage``. This module
covers the same faults for a JSON sidecar: a full disk, a denied write, a
cut-off write, and a corrupt file. The clock is injected.
"""

from __future__ import annotations

import json
import re
import shutil
from collections.abc import Callable
from pathlib import Path
from typing import Any

STARTUP_BUDGET_MS = 8_000
IDLE_CPU_PERCENT = 1.0
APPROVAL_TTL_MS = 120_000

_PROVIDER = re.compile(r"\b429\b|rate limit|provider outage|provider unavailable", re.I)
_DISK = re.compile(r"enospc|disk full|no space left", re.I)
_DENIED = re.compile(r"eacces|eperm|permission denied|access is denied", re.I)
_CLOCK = re.compile(r"clock jump|time jump|clock skew", re.I)
_CORRUPT = re.compile(r"corrupt|malformed json|unexpected token", re.I)
_INTERRUPT = re.compile(r"interrupted write|partial write", re.I)
_CRASH = re.compile(r"kernel crash|kernel restart|process crash", re.I)


def classify_failure(message: str, code: str = "") -> str:
    text = f"{code} {message}"
    if _PROVIDER.search(text):
        return "provider-outage"
    if _DISK.search(text):
        return "disk-full"
    if _DENIED.search(text):
        return "permission-denied"
    if _CLOCK.search(text):
        return "clock-jump"
    if _CORRUPT.search(text):
        return "corrupt-state"
    if _INTERRUPT.search(text):
        return "interrupted-write"
    if _CRASH.search(text):
        return "kernel-crash"
    return "other"


_RECOVERY = {
    "kernel-crash": {
        "action": "resume",
        "reason": "the checkpoint stays interrupted until the run continues",
    },
    "provider-outage": {
        "action": "retry",
        "reason": "transient provider failure — one bounded retry",
    },
    "disk-full": {
        "action": "stop",
        "reason": "the write did not land and the previous file stays",
    },
    "permission-denied": {
        "action": "stop",
        "reason": "the write did not land and the previous file stays",
    },
    "clock-jump": {
        "action": "expire",
        "reason": "a jumped clock does not extend a spoken yes",
    },
    "corrupt-state": {
        "action": "restore",
        "reason": "the backup written before the change is copied back",
    },
    "interrupted-write": {
        "action": "restore",
        "reason": "the backup written before the change is copied back",
    },
}


def recover_failure(kind: str, attempts: int = 0) -> dict[str, str]:
    if kind.startswith("provider") and attempts >= 2:
        return {"action": "fallback", "reason": "already retried — fall back instead of looping"}
    found = _RECOVERY.get(kind)
    if found:
        return dict(found)
    return {"action": "fallback", "reason": "use the existing safer path"}


def approval_fresh(asked_at: float, now: float, ttl_ms: float = APPROVAL_TTL_MS) -> bool:
    """Same bound as the desktop spoken-yes window. A backward clock expires it."""
    return asked_at > 0 and now >= asked_at and now - asked_at <= ttl_ms


def startup_within(start: float, ready: float, budget: float = STARTUP_BUDGET_MS) -> dict[str, Any]:
    elapsed = ready - start
    return {"ok": elapsed >= 0 and elapsed <= budget, "elapsed": elapsed}


def idle_within(samples: list[float], budget: float = IDLE_CPU_PERCENT) -> dict[str, Any]:
    peak = max(samples) if samples else 0
    return {"ok": bool(samples) and all(sample <= budget for sample in samples), "peak": peak}


def offline_flows(online: bool, has_local_model: bool) -> dict[str, bool]:
    return {
        "chat": True,
        "tasks": True,
        "memory": True,
        "localModel": has_local_model,
        "cloud": online,
    }


def _backup(path: Path) -> Path:
    return Path(str(path) + ".bak")


def migrate_json(
    path: Path,
    migrate: Callable[[Any], Any],
    now: float,
    fail: str | None = None,
) -> dict[str, Any]:
    """Write a backup, then publish. A failed publish leaves the previous body."""
    bak = _backup(path)
    raw = path.read_text(encoding="utf-8") if path.is_file() else None
    if raw is None:
        return {"ok": False, "restored": False, "reason": "missing", "backup": None}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        if not bak.is_file():
            return {"ok": False, "restored": False, "reason": "corrupt-state", "backup": None}
        saved = json.loads(bak.read_text(encoding="utf-8"))
        path.write_text(json.dumps(saved["body"]), encoding="utf-8")
        return {"ok": True, "restored": True, "reason": "corrupt-state", "backup": str(bak)}
    prev = parsed.get("version") if isinstance(parsed, dict) else None
    bak.write_text(json.dumps({"at": now, "body": parsed}), encoding="utf-8")
    if fail in {"disk-full", "permission-denied"}:
        return {"ok": False, "restored": False, "reason": fail, "backup": str(bak)}
    nxt = migrate(parsed)
    body = json.dumps(nxt)
    if fail == "interrupt":
        return {"ok": False, "restored": False, "reason": "interrupted-write", "backup": str(bak)}
    tmp = Path(str(path) + ".tmp")
    tmp.write_text(body, encoding="utf-8")
    tmp.replace(path)
    return {"ok": True, "restored": False, "reason": None, "backup": str(bak), "from": prev}


def restore_database_file(path: Path) -> bool:
    """Copy a quiescent backup over a corrupt database file. The backup is not a live connection."""
    bak = _backup(path)
    if not bak.is_file():
        return False
    shutil.copyfile(bak, path)
    return True
