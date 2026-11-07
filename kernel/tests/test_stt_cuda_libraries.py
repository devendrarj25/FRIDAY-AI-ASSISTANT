"""Speech uses the graphics card when the CUDA 12 libraries that pip installs are present, and only then."""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "kernel"))

import stt  # noqa: E402


def _fake_nvidia(tmp_path: Path, with_cudnn: bool = True) -> list[Path]:
    sub = "bin" if os.name == "nt" else "lib"
    cublas = tmp_path / "nvidia" / "cublas" / sub
    cublas.mkdir(parents=True)
    (cublas / ("cublas64_12.dll" if os.name == "nt" else "libcublas.so.12")).write_bytes(b"x")
    folders = [cublas]
    if with_cudnn:
        cudnn = tmp_path / "nvidia" / "cudnn" / sub
        cudnn.mkdir(parents=True)
        (cudnn / ("cudnn64_9.dll" if os.name == "nt" else "libcudnn.so.9")).write_bytes(b"x")
        folders.append(cudnn)
    return folders


def _clean_env(monkeypatch):
    for key in ("FRIDAY_GPU", "FRIDAY_STT_CUDA", "CUDA_PATH", "LD_LIBRARY_PATH"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("PATH", "")


def test_nothing_asked_means_cpu_even_with_libraries(tmp_path, monkeypatch):
    _clean_env(monkeypatch)
    monkeypatch.setattr(stt, "nvidia_pip_dirs", lambda: _fake_nvidia(tmp_path))
    assert stt.cuda_runtime_ready() is False
    assert stt.choose_stt_device(False)["device"] == "cpu"


def test_asked_with_both_pip_libraries_uses_the_card(tmp_path, monkeypatch):
    _clean_env(monkeypatch)
    monkeypatch.setenv("FRIDAY_STT_CUDA", "1")
    folders = _fake_nvidia(tmp_path)
    exposed: list[list[Path]] = []
    monkeypatch.setattr(stt, "nvidia_pip_dirs", lambda: folders)
    monkeypatch.setattr(stt, "expose_cuda_dirs", lambda dirs: exposed.append(list(dirs)))
    assert stt.cuda_runtime_ready() is True
    assert exposed == [folders]
    assert stt.choose_stt_device(True)["device"] == "cuda"


def test_one_missing_library_stays_on_the_cpu(tmp_path, monkeypatch):
    _clean_env(monkeypatch)
    monkeypatch.setenv("FRIDAY_STT_CUDA", "1")
    monkeypatch.setattr(stt, "nvidia_pip_dirs", lambda: _fake_nvidia(tmp_path, with_cudnn=False))
    monkeypatch.setattr(stt, "expose_cuda_dirs", lambda dirs: None)
    assert stt.cuda_runtime_ready() is False


def test_pip_folders_are_found_from_the_installed_wheels(tmp_path, monkeypatch):
    _fake_nvidia(tmp_path)
    monkeypatch.syspath_prepend(str(tmp_path))
    import importlib

    importlib.invalidate_caches()
    found = stt.nvidia_pip_dirs()
    names = sorted(folder.parent.name for folder in found)
    assert names == ["cublas", "cudnn"]


def test_exposing_folders_puts_them_on_the_path(tmp_path, monkeypatch):
    monkeypatch.setenv("PATH", "")
    folders = _fake_nvidia(tmp_path)
    stt.expose_cuda_dirs(folders)
    assert str(folders[0]) in os.environ["PATH"].split(os.pathsep)
