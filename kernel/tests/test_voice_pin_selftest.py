"""The self-test of the optional voice pins: a fake onnxruntime stands in, no weights and no network.

The fake exposes the calls the self-test uses (``InferenceSession`` with ``get_inputs``, ``get_outputs`` and ``run``),
so every refusal reason is reachable:
file missing, runtime missing, graph differs, wrong shape, run fails.
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "kernel"))

import voice_pin_selftest as selftest  # noqa: E402

DENOISE = {
    "kind": "onnx-signature",
    "file": "onnx/dpdfnet8.onnx",
    "inputs": [
        {"name": "spec", "shape": [1, 1, 161, 2], "type": "float32"},
        {"name": "state_in", "shape": [66928], "type": "float32"},
    ],
    "outputs": [{"name": "spec_e", "shape": [1, 1, 161, 2]}, {"name": "state_out", "shape": [66928]}],
}
SPEAKER = {
    "kind": "onnx-signature",
    "file": "onnx/model_int8.onnx",
    "inputs": [{"name": "input_features", "shape": ["B", "T", 80], "type": "float32", "run": [1, 200, 80]}],
    "outputs": [{"name": "last_hidden_state", "shape": ["B", 256]}],
}


def _node(name: str, shape: list, kind: str = "tensor(float)") -> types.SimpleNamespace:
    return types.SimpleNamespace(name=name, shape=shape, type=kind)


def _fake_ort(inputs: list, outputs: list, returns: list | None = None, fail: bool = False) -> types.ModuleType:
    class Session:
        def __init__(self, path: str, providers: list[str]) -> None:
            assert providers == ["CPUExecutionProvider"]
            self.path = path

        def get_inputs(self) -> list:
            return inputs

        def get_outputs(self) -> list:
            return outputs

        def run(self, names: list[str], feed: dict) -> list:
            if fail:
                raise RuntimeError("kernel died")
            assert set(feed) == {item.name for item in inputs}
            for item in inputs:
                assert all(isinstance(dim, int) for dim in feed[item.name].shape)
            return returns if returns is not None else [np.zeros([1, 1, 161, 2]), np.zeros([66928])]

    module = types.ModuleType("fake_ort")
    module.InferenceSession = Session  # type: ignore[attr-defined]
    return module


def _folder(tmp_path: Path, spec: dict) -> Path:
    file = tmp_path / spec["file"]
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_bytes(b"x")
    return tmp_path


DENOISE_IO = (
    [_node("spec", [1, 1, 161, 2]), _node("state_in", [66928])],
    [_node("spec_e", [1, 1, 161, 2]), _node("state_out", [66928])],
)


def test_denoise_graph_that_matches_its_pin_passes(tmp_path: Path) -> None:
    result = selftest.selftest_onnx(_folder(tmp_path, DENOISE), DENOISE, _fake_ort(*DENOISE_IO), np)
    assert result["ok"] is True and result["reason"] == ""


def test_dynamic_dimensions_take_the_run_shape_and_any_size(tmp_path: Path) -> None:
    io = ([_node("input_features", ["B", "T", 80])], [_node("last_hidden_state", ["B", 256])])
    ort = _fake_ort(*io, returns=[np.zeros([1, 256])])
    assert selftest.selftest_onnx(_folder(tmp_path, SPEAKER), SPEAKER, ort, np)["ok"] is True
    # a dynamic axis the runtime reports as None is also accepted
    io = ([_node("input_features", [None, None, 80])], [_node("last_hidden_state", [None, 256])])
    ort = _fake_ort(*io, returns=[np.zeros([1, 256])])
    assert selftest.selftest_onnx(_folder(tmp_path, SPEAKER), SPEAKER, ort, np)["ok"] is True


def test_missing_file_is_a_named_failure(tmp_path: Path) -> None:
    result = selftest.selftest_onnx(tmp_path, DENOISE, _fake_ort(*DENOISE_IO), np)
    assert (result["ok"], result["reason"]) == (False, "file-missing")


def test_missing_runtime_is_a_named_failure_not_a_crash(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setitem(sys.modules, "onnxruntime", None)  # import raises ImportError
    result = selftest.selftest_onnx(_folder(tmp_path, DENOISE), DENOISE, None, np)
    assert (result["ok"], result["reason"]) == (False, "runtime-missing")


def test_unopenable_graph_is_cannot_open(tmp_path: Path) -> None:
    ort = _fake_ort(*DENOISE_IO)

    def boom(path: str, providers: list[str]) -> None:
        raise ValueError("protobuf parsing failed")

    ort.InferenceSession = boom  # type: ignore[attr-defined]
    result = selftest.selftest_onnx(_folder(tmp_path, DENOISE), DENOISE, ort, np)
    assert (result["ok"], result["reason"]) == (False, "cannot-open")


def test_a_different_graph_is_refused(tmp_path: Path) -> None:
    folder = _folder(tmp_path, DENOISE)
    other_inputs = ([_node("spec", [1, 1, 161, 2])], DENOISE_IO[1])
    assert selftest.selftest_onnx(folder, DENOISE, _fake_ort(*other_inputs), np)["reason"] == "inputs-differ"
    other_outputs = (DENOISE_IO[0], [_node("spec_e", [1, 1, 161, 2])])
    assert selftest.selftest_onnx(folder, DENOISE, _fake_ort(*other_outputs), np)["reason"] == "outputs-differ"
    wrong_shape = ([_node("spec", [1, 1, 257, 2]), _node("state_in", [66928])], DENOISE_IO[1])
    assert selftest.selftest_onnx(folder, DENOISE, _fake_ort(*wrong_shape), np)["reason"] == "input-shape-differs"
    wrong_type = ([_node("spec", [1, 1, 161, 2], "tensor(float16)"), _node("state_in", [66928])], DENOISE_IO[1])
    assert selftest.selftest_onnx(folder, DENOISE, _fake_ort(*wrong_type), np)["reason"] == "input-type-differs"
    bad_out = (DENOISE_IO[0], [_node("spec_e", [1, 1, 161, 2]), _node("state_out", [10])])
    assert selftest.selftest_onnx(folder, DENOISE, _fake_ort(*bad_out), np)["reason"] == "output-shape-differs"


def test_a_failed_pass_or_wrong_output_shape_is_red(tmp_path: Path) -> None:
    folder = _folder(tmp_path, DENOISE)
    failing = selftest.selftest_onnx(folder, DENOISE, _fake_ort(*DENOISE_IO, fail=True), np)
    assert (failing["ok"], failing["reason"]) == (False, "run-failed")
    short = selftest.selftest_onnx(
        folder, DENOISE, _fake_ort(*DENOISE_IO, returns=[np.zeros([1, 1, 161, 2]), np.zeros([5])]), np
    )
    assert (short["ok"], short["reason"]) == (False, "output-wrong-shape")


def test_a_dynamic_input_without_a_run_shape_is_refused(tmp_path: Path) -> None:
    spec = {**SPEAKER, "inputs": [{"name": "input_features", "shape": ["B", "T", 80], "type": "float32"}]}
    io = ([_node("input_features", ["B", "T", 80])], [_node("last_hidden_state", ["B", 256])])
    result = selftest.selftest_onnx(_folder(tmp_path, spec), spec, _fake_ort(*io), np)
    assert (result["ok"], result["reason"]) == (False, "no-run-shape")


CT2 = {"kind": "ct2-folder", "needs": ["config.json", "model.bin", "vocabulary.json", "tokenizer.json"]}


def test_ct2_folder_needs_every_file_including_the_tokenizer(tmp_path: Path) -> None:
    for name in ["config.json", "model.bin", "vocabulary.json"]:
        (tmp_path / name).write_bytes(b"x")
    result = selftest.selftest_ct2(tmp_path, CT2, importer=lambda name: object())
    assert (result["ok"], result["reason"]) == (False, "files-missing")
    assert "tokenizer.json" in result["detail"]
    (tmp_path / "tokenizer.json").write_bytes(b"x")
    assert selftest.selftest_ct2(tmp_path, CT2, importer=lambda name: object())["ok"] is True


def test_ct2_missing_library_is_named(tmp_path: Path) -> None:
    for name in CT2["needs"]:
        (tmp_path / name).write_bytes(b"x")

    def refuse(name: str) -> None:
        raise ImportError(name)

    result = selftest.selftest_ct2(tmp_path, CT2, importer=refuse)
    assert (result["ok"], result["reason"]) == (False, "runtime-missing")


def test_unknown_kind_and_bad_spec_never_pass(tmp_path: Path, capsys) -> None:
    assert selftest.run(tmp_path, {"kind": "something-else"})["reason"] == "no-self-test"
    sys.argv = ["voice_pin_selftest.py", "--dir", str(tmp_path), "--spec", "[1]"]
    assert selftest.main() == 0
    assert '"bad-spec"' in capsys.readouterr().out


VAANI = {
    "kind": "ct2-folder",
    "needs": ["config.json", "model.bin", "vocabulary.json"],
    "companion": {
        "file": "tokenizer.json",
        "reason": "needs the large-v3 tokenizer.json (Systran/faster-whisper-large-v3)",
    },
}


def _vaani_folder(tmp_path: Path, tokenizer: bool = False) -> Path:
    for name in ["config.json", "model.bin", "vocabulary.json"] + (["tokenizer.json"] if tokenizer else []):
        (tmp_path / name).write_bytes(b"x")
    return tmp_path


def test_a_missing_companion_is_blocked_with_its_reason_not_a_failure(tmp_path: Path) -> None:
    def never(name: str) -> None:
        raise AssertionError("the import must not be tried while the companion is missing")

    result = selftest.selftest_ct2(_vaani_folder(tmp_path), VAANI, importer=never)
    assert result["ok"] is True and result["blocked"] is True
    assert result["reason"] == "blocked-needs-tokenizer.json"
    assert "Systran/faster-whisper-large-v3" in result["detail"]


def test_with_the_companion_beside_it_the_folder_passes_for_real(tmp_path: Path) -> None:
    result = selftest.selftest_ct2(_vaani_folder(tmp_path, tokenizer=True), VAANI, importer=lambda name: object())
    assert result["ok"] is True and "blocked" not in result


def test_a_missing_pinned_file_is_still_a_failure_even_with_a_companion_rule(tmp_path: Path) -> None:
    (tmp_path / "config.json").write_bytes(b"x")
    result = selftest.selftest_ct2(tmp_path, VAANI, importer=lambda name: object())
    assert (result["ok"], result["reason"]) == (False, "files-missing")
