"""Parse a workspace hosts file (hosts or etc/hosts) into IP → names. Does not read the OS /etc/hosts. Read-only."""

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

    rel = None
    if "hosts" in (listing.get("entries") or []):
        rel = "hosts"
    else:
        etc = await tools.execute("fs.read", {"path": f"{folder.rstrip('/\\')}/etc"})
        if etc.get("ok") and "hosts" in (etc.get("entries") or []):
            rel = "etc/hosts"
    if not rel:
        return {"ok": True, "folder": folder, "file": None, "entries": []}
    got = await tools.execute("fs.read", {"path": f"{folder.rstrip('/\\')}/{rel}"})
    rows = []
    for line in str(got.get("content") or "").splitlines():
        stripped = line.split("#", 1)[0].strip()
        if not stripped:
            continue
        parts = stripped.split()
        if len(parts) < 2:
            continue
        rows.append({"ip": parts[0], "names": parts[1:]})
    return {"ok": True, "folder": folder, "file": rel, "entries": rows, "entryCount": len(rows)}


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
    with tempfile.TemporaryDirectory(prefix="friday-hosts-read-") as tmp:
        Path(tmp, "hosts").write_text("127.0.0.1 localhost\n# comment\n10.0.0.2 friday.local\n", encoding="utf-8")
        result = asyncio.run(run(_LocalTools(tmp), folder="."))
        if result.get("entryCount") != 2 or result["entries"][1]["names"] != ["friday.local"]:
            raise RuntimeError(result)
        return {"ok": True, "entryCount": result["entryCount"]}

