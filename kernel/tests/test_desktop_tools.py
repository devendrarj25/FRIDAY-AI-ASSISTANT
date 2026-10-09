"""Desktop tools stay approval-gated. Off Windows they fail closed."""

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import control  # noqa: E402
from authority import Authority  # noqa: E402

pytest.importorskip("httpx", reason="tool registry needs the kernel runtime deps")
from tools import RISK, ToolRegistry  # noqa: E402


class _Storage:
    def enabled_tools(self):
        return {}


NAMES = (
    "input.scroll",
    "input.drag",
    "clipboard.read",
    "clipboard.write",
    "screen.perceive",
)


def test_new_desktop_tools_are_exec():
    for name in NAMES:
        assert RISK[name] == "exec"


def test_perceive_is_denied_without_authorization(tmp_path):
    tools = ToolRegistry(_Storage(), workspace=tmp_path, authority=Authority("s3cret"))
    result = asyncio.run(tools.execute("screen.perceive", {}))
    assert result["ok"] is False
    assert "authorization" in result["error"]


@pytest.mark.skipif(sys.platform.startswith("win"), reason="Windows desktop is checked on the owner's PC")
def test_structured_perception_refuses_off_windows():
    with pytest.raises(control.ControlError):
        control.perceive()


@pytest.mark.skipif(sys.platform.startswith("win"), reason="Windows desktop is checked on the owner's PC")
@pytest.mark.skipif(sys.platform.startswith("win"), reason="Windows desktop is checked on the owner's PC")
def test_pattern_actions_refuse_off_windows():
    with pytest.raises(control.ControlError):
        control.invoke_pattern("Save", "click")


def test_clipboard_refuses_off_windows(monkeypatch):
    monkeypatch.setattr(control, "WINDOWS", False)
    with pytest.raises(control.ControlError):
        control.clipboard_read()
    with pytest.raises(control.ControlError):
        control.clipboard_write("nope")


def test_windows_launch_uses_an_argument_vector(monkeypatch):
    calls = []

    def fake_popen(cmd, **kwargs):
        calls.append((cmd, kwargs))

        class Proc:
            pid = 7

        return Proc()

    monkeypatch.setattr(control, "WINDOWS", True)
    monkeypatch.setattr(control.os.path, "exists", lambda _path: False)
    monkeypatch.setattr(control.shutil, "which", lambda _name: None)
    monkeypatch.setattr(control.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(control.time, "sleep", lambda _seconds: None)
    result = control.launch_app("Notepad", ["note.txt"])
    assert result["ok"] is True
    cmd, kwargs = calls[0]
    assert kwargs.get("shell") in (None, False)
    assert cmd[:4] == ["cmd", "/c", "start", ""]
    assert cmd[4:] == ["Notepad", "note.txt"]
    assert isinstance(cmd, list)
