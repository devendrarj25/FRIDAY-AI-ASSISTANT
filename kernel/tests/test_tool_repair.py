import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import tool_repair  # noqa: E402


@pytest.mark.parametrize(
    "tool,error,expect",
    [
        ("shell.cmd", "refused: formatting or wiping a disk", "blocked by policy"),
        ("shell.cmd", "needs a signed authorization", "owner's approval"),
        ("fs.read", "that path is outside the folders FRIDAY may read", "inside the workspace"),
        ("fs.make", "report.docx already exists; say overwrite to replace it", "overwrite"),
        ("fs.read", "No such file or directory: notes.txt", "fs.list"),
        ("http.fetch", "blocked: loopback address", "public"),
        ("pip.install", "ERROR: No matching distribution found for foo", "package name"),
        ("shell.cmd", "'tesseract' is not recognized as an internal or external command", "not installed"),
        ("python.exec", "timed out after 60s", "smaller input"),
    ],
)
def test_each_failure_gets_a_next_step(tool, error, expect):
    out = tool_repair.with_hint(tool, {"ok": False, "error": error})
    assert expect in out["hint"]


def test_a_success_or_an_unknown_error_is_left_alone():
    ok = {"ok": True, "content": "x"}
    assert tool_repair.with_hint("fs.read", ok) is ok
    odd = {"ok": False, "error": "something never seen before"}
    assert tool_repair.with_hint("fs.read", odd) == odd
    assert tool_repair.with_hint("fs.read", {"ok": False}) == {"ok": False}


def test_a_hint_already_there_is_kept():
    given = {"ok": False, "error": "No such file", "hint": "mine"}
    assert tool_repair.with_hint("fs.read", given)["hint"] == "mine"


def test_a_refusal_is_never_a_way_around():
    for text in ("refused: a force push rewrites published history", "needs approval"):
        hint = tool_repair.hint_for("git.push", {"ok": False, "error": text})
        assert hint and ("Do not retry" in hint or "do not retry" in hint)


def test_the_registry_adds_it_to_a_real_failed_call(tmp_path):
    import asyncio
    import importlib

    from authority import Authority

    # By name: the repository root also has a ``tools`` folder that a static checker prefers.
    ToolRegistry = importlib.import_module("tools").ToolRegistry

    class S:
        def enabled_tools(self):
            return {}

        def settings(self):
            return {}

    reg = ToolRegistry(S(), tmp_path, Authority("k"))
    out = asyncio.run(reg.execute("fs.read", {"path": "nope.txt"}))
    assert out["ok"] is False and "hint" in out
    blocked = asyncio.run(reg.execute("shell.cmd", {"command": "format c:"}))
    assert blocked["policy"] is True and "Do not retry" in blocked["hint"]
