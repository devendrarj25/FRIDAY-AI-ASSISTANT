"""Read tsconfig.json compilerOptions (target, module, strict, jsx, paths keys) and whether files/include exist. Strips JSON comments. Read-only."""

from __future__ import annotations

import asyncio
import json
import re
import tempfile

from pathlib import Path

MANIFEST = None


def register(manifest: dict) -> None:
    global MANIFEST
    MANIFEST = manifest


def _jsonc(text: str):
    stripped = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    stripped = re.sub(r"(^|\s)//.*?$", "", stripped, flags=re.M)
    return json.loads(stripped)


async def run(tools, path: str = "tsconfig.json") -> dict:

    result = await tools.execute("fs.read", {"path": path})
    if not result.get("ok"):
        return result
    if "entries" in result and "content" not in result:
        return {"ok": False, "error": "path is a directory — pass a file"}
    content = str(result.get("content") or "")

    try:
        data = _jsonc(content)
    except json.JSONDecodeError as exc:
        return {"ok": False, "error": f"tsconfig is not JSON: {exc}"}
    if not isinstance(data, dict):
        return {"ok": False, "error": "tsconfig root is not an object"}
    opts = data.get("compilerOptions") if isinstance(data.get("compilerOptions"), dict) else {}
    paths = opts.get("paths") if isinstance(opts.get("paths"), dict) else {}
    return {
        "ok": True,
        "path": path,
        "target": opts.get("target"),
        "module": opts.get("module"),
        "strict": opts.get("strict"),
        "jsx": opts.get("jsx"),
        "pathAliases": sorted(paths),
        "include": data.get("include"),
        "extends": data.get("extends"),
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
    with tempfile.TemporaryDirectory(prefix="friday-tsconfig-inspect-") as tmp:
        Path(tmp, "tsconfig.json").write_text(
            '{ "compilerOptions": { "target": "ES2022", "strict": true, "paths": { "@/*": ["src/*"] } }, "include": ["src"] }\n',
            encoding="utf-8",
        )
        result = asyncio.run(run(_LocalTools(tmp), path="tsconfig.json"))
        if result.get("target") != "ES2022" or result.get("strict") is not True:
            raise RuntimeError(result)
        if result.get("pathAliases") != ["@/*"]:
            raise RuntimeError(result)
        return {"ok": True, "target": result["target"]}

