"""FRIDAY Runtime: the one door for onnxruntime sessions (budget, hash once per stamp, CPU fallback, one error type).

A real 84-byte graph (``fixtures/tiny_relu.onnx``, Relu over four floats) runs through the real onnxruntime; no weights,
no network. The hash counter wraps ``_hash_file``, so the tests count full reads instead of timing them.
"""

from __future__ import annotations

import hashlib
import os
import sys
import types
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import friday_runtime as fr  # noqa: E402

ort = pytest.importorskip("onnxruntime")
FIXTURE = Path(__file__).parent / "fixtures" / "tiny_relu.onnx"
SHA = hashlib.sha256(FIXTURE.read_bytes()).hexdigest()
CPU = "CPUExecutionProvider"


@pytest.fixture(autouse=True)
def _fresh_cache():
    fr._verified.clear()
    yield
    fr._verified.clear()


@pytest.fixture
def model(tmp_path):
    target = tmp_path / "tiny.onnx"
    target.write_bytes(FIXTURE.read_bytes())
    return target


@pytest.fixture
def hashes(monkeypatch):
    calls: list[Path] = []
    real = fr._hash_file

    def counting(path):
        calls.append(Path(path))
        return real(path)

    monkeypatch.setattr(fr, "_hash_file", counting)
    return calls


def test_the_fixture_is_a_real_graph_that_runs():
    session = fr.open_session(FIXTURE, "vad")
    out = session.run(None, {"x": np.array([[-1, 2, -3, 4]], dtype=np.float32)})[0]
    assert out.tolist() == [[0.0, 2.0, 0.0, 4.0]]


def test_the_budget_of_the_role_reaches_the_session(monkeypatch):
    seen: dict = {}

    def budget(role, phase=None, cores=None, intra=None):
        seen.update(role=role, phase=phase, intra=intra)
        return None

    monkeypatch.setattr(fr.voice_budget, "ort_session_options", budget)
    fr.open_session(FIXTURE, "tts", "speaking", intra=3)
    assert seen == {"role": "tts", "phase": "speaking", "intra": 3}


def test_the_real_options_carry_the_budget_threads(monkeypatch):
    seen = {}
    real = ort.InferenceSession

    class Spy:
        def __init__(self, path, options, providers):
            seen["intra"] = options.intra_op_num_threads
            seen["inter"] = options.inter_op_num_threads
            seen["spin"] = options.get_session_config_entry("session.intra_op.allow_spinning")
            self._inner = real(path, options, providers=providers)

        def __getattr__(self, name):
            return getattr(self._inner, name)

    monkeypatch.setattr(ort, "InferenceSession", Spy)
    fr.open_session(FIXTURE, "vad")
    assert seen == {"intra": 1, "inter": 1, "spin": "0"}


def test_a_thread_count_the_caller_was_told_to_use_replaces_the_budget(monkeypatch):
    seen = {}
    real = ort.InferenceSession

    class Spy:
        def __init__(self, path, options, providers):
            seen["intra"] = options.intra_op_num_threads
            self._inner = real(path, options, providers=providers)

        def __getattr__(self, name):
            return getattr(self._inner, name)

    monkeypatch.setattr(ort, "InferenceSession", Spy)
    fr.open_session(FIXTURE, "asr_final", intra=2)
    assert seen["intra"] == 2


def test_configure_sets_the_options_only_this_graph_needs():
    marks = []

    def configure(options, runtime, providers):
        options.log_severity_level = 3
        marks.append((runtime is ort, providers))

    fr.open_session(FIXTURE, "vad", configure=configure)
    assert marks == [(True, [CPU])]


def test_the_hash_is_checked_once_and_a_cold_load_does_not_hash_again(model, hashes):
    assert fr.open_session(model, "vad", sha256=SHA)
    assert fr.open_session(model, "vad", sha256=SHA)
    assert fr.verify(model, SHA)
    assert len(hashes) == 1


def test_a_changed_stamp_hashes_the_file_again(model, hashes):
    fr.open_session(model, "vad", sha256=SHA)
    stat = model.stat()
    os.utime(model, ns=(stat.st_atime_ns, stat.st_mtime_ns + 5_000_000_000))
    fr.open_session(model, "vad", sha256=SHA)
    assert len(hashes) == 2


def test_force_hashes_again_for_doctor(model, hashes):
    assert fr.verify(model, SHA)
    assert fr.verify(model, SHA, force=True)
    assert len(hashes) == 2


def test_a_wrong_hash_is_refused_and_never_remembered(model, hashes):
    with pytest.raises(fr.FridayRuntimeError, match="SHA-256"):
        fr.open_session(model, "vad", sha256="0" * 64)
    assert fr.verify(model, SHA)
    assert fr.verify(model, "0" * 64) is False
    assert len(hashes) == 3


def test_a_file_that_changed_in_place_with_the_same_hash_claim_is_caught(model):
    assert fr.verify(model, SHA)
    model.write_bytes(model.read_bytes() + b"\0")  # size changes: the stamp no longer matches
    assert fr.verify(model, SHA) is False


def test_a_missing_file_does_not_verify(tmp_path):
    assert fr.verify(tmp_path / "nope.onnx", SHA) is False


def test_a_provider_that_cannot_open_falls_back_to_the_cpu(monkeypatch):
    tried: list[list[str]] = []
    real = ort.InferenceSession

    def flaky(path, options, providers):
        tried.append(list(providers))
        if "DmlExecutionProvider" in providers:
            raise RuntimeError("no such device")
        return real(path, options, providers=providers)

    monkeypatch.setattr(ort, "InferenceSession", flaky)
    seen: list[list[str]] = []
    session = fr.open_session(
        FIXTURE, "asr_stream", providers=["DmlExecutionProvider", CPU], configure=lambda o, r, p: seen.append(p)
    )
    assert tried == [["DmlExecutionProvider", CPU], [CPU]]
    assert seen == [["DmlExecutionProvider", CPU], [CPU]]
    assert session.run(None, {"x": np.zeros((1, 4), dtype=np.float32)})


def test_a_cpu_open_that_fails_is_one_error_type_with_the_cause_chained(tmp_path):
    broken = tmp_path / "broken.onnx"
    broken.write_bytes(b"not a graph")
    with pytest.raises(fr.FridayRuntimeError, match="broken.onnx did not open") as raised:
        fr.open_session(broken, "vad")
    assert raised.value.__cause__ is not None


def test_a_missing_file_is_a_friday_runtime_error(tmp_path):
    with pytest.raises(fr.FridayRuntimeError):
        fr.open_session(tmp_path / "gone.onnx", "vad")


def test_an_unknown_role_is_refused():
    with pytest.raises(fr.FridayRuntimeError, match="unknown voice role"):
        fr.open_session(FIXTURE, "toaster")


def test_a_missing_runtime_is_one_named_error(monkeypatch):
    monkeypatch.setitem(sys.modules, "onnxruntime", None)
    with pytest.raises(fr.FridayRuntimeError, match="onnxruntime is not available"):
        fr.open_session(FIXTURE, "vad")


def test_a_runtime_handed_in_is_used_and_gets_no_options_when_it_has_none():
    calls = []

    class Plain:
        def __init__(self, path, providers=None):
            calls.append((path, providers))

    module = types.ModuleType("plain_ort")
    module.InferenceSession = Plain  # type: ignore[attr-defined]
    made = fr.open_session("a.onnx", "turn", ort_module=module)
    assert isinstance(made, Plain) and calls == [("a.onnx", [CPU])]


def test_the_optimised_graph_cache_is_off_by_default(model, tmp_path, monkeypatch):
    monkeypatch.delenv(fr.CACHE_ENV, raising=False)
    cache = tmp_path / "cache"
    fr.open_session(model, "vad", sha256=SHA, cache_dir=cache)
    assert not cache.exists()


def test_the_optimised_graph_cache_is_keyed_by_hash_runtime_and_cpu(model, tmp_path):
    cache = tmp_path / "cache"
    fr.open_session(model, "vad", sha256=SHA, cache_dir=cache, optimized_cache=True)
    files = sorted(p.name for p in cache.iterdir())
    assert len(files) == 1 and files[0].startswith(SHA[:24]) and f"ort{ort.__version__}" in files[0]
    assert files[0].endswith(".onnx") and not files[0].endswith(".tmp")
    again = fr.open_session(model, "vad", sha256=SHA, cache_dir=cache, optimized_cache=True)
    assert sorted(p.name for p in cache.iterdir()) == files
    assert again.run(None, {"x": np.ones((1, 4), dtype=np.float32)})[0].tolist() == [[1.0] * 4]


def test_a_damaged_cache_copy_is_dropped_and_the_real_file_opens(model, tmp_path):
    cache = tmp_path / "cache"
    fr.open_session(model, "vad", sha256=SHA, cache_dir=cache, optimized_cache=True)
    (copy,) = list(cache.iterdir())
    copy.write_bytes(b"damaged")
    session = fr.open_session(model, "vad", sha256=SHA, cache_dir=cache, optimized_cache=True)
    assert session.get_inputs()[0].name == "x"
    assert copy.stat().st_size != len(b"damaged") or copy.read_bytes() != b"damaged"


def test_the_cache_needs_the_hash_and_the_cpu(model, tmp_path):
    cache = tmp_path / "cache"
    fr.open_session(model, "vad", cache_dir=cache, optimized_cache=True)
    assert not cache.exists()


def test_runtime_info_names_the_layer_and_the_engine():
    info = fr.runtime_info()
    assert info["name"] == "FRIDAY Runtime" and info["engine"] == "onnxruntime"
    assert info["engineVersion"] == ort.__version__ and CPU in info["providers"]


def test_runtime_info_without_the_engine_is_an_answer_not_a_crash(monkeypatch):
    monkeypatch.setitem(sys.modules, "onnxruntime", None)
    info = fr.runtime_info()
    assert info == {"name": "FRIDAY Runtime", "engine": "onnxruntime", "engineVersion": None, "providers": []}


def test_session_options_for_a_package_that_opens_its_own_session():
    options = fr.session_options("asr_final", intra=2)
    assert options.intra_op_num_threads == 2
    with pytest.raises(fr.FridayRuntimeError):
        fr.session_options("toaster")


def test_the_config_key_turns_the_cache_on_and_the_variable_wins(monkeypatch, tmp_path):
    (tmp_path / "kernel.yaml").write_text("voice_runtime:\n  optimized_cache: true\n", encoding="utf-8")
    monkeypatch.setenv("FRIDAY_CONFIG_DIR", str(tmp_path))
    monkeypatch.delenv(fr.CACHE_ENV, raising=False)
    assert fr._cache_enabled(None) is True
    monkeypatch.setenv(fr.CACHE_ENV, "0")
    assert fr._cache_enabled(None) is False
    (tmp_path / "kernel.yaml").write_text("voice_runtime:\n  optimized_cache: false\n", encoding="utf-8")
    monkeypatch.setenv(fr.CACHE_ENV, "1")
    assert fr._cache_enabled(None) is True


def test_the_shipped_config_keeps_the_cache_off(monkeypatch):
    monkeypatch.delenv("FRIDAY_CONFIG_DIR", raising=False)
    monkeypatch.delenv("FRIDAY_ROOT", raising=False)
    monkeypatch.delenv(fr.CACHE_ENV, raising=False)
    assert fr._config_cache_flag() is False
    text = (Path(__file__).resolve().parents[2] / "config" / "kernel.yaml").read_text(encoding="utf-8")
    assert "optimized_cache: false" in text
    assert "auto_approve_exec: false" in text


def test_the_doctor_row_names_the_layer_the_engine_and_the_providers():
    import voice_pin_selftest as pins

    row = pins.runtime_row(
        {
            "name": "FRIDAY Runtime",
            "engine": "onnxruntime",
            "engineVersion": "1.2.3",
            "providers": [CPU],
            "optimizedCache": False,
        }
    )
    assert row["id"] == "friday-runtime" and row["label"] == "FRIDAY Runtime" and row["ok"] is True
    assert "1.2.3" in row["detail"] and CPU in row["detail"]
    assert pins.runtime_row({"engineVersion": None, "providers": []})["ok"] is False
    assert pins.runtime_row()["label"] == "FRIDAY Runtime"


# ---- own_engine: the engine is FRIDAY's only when the installed wheel hash is the pinned one ----------------------


class _Dist:
    def __init__(self, text):
        self.text = text

    def read_text(self, name):
        return self.text if name == "direct_url.json" else None


def _cfg(tmp_path, wheels):
    import json

    path = tmp_path / "friday-runtime.json"
    path.write_text(json.dumps({"wheels": wheels}), encoding="utf-8")
    return path


def _direct(sha):
    import json

    return json.dumps({"url": "file:///w.whl", "archive_info": {"hashes": {"sha256": sha}}})


def test_own_engine_matches_the_pinned_wheel(tmp_path):
    sha = "ab" * 32
    cfg = _cfg(tmp_path, {fr._platform_key(): {"file": "w.whl", "sha256": sha}})
    assert fr.own_engine(cfg, _Dist(_direct(sha.upper()))) is True


def test_own_engine_mismatch_is_official(tmp_path):
    cfg = _cfg(tmp_path, {fr._platform_key(): {"file": "w.whl", "sha256": "ab" * 32}})
    assert fr.own_engine(cfg, _Dist(_direct("cd" * 32))) is False


def test_own_engine_without_direct_url_is_official(tmp_path):
    cfg = _cfg(tmp_path, {fr._platform_key(): {"file": "w.whl", "sha256": "ab" * 32}})
    assert fr.own_engine(cfg, _Dist(None)) is False


def test_own_engine_with_empty_wheels_is_official(tmp_path):
    assert fr.own_engine(_cfg(tmp_path, {}), _Dist(_direct("ab" * 32))) is False


def test_own_engine_bad_json_never_throws(tmp_path):
    cfg = _cfg(tmp_path, {fr._platform_key(): {"sha256": "ab" * 32}})
    assert fr.own_engine(cfg, _Dist("{not json")) is False
    cfg.write_text("{broken", encoding="utf-8")
    assert fr.own_engine(cfg, _Dist(_direct("ab" * 32))) is False
    assert fr.own_engine(tmp_path / "missing.json", _Dist(_direct("ab" * 32))) is False


def test_runtime_info_names_the_own_build_only_on_a_match(monkeypatch):
    monkeypatch.setattr(fr, "own_engine", lambda *a, **k: True)
    assert fr.runtime_info()["name"] == "FRIDAY Runtime (own build)"
    monkeypatch.setattr(fr, "own_engine", lambda *a, **k: False)
    assert fr.runtime_info()["name"] == "FRIDAY Runtime"
