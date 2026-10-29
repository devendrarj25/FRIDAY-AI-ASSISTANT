"""Project scaffolder.

Delegates writes to kernel fs.write. Dry-run by default.
"""

from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path

MANIFEST = None

NODE_FILES = {
    "package.json": '{\n  "name": "__NAME__",\n  "version": "0.1.0",\n  "private": true,\n  "type": "module",\n  "scripts": {\n    "start": "node src/index.js"\n  }\n}\n',
    "README.md": "# __NAME__\n\nScaffolded by FRIDAY project-scaffold. Owner: Devendra Singh Meena.\n",
    "src/index.js": 'console.log("hello from __NAME__");\n',
}

PYTHON_FILES = {
    "pyproject.toml": '[project]\nname = "__NAME__"\nversion = "0.1.0"\nrequires-python = ">=3.12"\n',
    "README.md": "# __NAME__\n\nScaffolded by FRIDAY project-scaffold. Owner: Devendra Singh Meena.\n",
    "src/__init__.py": '"""__NAME__ package."""\n',
}


def register(manifest: dict) -> None:
    global MANIFEST
    MANIFEST = manifest


def _templates(kind: str) -> dict[str, str]:
    key = (kind or "node").strip().lower()
    if key in ("python", "py"):
        return PYTHON_FILES
    return NODE_FILES


def _join(folder: str, rel: str) -> str:
    base = str(folder or ".").rstrip("/\\")
    return f"{base}/{rel}" if base else rel


async def run(tools, folder: str = "scaffold", kind: str = "node", apply: bool = False, name: str = "app") -> dict:
    """Plan or write a small project tree. apply=False is inspect-only."""
    files = _templates(kind)
    label = str(name or "app").strip() or "app"
    planned = [_join(folder, rel) for rel in files]
    if not apply:
        return {"ok": True, "dryRun": True, "folder": folder, "kind": kind, "files": planned}
    written = []
    for rel, content in files.items():
        path = _join(folder, rel)
        result = await tools.execute("fs.write", {"path": path, "content": content.replace("__NAME__", label)})
        if not result.get("ok"):
            return result
        written.append(path)
    return {"ok": True, "dryRun": False, "folder": folder, "kind": kind, "files": written}


class _LocalTools:
    def __init__(self, root: str) -> None:
        self.root = Path(root)

    async def execute(self, name: str, args: dict, **_kwargs) -> dict:
        target = (self.root / str(args.get("path", "."))).resolve()
        try:
            target.relative_to(self.root.resolve())
        except ValueError:
            return {"ok": False, "error": "path escapes workspace"}
        if name == "fs.read":
            if target.is_dir():
                return {"ok": True, "entries": sorted(p.name for p in target.iterdir())}
            if not target.is_file():
                return {"ok": False, "error": "missing"}
            return {"ok": True, "content": target.read_text(encoding="utf-8", errors="replace")}
        if name == "fs.write":
            target.parent.mkdir(parents=True, exist_ok=True)
            data = str(args.get("content", ""))
            target.write_text(data, encoding="utf-8")
            return {"ok": True, "bytes": len(data)}
        return {"ok": False, "error": f"unknown tool {name}"}


def self_test(payload=None) -> dict:
    with tempfile.TemporaryDirectory(prefix="friday-project-scaffold-") as tmp:
        tools = _LocalTools(tmp)
        preview = asyncio.run(run(tools, folder="out", kind="node", apply=False, name="demo"))
        if not preview.get("ok") or not preview.get("dryRun"):
            raise RuntimeError("dry-run preview failed")
        applied = asyncio.run(run(tools, folder="out", kind="node", apply=True, name="demo"))
        if not applied.get("ok") or "out/package.json" not in applied.get("files", []):
            raise RuntimeError("apply did not write package.json")
        listing = asyncio.run(tools.execute("fs.read", {"path": "out"}))
        if "package.json" not in listing.get("entries", []):
            raise RuntimeError("package.json missing after apply")
        py = asyncio.run(run(tools, folder="pyout", kind="python", apply=True, name="demo"))
        if "pyout/pyproject.toml" not in py.get("files", []):
            raise RuntimeError("python scaffold missing pyproject.toml")
        return {"ok": True, "files": applied["files"]}
