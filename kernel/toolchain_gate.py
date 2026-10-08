"""Plans for FRIDAY's own tools. The process environment is never replaced."""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "config" / "toolchain-manifest.json"

DENIED = {"torch", "vllm", "vosk", "piper-tts", "kokoro-onnx", "sherpa-onnx", "silero-vad"}
KNOWN = {
    "pip",
    "faster-whisper",
    "edge-tts",
    "numpy",
    "httpx",
    "supertonic",
}


def load_manifest() -> dict:
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def _distance(left: str, right: str) -> int:
    if abs(len(left) - len(right)) > 2:
        return 3
    previous = list(range(len(right) + 1))
    for i, a in enumerate(left, start=1):
        current = [i]
        for j, b in enumerate(right, start=1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a != b)))
        previous = current
    return previous[-1]


def typosquat(name: str) -> str | None:
    for known in KNOWN:
        if name != known and _distance(name, known) == 1:
            return known
    return None


def contained(workspace: Path, raw: str) -> Path:
    root = workspace.resolve()
    target = (root / raw).resolve()
    if target != root and root not in target.parents:
        raise PermissionError("path escapes the workspace root")
    return target


def isolated_env(present: dict[str, str], preference: str = "bundled-first") -> dict[str, str]:
    manifest = load_manifest()
    rank = {"bundled": 0, "on-demand": 1, "external": 2}
    if preference == "on-demand-first":
        rank = {"on-demand": 0, "bundled": 1, "external": 2}
    if preference == "system-first":
        rank = {"external": 0, "on-demand": 1, "bundled": 2}
    packs = sorted(manifest["packs"], key=lambda pack: rank.get(pack["tier"], 9))
    dirs = [present[pack["id"]] for pack in packs if present.get(pack["id"])]
    return {"PATH": ";".join(dirs), "FRIDAY_TOOLCHAIN": "1"}


def plan_pip(action: str, args: dict, workspace: Path) -> dict:
    package = str(args.get("package") or "").strip().lower()
    if action in {"install", "uninstall"} and not package:
        return {"ok": False, "error": "missing package", "cause": "usage"}
    if package in DENIED:
        return {"ok": False, "error": f"{package} is not installed by FRIDAY", "cause": "denied"}
    close = typosquat(package) if package else None
    if close:
        return {"ok": False, "error": f"{package} looks like {close}", "cause": "typosquat"}
    if package and package not in KNOWN and action == "install" and args.get("level") != "full":
        return {"ok": False, "error": "package is not on the allow list", "cause": "allow"}
    exe = str(args.get("python") or "")
    if not exe:
        return {"ok": False, "error": "FRIDAY Python is not in the runtime folder", "cause": "no-python", "fatal": False}
    argv = [exe, "-m", "pip", action]
    if package:
        argv.append(package)
    if action == "install":
        argv.extend(["--dry-run"] if not args.get("confirm") else [])
    try:
        if args.get("path"):
            contained(workspace, str(args["path"]))
    except PermissionError as exc:
        return {"ok": False, "error": str(exc), "cause": "path"}
    return {
        "ok": True,
        "argv": argv,
        "dryRun": action == "install" and not args.get("confirm"),
        "cwd": str(workspace),
        "cause": "ok",
    }


def plan_node(action: str, args: dict, workspace: Path) -> dict:
    node = str(args.get("node") or "")
    npm = str(args.get("npm") or "npm")
    cache = str(workspace / ".friday-npm-cache")
    if action == "script":
        if not node:
            return {"ok": False, "error": "portable Node is not in the runtime folder", "cause": "missing", "fatal": False}
        script = str(args.get("script") or "")
        try:
            target = contained(workspace, script)
        except PermissionError as exc:
            return {"ok": False, "error": str(exc), "cause": "path"}
        return {"ok": True, "argv": [node, str(target)], "cwd": str(workspace), "dryRun": False}
    if action == "npm-run":
        script = str(args.get("script") or "")
        return {
            "ok": True,
            "argv": [npm, "run", script, "--cache", cache, "--prefix", str(workspace)],
            "cwd": str(workspace),
            "dryRun": False,
        }
    package = str(args.get("package") or "")
    argv = [npm, "install", "--cache", cache, "--prefix", str(workspace)]
    if package:
        argv.append(package)
    return {
        "ok": True,
        "argv": argv,
        "cwd": str(workspace),
        "dryRun": not args.get("confirm"),
    }


def plan_cpp(action: str, args: dict, workspace: Path) -> dict:
    compiler = str(args.get("compiler") or "")
    if not compiler:
        return {"ok": False, "error": "the C toolchain is not in the runtime folder", "cause": "missing", "fatal": False}
    source = str(args.get("source") or "")
    try:
        src = contained(workspace, source)
        out = contained(workspace, str(args.get("output") or "a.exe"))
    except PermissionError as exc:
        return {"ok": False, "error": str(exc), "cause": "path"}
    if action == "build":
        return {"ok": True, "argv": [compiler, str(src), "-o", str(out)], "cwd": str(workspace), "timeout": 20}
    return {"ok": True, "argv": [str(out)], "cwd": str(workspace), "timeout": 10}


def plan_git(action: str, args: dict, workspace: Path) -> dict:
    git = str(args.get("git") or "")
    if not git:
        return {"ok": False, "error": "Git is not in the isolated environment", "cause": "missing", "fatal": False}
    if action == "push":
        target = str(args.get("branch") or "")
        if target in {"main", "master"}:
            return {"ok": False, "error": "push to main is refused", "cause": "main"}
        if not args.get("confirm"):
            return {"ok": False, "error": "a remote action waits for the dial", "cause": "dial", "fatal": False}
    allowed = {
        "status": ["status", "--short"],
        "diff": ["diff"],
        "log": ["log", "-n", "20"],
        "branch": ["branch"],
        "commit": ["commit", "-m", str(args.get("message") or "update")],
        "push": ["push", "origin", str(args.get("branch") or "HEAD")],
    }
    argv = allowed.get(action)
    if not argv:
        return {"ok": False, "error": "git action is not available", "cause": "usage"}
    return {"ok": True, "argv": [git, *argv], "cwd": str(workspace), "dryRun": False}


def plan_java(action: str, args: dict, workspace: Path) -> dict:
    java = str(args.get("java") or "")
    javac = str(args.get("javac") or "")
    if action == "run" and not java:
        return {"ok": False, "error": "the JDK is not in the runtime folder", "cause": "missing", "fatal": False}
    if action == "compile" and not javac:
        return {"ok": False, "error": "the JDK is not in the runtime folder", "cause": "missing", "fatal": False}
    try:
        source = contained(workspace, str(args.get("source") or "Main.java"))
    except PermissionError as exc:
        return {"ok": False, "error": str(exc), "cause": "path"}
    if action == "compile":
        return {"ok": True, "argv": [javac, str(source)], "cwd": str(workspace), "timeout": 30}
    return {"ok": True, "argv": [java, str(source.with_suffix(""))], "cwd": str(workspace), "timeout": 20}


def plan_ci(args: dict, workspace: Path) -> dict:
    text = " ".join(str(args.get(key) or "") for key in ("script", "extra"))
    if "workflow" in text or "dispatch" in text:
        return {"ok": False, "error": "hosted workflows are not dispatched from here", "cause": "dispatch"}
    return {
        "ok": True,
        "argv": ["npm", "run", "validate:local"],
        "cwd": str(workspace),
        "editsWorkflows": False,
    }


def redact_receipt(text: str) -> str:
    import re

    return re.sub(r"(?i)(password|token|api[_-]?key)\s*[:=]\s*\S+", r"\1: [blank]", text)
