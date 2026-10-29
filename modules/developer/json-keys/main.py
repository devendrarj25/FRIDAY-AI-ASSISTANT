"""Walk a JSON object/array and list unique key paths (dot notation) with value kinds. Read-only."""

from __future__ import annotations

import asyncio
import json
import tempfile

from pathlib import Path

MANIFEST = None


def register(manifest: dict) -> None:
    global MANIFEST
    MANIFEST = manifest


def _walk(node, prefix: str, acc: dict) -> None:
    if isinstance(node, dict):
        acc[prefix or "$"] = acc.get(prefix or "$", "object")
        for key, value in node.items():
            path = f"{prefix}.{key}" if prefix else key
            _walk(value, path, acc)
    elif isinstance(node, list):
        acc[prefix or "$"] = "array"
        if node:
            _walk(node[0], f"{prefix or '$'}[]", acc)
    elif node is None:
        acc[prefix] = "null"
    else:
        acc[prefix] = type(node).__name__


async def run(tools, path: str) -> dict:

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
    keys = {}
    _walk(data, "", keys)
    rows = [{"path": k, "kind": v} for k, v in sorted(keys.items()) if k]
    return {"ok": True, "path": path, "keys": rows, "keyCount": len(rows)}


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
    with tempfile.TemporaryDirectory(prefix="friday-json-keys-") as tmp:
        Path(tmp, "doc.json").write_text('{"user": {"id": 1, "tags": ["a"]}}', encoding="utf-8")
        result = asyncio.run(run(_LocalTools(tmp), path="doc.json"))
        paths = {item["path"] for item in result["keys"]}
        if "user.id" not in paths or "user.tags[]" not in paths:
            raise RuntimeError(result)
        return {"ok": True, "keyCount": result["keyCount"]}

