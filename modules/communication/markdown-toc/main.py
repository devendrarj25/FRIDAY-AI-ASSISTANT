"""Build a table of contents from ATX headings in a Markdown file, with GitHub-ish slugs. Read-only."""

from __future__ import annotations

import asyncio
import re
import tempfile

from pathlib import Path

MANIFEST = None


def register(manifest: dict) -> None:
    global MANIFEST
    MANIFEST = manifest


def _slug(text: str) -> str:
    value = text.lower()
    value = re.sub(r"[^a-z0-9\s-]", "", value)
    return re.sub(r"\s+", "-", value).strip("-")


async def run(tools, path: str) -> dict:

    result = await tools.execute("fs.read", {"path": path})
    if not result.get("ok"):
        return result
    if "entries" in result and "content" not in result:
        return {"ok": False, "error": "path is a directory — pass a file"}
    content = str(result.get("content") or "")

    toc = []
    for line in content.splitlines():
        if not line.startswith("#"):
            continue
        level = len(line) - len(line.lstrip("#"))
        text = line[level:].strip()
        if not text:
            continue
        toc.append({"level": level, "text": text, "slug": _slug(text)})
    return {"ok": True, "path": path, "toc": toc, "headingCount": len(toc)}


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
    with tempfile.TemporaryDirectory(prefix="friday-markdown-toc-") as tmp:
        Path(tmp, "doc.md").write_text("# Hello World\n\n## Next Step\n", encoding="utf-8")
        result = asyncio.run(run(_LocalTools(tmp), path="doc.md"))
        if result["toc"][0]["slug"] != "hello-world" or result.get("headingCount") != 2:
            raise RuntimeError(result)
        return {"ok": True, "headingCount": result["headingCount"]}

