"""Local stack / lockfile auditor.

Read-only. Uses kernel fs.read. Distinct from repo-import (no clone).
"""

from __future__ import annotations

import asyncio
import json
import tempfile
from pathlib import Path

MANIFEST = None

MARKERS = {
    "package.json": "node",
    "package-lock.json": "npm-lock",
    "yarn.lock": "yarn-lock",
    "pnpm-lock.yaml": "pnpm-lock",
    "requirements.txt": "python-requirements",
    "pyproject.toml": "python",
    "poetry.lock": "poetry-lock",
    "Pipfile.lock": "pipenv-lock",
    "Cargo.toml": "rust",
    "Cargo.lock": "cargo-lock",
    "go.mod": "go",
    "go.sum": "go-sum",
}


def register(manifest: dict) -> None:
    global MANIFEST
    MANIFEST = manifest


async def _read_file(tools, folder: str, name: str) -> str | None:
    result = await tools.execute("fs.read", {"path": f"{folder.rstrip('/\\')}/{name}"})
    if not result.get("ok"):
        return None
    if "content" in result:
        return str(result.get("content") or "")
    return None


async def run(tools, folder: str = ".") -> dict:
    listing = await tools.execute("fs.read", {"path": folder})
    if not listing.get("ok"):
        return listing
    entries = set(listing.get("entries") or [])
    found = []
    engines = None
    python_requires = None
    for name, label in MARKERS.items():
        if name not in entries:
            continue
        found.append({"file": name, "kind": label})
        if name == "package.json":
            raw = await _read_file(tools, folder, name)
            if raw:
                try:
                    data = json.loads(raw)
                    engines = data.get("engines") if isinstance(data, dict) else None
                except json.JSONDecodeError:
                    engines = {"error": "package.json is not valid JSON"}
        if name == "pyproject.toml":
            raw = await _read_file(tools, folder, name) or ""
            for line in raw.splitlines():
                if "requires-python" in line.lower():
                    python_requires = line.strip()
                    break
    stack = sorted({item["kind"].split("-")[0] for item in found if item["kind"] in ("node", "python", "rust", "go")})
    return {
        "ok": True,
        "folder": folder,
        "stack": stack,
        "files": found,
        "engines": engines,
        "pythonRequires": python_requires,
    }


class _LocalTools:
    def __init__(self, root: str) -> None:
        self.root = Path(root)

    async def execute(self, name: str, args: dict, **_kwargs) -> dict:
        target = (self.root / str(args.get("path", "."))).resolve()
        try:
            target.relative_to(self.root.resolve())
        except ValueError:
            return {"ok": False, "error": "path escapes workspace"}
        if name != "fs.read":
            return {"ok": False, "error": f"unknown tool {name}"}
        if target.is_dir():
            return {"ok": True, "entries": sorted(p.name for p in target.iterdir())}
        if not target.is_file():
            return {"ok": False, "error": "missing"}
        return {"ok": True, "content": target.read_text(encoding="utf-8", errors="replace")}


def self_test(payload=None) -> dict:
    with tempfile.TemporaryDirectory(prefix="friday-stack-audit-") as tmp:
        root = Path(tmp) / "app"
        root.mkdir()
        (root / "package.json").write_text(
            json.dumps({"name": "demo", "engines": {"node": ">=22"}}),
            encoding="utf-8",
        )
        (root / "package-lock.json").write_text("{}", encoding="utf-8")
        (root / "pyproject.toml").write_text('[project]\nrequires-python = ">=3.12"\n', encoding="utf-8")
        tools = _LocalTools(tmp)
        result = asyncio.run(run(tools, folder="app"))
        if not result.get("ok"):
            raise RuntimeError(result)
        if "node" not in result.get("stack", []) or "python" not in result.get("stack", []):
            raise RuntimeError(f"expected node+python stack, got {result}")
        if not any(item["file"] == "package-lock.json" for item in result.get("files", [])):
            raise RuntimeError("lockfile not reported")
        return {"ok": True, "stack": result["stack"]}
