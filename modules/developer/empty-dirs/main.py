"""Find directories that contain no files (subdirs may exist). Skips .git and node_modules. Read-only; does not delete."""

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

_SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "dist", ".friday"}


def _iter_paths(root: Path, files_only: bool = False, limit: int = 4000):
    count = 0
    if root.is_file():
        yield root
        return
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [name for name in dirnames if name not in _SKIP_DIRS]
        base = Path(dirpath)
        if not files_only:
            for name in dirnames:
                yield base / name
                count += 1
                if count >= limit:
                    return
        for name in filenames:
            yield base / name
            count += 1
            if count >= limit:
                return


async def run(tools, folder: str = ".") -> dict:

    listing = await tools.execute("fs.read", {"path": folder})
    if not listing.get("ok"):
        return listing
    if "entries" not in listing:
        return {"ok": False, "error": "path is a file — pass a folder"}
    root = _resolve(tools, listing, folder)
    if root is None or not root.is_dir():
        return {"ok": False, "error": f"folder not found: {folder}"}

    empty = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [name for name in dirnames if name not in _SKIP_DIRS]
        if not dirnames and not filenames:
            rel = str(Path(dirpath).relative_to(root)).replace("\\", "/")
            if rel != ".":
                empty.append(rel)
    return {"ok": True, "folder": folder, "emptyDirs": sorted(empty), "count": len(empty)}


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
    with tempfile.TemporaryDirectory(prefix="friday-empty-dirs-") as tmp:
        (Path(tmp) / "keep").mkdir()
        (Path(tmp) / "keep" / "file.txt").write_text("x", encoding="utf-8")
        (Path(tmp) / "void").mkdir()
        result = asyncio.run(run(_LocalTools(tmp), folder="."))
        if result.get("emptyDirs") != ["void"]:
            raise RuntimeError(result)
        return {"ok": True, "count": result["count"]}

