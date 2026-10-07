"""Read Cargo.toml for [package] name and [[bin]] name entries. Distinct from stack-audit (which only flags Cargo.toml presence). Read-only."""

from __future__ import annotations

import asyncio
import tempfile

from pathlib import Path

MANIFEST = None


def register(manifest: dict) -> None:
    global MANIFEST
    MANIFEST = manifest


async def run(tools, path: str = "Cargo.toml") -> dict:

    result = await tools.execute("fs.read", {"path": path})
    if not result.get("ok"):
        return result
    if "entries" in result and "content" not in result:
        return {"ok": False, "error": "path is a directory — pass a file"}
    content = str(result.get("content") or "")

    package = None
    bins = []
    section = None
    pending_bin = None
    for line in content.splitlines():
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            if pending_bin:
                bins.append(pending_bin)
                pending_bin = None
            section = stripped
            if section == "[[bin]]":
                pending_bin = {}
            continue
        if "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"')
        if section == "[package]" and key == "name":
            package = value
        if section == "[[bin]]" and pending_bin is not None:
            pending_bin[key] = value
    if pending_bin:
        bins.append(pending_bin)
    return {"ok": True, "path": path, "package": package, "bins": bins, "binNames": [b.get("name") for b in bins if b.get("name")]}


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
    with tempfile.TemporaryDirectory(prefix="friday-cargo-bin-names-") as tmp:
        Path(tmp, "Cargo.toml").write_text(
            '[package]\nname = "demo"\n\n[[bin]]\nname = "cli"\npath = "src/main.rs"\n',
            encoding="utf-8",
        )
        result = asyncio.run(run(_LocalTools(tmp), path="Cargo.toml"))
        if result.get("package") != "demo" or result.get("binNames") != ["cli"]:
            raise RuntimeError(result)
        return {"ok": True, "binNames": result["binNames"]}

