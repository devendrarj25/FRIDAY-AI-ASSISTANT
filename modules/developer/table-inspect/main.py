"""CSV / JSON / NDJSON schema inspector.

Read-only via kernel fs.read. Does not duplicate document-extract (PDF/DOCX/XLSX).
"""

from __future__ import annotations

import asyncio
import csv
import io
import json
import tempfile
from pathlib import Path

MANIFEST = None
SAMPLE_ROWS = 5


def register(manifest: dict) -> None:
    global MANIFEST
    MANIFEST = manifest


def _kind(path: str, content: str) -> str:
    lower = path.lower()
    if lower.endswith(".csv") or lower.endswith(".tsv"):
        return "csv"
    if lower.endswith(".ndjson") or lower.endswith(".jsonl"):
        return "ndjson"
    stripped = content.lstrip()
    if stripped.startswith("{") or stripped.startswith("["):
        return "json"
    if "\n{" in content or content.startswith("{") and "\n" in content:
        return "ndjson"
    return "csv"


def _inspect_csv(content: str) -> dict:
    sample = content.lstrip("\ufeff")
    try:
        dialect = csv.Sniffer().sniff(sample[:4096] if len(sample) > 64 else sample + "\n,")
    except csv.Error:
        dialect = csv.excel
    reader = csv.DictReader(io.StringIO(sample), dialect=dialect)
    rows = []
    for i, row in enumerate(reader):
        if i >= 2000:
            break
        rows.append(row)
    columns = list(reader.fieldnames or [])
    return {
        "format": "csv",
        "columns": columns,
        "rowCount": len(rows),
        "sample": rows[:SAMPLE_ROWS],
    }


def _inspect_json(content: str) -> dict:
    data = json.loads(content)
    if isinstance(data, list):
        rows = [item for item in data if isinstance(item, dict)]
        columns = sorted({key for row in rows[:200] for key in row})
        return {"format": "json-array", "columns": columns, "rowCount": len(data), "sample": rows[:SAMPLE_ROWS]}
    if isinstance(data, dict):
        return {"format": "json-object", "columns": sorted(data.keys()), "rowCount": 1, "sample": [data]}
    return {"format": "json", "columns": [], "rowCount": 1, "sample": [data]}


def _inspect_ndjson(content: str) -> dict:
    rows = []
    for line in content.splitlines():
        if not line.strip():
            continue
        rows.append(json.loads(line))
        if len(rows) >= 2000:
            break
    objects = [row for row in rows if isinstance(row, dict)]
    columns = sorted({key for row in objects[:200] for key in row})
    return {"format": "ndjson", "columns": columns, "rowCount": len(rows), "sample": objects[:SAMPLE_ROWS]}


async def run(tools, path: str) -> dict:
    result = await tools.execute("fs.read", {"path": path})
    if not result.get("ok"):
        return result
    if "entries" in result:
        return {"ok": False, "error": "path is a directory — pass a CSV, JSON, or NDJSON file"}
    content = str(result.get("content") or "")
    kind = _kind(path, content)
    try:
        if kind == "csv":
            inspected = _inspect_csv(content)
        elif kind == "ndjson":
            inspected = _inspect_ndjson(content)
        else:
            inspected = _inspect_json(content)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "path": path, **inspected}


class _LocalTools:
    def __init__(self, root: str) -> None:
        self.root = Path(root)

    async def execute(self, name: str, args: dict, **_kwargs) -> dict:
        target = (self.root / str(args.get("path", "."))).resolve()
        try:
            target.relative_to(self.root.resolve())
        except ValueError:
            return {"ok": False, "error": "path escapes workspace"}
        if name != "fs.read":
            return {"ok": False, "error": f"unknown tool {name}"}
        if target.is_dir():
            return {"ok": True, "entries": sorted(p.name for p in target.iterdir())}
        if not target.is_file():
            return {"ok": False, "error": "missing"}
        return {"ok": True, "content": target.read_text(encoding="utf-8", errors="replace")}


def self_test(payload=None) -> dict:
    with tempfile.TemporaryDirectory(prefix="friday-table-inspect-") as tmp:
        csv_path = Path(tmp) / "rows.csv"
        csv_path.write_text("name,qty\nalpha,2\nbeta,3\n", encoding="utf-8")
        json_path = Path(tmp) / "rows.json"
        json_path.write_text('[{"name":"alpha","qty":2},{"name":"beta","qty":3}]', encoding="utf-8")
        tools = _LocalTools(tmp)
        csv_result = asyncio.run(run(tools, path="rows.csv"))
        if csv_result.get("rowCount") != 2 or csv_result.get("columns") != ["name", "qty"]:
            raise RuntimeError(csv_result)
        json_result = asyncio.run(run(tools, path="rows.json"))
        if json_result.get("rowCount") != 2:
            raise RuntimeError(json_result)
        return {"ok": True, "csv": csv_result["rowCount"], "json": json_result["rowCount"]}
