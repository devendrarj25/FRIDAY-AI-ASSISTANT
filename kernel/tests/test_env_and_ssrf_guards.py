"""FRIDAY · proof that a spawned command cannot read FRIDAY's secrets and
that the unapproved `http.fetch` tool cannot be aimed at a private address."""

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from authority import Authority  # noqa: E402
from env_guard import child_env, guard_public_url  # noqa: E402

import tools as tools_module  # noqa: E402


def test_child_env_drops_authority_secret_and_api_keys():
    source = {
        "PATH": "/usr/bin",
        "PYTHONUNBUFFERED": "1",
        "FRIDAY_TOOL_AUTHORITY_SECRET": "top-secret",
        "FRIDAY_BRIDGE_TOKEN": "bridge",
        "OPENAI_API_KEY": "sk-live",
        "GITHUB_TOKEN": "ghp_x",
        "DB_PASSWORD": "hunter2",
        "AWS_SESSION_TOKEN": "aws",
    }
    clean = child_env(source)
    assert clean == {"PATH": "/usr/bin", "PYTHONUNBUFFERED": "1"}
    assert "top-secret" not in "".join(clean.values())


def test_child_env_extra_is_applied():
    assert child_env({"PATH": "/x"}, extra={"PYTHONUNBUFFERED": "1"})["PYTHONUNBUFFERED"] == "1"


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1:8765/",  # FRIDAY's own kernel
        "http://localhost/admin",
        "http://169.254.169.254/latest/meta-data/",  # cloud metadata
        "http://192.168.1.1/",  # the owner's router
        "http://10.0.0.5/",
        "file:///C:/Windows/win.ini",
        "ftp://example.com/",
    ],
)
def test_guard_blocks_non_public_targets(url):
    with pytest.raises(PermissionError):
        guard_public_url(url)


def test_guard_allows_a_normal_public_url():
    guard_public_url("https://example.com/docs")


def test_http_fetch_denied_without_authorization():
    registry = tools_module.ToolRegistry(None, Path.cwd(), authority=Authority("s3cret"))
    result = asyncio.run(registry.execute("http.fetch", {"url": "https://example.com/"}))
    assert result["ok"] is False
    assert result.get("risk") == "write"


def test_http_fetch_tool_refuses_loopback():
    registry = tools_module.ToolRegistry(None, Path.cwd(), authority=Authority("s3cret"))
    args = {"url": "http://127.0.0.1:8765/"}
    token = registry.authority.issue("http.fetch", args, "write")
    result = asyncio.run(registry.execute("http.fetch", args, authorization=token))
    assert result["ok"] is False
    assert "blocked" in result["error"].lower()


def test_workspace_containment_rejects_sibling_prefix(tmp_path):
    root = tmp_path / "ws"
    root.mkdir()
    (tmp_path / "ws-evil").mkdir()
    registry = tools_module.ToolRegistry(None, root)
    with pytest.raises(PermissionError):
        registry._resolve("../ws-evil/secrets.txt")
    assert registry._resolve("notes.txt") == (root / "notes.txt")
