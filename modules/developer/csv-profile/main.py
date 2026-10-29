"""Profile a CSV: delimiter, column names, inferred types (int/float/bool/empty/text), null counts, and unique counts. Distinct from table-inspect sample rows. Read-only."""

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


def _infer(values: list[str]) -> str:
    nonempty = [v for v in values if v != ""]
    if not nonempty:
        return "empty"
    if all(v.lower() in ("true", "false", "yes", "no") for v in nonempty):
        return "bool"
    try:
        [int(v) for v in nonempty]
        return "int"
    except ValueError:
        pass
    try:
        [float(v) for v in nonempty]
        return "float"
    except ValueError:
        return "text"


async def run(tools, path: str) -> dict:

    result = await tools.execute("fs.read", {"path": path})
    if not result.get("ok"):
        return result
    if "entries" in result and "content" not in result:
        return {"ok": False, "error": "path is a directory — pass a CSV file"}
    content = str(result.get("content") or "")

    sample = content.lstrip("\ufeff")
    try:
        dialect = csv.Sniffer().sniff(sample[:4096], delimiters=",;\t|")
        delimiter = dialect.delimiter
    except csv.Error:
        delimiter = ","
    reader = csv.DictReader(io.StringIO(sample), delimiter=delimiter)
    rows = [dict(row) for row in reader]
    columns = reader.fieldnames or []
    profile = []
    for col in columns:
        values = [str(row.get(col) or "").strip() for row in rows]
        uniques = sorted(set(values))
        profile.append({
            "column": col,
            "type": _infer(values),
            "nullCount": sum(1 for v in values if v == ""),
            "uniqueCount": len(uniques),
            "sample": uniques[:8],
        })
    return {"ok": True, "path": path, "delimiter": delimiter, "rowCount": len(rows), "columns": profile}


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
    with tempfile.TemporaryDirectory(prefix="friday-csv-profile-") as tmp:
        Path(tmp, "sales.csv").write_text("item,qty,ok\na,2,true\nb,5,false\n", encoding="utf-8")
        result = asyncio.run(run(_LocalTools(tmp), path="sales.csv"))
        types = {col["column"]: col["type"] for col in result["columns"]}
        if types.get("qty") != "int" or types.get("ok") != "bool" or result.get("rowCount") != 2:
            raise RuntimeError(result)
        return {"ok": True, "types": types}

