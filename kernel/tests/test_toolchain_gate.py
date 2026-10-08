"""Toolchain plans stay inside the workspace and do not touch the system path."""

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import toolchain_gate  # noqa: E402


def test_manifest_hashes_and_copyleft_tier():
    manifest = toolchain_gate.load_manifest()
    bundled = 0
    for pack in manifest["packs"]:
        assert len(pack["sha256"]) == 64
        assert pack["license"]
        assert pack["bytes"] > 0
        if pack["tier"] == "bundled":
            bundled += pack["bytes"]
            assert "GPL" not in pack["license"] and "LGPL" not in pack["license"]
    assert bundled <= manifest["budgetBytes"]


def test_isolated_env_does_not_replace_the_process_path(tmp_path):
    before = os.environ.get("PATH")
    env = toolchain_gate.isolated_env({"python-embed": str(tmp_path)}, "bundled-first")
    assert os.environ.get("PATH") == before
    assert env["FRIDAY_TOOLCHAIN"] == "1"
    assert str(tmp_path) in env["PATH"]


def test_pip_refuses_denied_and_typos_and_dry_runs(tmp_path):
    denied = toolchain_gate.plan_pip("install", {"package": "torch", "python": "python"}, tmp_path)
    assert denied["ok"] is False
    assert denied["cause"] == "denied"
    typo = toolchain_gate.plan_pip("install", {"package": "numpyy", "python": "python"}, tmp_path)
    assert typo["cause"] == "typosquat"
    dry = toolchain_gate.plan_pip(
        "install", {"package": "numpy", "python": "python", "confirm": False}, tmp_path
    )
    assert dry["dryRun"] is True
    assert "--dry-run" in dry["argv"]
    missing = toolchain_gate.plan_pip("list", {}, tmp_path)
    assert missing["cause"] == "no-python"


def test_paths_and_git_and_ci(tmp_path):
    with pytest.raises(PermissionError):
        toolchain_gate.contained(tmp_path, "../outside")
    push = toolchain_gate.plan_git("push", {"git": "git", "branch": "main", "confirm": True}, tmp_path)
    assert push["ok"] is False
    waiting = toolchain_gate.plan_git("push", {"git": "git", "branch": "upgrade/demo"}, tmp_path)
    assert waiting["cause"] == "dial"
    status = toolchain_gate.plan_git("status", {"git": "git"}, tmp_path)
    assert status["argv"][:2] == ["git", "status"]
    ci = toolchain_gate.plan_ci({"script": "workflow dispatch"}, tmp_path)
    assert ci["ok"] is False
    local = toolchain_gate.plan_ci({}, tmp_path)
    assert local["argv"] == ["npm", "run", "validate:local"]
    assert local["editsWorkflows"] is False
    java = toolchain_gate.plan_java("run", {}, tmp_path)
    assert java["fatal"] is False
    cpp = toolchain_gate.plan_cpp("build", {"compiler": "gcc", "source": "../x.cpp"}, tmp_path)
    assert cpp["cause"] == "path"
    node = toolchain_gate.plan_node("script", {"script": "../evil.mjs", "node": "node"}, tmp_path)
    assert node["cause"] == "path"
    assert "hunter2" not in toolchain_gate.redact_receipt("password=hunter2")
