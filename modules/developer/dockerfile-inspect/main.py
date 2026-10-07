"""Parse a Dockerfile for FROM, USER, EXPOSE, WORKDIR, COPY/ADD counts and whether a non-root USER is set. Read-only; does not build images."""

from __future__ import annotations

import asyncio
import tempfile

from pathlib import Path

MANIFEST = None


def register(manifest: dict) -> None:
    global MANIFEST
    MANIFEST = manifest


async def run(tools, path: str = "Dockerfile") -> dict:

    result = await tools.execute("fs.read", {"path": path})
    if not result.get("ok"):
        return result
    if "entries" in result and "content" not in result:
        return {"ok": False, "error": "path is a directory — pass a file"}
    content = str(result.get("content") or "")

    froms = []
    users = []
    exposes = []
    workdirs = []
    copy_add = 0
    runs = 0
    for line in content.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        verb, _, rest = stripped.partition(" ")
        verb = verb.upper()
        if verb == "FROM":
            froms.append(rest.strip())
        elif verb == "USER":
            users.append(rest.strip())
        elif verb == "EXPOSE":
            exposes.extend(rest.split())
        elif verb == "WORKDIR":
            workdirs.append(rest.strip())
        elif verb in ("COPY", "ADD"):
            copy_add += 1
        elif verb == "RUN":
            runs += 1
    last_user = users[-1] if users else None
    return {
        "ok": True,
        "path": path,
        "from": froms,
        "user": last_user,
        "nonRootUser": bool(last_user and last_user not in ("root", "0")),
        "expose": exposes,
        "workdir": workdirs[-1] if workdirs else None,
        "copyAddCount": copy_add,
        "runCount": runs,
    }


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
    with tempfile.TemporaryDirectory(prefix="friday-dockerfile-inspect-") as tmp:
        Path(tmp, "Dockerfile").write_text(
            "FROM python:3.12-slim\nWORKDIR /app\nCOPY . .\nUSER app\nEXPOSE 8000\nRUN pip install .\n",
            encoding="utf-8",
        )
        result = asyncio.run(run(_LocalTools(tmp), path="Dockerfile"))
        if result.get("from") != ["python:3.12-slim"] or not result.get("nonRootUser"):
            raise RuntimeError(result)
        if result.get("expose") != ["8000"] or result.get("runCount") != 1:
            raise RuntimeError(result)
        return {"ok": True, "user": result["user"]}

