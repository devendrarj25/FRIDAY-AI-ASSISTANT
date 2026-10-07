"""Read go.mod for the module path, go version, and require block count. Read-only."""

from __future__ import annotations

import asyncio
import tempfile

from pathlib import Path

MANIFEST = None


def register(manifest: dict) -> None:
    global MANIFEST
    MANIFEST = manifest


async def run(tools, path: str = "go.mod") -> dict:

    result = await tools.execute("fs.read", {"path": path})
    if not result.get("ok"):
        return result
    if "entries" in result and "content" not in result:
        return {"ok": False, "error": "path is a directory — pass a file"}
    content = str(result.get("content") or "")

    module = None
    version = None
    requires = []
    in_require = False
    for line in content.splitlines():
        stripped = line.strip()
        if stripped.startswith("module "):
            module = stripped.split(None, 1)[1]
        elif stripped.startswith("go "):
            version = stripped.split(None, 1)[1]
        elif stripped.startswith("require ("):
            in_require = True
        elif in_require and stripped == ")":
            in_require = False
        elif in_require or stripped.startswith("require "):
            token = stripped[len("require "):] if stripped.startswith("require ") else stripped
            if token:
                requires.append(token.split()[0])
    return {"ok": True, "path": path, "module": module, "go": version, "requireCount": len(requires), "requires": requires[:40]}


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
    with tempfile.TemporaryDirectory(prefix="friday-go-mod-line-") as tmp:
        Path(tmp, "go.mod").write_text("module example.com/demo\n\ngo 1.22\n\nrequire github.com/x/y v1.0.0\n", encoding="utf-8")
        result = asyncio.run(run(_LocalTools(tmp), path="go.mod"))
        if result.get("module") != "example.com/demo" or result.get("go") != "1.22":
            raise RuntimeError(result)
        return {"ok": True, "module": result["module"]}

