"""Naive parse of docker-compose.yml / compose.yaml: service names under the services: key, and ports: lines. No PyYAML required. Read-only."""

from __future__ import annotations

import asyncio
import tempfile

from pathlib import Path

MANIFEST = None


def register(manifest: dict) -> None:
    global MANIFEST
    MANIFEST = manifest

def _resolve(tools, listing: dict, path: str):
    candidates = []
    if listing.get("path"):
        candidates.append(Path(str(listing["path"])))
    workspace = getattr(tools, "workspace", None)
    if workspace:
        candidates.append(Path(workspace) / path)
    candidates.append(Path(path))
    for item in candidates:
        try:
            if item.exists():
                return item
        except OSError:
            continue
    return None


def _parse_compose(text: str) -> dict:
    services = []
    ports = []
    in_services = False
    current = None
    for line in text.splitlines():
        if line.startswith("services:"):
            in_services = True
            continue
        if in_services and line and not line.startswith(" ") and not line.startswith("\t"):
            in_services = False
        if not in_services:
            continue
        if len(line) >= 3 and line.startswith("  ") and not line.startswith("    ") and line.rstrip().endswith(":"):
            name = line.strip().rstrip(":")
            if name and name not in ("volumes", "networks", "configs", "secrets"):
                current = name
                services.append(name)
        if "ports:" in line or (current and line.strip().startswith("-") and ":" in line and line.strip()[0] == "-"):
            if "ports" in line:
                continue
            token = line.strip().lstrip("- ").strip().strip("\"\'")
            if token and any(ch.isdigit() for ch in token):
                ports.append({"service": current, "mapping": token})
    return {"services": services, "ports": ports}


async def run(tools, folder: str = ".") -> dict:

    listing = await tools.execute("fs.read", {"path": folder})
    if not listing.get("ok"):
        return listing
    if "entries" not in listing:
        return {"ok": False, "error": "path is a file — pass a folder"}
    root = _resolve(tools, listing, folder)
    if root is None or not root.is_dir():
        return {"ok": False, "error": f"folder not found: {folder}"}

    names = listing.get("entries") or []
    chosen = None
    for candidate in ("docker-compose.yml", "docker-compose.yaml", "compose.yaml", "compose.yml"):
        if candidate in names:
            chosen = candidate
            break
    if not chosen:
        return {"ok": True, "folder": folder, "file": None, "services": [], "ports": []}
    got = await tools.execute("fs.read", {"path": f"{folder.rstrip('/\\')}/{chosen}"})
    parsed = _parse_compose(str(got.get("content") or ""))
    return {"ok": True, "folder": folder, "file": chosen, **parsed}


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
    with tempfile.TemporaryDirectory(prefix="friday-compose-service-list-") as tmp:
        Path(tmp, "docker-compose.yml").write_text(
            "services:\n  web:\n    image: nginx\n    ports:\n      - 8080:80\n  db:\n    image: postgres\n",
            encoding="utf-8",
        )
        result = asyncio.run(run(_LocalTools(tmp), folder="."))
        if result.get("services") != ["web", "db"]:
            raise RuntimeError(result)
        if not any(item.get("mapping") == "8080:80" for item in result.get("ports", [])):
            raise RuntimeError(result)
        return {"ok": True, "services": result["services"]}

