"""List KEY names from .env and .env.example files only — never values. Flags keys present in example but missing in .env. Read-only."""

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


def _keys(text: str) -> list[str]:
    out = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key = stripped.split("=", 1)[0].strip()
        if key and key not in out:
            out.append(key)
    return out


async def run(tools, folder: str = ".") -> dict:

    listing = await tools.execute("fs.read", {"path": folder})
    if not listing.get("ok"):
        return listing
    if "entries" not in listing:
        return {"ok": False, "error": "path is a file — pass a folder"}
    root = _resolve(tools, listing, folder)
    if root is None or not root.is_dir():
        return {"ok": False, "error": f"folder not found: {folder}"}

    names = [name for name in (listing.get("entries") or []) if name.startswith(".env")]
    files = []
    for name in sorted(names):
        got = await tools.execute("fs.read", {"path": f"{folder.rstrip('/\\')}/{name}"})
        keys = _keys(str(got.get("content") or ""))
        files.append({"file": name, "keys": keys, "keyCount": len(keys)})
    example = next((item for item in files if item["file"] in (".env.example", ".env.sample")), None)
    live = next((item for item in files if item["file"] == ".env"), None)
    missing = []
    if example and live:
        missing = [key for key in example["keys"] if key not in live["keys"]]
    return {"ok": True, "folder": folder, "files": files, "missingFromEnv": missing}


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
    with tempfile.TemporaryDirectory(prefix="friday-env-key-audit-") as tmp:
        Path(tmp, ".env.example").write_text("API_URL=x\nSECRET=y\n", encoding="utf-8")
        Path(tmp, ".env").write_text("API_URL=http://localhost\n", encoding="utf-8")
        result = asyncio.run(run(_LocalTools(tmp), folder="."))
        if result.get("missingFromEnv") != ["SECRET"]:
            raise RuntimeError(result)
        if any("http://localhost" in str(item) for item in result.get("files", [])):
            raise RuntimeError("value leaked")
        return {"ok": True, "missingFromEnv": result["missingFromEnv"]}

