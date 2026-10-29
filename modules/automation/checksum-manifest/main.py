"""SHA-256 every file under a folder. Dry-run returns the map; apply=True writes .friday-checksums.sha256 in that folder. Does not overwrite releases/SHA256SUMS.txt."""

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
        if path.name == ".friday-checksums.sha256":
            continue
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        rel = str(path.relative_to(root)).replace("\\", "/")
        rows.append({"path": rel, "sha256": digest, "bytes": path.stat().st_size})
    rows.sort(key=lambda item: item["path"])
    report_rel = ".friday-checksums.sha256"
    text = "".join(f"{item['sha256']}  {item['path']}\n" for item in rows)
    if not apply:
        return {"ok": True, "dryRun": True, "folder": folder, "reportPath": report_rel, "files": rows, "fileCount": len(rows)}
    written = await tools.execute("fs.write", {"path": f"{folder.rstrip('/\\')}/{report_rel}", "content": text})
    if not written.get("ok"):
        return written
    return {"ok": True, "dryRun": False, "folder": folder, "reportPath": report_rel, "files": rows, "fileCount": len(rows)}


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
    with tempfile.TemporaryDirectory(prefix="friday-checksum-manifest-") as tmp:
        Path(tmp, "a.txt").write_text("alpha", encoding="utf-8")
        tools = _LocalTools(tmp)
        preview = asyncio.run(run(tools, folder=".", apply=False))
        if not preview.get("dryRun") or preview.get("fileCount") != 1:
            raise RuntimeError(preview)
        applied = asyncio.run(run(tools, folder=".", apply=True))
        report = Path(tmp, ".friday-checksums.sha256")
        if applied.get("dryRun") or not report.is_file() or "alpha" in report.read_text(encoding="utf-8"):
            raise RuntimeError(applied)
        if applied["files"][0]["sha256"] not in report.read_text(encoding="utf-8"):
            raise RuntimeError(applied)
        return {"ok": True, "fileCount": applied["fileCount"]}

