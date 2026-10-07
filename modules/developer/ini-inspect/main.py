"""Parse INI/CFG with configparser: section names and key names only (values omitted when a key looks like password/token/secret). Read-only."""

from __future__ import annotations

import asyncio
import configparser
import io
import tempfile

from pathlib import Path

MANIFEST = None


def register(manifest: dict) -> None:
    global MANIFEST
    MANIFEST = manifest


_SKIP = ("password", "passwd", "secret", "token", "api_key", "apikey")


async def run(tools, path: str) -> dict:

    result = await tools.execute("fs.read", {"path": path})
    if not result.get("ok"):
        return result
    if "entries" in result and "content" not in result:
        return {"ok": False, "error": "path is a directory — pass a file"}
    content = str(result.get("content") or "")

    parser = configparser.ConfigParser()
    try:
        parser.read_file(io.StringIO(content))
    except configparser.Error as exc:
        return {"ok": False, "error": str(exc)}
    sections = []
    for name in parser.sections():
        keys = []
        for key in parser.options(name):
            skipped = key.lower() in _SKIP
            item = {"key": key, "skipped": skipped}
            if not skipped:
                item["value"] = parser.get(name, key)
            keys.append(item)
        sections.append({"section": name, "keys": keys})
    return {"ok": True, "path": path, "sections": sections, "sectionCount": len(sections)}


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
    with tempfile.TemporaryDirectory(prefix="friday-ini-inspect-") as tmp:
        Path(tmp, "app.ini").write_text("[db]\nhost = localhost\npassword = nope\n", encoding="utf-8")
        result = asyncio.run(run(_LocalTools(tmp), path="app.ini"))
        keys = {item["key"]: item for item in result["sections"][0]["keys"]}
        if keys["host"]["value"] != "localhost" or "value" in keys["password"]:
            raise RuntimeError(result)
        return {"ok": True, "sectionCount": result["sectionCount"]}

