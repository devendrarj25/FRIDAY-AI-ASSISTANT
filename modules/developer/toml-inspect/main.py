"""Parse a TOML file with stdlib tomllib and report top-level keys and table names. Read-only."""

from __future__ import annotations

import asyncio
import tempfile
import tomllib


from pathlib import Path

MANIFEST = None


def register(manifest: dict) -> None:
    global MANIFEST
    MANIFEST = manifest


async def run(tools, path: str) -> dict:

    result = await tools.execute("fs.read", {"path": path})
    if not result.get("ok"):
        return result
    if "entries" in result and "content" not in result:
        return {"ok": False, "error": "path is a directory — pass a file"}
    content = str(result.get("content") or "")

    try:
        data = tomllib.loads(content)
    except tomllib.TOMLDecodeError as exc:
        return {"ok": False, "error": str(exc)}
    tables = sorted(k for k, v in data.items() if isinstance(v, dict))
    keys = sorted(data)
    return {"ok": True, "path": path, "keys": keys, "tables": tables, "keyCount": len(keys)}


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
    with tempfile.TemporaryDirectory(prefix="friday-toml-inspect-") as tmp:
        Path(tmp, "pyproject.toml").write_text('[project]\nname = "demo"\n\n[tool.ruff]\nline-length = 100\n', encoding="utf-8")
        result = asyncio.run(run(_LocalTools(tmp), path="pyproject.toml"))
        if "project" not in result.get("tables", []) or "tool" not in result.get("keys", []):
            raise RuntimeError(result)
        return {"ok": True, "tables": result["tables"]}

