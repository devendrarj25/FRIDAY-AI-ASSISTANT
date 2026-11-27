"""fs.write keeps a before-copy of a file it overwrites, so the change can be undone."""

import asyncio
import importlib
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from authority import Authority  # noqa: E402

pytest.importorskip("httpx", reason="tool registry needs the kernel runtime deps")
# By name: the repository root also has a `tools/` folder, and the kernel module is meant here.
tools_mod = importlib.import_module("tools")
file_tools = importlib.import_module("file_tools")


class _Storage:
    def enabled_tools(self):
        return {}


def _registry(tmp_path: Path):
    return tools_mod.ToolRegistry(_Storage(), workspace=tmp_path, authority=Authority("unit-test-key"))


def test_a_new_file_needs_no_backup(tmp_path):
    reg = _registry(tmp_path)
    result = asyncio.run(reg._fs_write({"path": "notes/a.txt", "content": "first"}))
    assert result["ok"] is True
    assert result["bytes"] == 5
    assert "backup" not in result
    assert (tmp_path / "notes" / "a.txt").read_text(encoding="utf-8") == "first"


def test_an_overwrite_keeps_the_old_content_and_returns_an_undo_handle(tmp_path):
    reg = _registry(tmp_path)
    target = tmp_path / "notes" / "a.txt"
    target.parent.mkdir(parents=True)
    target.write_text("the owner's draft", encoding="utf-8")
    result = asyncio.run(reg._fs_write({"path": "notes/a.txt", "content": "replaced"}))
    assert result["ok"] is True
    assert target.read_text(encoding="utf-8") == "replaced"
    backup = tmp_path / result["backup"]
    assert backup.read_text(encoding="utf-8") == "the owner's draft"
    assert backup.parent.parent.name == file_tools.TRASH
    assert result["undo"] == {"tool": "fs.copy", "from": result["backup"], "to": "notes/a.txt", "overwrite": True}


def test_two_overwrites_in_the_same_second_keep_both_copies(tmp_path):
    reg = _registry(tmp_path)
    (tmp_path / "a.txt").write_text("one", encoding="utf-8")
    first = asyncio.run(reg._fs_write({"path": "a.txt", "content": "two"}))
    second = asyncio.run(reg._fs_write({"path": "a.txt", "content": "three"}))
    assert first["backup"] != second["backup"]
    assert (tmp_path / first["backup"]).read_text(encoding="utf-8") == "one"
    assert (tmp_path / second["backup"]).read_text(encoding="utf-8") == "two"


def test_the_undo_handle_puts_the_old_file_back(tmp_path):
    reg = _registry(tmp_path)
    (tmp_path / "a.txt").write_text("before", encoding="utf-8")
    result = asyncio.run(reg._fs_write({"path": "a.txt", "content": "after"}))
    undo = result["undo"]
    restored = asyncio.run(reg._fs_copy({"from": undo["from"], "to": undo["to"], "overwrite": undo["overwrite"]}))
    assert restored["ok"] is True
    assert (tmp_path / "a.txt").read_text(encoding="utf-8") == "before"


def test_a_very_large_old_file_is_written_without_a_copy_and_says_so(tmp_path, monkeypatch):
    reg = _registry(tmp_path)
    monkeypatch.setattr(tools_mod, "WRITE_BACKUP_MAX_BYTES", 4)
    (tmp_path / "big.txt").write_text("0123456789", encoding="utf-8")
    result = asyncio.run(reg._fs_write({"path": "big.txt", "content": "small"}))
    assert result["ok"] is True
    assert "backup" not in result
    assert "too large" in result["backupSkipped"]
    assert (tmp_path / "big.txt").read_text(encoding="utf-8") == "small"
