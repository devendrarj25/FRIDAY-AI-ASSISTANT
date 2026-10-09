"""The kernel type-check ceiling may shrink. It may not grow.

A missing tool or a report that is not JSON fails the test when CI,
GITHUB_ACTIONS, or FRIDAY_PYRIGHT_STRICT is set. On a workstation the same
gap prints a loud line and skips.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
BASELINE = REPO / "kernel" / "pyright-baseline.txt"


def pyright_must_enforce() -> bool:
    if os.environ.get("CI") or os.environ.get("GITHUB_ACTIONS"):
        return True
    flag = os.environ.get("FRIDAY_PYRIGHT_STRICT", "").strip().lower()
    return flag in {"1", "true", "yes"}


def give_up(message: str) -> None:
    if pyright_must_enforce():
        pytest.fail(message)
    print(f"PYRIGHT BASELINE NOT ENFORCED: {message}", file=sys.stderr)
    pytest.skip(message)


def test_pyright_strict_is_on_for_ci_and_the_flag(monkeypatch):
    monkeypatch.delenv("CI", raising=False)
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
    monkeypatch.delenv("FRIDAY_PYRIGHT_STRICT", raising=False)
    assert pyright_must_enforce() is False
    monkeypatch.setenv("CI", "true")
    assert pyright_must_enforce() is True
    monkeypatch.delenv("CI")
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    assert pyright_must_enforce() is True
    monkeypatch.delenv("GITHUB_ACTIONS")
    monkeypatch.setenv("FRIDAY_PYRIGHT_STRICT", "yes")
    assert pyright_must_enforce() is True


def test_pyright_strict_fails_closed_when_the_tool_is_missing(monkeypatch):
    monkeypatch.setenv("FRIDAY_PYRIGHT_STRICT", "1")

    def boom(*_args, **_kwargs):
        return subprocess.CompletedProcess(args=[], returncode=1, stdout="", stderr="missing")

    monkeypatch.setattr(subprocess, "run", boom)
    with pytest.raises(pytest.fail.Exception, match="not installed"):
        test_pyright_error_count_does_not_grow()


def test_pyright_strict_fails_closed_when_the_report_is_not_json(monkeypatch):
    monkeypatch.setenv("FRIDAY_PYRIGHT_STRICT", "1")
    calls = {"n": 0}

    def sequenced(*_args, **_kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            return subprocess.CompletedProcess(args=[], returncode=0, stdout="pyright 1", stderr="")
        return subprocess.CompletedProcess(args=[], returncode=1, stdout="not-json", stderr="")

    monkeypatch.setattr(subprocess, "run", sequenced)
    with pytest.raises(pytest.fail.Exception, match="JSON"):
        test_pyright_error_count_does_not_grow()


def test_pyright_error_count_does_not_grow():
    probe = subprocess.run(
        [sys.executable, "-m", "pyright", "--version"],
        cwd=REPO,
        capture_output=True,
        text=True,
    )
    if probe.returncode != 0:
        give_up("pyright is not installed")
    proc = subprocess.run(
        [sys.executable, "-m", "pyright", "--pythonpath", sys.executable, "--outputjson", "kernel"],
        cwd=REPO,
        capture_output=True,
        text=True,
    )
    try:
        report = json.loads(proc.stdout)
    except json.JSONDecodeError:
        give_up("pyright did not return a JSON report")
    count = int(report["summary"]["errorCount"])
    ceiling = int(BASELINE.read_text(encoding="utf-8").strip())
    assert count <= ceiling, f"pyright errors grew from {ceiling} to {count}"
