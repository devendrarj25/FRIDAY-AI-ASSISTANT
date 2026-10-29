"""List .github/workflows YAML files and the top-level name: / on: keys. Read-only; does not dispatch Actions."""

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


async def run(tools, folder: str = ".") -> dict:

    listing = await tools.execute("fs.read", {"path": folder})
    if not listing.get("ok"):
        return listing
    if "entries" not in listing:
        return {"ok": False, "error": "path is a file — pass a folder"}
    root = _resolve(tools, listing, folder)
    if root is None or not root.is_dir():
        return {"ok": False, "error": f"folder not found: {folder}"}

    gh = root / ".github" / "workflows"
    if not gh.is_dir():
        listing_ok = await tools.execute("fs.read", {"path": f"{folder.rstrip('/\\')}/.github"})
        if listing_ok.get("ok") is False:
            return {"ok": True, "folder": folder, "workflows": []}
        return {"ok": True, "folder": folder, "workflows": []}
    rows = []
    for path in sorted(gh.glob("*.y*ml")):
        rel = str(path.relative_to(root)).replace("\\", "/")
        got = await tools.execute("fs.read", {"path": f"{folder.rstrip('/\\')}/{rel}"})
        text = str(got.get("content") or "")
        name = None
        on_keys = []
        in_on = False
        for line in text.splitlines():
            if line.startswith("name:"):
                name = line.split(":", 1)[1].strip().strip("\"\'")
            if line.startswith("on:"):
                rest = line.split(":", 1)[1].strip()
                in_on = True
                if rest and rest not in ("|", ">"):
                    on_keys.append(rest.strip("[] ").split(",")[0].strip())
                continue
            if in_on:
                if line and not line.startswith(" ") and not line.startswith("\t"):
                    in_on = False
                elif line.strip().endswith(":") and not line.strip().startswith("-"):
                    on_keys.append(line.strip().rstrip(":"))
        rows.append({"file": path.name, "name": name, "on": [k for k in on_keys if k]})
    return {"ok": True, "folder": folder, "workflows": rows}


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
    with tempfile.TemporaryDirectory(prefix="friday-workflow-list-") as tmp:
        wf = Path(tmp) / ".github" / "workflows"
        wf.mkdir(parents=True)
        (wf / "ci.yml").write_text("name: PR Validation\non:\n  pull_request:\n  push:\n", encoding="utf-8")
        result = asyncio.run(run(_LocalTools(tmp), folder="."))
        if result["workflows"][0]["name"] != "PR Validation":
            raise RuntimeError(result)
        if "pull_request" not in result["workflows"][0]["on"]:
            raise RuntimeError(result)
        return {"ok": True, "name": result["workflows"][0]["name"]}

