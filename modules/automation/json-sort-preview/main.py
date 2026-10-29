"""Recursively sort JSON object keys. Dry-run returns pretty JSON; apply writes the file in place via fs.write."""

from __future__ import annotations

import asyncio
import json
import tempfile

from pathlib import Path

MANIFEST = None


def register(manifest: dict) -> None:
    global MANIFEST
    MANIFEST = manifest


def _sort(node):
    if isinstance(node, dict):
        return {k: _sort(node[k]) for k in sorted(node)}
    if isinstance(node, list):
        return [_sort(item) for item in node]
    return node


async def run(tools, path: str, apply: bool = False) -> dict:

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
    ordered = _sort(data)
    pretty = json.dumps(ordered, indent=2) + "\n"
    if not apply:
        return {"ok": True, "dryRun": True, "path": path, "preview": pretty, "changed": pretty != (content if content.endswith("\n") else content + "\n")}
    written = await tools.execute("fs.write", {"path": path, "content": pretty})
    if not written.get("ok"):
        return written
    return {"ok": True, "dryRun": False, "path": path, "bytes": written.get("bytes")}


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
        if name == "fs.write":
            target.parent.mkdir(parents=True, exist_ok=True)
            data = str(args.get("content", ""))
            target.write_text(data, encoding="utf-8")
            return {"ok": True, "bytes": len(data)}
        return {"ok": False, "error": f"unknown tool {name}"}


def self_test(payload=None) -> dict:
    with tempfile.TemporaryDirectory(prefix="friday-json-sort-preview-") as tmp:
        Path(tmp, "doc.json").write_text('{"b": 1, "a": 2}', encoding="utf-8")
        tools = _LocalTools(tmp)
        preview = asyncio.run(run(tools, path="doc.json", apply=False))
        if not preview.get("preview", "").lstrip().startswith("{") or '"a"' not in preview["preview"]:
            raise RuntimeError(preview)
        applied = asyncio.run(run(tools, path="doc.json", apply=True))
        text = Path(tmp, "doc.json").read_text(encoding="utf-8")
        if list(json.loads(text).keys()) != ["a", "b"] or applied.get("dryRun"):
            raise RuntimeError(applied)
        return {"ok": True, "bytes": applied["bytes"]}

