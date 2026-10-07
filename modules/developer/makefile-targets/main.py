"""List GNU Make targets from Makefile / makefile (name before first colon, skip .PHONY and pattern rules). Read-only; does not run make."""

from __future__ import annotations

import asyncio
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


_TARGET = re.compile(r"^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:")


async def run(tools, folder: str = ".") -> dict:

    listing = await tools.execute("fs.read", {"path": folder})
    if not listing.get("ok"):
        return listing
    if "entries" not in listing:
        return {"ok": False, "error": "path is a file — pass a folder"}
    root = _resolve(tools, listing, folder)
    if root is None or not root.is_dir():
        return {"ok": False, "error": f"folder not found: {folder}"}

    chosen = next((name for name in ("Makefile", "makefile", "GNUmakefile") if name in (listing.get("entries") or [])), None)
    if not chosen:
        return {"ok": True, "folder": folder, "file": None, "targets": []}
    got = await tools.execute("fs.read", {"path": f"{folder.rstrip('/\\')}/{chosen}"})
    targets = []
    for line in str(got.get("content") or "").splitlines():
        if line.startswith("\t") or line.startswith(" ") or line.startswith("#"):
            continue
        match = _TARGET.match(line)
        if not match:
            continue
        name = match.group(1)
        if name not in (".PHONY", ".SUFFIXES") and name not in targets:
            targets.append(name)
    return {"ok": True, "folder": folder, "file": chosen, "targets": targets}


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
    with tempfile.TemporaryDirectory(prefix="friday-makefile-targets-") as tmp:
        Path(tmp, "Makefile").write_text(".PHONY: all\nall: build\n\t@echo x\nbuild:\n\t@echo y\n", encoding="utf-8")
        result = asyncio.run(run(_LocalTools(tmp), folder="."))
        if result.get("targets") != ["all", "build"]:
            raise RuntimeError(result)
        return {"ok": True, "targets": result["targets"]}

