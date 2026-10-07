"""Manifest-based module loader.

Each module lives in modules/<name>/ (repo-import convention) or
modules/<segment>/<name>/ (capability-tree segments) with a manifest.json:
{ "name", "version", "description", "permissions": [...], "entry": "main.py" }
A module never gets tools beyond the permissions it declares.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

# Same segments electron/friday-contract.cjs lists for the modules tree.
_SEGMENTS = {
    "ai",
    "system",
    "automation",
    "communication",
    "developer",
    "ui",
    "custom",
}


class ModuleRegistry:
    def __init__(self, root: Path, storage) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.storage = storage
        self.loaded: dict[str, object] = {}
        self.manifests: dict[str, dict] = {}

    def discover(self) -> list[dict]:
        found: dict[str, dict] = {}
        for pattern in ("*/manifest.json", "*/*/manifest.json"):
            for manifest_path in sorted(self.root.glob(pattern)):
                rel = manifest_path.parent.relative_to(self.root)
                parts = rel.parts
                if len(parts) == 1 and parts[0] in _SEGMENTS:
                    continue
                if len(parts) == 2 and parts[0] not in _SEGMENTS:
                    continue
                data = json.loads(manifest_path.read_text(encoding="utf-8"))
                data["_dir"] = str(manifest_path.parent)
                key = str(data.get("name") or manifest_path.parent.name)
                found[key] = data
        return [found[name] for name in sorted(found)]

    def load_all(self) -> None:
        for manifest in self.discover():
            self.manifests[manifest["name"]] = manifest
            if manifest.get("enabled", True):
                try:
                    self._load(manifest)
                except Exception as exc:
                    print(f"[modules] failed to load {manifest['name']}: {exc}")

    def _load(self, manifest: dict) -> None:
        entry = Path(manifest["_dir"]) / manifest.get("entry", "main.py")
        spec = importlib.util.spec_from_file_location(f"friday_module_{manifest['name']}", entry)
        if spec is None or spec.loader is None:
            raise RuntimeError("bad module entry")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        if hasattr(module, "register"):
            module.register(manifest)
        self.loaded[manifest["name"]] = module

    def describe(self) -> list[dict]:
        return [
            {
                "name": m["name"],
                "version": m.get("version", "0.0.0"),
                "description": m.get("description", ""),
                "permissions": m.get("permissions", []),
                "enabled": m["name"] in self.loaded,
                "entry": str(Path(m["_dir"]).name + "/" + m.get("entry", "main.py")),
            }
            for m in self.manifests.values()
        ]

    def toggle(self, name: str, enabled: bool) -> dict:
        manifest = self.manifests.get(name)
        if manifest is None:
            return {"ok": False, "error": "unknown module"}
        if enabled and name not in self.loaded:
            self._load(manifest)
        if not enabled:
            self.loaded.pop(name, None)
        return {"ok": True, "enabled": name in self.loaded}
