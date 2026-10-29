"""The kernel never trusts a caller's word: risky tools need a signed,
single-use authorization that matches the tool and its exact arguments."""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402
from authority import Authority, hash_args  # noqa: E402

pytest.importorskip("httpx", reason="tool registry needs the kernel runtime deps")
from tools import ToolRegistry  # noqa: E402


class _Storage:
    def enabled_tools(self):
        return {}


def _registry(tmp_path, secret="s3cret"):
    return ToolRegistry(_Storage(), workspace=tmp_path, authority=Authority(secret))


def test_hash_is_key_order_independent():
    assert hash_args({"a": 1, "b": "x"}) == hash_args({"b": "x", "a": 1})


def test_shortlist_keeps_the_matching_tool(tmp_path):
    tools = _registry(tmp_path)
    picked = tools.shortlist("read the note from disk")
    names = [tool["name"] for tool in picked]
    assert "fs.read" in names
    assert len(picked) < len(tools.describe())


def test_safe_tool_needs_no_authorization(tmp_path):
    tools = _registry(tmp_path)
    (tmp_path / "note.txt").write_text("hello", encoding="utf-8")
    result = asyncio.run(tools.execute("fs.read", {"path": "note.txt"}))
    assert result["ok"] is True


def test_risky_tool_is_denied_without_authorization(tmp_path):
    tools = _registry(tmp_path)
    result = asyncio.run(tools.execute("fs.write", {"path": "x.txt", "content": "no"}))
    assert result["ok"] is False
    assert not (tmp_path / "x.txt").exists()


def test_risky_tool_runs_with_a_matching_authorization(tmp_path):
    tools = _registry(tmp_path)
    args = {"path": "x.txt", "content": "yes"}
    token = tools.authority.issue("fs.write", args, "write")
    assert asyncio.run(tools.execute("fs.write", args, authorization=token))["ok"] is True
    # single use: the same token cannot write again
    assert asyncio.run(tools.execute("fs.write", args, authorization=token))["ok"] is False


def test_authorization_does_not_transfer_to_other_arguments(tmp_path):
    tools = _registry(tmp_path)
    token = tools.authority.issue("fs.write", {"path": "a.txt", "content": "a"}, "write")
    result = asyncio.run(tools.execute("fs.write", {"path": "b.txt", "content": "b"}, authorization=token))
    assert result["ok"] is False


def test_forged_token_is_rejected(tmp_path):
    tools = _registry(tmp_path)
    other = Authority("different-secret").issue("fs.write", {"path": "x.txt", "content": "no"})
    result = asyncio.run(tools.execute("fs.write", {"path": "x.txt", "content": "no"}, authorization=other))
    assert result["ok"] is False
