"""List zip member names, sizes, and compressed sizes without extracting. Opens the local file after fs.read confirms it exists (kernel fs.read is text-only)."""

from __future__ import annotations

import asyncio
import tempfile
import zipfile

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


async def run(tools, path: str) -> dict:
    listing = await tools.execute("fs.read", {"path": path})
    if listing.get("ok") is False:
        return listing
    if "entries" in listing and not listing.get("path"):
        return {"ok": False, "error": "path is a directory — pass a .zip file"}
    target = _resolve(tools, listing, path)
    if target is None or not target.is_file():
        return {"ok": False, "error": f"zip file not found on disk: {path}"}
    try:
        with zipfile.ZipFile(target) as zf:
            members = [
                {"name": info.filename, "bytes": info.file_size, "compressed": info.compress_size, "dir": info.is_dir()}
                for info in zf.infolist()
            ]
    except zipfile.BadZipFile as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "path": str(target), "members": members[:200], "memberCount": len(members)}


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
    with tempfile.TemporaryDirectory(prefix="friday-zip-contents-") as tmp:
        archive = Path(tmp) / "pack.zip"
        with zipfile.ZipFile(archive, "w") as zf:
            zf.writestr("hello.txt", "hi")
            zf.writestr("dir/note.md", "n")
        result = asyncio.run(run(_LocalTools(tmp), path="pack.zip"))
        names = {m["name"] for m in result["members"]}
        if names != {"hello.txt", "dir/note.md"}:
            raise RuntimeError(result)
        return {"ok": True, "memberCount": result["memberCount"]}

