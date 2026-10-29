"""Parse .gitignore patterns in a folder and flag common misses (node_modules, .venv, dist, .env) when those directories exist. Read-only."""

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

    listing_files = set(listing.get("entries") or [])
    raw = ""
    if ".gitignore" in listing_files:
        gi = await tools.execute("fs.read", {"path": f"{folder.rstrip('/\\')}/.gitignore"})
        raw = str(gi.get("content") or "")
    patterns = [line.strip() for line in raw.splitlines() if line.strip() and not line.strip().startswith("#")]
    joined = "\n".join(patterns)
    suspects = []
    for name, hint in (("node_modules", "node_modules"), (".venv", ".venv"), ("dist", "dist"), (".env", ".env")):
        if name in listing_files and hint not in joined:
            suspects.append(name)
    return {
        "ok": True,
        "folder": folder,
        "patternCount": len(patterns),
        "patterns": patterns[:80],
        "missingIgnores": suspects,
        "hasGitignore": ".gitignore" in listing_files,
    }


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
    with tempfile.TemporaryDirectory(prefix="friday-gitignore-audit-") as tmp:
        root = Path(tmp)
        (root / "node_modules").mkdir()
        (root / ".gitignore").write_text("dist\n", encoding="utf-8")
        tools = _LocalTools(tmp)
        result = asyncio.run(run(tools, folder="."))
        if "node_modules" not in result.get("missingIgnores", []):
            raise RuntimeError(result)
        if result.get("patternCount") != 1:
            raise RuntimeError(result)
        return {"ok": True, "missingIgnores": result["missingIgnores"]}

