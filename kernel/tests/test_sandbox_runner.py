"""Windows Sandbox runs: the configuration is locked down and the result comes back through a folder."""

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import sandbox_runner  # noqa: E402
from authority import Authority  # noqa: E402

pytest.importorskip("httpx", reason="tool registry needs the kernel runtime deps")
from tools import RISK, ToolRegistry  # noqa: E402


class _Storage:
    def enabled_tools(self):
        return {}


def test_configuration_is_read_only_offline_and_escaped(tmp_path):
    work = tmp_path / "a&b"
    out = tmp_path / "out"
    xml = sandbox_runner.build_wsb(work, out, 'dir "C:\\work" <x>')
    assert "<Networking>Disable</Networking>" in xml
    assert "<ReadOnly>true</ReadOnly>" in xml and xml.count("<ReadOnly>false</ReadOnly>") == 1
    assert "a&amp;b" in xml and "&lt;x&gt;" in xml
    assert "<VGpu>Disable</VGpu>" in xml and "shutdown /s /t 0" in xml
    online = sandbox_runner.build_wsb(work, out, "ver", network=True)
    assert "<Networking>Default</Networking>" in online


@pytest.mark.parametrize("bad", ["", "   ", "a\nb", "a\x00b"])
def test_bad_commands_are_refused(tmp_path, bad):
    with pytest.raises(ValueError):
        sandbox_runner.build_wsb(tmp_path, tmp_path, bad)


def test_missing_feature_is_reported_with_the_next_step(tmp_path):
    out = sandbox_runner.run(tmp_path, "ver", ready=False)
    assert out["ok"] is False and out["cause"] == "missing" and "Install Manager" in out["error"]


def test_result_is_read_back_from_the_results_folder(tmp_path):
    def launch(argv):
        results = Path(argv[1]).parent
        (results / "output.txt").write_text("hello from the guest", encoding="utf-8")
        (results / "exit.txt").write_text("0 \r\n", encoding="utf-8")

    out = sandbox_runner.run(tmp_path, "echo hello", launch=launch, ready=True, sleep=lambda _s: None)
    assert out["ok"] is True and out["stdout"] == "hello from the guest" and out["code"] == 0
    assert (tmp_path / ".friday-sandbox" / out["runId"] / "run.wsb").exists()


def test_a_failing_command_and_a_timeout_are_reported(tmp_path):
    def launch(argv):
        results = Path(argv[1]).parent
        (results / "output.txt").write_text("boom", encoding="utf-8")
        (results / "exit.txt").write_text("3", encoding="utf-8")

    failed = sandbox_runner.run(tmp_path, "bad", launch=launch, ready=True, sleep=lambda _s: None)
    assert failed["ok"] is False and failed["code"] == 3 and failed["error"] == "boom"
    ticks = iter(range(0, 10_000, 100))
    clock = sandbox_runner.time
    original = clock.monotonic
    clock.monotonic = lambda: next(ticks)
    try:
        slow = sandbox_runner.run(tmp_path, "hang", launch=lambda argv: None, ready=True, sleep=lambda _s: None)
    finally:
        clock.monotonic = original
    assert slow["ok"] is False and slow["cause"] == "timeout"


def test_tool_is_exec_tier_and_needs_authorization(tmp_path):
    assert RISK["sandbox.run"] == "exec"
    reg = ToolRegistry(_Storage(), tmp_path, Authority("test-secret"))
    out = asyncio.run(reg.execute("sandbox.run", {"command": "ver"}))
    assert out["ok"] is False and out["risk"] == "exec"
