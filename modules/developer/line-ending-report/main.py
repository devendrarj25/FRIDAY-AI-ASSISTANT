"""Classify text files as LF, CRLF, CR, or mixed. Useful before a repo-wide .gitattributes pass. Read-only."""

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


_TEXT = {".py", ".ts", ".tsx", ".js", ".json", ".md", ".txt", ".yml", ".yaml", ".toml", ".css", ".html", ".cjs", ".mjs"}


def _kind(raw: bytes) -> str:
    crlf = raw.count(b"\r\n")
    tmp = raw.replace(b"\r\n", b"")
    cr = tmp.count(b"\r")
    lf = tmp.count(b"\n")
    kinds = [label for label, n in (("crlf", crlf), ("lf", lf), ("cr", cr)) if n]
    if len(kinds) > 1:
        return "mixed"
    return kinds[0] if kinds else "none"


async def run(tools, folder: str = ".") -> dict:

    listing = await tools.execute("fs.read", {"path": folder})
    if not listing.get("ok"):
        return listing
    if "entries" not in listing:
        return {"ok": False, "error": "path is a file — pass a folder"}
    root = _resolve(tools, listing, folder)
    if root is None or not root.is_dir():
        return {"ok": False, "error": f"folder not found: {folder}"}

    counts = {"lf": 0, "crlf": 0, "cr": 0, "mixed": 0, "none": 0}
    mixed_files = []
    for path in _iter_paths(root, files_only=True):
        if path.suffix.lower() not in _TEXT:
            continue
        kind = _kind(path.read_bytes())
        counts[kind] = counts.get(kind, 0) + 1
        if kind == "mixed":
            mixed_files.append(str(path.relative_to(root)).replace("\\", "/"))
    return {"ok": True, "folder": folder, "counts": counts, "mixedFiles": mixed_files[:40]}


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
    with tempfile.TemporaryDirectory(prefix="friday-line-ending-report-") as tmp:
        Path(tmp, "unix.py").write_bytes(b"a\nb\n")
        Path(tmp, "win.txt").write_bytes(b"a\r\nb\r\n")
        Path(tmp, "mix.md").write_bytes(b"a\r\nb\nc\n")
        result = asyncio.run(run(_LocalTools(tmp), folder="."))
        if result["counts"]["lf"] < 1 or result["counts"]["crlf"] < 1 or result["counts"]["mixed"] != 1:
            raise RuntimeError(result)
        return {"ok": True, "counts": result["counts"]}

