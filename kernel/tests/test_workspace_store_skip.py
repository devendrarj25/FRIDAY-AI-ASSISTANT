"""When the workspace root is FRIDAY's own folder, her stores are not walked every 20 seconds."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import workspace  # noqa: E402

STORES = ("database", "memory", "state", "backup", "models", "library")


def _populate(root: Path, stores: tuple[str, ...]) -> None:
    for name in stores:
        (root / name).mkdir(parents=True, exist_ok=True)
        for i in range(4):
            (root / name / f"f{i}.txt").write_text("x", "utf8")
    (root / "docs").mkdir(exist_ok=True)
    (root / "docs" / "plan.md").write_text("plan", "utf8")


def _scan(tmp_path: Path, root: Path) -> dict:
    ws = workspace.Workspace(data_dir=tmp_path / "data")
    ws.set_root(str(root))
    return ws.scan()


def test_friday_root_skips_its_own_store_folders(tmp_path):
    root = tmp_path / "friday"
    _populate(root, STORES)
    out = _scan(tmp_path, root)
    assert out["files"] == 1  # docs/plan.md only
    walked = {Path(f["path"]).name for f in out["detected"]}
    assert not walked & set(STORES)


def test_an_owner_folder_with_those_names_elsewhere_is_still_scanned(tmp_path):
    root = tmp_path / "projects"
    _populate(root, ("models", "library", "backup"))
    out = _scan(tmp_path, root)
    assert out["files"] == 13  # three folders of four files, plus the plan


def test_a_store_name_below_the_top_level_is_not_skipped(tmp_path):
    root = tmp_path / "friday"
    _populate(root, ("database", "memory"))
    (root / "docs" / "models").mkdir()
    (root / "docs" / "models" / "notes.md").write_text("n", "utf8")
    out = _scan(tmp_path, root)
    assert out["files"] == 2  # docs/plan.md and docs/models/notes.md
