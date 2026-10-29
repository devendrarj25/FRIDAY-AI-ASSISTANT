"""Naive first-level YAML key: scanner (no PyYAML). Useful for compose/workflow-adjacent files. Read-only."""

from __future__ import annotations

import asyncio
import tempfile

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

    keys = []
    for line in content.splitlines():
        if not line or line.startswith(" ") or line.startswith("\t") or line.startswith("#") or line.startswith("-"):
            continue
        if ":" not in line:
            continue
        key = line.split(":", 1)[0].strip()
        if key and key not in keys:
            keys.append(key)
    return {"ok": True, "path": path, "keys": keys, "keyCount": len(keys)}


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
    with tempfile.TemporaryDirectory(prefix="friday-yaml-keys-") as tmp:
        Path(tmp, "app.yml").write_text("name: demo\nversion: 1\n  nested: skip\n", encoding="utf-8")
        result = asyncio.run(run(_LocalTools(tmp), path="app.yml"))
        if result.get("keys") != ["name", "version"]:
            raise RuntimeError(result)
        return {"ok": True, "keys": result["keys"]}

