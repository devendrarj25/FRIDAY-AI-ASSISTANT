"""Sniff comma/semicolon/tab/pipe on a CSV/TSV sample and report dialect plus header names. Read-only."""

from __future__ import annotations

import asyncio
import csv
import io
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

    sample = content.lstrip("\ufeff")
    try:
        dialect = csv.Sniffer().sniff(sample[:8192], delimiters=",;\t|")
        delimiter = dialect.delimiter
        quote = dialect.quotechar
    except csv.Error:
        delimiter = ","
        quote = '"'
    header = next(csv.reader(io.StringIO(sample.splitlines()[0] if sample else ""), delimiter=delimiter), [])
    return {"ok": True, "path": path, "delimiter": delimiter, "quote": quote, "headers": header, "headerCount": len(header)}


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
    with tempfile.TemporaryDirectory(prefix="friday-csv-delimiter-detect-") as tmp:
        Path(tmp, "rows.csv").write_text("a;b;c\n1;2;3\n", encoding="utf-8")
        result = asyncio.run(run(_LocalTools(tmp), path="rows.csv"))
        if result.get("delimiter") != ";" or result.get("headers") != ["a", "b", "c"]:
            raise RuntimeError(result)
        return {"ok": True, "delimiter": result["delimiter"]}

