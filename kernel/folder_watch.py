"""Folder watch: which files appeared in the folders the owner already chose, since the last look.

The folders are the ones FRIDAY may read (the owner's workspace and anything under ``read_roots``), top level only,
so nothing new is opened and no new permission is asked. The first look of a folder only records what is there, so
turning this on does not announce a whole drive. Credential files are never listed. The state is one small JSON
file of names and modification times; no file content is read.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import file_tools

MAX_PER_FOLDER = 300
MAX_REPORTED = 20


def _listing(root: Path) -> dict[str, float]:
    found: dict[str, float] = {}
    try:
        with os.scandir(root) as entries:
            for entry in entries:
                if len(found) >= MAX_PER_FOLDER:
                    break
                try:
                    if not entry.is_file(follow_symlinks=False) or entry.name.startswith("."):
                        continue
                    if file_tools.is_sensitive(Path(entry.path)):
                        continue
                    found[entry.name] = entry.stat(follow_symlinks=False).st_mtime
                except OSError:
                    continue
    except OSError:
        pass
    return found


def scan(roots: list[Path], state_path: Path) -> dict:
    try:
        known = json.loads(state_path.read_text(encoding="utf-8"))
        if not isinstance(known, dict):
            known = {}
    except (OSError, ValueError):
        known = {}
    fresh: list[dict] = []
    baseline: list[str] = []
    state: dict[str, dict[str, float]] = {}
    for root in roots:
        key = str(root)
        now = _listing(root)
        state[key] = now
        if key not in known:
            baseline.append(key)
            continue
        before = known[key] if isinstance(known[key], dict) else {}
        for name, mtime in now.items():
            if name not in before or mtime > float(before.get(name, 0)):
                fresh.append({"folder": root.name or key, "name": name, "new": name not in before})
    try:
        state_path.parent.mkdir(parents=True, exist_ok=True)
        state_path.write_text(json.dumps(state), encoding="utf-8")
    except OSError:
        pass
    return {"ok": True, "files": fresh[:MAX_REPORTED], "more": max(0, len(fresh) - MAX_REPORTED), "baseline": baseline}
