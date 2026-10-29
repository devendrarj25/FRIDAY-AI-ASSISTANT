"""Plan copying files matching an extension into a destination folder. Dry-run by default; apply writes .friday-copy-plan.json only — it does not copy bytes."""

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


async def run(tools, folder: str = ".", dest: str = "backup", ext: str = "", apply: bool = False) -> dict:

    listing = await tools.execute("fs.read", {"path": folder})
    if not listing.get("ok"):
        return listing
    if "entries" not in listing:
        return {"ok": False, "error": "path is a file — pass a folder"}
    root = _resolve(tools, listing, folder)
    if root is None or not root.is_dir():
        return {"ok": False, "error": f"folder not found: {folder}"}

    needle = (ext or "").lower()
    if needle and not needle.startswith("."):
        needle = "." + needle
    plan = []
    for path in _iter_paths(root, files_only=True):
        if needle and path.suffix.lower() != needle:
            continue
        rel = str(path.relative_to(root)).replace("\\", "/")
        plan.append({"from": rel, "to": f"{dest.rstrip('/\\')}/{rel}", "bytes": path.stat().st_size})
    report = {"folder": folder, "dest": dest, "copies": plan, "count": len(plan), "bytes": sum(item["bytes"] for item in plan)}
    target = f"{folder.rstrip('/\\')}/.friday-copy-plan.json"
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
    with tempfile.TemporaryDirectory(prefix="friday-copy-plan-") as tmp:
        Path(tmp, "a.csv").write_text("x", encoding="utf-8")
        tools = _LocalTools(tmp)
        preview = asyncio.run(run(tools, folder=".", dest="safe", ext=".csv", apply=False))
        if preview["copies"][0]["to"] != "safe/a.csv" or not preview.get("dryRun"):
            raise RuntimeError(preview)
        applied = asyncio.run(run(tools, folder=".", dest="safe", ext=".csv", apply=True))
        if not Path(tmp, ".friday-copy-plan.json").is_file():
            raise RuntimeError(applied)
        return {"ok": True, "count": applied["count"]}

