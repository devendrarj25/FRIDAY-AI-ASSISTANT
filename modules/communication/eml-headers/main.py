"""Read From/To/Cc/Subject/Date from a local .eml file via stdlib email. Does not download mail or dump bodies."""

from __future__ import annotations

import asyncio
import email
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

    message = email.message_from_string(content)
    headers = {}
    for key in ("From", "To", "Cc", "Subject", "Date", "Message-ID"):
        value = message.get(key)
        if value:
            headers[key] = value
    return {"ok": True, "path": path, "headers": headers, "hasBody": bool(message.get_payload())}


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
    with tempfile.TemporaryDirectory(prefix="friday-eml-headers-") as tmp:
        Path(tmp, "note.eml").write_text(
            "From: a@example.com\nTo: b@example.com\nSubject: Hello\n\nBody here\n",
            encoding="utf-8",
        )
        result = asyncio.run(run(_LocalTools(tmp), path="note.eml"))
        if result["headers"].get("Subject") != "Hello" or result["headers"].get("From") != "a@example.com":
            raise RuntimeError(result)
        return {"ok": True, "subject": result["headers"]["Subject"]}

