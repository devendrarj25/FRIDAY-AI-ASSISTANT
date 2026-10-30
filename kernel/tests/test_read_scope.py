"""Read-only tools: which folders they may open, and the files they never open."""

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import file_tools  # noqa: E402
from authority import Authority  # noqa: E402

pytest.importorskip("httpx", reason="tool registry needs the kernel runtime deps")
from tools import ToolRegistry  # noqa: E402


class _Storage:
    def __init__(self, settings=None):
        self._settings = settings or {}

    def enabled_tools(self):
        return {}

    def settings(self):
        return self._settings


def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def world(tmp_path):
    root = tmp_path / "friday"
    (root / "workspace").mkdir(parents=True)
    (root / "config").mkdir()
    (root / "config" / "kernel.yaml").write_text("automation:\n  auto_approve_exec: false\n")
    (root / "security").mkdir()
    (root / "security" / "vault.txt").write_text("not for the model")
    project = tmp_path / "project"
    project.mkdir()
    (project / "main.py").write_text("print('hi')\n")
    (project / ".env").write_text("TOKEN=abc")
    (project / "server.pem").write_text("-----BEGIN-----")
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    (outside / "private.txt").write_text("outside every root")
    return root, project, outside


def registry(root, project=None, extra=None):
    settings = {}
    if project:
        settings["workspace_root"] = str(project)
    if extra:
        settings["read_roots"] = [str(p) for p in extra]
    return ToolRegistry(_Storage(settings), root / "workspace", Authority("secret"), root=root)


def test_relative_paths_still_stay_inside_the_tool_workspace(world):
    root, _, _ = world
    reg = registry(root)
    result = run(reg.execute("fs.read", {"path": "../config/kernel.yaml"}))
    assert result["ok"] is False
    assert "escapes" in result["error"]


def test_an_absolute_path_inside_the_friday_folder_is_readable(world):
    root, _, _ = world
    result = run(registry(root).execute("fs.read", {"path": str(root / "config" / "kernel.yaml")}))
    assert result["ok"] is True
    assert "auto_approve_exec: false" in result["content"]


def test_the_security_folder_of_the_friday_folder_is_never_read_or_listed(world):
    root, _, _ = world
    reg = registry(root)
    for tool in ("fs.read", "fs.list", "fs.info", "fs.identify", "fs.extract"):
        result = run(reg.execute(tool, {"path": str(root / "security" / "vault.txt")}))
        assert result["ok"] is False, tool
        assert "credentials" in result["error"]
    listing = run(reg.execute("fs.list", {"path": str(root / "security")}))
    assert listing["ok"] is False


def test_the_owners_workspace_is_readable_but_its_credential_files_are_not(world):
    root, project, _ = world
    reg = registry(root, project=project)
    assert run(reg.execute("fs.read", {"path": str(project / "main.py")}))["ok"] is True
    for name in (".env", "server.pem"):
        result = run(reg.execute("fs.read", {"path": str(project / name)}))
        assert result["ok"] is False, name


def test_a_folder_outside_every_root_is_refused(world):
    root, project, outside = world
    reg = registry(root, project=project)
    result = run(reg.execute("fs.read", {"path": str(outside / "private.txt")}))
    assert result["ok"] is False
    assert "outside the folders" in result["error"]


def test_a_folder_added_to_read_roots_becomes_readable(world):
    root, _, outside = world
    reg = registry(root, extra=[outside])
    assert run(reg.execute("fs.read", {"path": str(outside / "private.txt")}))["ok"] is True


def test_a_sibling_with_the_same_prefix_is_not_inside_the_root(world):
    root, project, _ = world
    sibling = project.parent / (project.name + "-evil")
    sibling.mkdir()
    (sibling / "x.txt").write_text("x")
    result = run(registry(root, project=project).execute("fs.read", {"path": str(sibling / "x.txt")}))
    assert result["ok"] is False


def test_a_large_file_is_cut_at_the_limit_and_says_so(world, monkeypatch):
    root, project, _ = world
    monkeypatch.setattr(file_tools, "MAX_TEXT_BYTES", 64)
    (project / "big.txt").write_text("a" * 500)
    result = run(registry(root, project=project).execute("fs.read", {"path": str(project / "big.txt")}))
    assert result["ok"] is True
    assert len(result["content"]) == 64
    assert result["truncated"] is True


def test_content_search_skips_credential_files(world):
    root, project, _ = world
    (project / "notes.txt").write_text("the TOKEN lives elsewhere")
    result = run(
        registry(root, project=project).execute("fs.find", {"path": str(project), "pattern": "*", "contains": "token"})
    )
    paths = [row["path"] for row in result["matches"]]
    assert "notes.txt" in paths
    assert ".env" not in paths


def test_is_sensitive_names():
    assert file_tools.is_sensitive(Path("a/.env"))
    assert file_tools.is_sensitive(Path("a/id_rsa"))
    assert file_tools.is_sensitive(Path("home/.ssh/config"))
    assert file_tools.is_sensitive(Path("config/provider-keys.json"))
    assert not file_tools.is_sensitive(Path("docs/security-notes.md"))
    assert not file_tools.is_sensitive(Path("src/keyboard.ts"))
