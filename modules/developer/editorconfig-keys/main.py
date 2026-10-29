"""Parse .editorconfig sections and keys (indent_style, indent_size, end_of_line, charset). Read-only."""

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

    if ".editorconfig" not in (listing.get("entries") or []):
        return {"ok": True, "folder": folder, "present": False, "sections": []}
    got = await tools.execute("fs.read", {"path": f"{folder.rstrip('/\\')}/.editorconfig"})
    sections = []
    current = {"glob": "*", "keys": {}}
    for line in str(got.get("content") or "").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or stripped.startswith(";"):
            continue
        if stripped.startswith("[") and stripped.endswith("]"):
            if current["keys"] or current["glob"] != "*":
                sections.append(current)
            current = {"glob": stripped[1:-1], "keys": {}}
            continue
        if "=" in stripped:
            key, value = stripped.split("=", 1)
            current["keys"][key.strip()] = value.strip()
    sections.append(current)
    return {"ok": True, "folder": folder, "present": True, "sections": sections}


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
    with tempfile.TemporaryDirectory(prefix="friday-editorconfig-keys-") as tmp:
        Path(tmp, ".editorconfig").write_text("root = true\n[*.py]\nindent_size = 4\n", encoding="utf-8")
        result = asyncio.run(run(_LocalTools(tmp), folder="."))
        py = next(item for item in result["sections"] if item["glob"] == "*.py")
        if py["keys"].get("indent_size") != "4":
            raise RuntimeError(result)
        return {"ok": True, "indent_size": py["keys"]["indent_size"]}

