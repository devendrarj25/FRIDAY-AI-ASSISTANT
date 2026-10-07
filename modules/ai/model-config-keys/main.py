"""List top-level keys from JSON/JSONC model config files in a folder (no secret values). Read-only."""

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


_SKIP_VALUES = {"api_key", "apikey", "token", "secret", "password"}


async def run(tools, folder: str = ".") -> dict:

    listing = await tools.execute("fs.read", {"path": folder})
    if not listing.get("ok"):
        return listing
    if "entries" not in listing:
        return {"ok": False, "error": "path is a file — pass a folder"}
    root = _resolve(tools, listing, folder)
    if root is None or not root.is_dir():
        return {"ok": False, "error": f"folder not found: {folder}"}

    files = []
    for path in _iter_paths(root, files_only=True):
        if path.suffix.lower() != ".json":
            continue
        rel = str(path.relative_to(root)).replace("\\", "/")
        got = await tools.execute("fs.read", {"path": f"{folder.rstrip('/\\')}/{rel}"})
        try:
            data = json.loads(str(got.get("content") or "") or "null")
        except json.JSONDecodeError:
            files.append({"path": rel, "error": "invalid json"})
            continue
        if not isinstance(data, dict):
            files.append({"path": rel, "keys": [], "kind": type(data).__name__})
            continue
        keys = []
        for key in sorted(data):
            item = {"key": key, "kind": type(data[key]).__name__}
            if str(key).lower() not in _SKIP_VALUES and not isinstance(data[key], (dict, list)):
                item["sample"] = str(data[key])[:80]
            keys.append(item)
        files.append({"path": rel, "keys": keys})
    return {"ok": True, "folder": folder, "files": files, "fileCount": len(files)}


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
    with tempfile.TemporaryDirectory(prefix="friday-model-config-keys-") as tmp:
        Path(tmp, "model.json").write_text('{"name": "local", "api_key": "SECRET", "ctx": 8192}', encoding="utf-8")
        result = asyncio.run(run(_LocalTools(tmp), folder="."))
        keys = {item["key"]: item for item in result["files"][0]["keys"]}
        if "sample" in keys["api_key"] or keys["name"]["sample"] != "local":
            raise RuntimeError(result)
        return {"ok": True, "fileCount": result["fileCount"]}

