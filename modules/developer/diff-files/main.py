"""Unified diff of two text files via stdlib difflib. Read-only; does not apply patches."""

from __future__ import annotations

import asyncio
import difflib
import tempfile

from pathlib import Path

MANIFEST = None


def register(manifest: dict) -> None:
    global MANIFEST
    MANIFEST = manifest


async def run(tools, left: str, right: str, context: int = 3) -> dict:
    a = await tools.execute("fs.read", {"path": left})
    b = await tools.execute("fs.read", {"path": right})
    if not a.get("ok"):
        return a
    if not b.get("ok"):
        return b
    left_lines = str(a.get("content") or "").splitlines()
    right_lines = str(b.get("content") or "").splitlines()
    diff = list(difflib.unified_diff(left_lines, right_lines, fromfile=left, tofile=right, lineterm="", n=max(0, int(context))))
    added = sum(1 for line in diff if line.startswith("+") and not line.startswith("+++"))
    removed = sum(1 for line in diff if line.startswith("-") and not line.startswith("---"))
    return {"ok": True, "left": left, "right": right, "diff": diff[:400], "added": added, "removed": removed, "identical": not diff}


class _LocalTools:
    def __init__(self, root: str) -> None:
        self.root = Path(root)
        self.workspace = self.root

    async def execute(self, name: str, args: dict, **_kwargs) -> dict:
        target = (self.root / str(args.get("path", "."))).resolve()
        try:
            target.relative_to(self.root.resolve())
        except ValueError:
            return {"ok": False, "error": "path escapes workspace"}
        if name == "fs.read":
            if not target.exists():
                return {"ok": False, "error": "missing"}
            if target.is_dir():
                return {"ok": True, "entries": sorted(p.name for p in target.iterdir()), "path": str(target)}
            return {"ok": True, "path": str(target), "content": target.read_text(encoding="utf-8", errors="replace")}
        return {"ok": False, "error": f"unknown tool {name}"}


def self_test(payload=None) -> dict:
    with tempfile.TemporaryDirectory(prefix="friday-diff-files-") as tmp:
        Path(tmp, "a.txt").write_text("one\ntwo\n", encoding="utf-8")
        Path(tmp, "b.txt").write_text("one\nthree\n", encoding="utf-8")
        result = asyncio.run(run(_LocalTools(tmp), left="a.txt", right="b.txt"))
        if result.get("identical") or result.get("added") < 1 or result.get("removed") < 1:
            raise RuntimeError(result)
        return {"ok": True, "added": result["added"], "removed": result["removed"]}

