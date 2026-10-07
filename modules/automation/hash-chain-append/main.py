"""Append a SHA-256 chained NDJSON audit line. Dry-run returns the next record; apply appends .friday-hash-chain.ndjson. Stdlib hashlib only."""

from __future__ import annotations

import asyncio
import hashlib
import json
import tempfile
from datetime import datetime, timezone

from pathlib import Path

MANIFEST = None


def register(manifest: dict) -> None:
    global MANIFEST
    MANIFEST = manifest


async def run(tools, folder: str = ".", payload: str = "", apply: bool = False) -> dict:
    chain_rel = f"{folder.rstrip('/\\')}/.friday-hash-chain.ndjson" if folder not in ("", ".") else ".friday-hash-chain.ndjson"
    prev = ""
    existing = await tools.execute("fs.read", {"path": chain_rel})
    lines = []
    if existing.get("ok") and "content" in existing:
        lines = [ln for ln in str(existing.get("content") or "").splitlines() if ln.strip()]
        if lines:
            try:
                prev = json.loads(lines[-1]).get("hash") or ""
            except json.JSONDecodeError:
                prev = ""
    body = str(payload or "")
    digest = hashlib.sha256(f"{prev}\n{body}".encode("utf-8")).hexdigest()
    record = {
        "at": datetime.now(timezone.utc).isoformat(),
        "prev": prev,
        "hash": digest,
        "payloadSha256": hashlib.sha256(body.encode("utf-8")).hexdigest(),
        "n": len(lines) + 1,
    }
    if not apply:
        return {"ok": True, "dryRun": True, "record": record, "chainPath": chain_rel}
    text = (str(existing.get("content") or "") if existing.get("ok") else "")
    if text and not text.endswith("\n"):
        text += "\n"
    text += json.dumps(record) + "\n"
    written = await tools.execute("fs.write", {"path": chain_rel, "content": text})
    if not written.get("ok"):
        return written
    return {"ok": True, "dryRun": False, "record": record, "chainPath": chain_rel}


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
        if name == "fs.write":
            target.parent.mkdir(parents=True, exist_ok=True)
            data = str(args.get("content", ""))
            target.write_text(data, encoding="utf-8")
            return {"ok": True, "bytes": len(data)}
        return {"ok": False, "error": f"unknown tool {name}"}


def self_test(payload=None) -> dict:
    with tempfile.TemporaryDirectory(prefix="friday-hash-chain-append-") as tmp:
        tools = _LocalTools(tmp)
        first = asyncio.run(run(tools, folder=".", payload="alpha", apply=True))
        second = asyncio.run(run(tools, folder=".", payload="beta", apply=True))
        if second["record"]["prev"] != first["record"]["hash"] or second["record"]["n"] != 2:
            raise RuntimeError(second)
        if first["record"]["hash"] == second["record"]["hash"]:
            raise RuntimeError("chain did not change")
        return {"ok": True, "n": second["record"]["n"]}

