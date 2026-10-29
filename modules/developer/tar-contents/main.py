"""List tar/tar.gz member names and sizes without extracting. Opens the local file after fs.read confirms it exists."""

from __future__ import annotations

import asyncio
import tarfile
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


async def run(tools, path: str) -> dict:
    listing = await tools.execute("fs.read", {"path": path})
    if listing.get("ok") is False:
        return listing
    target = _resolve(tools, listing, path)
    if target is None or not target.is_file():
        return {"ok": False, "error": f"tar file not found on disk: {path}"}
    try:
        with tarfile.open(target, mode="r:*") as tf:
            members = []
            for info in tf.getmembers():
                members.append({"name": info.name, "bytes": info.size, "dir": info.isdir(), "link": info.issym()})
    except tarfile.TarError as exc:
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
    with tempfile.TemporaryDirectory(prefix="friday-tar-contents-") as tmp:
        archive = Path(tmp) / "pack.tar"
        inner = Path(tmp) / "hello.txt"
        inner.write_text("hi", encoding="utf-8")
        with tarfile.open(archive, "w") as tf:
            tf.add(inner, arcname="hello.txt")
        result = asyncio.run(run(_LocalTools(tmp), path="pack.tar"))
        if result["members"][0]["name"] != "hello.txt":
            raise RuntimeError(result)
        return {"ok": True, "memberCount": result["memberCount"]}

