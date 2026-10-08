"""The kernel type-check ceiling may shrink. It may not grow."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
BASELINE = REPO / "kernel" / "pyright-baseline.txt"


def test_pyright_error_count_does_not_grow():
    probe = subprocess.run(
        [sys.executable, "-m", "pyright", "--version"],
        cwd=REPO,
        capture_output=True,
        text=True,
    )
    if probe.returncode != 0:
        pytest.skip("pyright is not installed")
    proc = subprocess.run(
        [sys.executable, "-m", "pyright", "--pythonpath", sys.executable, "--outputjson", "kernel"],
        cwd=REPO,
        capture_output=True,
        text=True,
    )
    try:
        report = json.loads(proc.stdout)
    except json.JSONDecodeError:
        pytest.skip("pyright did not return a JSON report")
    count = int(report["summary"]["errorCount"])
    ceiling = int(BASELINE.read_text(encoding="utf-8").strip())
    assert count <= ceiling, f"pyright errors grew from {ceiling} to {count}"
