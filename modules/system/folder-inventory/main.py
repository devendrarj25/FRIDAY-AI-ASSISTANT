"""Shallow-plus-one inventory: immediate children with file/dir kind, child counts, and total bytes. Read-only."""

from __future__ import annotations

import asyncio
import os
import tempfile

from pathlib import Path

MANIFEST = None


def register(manifest: dict) -> None:
    global MANIFEST
    MANIFEST = manifest

def _resolve(tools, listing: dict, path: str):
    candidates = []
    if listing.get("path"):
        candidates.append(Path(str(listing["path"])))
    workspace = getattr(tools, "workspace", None)
    if workspace:
        candidates.append(Path(workspace) / path)
    candidates.append(Path(path))
    for item in candidates:
        try:
            if item.exists():
                return item
        except OSError:
            continue
    return None


async def run(tools, folder: str = ".") -> dict:

    listing = await tools.execute("fs.read", {"path": folder})
    if not listing.get("ok"):
        return listing
    if "entries" not in listing:
        return {"ok": False, "error": "path is a file — pass a folder"}
    root = _resolve(tools, listing, folder)
    if root is None or not root.is_dir():
        return {"ok": False, "error": f"folder not found: {folder}"}

    children = []
    for entry in sorted(root.iterdir(), key=lambda p: p.name.lower()):
        if entry.name in {".git", "node_modules", "__pycache__"}:
            kind = "skipped"
            extra = {}
        elif entry.is_dir():
            files = sum(1 for p in entry.glob("*") if p.is_file())
            dirs = sum(1 for p in entry.glob("*") if p.is_dir())
            kind = "dir"
            extra = {"files": files, "dirs": dirs}
        else:
            kind = "file"
            extra = {"bytes": entry.stat().st_size}
        children.append({"name": entry.name, "kind": kind, **extra})
    return {"ok": True, "folder": folder, "children": children, "childCount": len(children)}


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
    with tempfile.TemporaryDirectory(prefix="friday-folder-inventory-") as tmp:
        (Path(tmp) / "sub").mkdir()
        (Path(tmp) / "sub" / "a.txt").write_text("x", encoding="utf-8")
        Path(tmp, "root.txt").write_text("y", encoding="utf-8")
        result = asyncio.run(run(_LocalTools(tmp), folder="."))
        names = {c["name"]: c for c in result["children"]}
        if names["sub"]["kind"] != "dir" or names["sub"]["files"] != 1 or names["root.txt"]["kind"] != "file":
            raise RuntimeError(result)
        return {"ok": True, "childCount": result["childCount"]}

