"""List prompt-like files (prompts/, *.prompt.md, *prompt*.txt) and return the first line of each. Read-only."""

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


def _is_prompt(path: Path, root: Path) -> bool:
    rel = str(path.relative_to(root)).replace("\\", "/").lower()
    name = path.name.lower()
    return "prompts/" in rel + "/" or name.endswith(".prompt.md") or "prompt" in name


async def run(tools, folder: str = ".") -> dict:

    listing = await tools.execute("fs.read", {"path": folder})
    if not listing.get("ok"):
        return listing
    if "entries" not in listing:
        return {"ok": False, "error": "path is a file — pass a folder"}
    root = _resolve(tools, listing, folder)
    if root is None or not root.is_dir():
        return {"ok": False, "error": f"folder not found: {folder}"}

    rows = []
    for path in _iter_paths(root, files_only=True):
        if not _is_prompt(path, root):
            continue
        rel = str(path.relative_to(root)).replace("\\", "/")
        got = await tools.execute("fs.read", {"path": f"{folder.rstrip('/\\')}/{rel}"})
        first = next((ln.strip() for ln in str(got.get("content") or "").splitlines() if ln.strip()), "")
        rows.append({"path": rel, "firstLine": first[:160], "bytes": path.stat().st_size})
    return {"ok": True, "folder": folder, "prompts": rows, "count": len(rows)}


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
    with tempfile.TemporaryDirectory(prefix="friday-prompt-pack-list-") as tmp:
        (Path(tmp) / "prompts").mkdir()
        (Path(tmp) / "prompts" / "greet.md").write_text("# Greeting\nHello\n", encoding="utf-8")
        Path(tmp, "skip.txt").write_text("nope", encoding="utf-8")
        result = asyncio.run(run(_LocalTools(tmp), folder="."))
        if result.get("count") != 1 or result["prompts"][0]["firstLine"] != "# Greeting":
            raise RuntimeError(result)
        return {"ok": True, "count": result["count"]}

