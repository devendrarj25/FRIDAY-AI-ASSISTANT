"""Extract ATX headings from README.md to sketch the document outline. Read-only."""

from __future__ import annotations

import asyncio
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

    chosen = next((n for n in ("README.md", "Readme.md", "readme.md") if n in (listing.get("entries") or [])), None)
    if not chosen:
        return {"ok": True, "folder": folder, "file": None, "headings": []}
    got = await tools.execute("fs.read", {"path": f"{folder.rstrip('/\\')}/{chosen}"})
    headings = []
    for line in str(got.get("content") or "").splitlines():
        if line.startswith("#"):
            level = len(line) - len(line.lstrip("#"))
            text = line[level:].strip()
            if text:
                headings.append({"level": level, "text": text})
    return {"ok": True, "folder": folder, "file": chosen, "headings": headings, "headingCount": len(headings)}


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
    with tempfile.TemporaryDirectory(prefix="friday-readme-headings-") as tmp:
        Path(tmp, "README.md").write_text("# FRIDAY\n\n## Install\ntext\n## Build\n", encoding="utf-8")
        result = asyncio.run(run(_LocalTools(tmp), folder="."))
        if [h["text"] for h in result["headings"]] != ["FRIDAY", "Install", "Build"]:
            raise RuntimeError(result)
        return {"ok": True, "headingCount": result["headingCount"]}

