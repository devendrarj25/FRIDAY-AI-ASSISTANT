"""Code Runner: detect projects in the workspace and execute them safely.

Detection is fingerprint based (package.json, requirements.txt, pom.xml, ...).
Execution resolves the runtime first, optionally installs dependencies, then
spawns the process in the project directory with a timeout and captured
stdout/stderr. Nothing runs outside the folder it was detected in.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from env_guard import child_env

# fingerprint -> (language, runtime executable, run command, dependency command)
PROJECTS = [
    ("package.json", "JavaScript/TypeScript", "node", ["npm", "start"], ["npm", "install"]),
    ("requirements.txt", "Python", "python", ["python", "main.py"], ["python", "-m", "pip", "install", "-r", "requirements.txt"]),
    ("pyproject.toml", "Python", "python", ["python", "-m", "app"], ["python", "-m", "pip", "install", "."]),
    ("pom.xml", "Java", "java", ["mvn", "-q", "exec:java"], ["mvn", "-q", "-DskipTests", "package"]),
    ("build.gradle", "Java", "java", ["gradle", "run"], ["gradle", "build"]),
    ("go.mod", "Go", "go", ["go", "run", "."], ["go", "mod", "download"]),
    ("Cargo.toml", "Rust", "cargo", ["cargo", "run"], ["cargo", "fetch"]),
    ("composer.json", "PHP", "php", ["php", "index.php"], ["composer", "install"]),
    ("Gemfile", "Ruby", "ruby", ["ruby", "main.rb"], ["bundle", "install"]),
    ("Makefile", "C/C++", "make", ["make", "run"], ["make"]),
]

# suffix -> (language, runtime, command template)
SNIPPETS = {
    ".js": ("JavaScript", "node", lambda f: ["node", f]),
    ".mjs": ("JavaScript", "node", lambda f: ["node", f]),
    ".ts": ("TypeScript", "npx", lambda f: ["npx", "--yes", "tsx", f]),
    ".py": ("Python", "python", lambda f: ["python", f]),
    ".rb": ("Ruby", "ruby", lambda f: ["ruby", f]),
    ".php": ("PHP", "php", lambda f: ["php", f]),
    ".go": ("Go", "go", lambda f: ["go", "run", f]),
    ".rs": ("Rust", "rustc", lambda f: ["rustc", f, "-o", f + ".out"]),
    ".java": ("Java", "java", lambda f: ["java", f]),
    ".c": ("C", "gcc", lambda f: ["gcc", f, "-o", f + ".out"]),
    ".cpp": ("C++", "g++", lambda f: ["g++", f, "-o", f + ".out"]),
    ".cs": ("C#", "dotnet", lambda f: ["dotnet", "script", f]),
}


class ProjectRunner:
    def __init__(self, roots: list[Path]) -> None:
        self.roots = [Path(r) for r in roots if r]

    # ----------------------------------------------------------- detection --
    def detect(self) -> list[dict]:
        found: list[dict] = []
        for root in self.roots:
            if not root.exists():
                continue
            for entry in sorted(root.iterdir()):
                if not entry.is_dir() or entry.name.startswith("."):
                    continue
                info = self._identify(entry)
                if info:
                    found.append(info)
        return found

    def _identify(self, directory: Path) -> dict | None:
        for fingerprint, language, runtime, command, install in PROJECTS:
            if (directory / fingerprint).exists():
                return {
                    "id": directory.name,
                    "path": str(directory),
                    "language": language,
                    "runtime": runtime,
                    "runtimeInstalled": shutil.which(runtime) is not None,
                    "entry": fingerprint,
                    "command": command,
                    "install": install,
                }
        # Loose source files still count as a runnable project.
        for file in sorted(directory.glob("*")):
            spec = SNIPPETS.get(file.suffix.lower())
            if spec:
                language, runtime, builder = spec
                return {
                    "id": directory.name,
                    "path": str(directory),
                    "language": language,
                    "runtime": runtime,
                    "runtimeInstalled": shutil.which(runtime) is not None,
                    "entry": file.name,
                    "command": builder(file.name),
                    "install": None,
                }
        return None

    # ----------------------------------------------------------- execution --
    def _spawn(self, command: list[str], cwd: str, timeout: int) -> dict:
        try:
            proc = subprocess.run(
                command,
                cwd=cwd,
                capture_output=True,
                text=True,
                timeout=timeout,
                # Model-authored code never sees FRIDAY's secrets.
                env=child_env(extra={"PYTHONUNBUFFERED": "1"}),
            )
            return {
                "ok": proc.returncode == 0,
                "code": proc.returncode,
                "stdout": proc.stdout[-20000:],
                "stderr": proc.stderr[-20000:],
                "command": " ".join(command),
            }
        except subprocess.TimeoutExpired:
            return {"ok": False, "code": None, "stdout": "", "stderr": f"Timed out after {timeout}s", "command": " ".join(command)}
        except FileNotFoundError:
            return {"ok": False, "code": None, "stdout": "", "stderr": f"{command[0]} is not installed", "command": " ".join(command)}

    def run(self, project_id: str, install: bool = False, timeout: int = 300) -> dict:
        project = next((p for p in self.detect() if p["id"] == project_id), None)
        if project is None:
            return {"ok": False, "error": f"project not found: {project_id}"}
        if not project["runtimeInstalled"]:
            return {
                "ok": False,
                "error": f"{project['runtime']} is not installed",
                "runtime": project["runtime"],
            }
        steps = []
        if install and project.get("install"):
            steps.append({"step": "dependencies", **self._spawn(project["install"], project["path"], timeout)})
            if not steps[-1]["ok"]:
                return {"ok": False, "project": project_id, "steps": steps}
        steps.append({"step": "run", **self._spawn(project["command"], project["path"], timeout)})
        return {"ok": steps[-1]["ok"], "project": project_id, "language": project["language"], "steps": steps}

    def snippet(self, language: str, code: str, timeout: int = 60) -> dict:
        suffix = next(
            (ext for ext, spec in SNIPPETS.items() if spec[0].lower() == str(language).lower()),
            None,
        )
        if suffix is None:
            return {"ok": False, "error": f"unsupported language: {language}"}
        _lang, runtime, builder = SNIPPETS[suffix]
        if shutil.which(runtime) is None:
            return {"ok": False, "error": f"{runtime} is not installed", "runtime": runtime}
        with tempfile.TemporaryDirectory(prefix="friday-run-") as tmp:
            file = Path(tmp) / f"snippet{suffix}"
            file.write_text(code, encoding="utf-8")
            result = self._spawn(builder(file.name), tmp, timeout)
            # Compiled languages: run the produced binary.
            binary = Path(tmp) / f"snippet{suffix}.out"
            if result["ok"] and binary.exists():
                result = self._spawn([str(binary)], tmp, timeout)
            return {"language": language, **result}

    def languages(self) -> list[dict]:
        return [
            {"language": spec[0], "runtime": spec[1], "installed": shutil.which(spec[1]) is not None}
            for spec in {v[0]: v for v in SNIPPETS.values()}.values()
        ]
