"""Summarise VEVENT SUMMARY/DTSTART/DTEND/LOCATION from a local .ics file. Naive line parser, no calendar write."""

from __future__ import annotations

import asyncio
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

    events = []
    current = None
    for raw in content.splitlines():
        line = raw.strip()
        if line == "BEGIN:VEVENT":
            current = {}
            continue
        if line == "END:VEVENT" and current is not None:
            events.append(current)
            current = None
            continue
        if current is None or ":" not in line:
            continue
        key, value = line.split(":", 1)
        key = key.split(";", 1)[0].upper()
        if key in {"SUMMARY", "DTSTART", "DTEND", "LOCATION", "UID"}:
            current[key.lower()] = value
    return {"ok": True, "path": path, "events": events, "eventCount": len(events)}


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
    with tempfile.TemporaryDirectory(prefix="friday-ics-summary-") as tmp:
        Path(tmp, "cal.ics").write_text(
            "BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:Standup\nDTSTART:20260906T090000Z\nEND:VEVENT\nEND:VCALENDAR\n",
            encoding="utf-8",
        )
        result = asyncio.run(run(_LocalTools(tmp), path="cal.ics"))
        if result.get("eventCount") != 1 or result["events"][0].get("summary") != "Standup":
            raise RuntimeError(result)
        return {"ok": True, "eventCount": result["eventCount"]}

