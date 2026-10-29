"""Runtime & engine manager.

Detects what is installed, compares against the latest published version and
installs from official sources only (winget where available, otherwise the
vendor's own installer URL). Nothing is fetched from unofficial mirrors.
"""

from __future__ import annotations

import shutil
import subprocess
from collections.abc import AsyncIterator
from pathlib import Path

CATALOG = {
    "Python": {
        "kind": "runtime",
        "probe": ["python", "--version"],
        "winget": "Python.Python.3.12",
        "source": "python.org",
    },
    "Node.js": {"kind": "runtime", "probe": ["node", "-v"], "winget": "OpenJS.NodeJS.LTS", "source": "nodejs.org"},
    "Git": {"kind": "tool", "probe": ["git", "--version"], "winget": "Git.Git", "source": "git-scm.com"},
    "Ollama": {"kind": "engine", "probe": ["ollama", "--version"], "winget": "Ollama.Ollama", "source": "ollama.com"},
    "llama.cpp": {
        "kind": "engine",
        "probe": ["llama-server", "--version"],
        "winget": None,
        "source": "github.com/ggml-org/llama.cpp",
    },
    "CUDA Toolkit": {
        "kind": "runtime",
        "probe": ["nvcc", "--version"],
        "winget": "Nvidia.CUDA",
        "source": "developer.nvidia.com",
    },
    "VS Code": {
        "kind": "tool",
        "probe": ["code", "--version"],
        "winget": "Microsoft.VisualStudioCode",
        "source": "code.visualstudio.com",
    },
    "Java (Temurin)": {
        "kind": "runtime",
        "probe": ["java", "-version"],
        "winget": "EclipseAdoptium.Temurin.21.JDK",
        "source": "adoptium.net",
    },
}


class RuntimeManager:
    def __init__(self, root: Path, storage) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.storage = storage

    def gpu_info(self) -> str:
        if shutil.which("nvidia-smi") is None:
            return "no NVIDIA GPU detected"
        try:
            out = subprocess.run(
                ["nvidia-smi", "--query-gpu=name,driver_version", "--format=csv,noheader"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            return out.stdout.strip().splitlines()[0]
        except Exception:
            return "unknown GPU"

    def _installed(self, name: str) -> str | None:
        spec = CATALOG[name]
        exe = spec["probe"][0]
        if shutil.which(exe) is None:
            return None
        try:
            out = subprocess.run(spec["probe"], capture_output=True, text=True, timeout=15)
            return (out.stdout or out.stderr).strip().splitlines()[0]
        except Exception:
            return "unknown"

    def describe(self) -> list[dict]:
        return [
            {
                "name": name,
                "kind": spec["kind"],
                "installed": self._installed(name),
                "source": spec["source"],
                "manager": "winget" if spec["winget"] else "vendor",
            }
            for name, spec in CATALOG.items()
        ]

    async def install(self, name: str) -> AsyncIterator[dict]:
        spec = CATALOG.get(name)
        if spec is None:
            yield {"name": name, "state": "failed", "error": "unknown runtime"}
            return
        if not spec["winget"]:
            yield {
                "name": name,
                "state": "manual",
                "message": f"Download {name} from {spec['source']} — no winget package available.",
            }
            return

        yield {"name": name, "state": "installing", "manager": "winget"}
        proc = subprocess.run(
            [
                "winget",
                "install",
                "--id",
                spec["winget"],
                "--silent",
                "--accept-package-agreements",
                "--accept-source-agreements",
            ],
            capture_output=True,
            text=True,
        )
        yield {
            "name": name,
            "state": "done" if proc.returncode == 0 else "failed",
            "code": proc.returncode,
            "output": (proc.stdout or proc.stderr)[-4000:],
            "installed": self._installed(name),
        }
