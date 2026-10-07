"""List npm/pnpm/yarn script names from package.json plus name, private flag, and workspace hint. Read-only; does not run scripts."""

from __future__ import annotations

import asyncio
import json
import tempfile

from pathlib import Path

MANIFEST = None


def register(manifest: dict) -> None:
    global MANIFEST
    MANIFEST = manifest


async def run(tools, path: str = "package.json") -> dict:

    result = await tools.execute("fs.read", {"path": path})
    if not result.get("ok"):
        return result
    if "entries" in result and "content" not in result:
        return {"ok": False, "error": "path is a directory — pass a file"}
    content = str(result.get("content") or "")

    try:
        data = json.loads(content)
    except json.JSONDecodeError as exc:
        return {"ok": False, "error": str(exc)}
    if not isinstance(data, dict):
        return {"ok": False, "error": "package.json root is not an object"}
    scripts = data.get("scripts") if isinstance(data.get("scripts"), dict) else {}
    return {
        "ok": True,
        "path": path,
        "name": data.get("name"),
        "private": bool(data.get("private")),
        "scripts": sorted(scripts),
        "scriptCount": len(scripts),
        "hasWorkspaces": "workspaces" in data,
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
    with tempfile.TemporaryDirectory(prefix="friday-package-scripts-") as tmp:
        Path(tmp, "package.json").write_text(
            json.dumps({"name": "demo", "private": True, "scripts": {"test": "vitest", "lint": "eslint ."}}),
            encoding="utf-8",
        )
        result = asyncio.run(run(_LocalTools(tmp), path="package.json"))
        if result.get("scripts") != ["lint", "test"] or result.get("private") is not True:
            raise RuntimeError(result)
        return {"ok": True, "scripts": result["scripts"]}

