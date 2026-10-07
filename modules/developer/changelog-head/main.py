"""Read CHANGELOG.md / CHANGELOG / HISTORY.md and return the first heading plus the first 24 lines. Read-only; does not rewrite release notes."""

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

    chosen = next((n for n in ("CHANGELOG.md", "CHANGELOG", "HISTORY.md", "CHANGES.md") if n in (listing.get("entries") or [])), None)
    if not chosen:
        return {"ok": True, "folder": folder, "file": None, "heading": None, "preview": []}
    got = await tools.execute("fs.read", {"path": f"{folder.rstrip('/\\')}/{chosen}"})
    lines = str(got.get("content") or "").splitlines()
    heading = next((line.lstrip("# ").strip() for line in lines if line.startswith("#")), None)
    return {"ok": True, "folder": folder, "file": chosen, "heading": heading, "preview": lines[:24], "lineCount": len(lines)}


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
    with tempfile.TemporaryDirectory(prefix="friday-changelog-head-") as tmp:
        Path(tmp, "CHANGELOG.md").write_text("# Changelog\n\n## 1.0.0.2\n- shipped\n", encoding="utf-8")
        result = asyncio.run(run(_LocalTools(tmp), folder="."))
        if result.get("heading") != "Changelog" or "1.0.0.2" not in "\n".join(result["preview"]):
            raise RuntimeError(result)
        return {"ok": True, "heading": result["heading"]}

