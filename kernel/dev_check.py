"""Try a proposed change on a throwaway copy, and say what it did to a named check.

This is the sandbox step of controlled self-development. A proposal is a unified diff. It is applied to a
detached git worktree made from HEAD in a temp folder outside the repository, one fixed check is run there
and, for comparison, on a second untouched worktree, and both are deleted. The repository's own files and
branch are never touched, nothing is committed, and a change to a protected file is refused before anything
is applied. The check is one of a short fixed list, never a command taken from the proposal. The tool is
exec tier, so the owner approves it each time.

HEAD is what is compared: changes the owner has not committed yet are not in the copy, and the result says so.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from env_guard import child_env

MAX_DIFF = 500_000
TAIL = 4000

#: Never changed by a proposal, whatever else it does. The policy files are also read from governance.ts.
FIXED_BLOCKED = (
    "agents.md",
    "claude.md",
    "config/friday-version.json",
    "scripts/identity.cjs",
    "kernel/authority.py",
    "kernel/billing.py",
    "kernel/env_guard.py",
)
BLOCKED_PREFIXES = (".github/", ".git/", "node_modules/")

CHECKS: dict[str, list[str]] = {
    "pytest": [sys.executable, "-m", "pytest", "-q", "-x", "-p", "no:cacheprovider"],
    "typecheck": ["npm", "run", "typecheck"],
    "lint": ["npm", "run", "lint"],
    "test-fast": ["npm", "run", "test:fast"],
}


def protected_files(repo: Path) -> set[str]:
    out: set[str] = set(FIXED_BLOCKED)
    gov = repo / "src/lib/friday/self/governance.ts"
    if gov.is_file():
        block = re.search(r"PROTECTED_POLICY_FILES[^=]*=\s*\[(.*?)\]", gov.read_text(encoding="utf-8"), re.S)
        if block:
            out.update(m.lower() for m in re.findall(r'"([^"]+)"', block.group(1)))
    return out


def diff_paths(diff: str) -> list[str]:
    paths: set[str] = set()
    for line in diff.splitlines():
        for prefix in ("--- ", "+++ "):
            if line.startswith(prefix):
                raw = line[len(prefix) :].split("\t")[0].strip()
                if raw and raw != "/dev/null":
                    paths.add(re.sub(r"^[ab]/", "", raw))
        for rename in re.finditer(r"^(?:rename|copy) (?:from|to) (.+)$", line):
            paths.add(rename.group(1).strip())
    return sorted(paths)


def refusal(repo: Path, diff: str) -> str | None:
    paths = diff_paths(diff)
    if not paths:
        return "the proposal names no file"
    blocked = protected_files(repo)
    for path in paths:
        norm = re.sub(r"^(\./)+", "", path.replace("\\", "/")).lower()
        if path.startswith("/") or ".." in Path(path).parts or re.match(r"^[a-z]:", path, re.I):
            return f"{path} is outside the repository"
        if norm in blocked or any(norm.startswith(prefix) for prefix in BLOCKED_PREFIXES):
            return f"{path} is protected: a proposal never changes it"
    return None


def _git(args: list[str], cwd: Path, stdin: str | None = None, timeout: int = 120) -> subprocess.CompletedProcess:
    return subprocess.run(  # noqa: S603 - argv form, fixed git subcommands
        ["git", *args],
        cwd=cwd,
        input=stdin,
        capture_output=True,
        text=True,
        timeout=timeout,
        env=child_env(),
        check=False,
    )


def _run_check(name: str, cwd: Path, timeout: int) -> dict:
    try:
        run = subprocess.run(  # noqa: S603 - argv from the fixed CHECKS table
            CHECKS[name], cwd=cwd, capture_output=True, text=True, timeout=timeout, env=child_env(), check=False
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "exit": None, "timedOut": True, "tail": f"the check ran longer than {timeout} seconds"}
    except OSError as exc:
        return {"ok": False, "exit": None, "timedOut": False, "tail": f"could not start the check: {exc}"}
    return {
        "ok": run.returncode == 0,
        "exit": run.returncode,
        "timedOut": False,
        "tail": (run.stdout + run.stderr)[-TAIL:],
    }


def _link_modules(repo: Path, tree: Path) -> None:
    source = repo / "node_modules"
    target = tree / "node_modules"
    if source.is_dir() and not target.exists():
        try:
            target.symlink_to(source, target_is_directory=True)
        except OSError:
            pass  # a check that needs it will say so


def check_proposal(repo: Path, diff: str, check: str, baseline: bool = True, timeout: int = 900) -> dict:
    if check not in CHECKS:
        return {"ok": False, "error": f"check must be one of: {', '.join(CHECKS)}"}
    if len(diff) > MAX_DIFF:
        return {"ok": False, "error": f"the proposal is larger than {MAX_DIFF // 1000} KB"}
    reason = refusal(repo, diff)
    if reason:
        return {"ok": False, "error": reason, "cause": "refused"}
    if _git(["rev-parse", "--is-inside-work-tree"], repo).returncode != 0:
        return {"ok": False, "error": "this is not a git repository"}
    scratch = Path(tempfile.mkdtemp(prefix="friday-devcheck-"))
    trees: list[Path] = []
    try:

        def make(name: str) -> Path | None:
            tree = scratch / name
            if _git(["worktree", "add", "--detach", str(tree), "HEAD"], repo).returncode != 0:
                return None
            trees.append(tree)
            return tree

        after_tree = make("after")
        if after_tree is None:
            return {"ok": False, "error": "could not make a throwaway copy of HEAD"}
        patch = diff if diff.endswith("\n") else diff + "\n"
        dry = _git(["apply", "--check", "--whitespace=nowarn", "-"], after_tree, stdin=patch)
        if dry.returncode != 0:
            return {
                "ok": False,
                "applied": False,
                "error": "the proposal does not apply to HEAD",
                "detail": dry.stderr[-TAIL:],
            }
        applied = _git(["apply", "--whitespace=nowarn", "-"], after_tree, stdin=patch)
        if applied.returncode != 0:
            return {
                "ok": False,
                "applied": False,
                "error": "the proposal could not be applied",
                "detail": applied.stderr[-TAIL:],
            }
        _link_modules(repo, after_tree)
        before: dict | None = None
        if baseline:
            before_tree = make("before")
            if before_tree is not None:
                _link_modules(repo, before_tree)
                before = _run_check(check, before_tree, timeout)
        after = _run_check(check, after_tree, timeout)
        if before is None:
            verdict = "passes" if after["ok"] else "fails"
        elif before["ok"] and after["ok"]:
            verdict = "unchanged-pass"
        elif before["ok"] and not after["ok"]:
            verdict = "regressed"
        elif not before["ok"] and after["ok"]:
            verdict = "fixed"
        else:
            verdict = "unchanged-fail"
        return {
            "ok": True,
            "applied": True,
            "check": check,
            "verdict": verdict,
            "before": before,
            "after": after,
            "files": diff_paths(patch),
            "note": "compared against HEAD; changes not yet committed are not in the copy",
        }
    finally:
        for tree in trees:
            _git(["worktree", "remove", "--force", str(tree)], repo)
        _git(["worktree", "prune"], repo)
        shutil.rmtree(scratch, ignore_errors=True)
