"""CSV/JSON preview + normalize report.

Dry-run by default. Writes a report file only when apply=True.
"""

from __future__ import annotations

import asyncio
import csv
import io
import json
import tempfile
from pathlib import Path

MANIFEST = None


def register(manifest: dict) -> None:
    global MANIFEST
    MANIFEST = manifest


def _rows_from(path: str, content: str) -> list[dict]:
    lower = path.lower()
    if lower.endswith(".json"):
        data = json.loads(content)
        if isinstance(data, list):
            return [item if isinstance(item, dict) else {"value": item} for item in data]
        if isinstance(data, dict):
            return [data]
        return [{"value": data}]
    sample = content.lstrip("\ufeff")
    reader = csv.DictReader(io.StringIO(sample))
    return [dict(row) for row in reader]


def _normalize(rows: list[dict]) -> list[dict]:
    out = []
    for row in rows:
        cleaned = {}
        for key, value in row.items():
            label = str(key or "").strip().lower().replace(" ", "_")
            if not label:
                continue
            text = str(value).strip()
            cleaned[label] = text
        if cleaned:
            out.append(cleaned)
    return out


def _report_path(path: str) -> str:
    if path.lower().endswith(".json"):
        return path[: -len(".json")] + ".friday-import-report.json"
    if path.lower().endswith(".csv"):
        return path[: -len(".csv")] + ".friday-import-report.json"
    return f"{path}.friday-import-report.json"


async def run(tools, path: str, apply: bool = False) -> dict:
    result = await tools.execute("fs.read", {"path": path})
    if not result.get("ok"):
        return result
    if "entries" in result:
        return {"ok": False, "error": "path is a directory — pass a CSV or JSON file"}
    rows = _normalize(_rows_from(path, str(result.get("content") or "")))
    columns = sorted({key for row in rows for key in row})
    target = _report_path(path)
    report = {
        "source": path,
        "rowCount": len(rows),
        "columns": columns,
        "sample": rows[:8],
    }
    if not apply:
        return {"ok": True, "dryRun": True, "reportPath": target, **report}
    written = await tools.execute(
        "fs.write",
        {"path": target, "content": json.dumps(report, indent=2) + "\n"},
    )
    if not written.get("ok"):
        return written
    return {"ok": True, "dryRun": False, "reportPath": target, **report}


class _LocalTools:
    def __init__(self, root: str) -> None:
        self.root = Path(root)

    async def execute(self, name: str, args: dict, **_kwargs) -> dict:
        target = (self.root / str(args.get("path", "."))).resolve()
        try:
            target.relative_to(self.root.resolve())
        except ValueError:
            return {"ok": False, "error": "path escapes workspace"}
        if name == "fs.read":
            if target.is_dir():
                return {"ok": True, "entries": sorted(p.name for p in target.iterdir())}
            if not target.is_file():
                return {"ok": False, "error": "missing"}
            return {"ok": True, "content": target.read_text(encoding="utf-8", errors="replace")}
        if name == "fs.write":
            target.parent.mkdir(parents=True, exist_ok=True)
            data = str(args.get("content", ""))
            target.write_text(data, encoding="utf-8")
            return {"ok": True, "bytes": len(data)}
        return {"ok": False, "error": f"unknown tool {name}"}


def self_test(payload=None) -> dict:
    with tempfile.TemporaryDirectory(prefix="friday-data-normalize-") as tmp:
        src = Path(tmp) / "sales.csv"
        src.write_text(" Name , Qty \n Alpha , 2 \n", encoding="utf-8")
        tools = _LocalTools(tmp)
        preview = asyncio.run(run(tools, path="sales.csv", apply=False))
        if not preview.get("dryRun") or preview.get("columns") != ["name", "qty"]:
            raise RuntimeError(preview)
        applied = asyncio.run(run(tools, path="sales.csv", apply=True))
        if applied.get("dryRun") or not Path(tmp, "sales.friday-import-report.json").is_file():
            raise RuntimeError(applied)
        return {"ok": True, "rowCount": applied["rowCount"]}
