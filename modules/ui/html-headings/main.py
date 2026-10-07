"""Extract h1–h6 text from an HTML file with stdlib html.parser. Read-only."""

from __future__ import annotations

import asyncio
import tempfile
from html.parser import HTMLParser

from pathlib import Path

MANIFEST = None


def register(manifest: dict) -> None:
    global MANIFEST
    MANIFEST = manifest


class _Headings(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.rows = []
        self._tag = None
        self._buf = []

    def handle_starttag(self, tag, attrs):
        if tag in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            self._tag = tag
            self._buf = []

    def handle_endtag(self, tag):
        if tag == self._tag:
            text = "".join(self._buf).strip()
            if text:
                self.rows.append({"tag": tag, "text": text, "level": int(tag[1])})
            self._tag = None
            self._buf = []

    def handle_data(self, data):
        if self._tag:
            self._buf.append(data)


async def run(tools, path: str) -> dict:

    result = await tools.execute("fs.read", {"path": path})
    if not result.get("ok"):
        return result
    if "entries" in result and "content" not in result:
        return {"ok": False, "error": "path is a directory — pass a file"}
    content = str(result.get("content") or "")

    parser = _Headings()
    parser.feed(content)
    return {"ok": True, "path": path, "headings": parser.rows, "headingCount": len(parser.rows)}


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
    with tempfile.TemporaryDirectory(prefix="friday-html-headings-") as tmp:
        Path(tmp, "page.html").write_text("<h1>FRIDAY</h1><p>x</p><h2>Modules</h2>", encoding="utf-8")
        result = asyncio.run(run(_LocalTools(tmp), path="page.html"))
        if [h["text"] for h in result["headings"]] != ["FRIDAY", "Modules"]:
            raise RuntimeError(result)
        return {"ok": True, "headingCount": result["headingCount"]}

