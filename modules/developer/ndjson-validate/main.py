"""Validate each line of an NDJSON/JSONL file as JSON. Reports ok count, first errors, and object-vs-array mix. Distinct from table-inspect. Read-only."""

from __future__ import annotations

import asyncio
import json
import tempfile

from pathlib import Path

MANIFEST = None


def register(manifest: dict) -> None:
    global MANIFEST
    MANIFEST = manifest


async def run(tools, path: str, limit: int = 8) -> dict:

    result = await tools.execute("fs.read", {"path": path})
    if not result.get("ok"):
        return result
    if "entries" in result and "content" not in result:
        return {"ok": False, "error": "path is a directory — pass a file"}
    content = str(result.get("content") or "")

    ok_n = 0
    empty = 0
    errors = []
    kinds = {}
    for i, line in enumerate(content.splitlines(), 1):
        if not line.strip():
            empty += 1
            continue
        try:
            data = json.loads(line)
        except json.JSONDecodeError as exc:
            errors.append({"line": i, "error": str(exc)})
            if len(errors) >= max(1, int(limit)):
                continue
            continue
        ok_n += 1
        kind = type(data).__name__
        kinds[kind] = kinds.get(kind, 0) + 1
    return {"ok": True, "path": path, "validLines": ok_n, "emptyLines": empty, "errors": errors[: max(1, int(limit))], "errorCount": len(errors), "kinds": kinds}


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
    with tempfile.TemporaryDirectory(prefix="friday-ndjson-validate-") as tmp:
        Path(tmp, "rows.ndjson").write_text('{"a": 1}\nnot-json\n{"b": 2}\n', encoding="utf-8")
        result = asyncio.run(run(_LocalTools(tmp), path="rows.ndjson"))
        if result.get("validLines") != 2 or result.get("errorCount") != 1:
            raise RuntimeError(result)
        return {"ok": True, "errorCount": result["errorCount"]}

