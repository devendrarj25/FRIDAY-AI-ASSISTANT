"""The before-write folder is bounded: only the newest copies stay, within a total size, and never the copy that the
write in hand just made (its undo handle points at it)."""

import importlib
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

pytest.importorskip("httpx", reason="tool registry needs the kernel runtime deps")
tools_mod = importlib.import_module("tools")
file_tools = importlib.import_module("file_tools")


def _overwrite(workspace: Path, name: str, content: str) -> dict:
    target = workspace / name
    return tools_mod._write_with_backup(target, content, workspace, name)


def _folder(workspace: Path) -> Path:
    return workspace / file_tools.TRASH / tools_mod.WRITE_BACKUP_DIR


def test_only_the_newest_copies_are_kept_and_the_latest_one_always_is(monkeypatch, tmp_path):
    monkeypatch.setattr(tools_mod, "WRITE_BACKUP_KEEP", 5)
    (tmp_path / "a.txt").write_text("v0", encoding="utf-8")
    last = {}
    for n in range(1, 13):
        last = _overwrite(tmp_path, "a.txt", f"v{n}")
    kept = sorted(p.name for p in _folder(tmp_path).iterdir())
    assert len(kept) == 5  # was 12: every copy stayed forever
    assert (tmp_path / last["backup"]).read_text(encoding="utf-8") == "v11"
    assert (tmp_path / "a.txt").read_text(encoding="utf-8") == "v12"


def test_the_total_size_of_the_copies_is_capped_but_the_new_copy_stays(monkeypatch, tmp_path):
    monkeypatch.setattr(tools_mod, "WRITE_BACKUP_KEEP", 50)
    monkeypatch.setattr(tools_mod, "WRITE_BACKUP_MAX_TOTAL_BYTES", 250)
    (tmp_path / "big.txt").write_text("x" * 100, encoding="utf-8")
    last = {}
    for _ in range(6):
        last = _overwrite(tmp_path, "big.txt", "x" * 100)
    sizes = [p.stat().st_size for p in _folder(tmp_path).iterdir()]
    assert sum(sizes) <= 250 and len(sizes) == 2
    assert (tmp_path / last["backup"]).exists()


def test_a_copy_larger_than_the_cap_alone_is_still_kept_for_its_own_undo(monkeypatch, tmp_path):
    monkeypatch.setattr(tools_mod, "WRITE_BACKUP_MAX_TOTAL_BYTES", 10)
    (tmp_path / "big.txt").write_text("y" * 100, encoding="utf-8")
    result = _overwrite(tmp_path, "big.txt", "z")
    assert (tmp_path / result["backup"]).read_text(encoding="utf-8") == "y" * 100


def test_pruning_never_touches_anything_outside_the_before_write_folder(monkeypatch, tmp_path):
    monkeypatch.setattr(tools_mod, "WRITE_BACKUP_KEEP", 1)
    other = tmp_path / file_tools.TRASH / "deleted-by-the-owner.txt"
    other.parent.mkdir(parents=True)
    other.write_text("kept", encoding="utf-8")
    (tmp_path / "a.txt").write_text("v0", encoding="utf-8")
    for n in range(1, 4):
        _overwrite(tmp_path, "a.txt", f"v{n}")
    assert other.read_text(encoding="utf-8") == "kept"
