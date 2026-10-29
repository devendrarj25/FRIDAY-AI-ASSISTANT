"""Read git status --porcelain -b through the kernel git tool and summarise the branch, staged/unstaged/untracked counts, and sample paths. Does not clone or commit."""

from __future__ import annotations

import asyncio
import tempfile

from pathlib import Path

MANIFEST = None


def register(manifest: dict) -> None:
    global MANIFEST
    MANIFEST = manifest


async def run(tools, folder: str = ".") -> dict:
    result = await tools.execute("git", {"args": ["-C", folder, "status", "--porcelain=v1", "-b"]})
    if not result.get("ok"):
        return result
    lines = str(result.get("stdout") or "").splitlines()
    branch = ""
    staged = []
    unstaged = []
    untracked = []
    for line in lines:
        if line.startswith("##"):
            branch = line[2:].strip()
            continue
        if line.startswith("??"):
            untracked.append(line[3:].strip())
            continue
        if len(line) >= 2:
            x, y = line[0], line[1]
            path = line[3:].strip() if len(line) > 3 else line.strip()
            if x not in (" ", "?"):
                staged.append(path)
            if y not in (" ", "?"):
                unstaged.append(path)
    return {
        "ok": True,
        "folder": folder,
        "branch": branch,
        "staged": staged[:40],
        "unstaged": unstaged[:40],
        "untracked": untracked[:40],
        "counts": {"staged": len(staged), "unstaged": len(unstaged), "untracked": len(untracked)},
        "clean": not (staged or unstaged or untracked),
    }


class _LocalTools:
    def __init__(self, root: str, git_stdout: str = "") -> None:
        self.root = Path(root)
        self.workspace = self.root
        self.git_stdout = git_stdout

    async def execute(self, name: str, args: dict, **_kwargs) -> dict:
        if name == "git":
            return {"ok": True, "stdout": self.git_stdout, "stderr": "", "code": 0}
        target = (self.root / str(args.get("path", "."))).resolve()
        try:
            target.relative_to(self.root.resolve())
        except ValueError:
            return {"ok": False, "error": "path escapes workspace"}
        if name != "fs.read":
            return {"ok": False, "error": f"unknown tool {name}"}
        if target.is_dir():
            return {"ok": True, "entries": sorted(p.name for p in target.iterdir()), "path": str(target)}
        if not target.is_file():
            return {"ok": False, "error": "missing"}
        return {"ok": True, "path": str(target), "content": target.read_text(encoding="utf-8", errors="replace")}


def self_test(payload=None) -> dict:
    with tempfile.TemporaryDirectory(prefix="friday-git-status-report-") as tmp:
        stdout = "## main...origin/main\n M src/app.ts\nA  README.md\n?? scratch.txt\n"
        tools = _LocalTools(tmp, git_stdout=stdout)
        result = asyncio.run(run(tools, folder="."))
        if result.get("counts") != {"staged": 1, "unstaged": 1, "untracked": 1}:
            raise RuntimeError(result)
        if result.get("clean"):
            raise RuntimeError(result)
        return {"ok": True, "branch": result["branch"], "counts": result["counts"]}

