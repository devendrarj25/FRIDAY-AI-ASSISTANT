"""The speech status and the one-shot probe carry the kernel's own CUDA verdict for the voice budget."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "kernel"))

import stt  # noqa: E402
from test_stt_cuda_libraries import _clean_env, _fake_nvidia  # noqa: E402


def test_status_reports_false_when_nothing_asked_for_the_card(tmp_path, monkeypatch):
    _clean_env(monkeypatch)
    monkeypatch.setattr(stt, "nvidia_pip_dirs", lambda: _fake_nvidia(tmp_path))
    payload = stt.status_payload()
    assert payload["cudaRuntimeReady"] is False


def test_status_reports_true_only_with_both_libraries(tmp_path, monkeypatch):
    _clean_env(monkeypatch)
    monkeypatch.setenv("FRIDAY_STT_CUDA", "1")
    monkeypatch.setattr(stt, "expose_cuda_dirs", lambda dirs: None)
    both = _fake_nvidia(tmp_path)
    monkeypatch.setattr(stt, "nvidia_pip_dirs", lambda: both)
    assert stt.status_payload()["cudaRuntimeReady"] is True
    half_root = tmp_path / "half"
    half_root.mkdir()
    half = _fake_nvidia(half_root, with_cudnn=False)
    monkeypatch.setattr(stt, "nvidia_pip_dirs", lambda: half)
    assert stt.status_payload()["cudaRuntimeReady"] is False


def test_worker_status_and_probe_ops_carry_the_field(tmp_path, monkeypatch):
    _clean_env(monkeypatch)
    monkeypatch.setenv("FRIDAY_GPU", "1")
    monkeypatch.setattr(stt, "expose_cuda_dirs", lambda dirs: None)
    folders = _fake_nvidia(tmp_path)
    monkeypatch.setattr(stt, "nvidia_pip_dirs", lambda: folders)
    for op in ("status", "probe"):
        assert stt._handle_op({"op": op})["cudaRuntimeReady"] is True


def test_probe_flag_prints_the_field(tmp_path, monkeypatch, capsys):
    _clean_env(monkeypatch)
    monkeypatch.setattr(stt, "nvidia_pip_dirs", lambda: _fake_nvidia(tmp_path))
    monkeypatch.setattr(sys, "argv", ["stt.py", "--probe"])
    assert stt.main() == 0
    out = capsys.readouterr().out.strip().splitlines()[-1]
    assert json.loads(out)["cudaRuntimeReady"] is False
    assert os.environ.get("FRIDAY_STT_CUDA") is None
