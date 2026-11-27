"""The int8 derive step and its accept gate: the recipe, the record it returns, and every limit of the gate.

Nothing here needs the network or a model file. ``derive`` runs with a fake quantiser, so the record shape, the hashes
and the refusals are tested without the ``onnx`` package; the one test that quantises a real graph is skipped where
``onnx`` is not installed (it is not a kernel dependency).
"""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import voice_derive as vd  # noqa: E402


def _graphs(root: Path, names=("decoder.onnx", "joint.onnx")) -> None:
    for name in names:
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"fp32:" + name.encode())


def _fake(source: Path, target: Path, recipe) -> None:
    target.write_bytes(b"int8:" + source.read_bytes())


# ---- the recipe -----------------------------------------------------------------------------------------------


def test_recipe_is_the_fixed_int8_recipe():
    r = vd.make_recipe("friday-ear")
    assert r["weightType"] == "QInt8" and r["perChannel"] is True and r["reduceRange"] is True
    assert r["graphs"] == ["decoder.onnx", "joint.onnx"]  # the encoder is already int8 in the pinned export
    voice = vd.make_recipe("friday-voice")
    assert voice["graphs"] == ["onnx/text_encoder.onnx", "onnx/duration_predictor.onnx"]
    assert not any("vocoder" in g or "vector_estimator" in g for g in voice["graphs"])


def test_recipe_id_follows_every_field():
    a = vd.make_recipe("friday-ear")
    assert vd.recipe_id(a) == vd.recipe_id(dict(a))
    assert vd.recipe_id(a).startswith("friday-ear-int8-")
    assert vd.recipe_id(a) != vd.recipe_id(vd.make_recipe("friday-ear", ("decoder.onnx",)))
    assert vd.recipe_id(a) != vd.recipe_id({**a, "weightType": "QUInt8"})


def test_unknown_model_without_graphs_is_refused():
    with pytest.raises(vd.DeriveError):
        vd.make_recipe("no-such-model")
    assert vd.make_recipe("custom", ("x/y.onnx",))["graphs"] == ["x/y.onnx"]


@pytest.mark.parametrize(
    "change",
    [
        {"reduceRange": False},
        {"perChannel": False},
        {"weightType": "QUInt8"},
        {"method": "static"},
        {"graphs": []},
        {"graphs": ["../outside.onnx"]},
        {"graphs": ["/etc/model.onnx"]},
        {"graphs": ["a\\b.onnx"]},
        {"graphs": ["weights.bin"]},
        {"graphs": ["a.onnx", "a.onnx"]},
    ],
)
def test_a_recipe_that_loosens_the_rules_is_refused(tmp_path, change):
    src, out = tmp_path / "src", tmp_path / "out"
    _graphs(src, ("a.onnx",))
    with pytest.raises(vd.DeriveError):
        vd.derive(src, out, {**vd.make_recipe("m", ("a.onnx",)), **change}, quantize=_fake, ort_version="x")
    assert not out.exists()


# ---- derive ---------------------------------------------------------------------------------------------------


def test_derive_returns_hashes_sizes_recipe_and_runtime_version(tmp_path):
    src, out = tmp_path / "src", tmp_path / "out"
    _graphs(src, ("decoder.onnx", "joint.onnx", "encoder.onnx"))
    recipe = vd.make_recipe("friday-ear")
    seen = []

    def quantize(source, target, rec):
        seen.append((source.name, rec["reduceRange"]))
        _fake(source, target, rec)

    record = vd.derive(src, out, recipe, quantize=quantize, ort_version="1.2.3")
    assert set(record) == {"files", "recipeId", "ortVersion"}
    assert record["recipeId"] == vd.recipe_id(recipe) and record["ortVersion"] == "1.2.3"
    assert set(record["files"]) == {"decoder.onnx", "joint.onnx"}  # the encoder is not touched or copied
    assert seen == [("decoder.onnx", True), ("joint.onnx", True)]
    for name, row in record["files"].items():
        data = (out / name).read_bytes()
        assert row == {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
    assert not (out / "encoder.onnx").exists()
    assert (src / "decoder.onnx").read_bytes() == b"fp32:decoder.onnx"  # the source is never changed


def test_derive_keeps_nested_graph_names(tmp_path):
    src, out = tmp_path / "src", tmp_path / "out"
    recipe = vd.make_recipe("friday-voice")
    _graphs(src, tuple(recipe["graphs"]))
    record = vd.derive(src, out, recipe, quantize=_fake, ort_version="v")
    assert set(record["files"]) == set(recipe["graphs"])
    assert (out / "onnx" / "text_encoder.onnx").is_file()


def test_derive_is_repeatable(tmp_path):
    src = tmp_path / "src"
    _graphs(src)
    recipe = vd.make_recipe("friday-ear")
    one = vd.derive(src, tmp_path / "a", recipe, quantize=_fake, ort_version="v")
    two = vd.derive(src, tmp_path / "b", recipe, quantize=_fake, ort_version="v")
    assert one == two


def test_derive_refuses_a_missing_graph_and_writes_nothing(tmp_path):
    src, out = tmp_path / "src", tmp_path / "out"
    _graphs(src, ("decoder.onnx",))
    with pytest.raises(vd.DeriveError, match="joint.onnx"):
        vd.derive(src, out, vd.make_recipe("friday-ear"), quantize=_fake, ort_version="v")
    assert not out.exists()


def test_derive_refuses_the_source_folder_as_output(tmp_path):
    _graphs(tmp_path)
    with pytest.raises(vd.DeriveError):
        vd.derive(tmp_path, tmp_path, vd.make_recipe("friday-ear"), quantize=_fake, ort_version="v")
    assert (tmp_path / "decoder.onnx").read_bytes() == b"fp32:decoder.onnx"


def test_derive_names_a_quantiser_that_wrote_nothing(tmp_path):
    src = tmp_path / "src"
    _graphs(src)
    with pytest.raises(vd.DeriveError, match="wrote nothing"):
        vd.derive(src, tmp_path / "out", vd.make_recipe("friday-ear"), quantize=lambda s, t, r: None, ort_version="v")


def test_derive_really_quantises_a_tiny_graph(tmp_path):
    onnx = pytest.importorskip("onnx", reason="onnx is not a kernel dependency; only the derive call is skipped")
    pytest.importorskip("onnxruntime")
    import numpy as np
    from onnx import TensorProto, helper, numpy_helper

    weight = numpy_helper.from_array(np.random.RandomState(0).randn(64, 32).astype(np.float32), "w")
    node = helper.make_node("MatMul", ["x", "w"], ["y"])
    graph = helper.make_graph(
        [node],
        "tiny",
        [helper.make_tensor_value_info("x", TensorProto.FLOAT, [1, 64])],
        [helper.make_tensor_value_info("y", TensorProto.FLOAT, [1, 32])],
        [weight],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
    model.ir_version = 9
    src = tmp_path / "src"
    src.mkdir()
    onnx.save(model, str(src / "tiny.onnx"))
    record = vd.derive(src, tmp_path / "out", vd.make_recipe("tiny", ("tiny.onnx",)))
    assert record["files"]["tiny.onnx"]["bytes"] < (src / "tiny.onnx").stat().st_size
    ops = {n.op_type for n in onnx.load(str(tmp_path / "out" / "tiny.onnx")).graph.node}
    assert "MatMulInteger" in ops and record["ortVersion"]


# ---- the gate -------------------------------------------------------------------------------------------------


def _stt(wer, cer, high_wer=0.0, high_cer=0.0):
    return {
        "wer": wer,
        "cer": cer,
        "ci": {"wer": {"low": -0.001, "high": high_wer}, "cer": {"low": 0.0, "high": high_cer}},
    }


def _base():
    return {
        "stt": {"hi": {"wer": 0.20, "cer": 0.08}, "en": {"wer": 0.10, "cer": 0.04}},
        "tts": {"cer": 0.05},
        "speed": {"chunkP95Ms": 200.0, "chunkP95LoadedMs": 260.0, "ttsFirstAudioMs": 400.0},
    }


def _cand():
    return {
        "stt": {"hi": _stt(0.202, 0.081, 0.004, 0.003), "en": _stt(0.101, 0.04, 0.002, 0.001)},
        "tts": {"cer": 0.052},
        "speed": {"chunkP95Ms": 150.0, "chunkP95LoadedMs": 200.0, "ttsFirstAudioMs": 410.0},
    }


def test_a_close_and_faster_candidate_passes():
    verdict = vd.accept(_base(), _cand())
    assert verdict == {"ok": True, "reasons": []}


def test_a_candidate_with_the_same_numbers_passes():
    base = _base()
    cand = {**base, "stt": {k: _stt(v["wer"], v["cer"]) for k, v in base["stt"].items()}}
    assert vd.accept(base, cand)["ok"] is True


@pytest.mark.parametrize("lang,metric", [("hi", "wer"), ("hi", "cer"), ("en", "wer"), ("en", "cer")])
def test_stt_rise_over_half_a_point_fails_and_exactly_half_passes(lang, metric):
    cand = _cand()
    base_value = _base()["stt"][lang][metric]
    cand["stt"][lang][metric] = base_value + 0.0050
    assert vd.accept(_base(), cand)["ok"] is True
    cand["stt"][lang][metric] = base_value + 0.0051
    verdict = vd.accept(_base(), cand)
    assert verdict["ok"] is False and any(f"stt {lang} {metric}" in r and "points" in r for r in verdict["reasons"])


def test_interval_high_over_one_point_fails_and_exactly_one_passes():
    cand = _cand()
    cand["stt"]["hi"]["ci"]["wer"]["high"] = 0.010
    assert vd.accept(_base(), cand)["ok"] is True
    cand["stt"]["hi"]["ci"]["wer"]["high"] = 0.0101
    verdict = vd.accept(_base(), cand)
    assert verdict["ok"] is False and any("interval high" in r for r in verdict["reasons"])


def test_a_missing_interval_or_language_fails():
    cand = _cand()
    del cand["stt"]["hi"]["ci"]
    assert any("no paired interval" in r for r in vd.accept(_base(), cand)["reasons"])
    cand = _cand()
    del cand["stt"]["en"]
    verdict = vd.accept(_base(), cand)
    assert verdict["ok"] is False and any("stt en" in r and "no number" in r for r in verdict["reasons"])
    cand = _cand()
    del cand["stt"]
    assert vd.accept(_base(), cand)["ok"] is False


def test_tts_round_trip_limit_is_one_point():
    cand = _cand()
    cand["tts"]["cer"] = 0.06
    assert vd.accept(_base(), cand)["ok"] is True
    cand["tts"]["cer"] = 0.0601
    verdict = vd.accept(_base(), cand)
    assert verdict["ok"] is False and any(r.startswith("tts cer") for r in verdict["reasons"])
    cand = _cand()
    del cand["tts"]
    assert vd.accept(_base(), cand)["ok"] is False


def test_int8_may_be_at_most_ten_percent_slower():
    cand = _cand()
    cand["speed"]["chunkP95Ms"] = 220.0
    assert vd.accept(_base(), cand)["ok"] is True
    cand["speed"]["chunkP95Ms"] = 220.2
    verdict = vd.accept(_base(), cand)
    assert verdict["ok"] is False and any("speed chunkP95Ms" in r for r in verdict["reasons"])


def test_the_loaded_speed_counts_like_the_idle_speed():
    cand = _cand()
    cand["speed"]["chunkP95LoadedMs"] = 300.0
    verdict = vd.accept(_base(), cand)
    assert verdict["ok"] is False and any("chunkP95LoadedMs" in r for r in verdict["reasons"])
    cand = _cand()
    del cand["speed"]["chunkP95LoadedMs"]
    assert any("chunkP95LoadedMs" in r and "no number" in r for r in vd.accept(_base(), cand)["reasons"])


def test_a_gate_with_only_speed_or_only_accuracy_does_not_pass():
    speed_only = {"speed": {"chunkP95Ms": 100.0}}
    verdict = vd.accept(speed_only, speed_only)
    assert verdict["ok"] is False and "no accuracy number in the baseline" in verdict["reasons"]
    acc_only = {"tts": {"cer": 0.05}}
    verdict = vd.accept(acc_only, acc_only)
    assert verdict["ok"] is False and "no speed number in the baseline" in verdict["reasons"]
    assert vd.accept({}, {})["ok"] is False


def test_bad_numbers_fail_closed():
    cand = _cand()
    cand["tts"]["cer"] = float("nan")
    assert vd.accept(_base(), cand)["ok"] is False
    cand = _cand()
    cand["speed"]["chunkP95Ms"] = True
    assert vd.accept(_base(), cand)["ok"] is False
    cand = _cand()
    cand["speed"]["chunkP95Ms"] = "150"
    assert vd.accept(_base(), cand)["ok"] is False


def test_every_failure_is_named_not_only_the_first():
    cand = _cand()
    cand["stt"]["hi"]["wer"] = 0.30
    cand["tts"]["cer"] = 0.20
    cand["speed"]["ttsFirstAudioMs"] = 900.0
    verdict = vd.accept(_base(), cand)
    assert verdict["ok"] is False and len(verdict["reasons"]) >= 3


def test_accept_does_not_change_its_inputs():
    base, cand = _base(), _cand()
    before = (repr(base), repr(cand))
    vd.accept(base, cand)
    assert (repr(base), repr(cand)) == before
