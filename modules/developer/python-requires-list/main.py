"""Collect requirement pins from requirements.txt / requirements-dev.txt (name only, no extras after ; or #) and pyproject.toml dependency lines. Read-only."""

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


def _req_names(text: str) -> list[str]:
    out = []
    for line in text.splitlines():
        raw = line.split("#", 1)[0].strip()
        if not raw or raw.startswith("-"):
            continue
        name = raw.split(";", 1)[0].strip()
        for sep in ("==", ">=", "<=", "~=", "!=", ">"):
            if sep in name:
                name = name.split(sep, 1)[0].strip()
                break
        name = name.split("[", 1)[0].strip()
        if name and name not in out:
            out.append(name)
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

    files = []
    for name in ("requirements.txt", "requirements-dev.txt", "requirements-test.txt"):
        if name not in (listing.get("entries") or []):
            continue
        got = await tools.execute("fs.read", {"path": f"{folder.rstrip('/\\')}/{name}"})
        names = _req_names(str(got.get("content") or ""))
        files.append({"file": name, "packages": names})
    pyproject = None
    if "pyproject.toml" in (listing.get("entries") or []):
        got = await tools.execute("fs.read", {"path": f"{folder.rstrip('/\\')}/pyproject.toml"})
        deps = []
        in_deps = False
        for line in str(got.get("content") or "").splitlines():
            if line.strip().startswith("dependencies") and "=" in line:
                in_deps = True
            if in_deps:
                if line.strip().startswith("["):
                    continue
                if line.strip().startswith("]") or (line.startswith("[") and "dependencies" not in line):
                    in_deps = False
                    continue
                token = line.strip().strip(",").strip('"').strip("'")
                if token and not token.startswith("dependencies"):
                    deps.append(token.split("[")[0].split(">")[0].split("=")[0].strip())
        pyproject = [item for item in deps if item]
    return {"ok": True, "folder": folder, "requirementFiles": files, "pyprojectDependencies": pyproject}


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
    with tempfile.TemporaryDirectory(prefix="friday-python-requires-list-") as tmp:
        Path(tmp, "requirements.txt").write_text("fastapi==0.115.0\nhttpx>=0.27\n", encoding="utf-8")
        result = asyncio.run(run(_LocalTools(tmp), folder="."))
        pkgs = result["requirementFiles"][0]["packages"]
        if pkgs != ["fastapi", "httpx"]:
            raise RuntimeError(result)
        return {"ok": True, "packages": pkgs}

