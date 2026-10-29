"""Inventory test files by naming convention (test_*.py, *_test.py, *.test.ts, *.spec.ts, *.test.js). Read-only; does not run tests."""

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


def _kind(name: str) -> str | None:
    lower = name.lower()
    if lower.startswith("test_") and lower.endswith(".py"):
        return "pytest-prefix"
    if lower.endswith("_test.py"):
        return "pytest-suffix"
    if lower.endswith(".test.ts") or lower.endswith(".test.tsx"):
        return "vitest-ts"
    if lower.endswith(".spec.ts") or lower.endswith(".spec.tsx"):
        return "spec-ts"
    if lower.endswith(".test.js") or lower.endswith(".spec.js"):
        return "js"
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

    files = []
    counts = {}
    for path in _iter_paths(root, files_only=True):
        kind = _kind(path.name)
        if not kind:
            continue
        rel = str(path.relative_to(root)).replace("\\", "/")
        files.append({"path": rel, "kind": kind})
        counts[kind] = counts.get(kind, 0) + 1
    return {"ok": True, "folder": folder, "tests": files[:200], "counts": counts, "testCount": len(files)}


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
    with tempfile.TemporaryDirectory(prefix="friday-test-inventory-") as tmp:
        Path(tmp, "test_mod.py").write_text("def test_x():\n    pass\n", encoding="utf-8")
        Path(tmp, "app.test.ts").write_text("test('x', () => {})\n", encoding="utf-8")
        result = asyncio.run(run(_LocalTools(tmp), folder="."))
        if result.get("testCount") != 2:
            raise RuntimeError(result)
        return {"ok": True, "counts": result["counts"]}

