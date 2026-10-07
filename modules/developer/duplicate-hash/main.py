"""SHA-256 hash files in a folder (skipping .git/node_modules) and report groups that share the same digest. Read-only; does not delete."""

from __future__ import annotations

import asyncio
import hashlib
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


async def run(tools, folder: str = ".", minBytes: int = 1) -> dict:

    listing = await tools.execute("fs.read", {"path": folder})
    if not listing.get("ok"):
        return listing
    if "entries" not in listing:
        return {"ok": False, "error": "path is a file — pass a folder"}
    root = _resolve(tools, listing, folder)
    if root is None or not root.is_dir():
        return {"ok": False, "error": f"folder not found: {folder}"}

    listing  # confirmed readable
    groups: dict[str, list[dict]] = {}
    floor = max(0, int(minBytes))
    for path in _iter_paths(root, files_only=True):
        try:
            size = path.stat().st_size
        except OSError:
            continue
        if size < floor:
            continue
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        rel = str(path.relative_to(root)).replace("\\", "/")
        groups.setdefault(digest, []).append({"path": rel, "bytes": size})
    dupes = [{"hash": digest, "files": files} for digest, files in groups.items() if len(files) > 1]
    dupes.sort(key=lambda item: -len(item["files"]))
    return {"ok": True, "folder": folder, "duplicateGroups": dupes, "groupCount": len(dupes)}


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
    with tempfile.TemporaryDirectory(prefix="friday-duplicate-hash-") as tmp:
        Path(tmp, "a.txt").write_text("same-bytes", encoding="utf-8")
        Path(tmp, "b.txt").write_text("same-bytes", encoding="utf-8")
        Path(tmp, "c.txt").write_text("other", encoding="utf-8")
        result = asyncio.run(run(_LocalTools(tmp), folder="."))
        if result.get("groupCount") != 1 or len(result["duplicateGroups"][0]["files"]) != 2:
            raise RuntimeError(result)
        return {"ok": True, "groupCount": result["groupCount"]}

