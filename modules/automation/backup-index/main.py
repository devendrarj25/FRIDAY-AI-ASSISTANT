"""Index files that look like backups (*.bak, *.old, *~, copy of). Dry-run lists them; apply writes .friday-backup-index.json."""

from __future__ import annotations

import asyncio
import json
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


def _is_backup(name: str) -> bool:
    lower = name.lower()
    return lower.endswith(".bak") or lower.endswith(".old") or lower.endswith("~") or lower.startswith("copy of ") or ".bak." in lower


async def run(tools, folder: str = ".", apply: bool = False) -> dict:

    listing = await tools.execute("fs.read", {"path": folder})
    if not listing.get("ok"):
        return listing
    if "entries" not in listing:
        return {"ok": False, "error": "path is a file — pass a folder"}
    root = _resolve(tools, listing, folder)
    if root is None or not root.is_dir():
        return {"ok": False, "error": f"folder not found: {folder}"}

    rows = []
    for path in _iter_paths(root, files_only=True):
        if not _is_backup(path.name):
            continue
        rows.append({"path": str(path.relative_to(root)).replace("\\", "/"), "bytes": path.stat().st_size})
    report = {"folder": folder, "backups": rows, "count": len(rows)}
    target = f"{folder.rstrip('/\\')}/.friday-backup-index.json"
    if not apply:
        return {"ok": True, "dryRun": True, "reportPath": target, **report}
    written = await tools.execute("fs.write", {"path": target, "content": json.dumps(report, indent=2) + "\n"})
    if not written.get("ok"):
        return written
    return {"ok": True, "dryRun": False, "reportPath": target, **report}


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
        if name == "fs.write":
            target.parent.mkdir(parents=True, exist_ok=True)
            data = str(args.get("content", ""))
            target.write_text(data, encoding="utf-8")
            return {"ok": True, "bytes": len(data)}
        return {"ok": False, "error": f"unknown tool {name}"}


def self_test(payload=None) -> dict:
    with tempfile.TemporaryDirectory(prefix="friday-backup-index-") as tmp:
        Path(tmp, "notes.bak").write_text("old", encoding="utf-8")
        Path(tmp, "notes.txt").write_text("new", encoding="utf-8")
        result = asyncio.run(run(_LocalTools(tmp), folder=".", apply=True))
        if result.get("count") != 1 or not Path(tmp, ".friday-backup-index.json").is_file():
            raise RuntimeError(result)
        return {"ok": True, "count": result["count"]}

