"""Chroma 1.x ignores CHROMA_CACHE_DIR: kernel/memory.py points its embedding model at the FRIDAY folder."""

from __future__ import annotations

import sys
import types
from pathlib import Path
from typing import Any

import memory

_memory: Any = memory


def _fake_chroma(monkeypatch, default: Path):
    """A stand-in for chromadb's onnx_mini_lm_l6_v2 module with the real class attributes."""

    class ONNXMiniLM_L6_V2:  # noqa: N801 - the library's own name
        MODEL_NAME = "all-MiniLM-L6-v2"
        DOWNLOAD_PATH = default

    module: Any = types.ModuleType("chromadb.utils.embedding_functions.onnx_mini_lm_l6_v2")
    module.ONNXMiniLM_L6_V2 = ONNXMiniLM_L6_V2
    for name in (
        "chromadb",
        "chromadb.utils",
        "chromadb.utils.embedding_functions",
    ):
        monkeypatch.setitem(sys.modules, name, types.ModuleType(name))
    monkeypatch.setitem(sys.modules, module.__name__, module)
    return ONNXMiniLM_L6_V2


def test_cache_dir_variable_moves_the_embedding_model(monkeypatch, tmp_path):
    home_cache = tmp_path / "home" / ".cache" / "chroma" / "onnx_models" / "all-MiniLM-L6-v2"
    cls = _fake_chroma(monkeypatch, home_cache)
    root = tmp_path / "FRIDAY" / "cache" / "chroma"
    monkeypatch.setenv("CHROMA_CACHE_DIR", str(root))
    _memory._point_chroma_model_cache()
    assert cls.DOWNLOAD_PATH == root / "onnx_models" / "all-MiniLM-L6-v2"


def test_without_the_variable_chroma_keeps_its_own_folder(monkeypatch, tmp_path):
    home_cache = tmp_path / "home" / "chroma"
    cls = _fake_chroma(monkeypatch, home_cache)
    monkeypatch.delenv("CHROMA_CACHE_DIR", raising=False)
    _memory._point_chroma_model_cache()
    assert cls.DOWNLOAD_PATH == home_cache
    monkeypatch.setenv("CHROMA_CACHE_DIR", "   ")
    _memory._point_chroma_model_cache()
    assert cls.DOWNLOAD_PATH == home_cache


def test_a_chroma_without_the_class_is_left_alone(monkeypatch):
    monkeypatch.setenv("CHROMA_CACHE_DIR", "C:/FRIDAY/cache/chroma")
    monkeypatch.setitem(sys.modules, "chromadb", None)  # import raises
    _memory._point_chroma_model_cache()  # must not raise
