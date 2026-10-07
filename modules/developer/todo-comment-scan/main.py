"""Walk a folder for TODO/FIXME/HACK/XXX comments in source files (.py .ts .tsx .js .jsx .go .rs .c .h). Returns path + line + tag. Read-only."""

from __future__ import annotations

import asyncio
import os
import re
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


_TAG = re.compile(r"\b(TODO|FIXME|HACK|XXX)\b[:\s-]?(.*)$", re.I)
_SRC = {".py", ".ts", ".tsx", ".js", ".jsx", ".go", ".rs", ".c", ".h", ".mjs", ".cjs"}


async def run(tools, folder: str = ".", limit: int = 80) -> dict:

    listing = await tools.execute("fs.read", {"path": folder})
    if not listing.get("ok"):
        return listing
    if "entries" not in listing:
        return {"ok": False, "error": "path is a file — pass a folder"}
    root = _resolve(tools, listing, folder)
    if root is None or not root.is_dir():
        return {"ok": False, "error": f"folder not found: {folder}"}

    hits = []
    cap = max(1, int(limit))
    for path in _iter_paths(root, files_only=True):
        if path.suffix.lower() not in _SRC:
            continue
        rel = str(path.relative_to(root)).replace("\\", "/")
        got = await tools.execute("fs.read", {"path": f"{folder.rstrip('/\\')}/{rel}"})
        text = str(got.get("content") or "")
        for i, line in enumerate(text.splitlines(), 1):
            match = _TAG.search(line)
            if not match:
                continue
            hits.append({"file": rel, "line": i, "tag": match.group(1).upper(), "text": match.group(2).strip()[:120]})
            if len(hits) >= cap:
                break
        if len(hits) >= cap:
            break
    counts = {}
    for hit in hits:
        counts[hit["tag"]] = counts.get(hit["tag"], 0) + 1
    return {"ok": True, "folder": folder, "hits": hits, "tagCounts": counts, "hitCount": len(hits)}


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
    with tempfile.TemporaryDirectory(prefix="friday-todo-comment-scan-") as tmp:
        Path(tmp, "app.py").write_text("# TODO: wire auth\nprint(1)\n# FIXME later\n", encoding="utf-8")
        result = asyncio.run(run(_LocalTools(tmp), folder="."))
        tags = {hit["tag"] for hit in result.get("hits", [])}
        if tags != {"TODO", "FIXME"}:
            raise RuntimeError(result)
        return {"ok": True, "tagCounts": result["tagCounts"]}

