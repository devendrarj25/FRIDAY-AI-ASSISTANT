"""Log file inspector. Read-only via kernel fs.read."""

from __future__ import annotations

import asyncio
import re
import tempfile
from pathlib import Path

MANIFEST = None

LEVELS = (
    ("error", re.compile(r"\b(error|fatal|critical)\b", re.I)),
    ("warn", re.compile(r"\b(warn|warning)\b", re.I)),
    ("info", re.compile(r"\b(info|information)\b", re.I)),
)


def register(manifest: dict) -> None:
    global MANIFEST
    MANIFEST = manifest


async def run(tools, path: str, limit: int = 8) -> dict:
    result = await tools.execute("fs.read", {"path": path})
    if not result.get("ok"):
        return result
    if "entries" in result:
        return {"ok": False, "error": "path is a directory — pass a log file"}
    lines = str(result.get("content") or "").splitlines()
    counts = {"error": 0, "warn": 0, "info": 0, "other": 0}
    last_errors: list[str] = []
    for line in lines:
        matched = False
        for key, pattern in LEVELS:
            if pattern.search(line):
                counts[key] += 1
                matched = True
                if key == "error":
                    last_errors.append(line.strip())
                break
        if not matched:
            counts["other"] += 1
    cap = max(1, int(limit))
    return {
        "ok": True,
        "path": path,
        "lineCount": len(lines),
        "counts": counts,
        "lastErrors": last_errors[-cap:],
    }


class _LocalTools:
    def __init__(self, root: str) -> None:
        self.root = Path(root)

    async def execute(self, name: str, args: dict, **_kwargs) -> dict:
        target = (self.root / str(args.get("path", "."))).resolve()
        try:
            target.relative_to(self.root.resolve())
        except ValueError:
            return {"ok": False, "error": "path escapes workspace"}
        if name != "fs.read":
            return {"ok": False, "error": f"unknown tool {name}"}
        if target.is_dir():
            return {"ok": True, "entries": sorted(p.name for p in target.iterdir())}
        if not target.is_file():
            return {"ok": False, "error": "missing"}
        return {"ok": True, "content": target.read_text(encoding="utf-8", errors="replace")}


def self_test(payload=None) -> dict:
    with tempfile.TemporaryDirectory(prefix="friday-log-inspect-") as tmp:
        Path(tmp, "app.log").write_text(
            "INFO started\nWARN disk\nERROR boom\nERROR again\nplain\n",
            encoding="utf-8",
        )
        tools = _LocalTools(tmp)
        result = asyncio.run(run(tools, path="app.log", limit=2))
        if result.get("counts") != {"error": 2, "warn": 1, "info": 1, "other": 1}:
            raise RuntimeError(result)
        if result.get("lastErrors") != ["ERROR boom", "ERROR again"]:
            raise RuntimeError(result)
        return {"ok": True, "counts": result["counts"]}
