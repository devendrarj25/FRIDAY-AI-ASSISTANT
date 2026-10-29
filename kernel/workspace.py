"""Primary-folder scanner and watcher.

The user picks one root folder at install / first launch. On every kernel start
we walk it, recognise code roots by their manifests, index changed files into
vector memory and then keep watching for edits while the app runs.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path

SKIP_DIRS = {
    ".git",
    "node_modules",
    "venv",
    ".venv",
    "__pycache__",
    "dist",
    "build",
    "target",
    ".next",
    ".turbo",
    ".cache",
    "bin",
    "obj",
    ".idea",
    ".vs",
}

CODE_MARKERS = {
    "package.json": "Node",
    "pnpm-lock.yaml": "Node · pnpm",
    "pyproject.toml": "Python",
    "requirements.txt": "Python",
    "Cargo.toml": "Rust",
    "go.mod": "Go",
    "pom.xml": "Java · Maven",
    "CMakeLists.txt": "C/C++",
}

DOC_EXT = {".md", ".txt", ".pdf", ".docx", ".rst"}
DATA_EXT = {".csv", ".json", ".parquet", ".sqlite3", ".db"}
MODEL_EXT = {".gguf", ".safetensors", ".bin", ".onnx"}


@dataclass
class Folder:
    path: str
    kind: str
    stack: str | None = None
    files: int = 0
    indexed: bool = False

    def public(self) -> dict:
        return {
            "path": self.path,
            "kind": self.kind,
            "stack": self.stack,
            "files": self.files,
            "indexed": self.indexed,
        }


@dataclass
class Workspace:
    data_dir: Path
    memory: object | None = None
    root: Path | None = None
    detected: list[Folder] = field(default_factory=list)
    files: int = 0
    folders: int = 0
    changed: int = 0
    scanned_at: float = 0.0
    watching: bool = False
    _mtimes: dict[str, float] = field(default_factory=dict)
    _task: asyncio.Task | None = None

    # -- persistence ---------------------------------------------------------
    @property
    def state_file(self) -> Path:
        return self.data_dir / "workspace-index.json"

    def _load(self) -> None:
        try:
            self._mtimes = json.loads(self.state_file.read_text("utf8"))
        except Exception:
            self._mtimes = {}

    def _save(self) -> None:
        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        self.state_file.write_text(json.dumps(self._mtimes), "utf8")

    # -- api -----------------------------------------------------------------
    def set_root(self, root: str) -> dict:
        self.root = Path(root)
        return self.describe()

    def describe(self) -> dict:
        return {
            "root": str(self.root) if self.root else None,
            "scannedAt": time.strftime("%H:%M:%S", time.localtime(self.scanned_at)) if self.scanned_at else None,
            "files": self.files,
            "folders": self.folders,
            "changedSinceLastRun": self.changed,
            "watching": self.watching,
            "detected": [f.public() for f in self.detected],
        }

    def scan(self) -> dict:
        """Full walk of the root: classify folders, note changed files."""
        if not self.root or not self.root.exists():
            return self.describe()

        self._load()
        previous = dict(self._mtimes)
        current: dict[str, float] = {}
        detected: list[Folder] = []
        total_files = total_folders = 0

        for dirpath, dirnames, filenames in os.walk(self.root):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
            total_folders += 1

            stack = next((s for marker, s in CODE_MARKERS.items() if marker in filenames), None)
            kinds = {Path(f).suffix.lower() for f in filenames}
            if stack:
                kind = "code-root"
            elif kinds & MODEL_EXT:
                kind = "models"
            elif kinds & DATA_EXT:
                kind = "data"
            elif kinds & DOC_EXT:
                kind = "docs"
            else:
                kind = "other"

            for name in filenames:
                fp = Path(dirpath) / name
                try:
                    current[str(fp)] = fp.stat().st_mtime
                except OSError:
                    continue
                total_files += 1

            if kind != "other" or dirpath == str(self.root):
                detected.append(
                    Folder(
                        path=dirpath,
                        kind=kind,
                        stack=stack,
                        files=len(filenames),
                        indexed=kind in {"code-root", "docs"},
                    )
                )

        self.changed = sum(1 for p, m in current.items() if previous.get(p) != m)
        self._mtimes = current
        self._save()
        self.detected = detected
        self.files = total_files
        self.folders = total_folders
        self.scanned_at = time.time()
        return self.describe()

    async def start(self, interval: float = 20.0) -> None:
        """Scan once on launch, then poll for changes while the app runs."""
        if not self.root:
            return
        # A workspace may contain hundreds of thousands of files. Keep that
        # blocking walk off uvicorn's event loop so health checks and chat stay
        # responsive during startup and workspace changes.
        await asyncio.to_thread(self.scan)
        self.watching = True

        async def loop() -> None:
            while True:
                await asyncio.sleep(interval)
                await asyncio.to_thread(self.scan)

        self._task = asyncio.create_task(loop())

    def stop(self) -> None:
        self.watching = False
        if self._task:
            self._task.cancel()
            self._task = None
