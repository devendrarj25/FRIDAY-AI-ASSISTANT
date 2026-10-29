"""Extract Markdown [text](url) links and classify relative vs http(s). Read-only; does not fetch."""

from __future__ import annotations

import asyncio
import re
import tempfile

from pathlib import Path

MANIFEST = None


def register(manifest: dict) -> None:
    global MANIFEST
    MANIFEST = manifest


_LINK = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")


async def run(tools, path: str) -> dict:

    result = await tools.execute("fs.read", {"path": path})
    if not result.get("ok"):
        return result
    if "entries" in result and "content" not in result:
        return {"ok": False, "error": "path is a directory — pass a file"}
    content = str(result.get("content") or "")

    links = []
    for text, url in _LINK.findall(content):
        kind = "http" if url.lower().startswith("http://") or url.lower().startswith("https://") else "relative"
        links.append({"text": text, "url": url, "kind": kind})
    return {"ok": True, "path": path, "links": links, "linkCount": len(links), "httpCount": sum(1 for item in links if item["kind"] == "http")}


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
    with tempfile.TemporaryDirectory(prefix="friday-markdown-links-") as tmp:
        Path(tmp, "doc.md").write_text("[docs](VERSIONING.md) and [gh](https://github.com/devendrarj25/FRIDAY-AI-ASSISTANT)", encoding="utf-8")
        result = asyncio.run(run(_LocalTools(tmp), path="doc.md"))
        if result.get("linkCount") != 2 or result.get("httpCount") != 1:
            raise RuntimeError(result)
        return {"ok": True, "linkCount": result["linkCount"]}

