"""Count XML element tags and attributes with stdlib ElementTree. Read-only. Not for PDF/DOCX."""

from __future__ import annotations

import asyncio
import tempfile
from xml.etree import ElementTree as ET

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

    try:
        root = ET.fromstring(content)
    except ET.ParseError as exc:
        return {"ok": False, "error": str(exc)}
    counts = {}
    attrs = 0
    for el in root.iter():
        tag = el.tag.split("}")[-1]
        counts[tag] = counts.get(tag, 0) + 1
        attrs += len(el.attrib)
    ranked = sorted(({"tag": k, "count": v} for k, v in counts.items()), key=lambda item: -item["count"])
    return {"ok": True, "path": path, "root": root.tag.split("}")[-1], "tags": ranked, "attributeCount": attrs}


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
    with tempfile.TemporaryDirectory(prefix="friday-xml-tags-") as tmp:
        Path(tmp, "doc.xml").write_text("<root><item id=\"1\"/><item/><meta/></root>", encoding="utf-8")
        result = asyncio.run(run(_LocalTools(tmp), path="doc.xml"))
        item = next(row for row in result["tags"] if row["tag"] == "item")
        if item["count"] != 2 or result.get("attributeCount") != 1:
            raise RuntimeError(result)
        return {"ok": True, "root": result["root"]}

