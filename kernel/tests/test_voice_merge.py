import json
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import voice_merge as vm  # noqa: E402

WHISPER_TINY = {
    "model_type": "whisper",
    "d_model": 8,
    "encoder_layers": 1,
    "decoder_layers": 1,
    "encoder_attention_heads": 2,
    "decoder_attention_heads": 2,
    "encoder_ffn_dim": 16,
    "decoder_ffn_dim": 16,
    "vocab_size": 12,
    "num_mel_bins": 4,
    "max_source_positions": 6,
    "max_target_positions": 5,
    "scale_embedding": False,
    "suppress_tokens": [],
    "begin_suppress_tokens": [3],
}


def _src(path: Path, licence: str = "apache-2.0", weight: float = 1.0) -> dict:
    return {"path": str(path), "repo": f"test/{path.name}", "revision": "r1", "licence": licence, "weight": weight}


def _whisper_shapes(cfg: dict) -> dict[str, tuple[int, ...]]:
    d, f, m = cfg["d_model"], cfg["encoder_ffn_dim"], cfg["num_mel_bins"]
    shapes: dict[str, tuple[int, ...]] = {
        "model.encoder.conv1.weight": (d, m, 3), "model.encoder.conv1.bias": (d,),
        "model.encoder.conv2.weight": (d, d, 3), "model.encoder.conv2.bias": (d,),
        "model.encoder.embed_positions.weight": (cfg["max_source_positions"], d),
        "model.encoder.layer_norm.weight": (d,), "model.encoder.layer_norm.bias": (d,),
        "model.decoder.embed_tokens.weight": (cfg["vocab_size"], d),
        "model.decoder.embed_positions.weight": (cfg["max_target_positions"], d),
        "model.decoder.layer_norm.weight": (d,), "model.decoder.layer_norm.bias": (d,),
    }  # fmt: skip

    def attn(p: str) -> None:
        for proj in ("q_proj", "k_proj", "v_proj", "out_proj"):
            shapes[f"{p}.{proj}.weight"] = (d, d)
            if proj != "k_proj":
                shapes[f"{p}.{proj}.bias"] = (d,)

    def layer(p: str, cross: bool) -> None:
        attn(f"{p}.self_attn")
        norms = ["self_attn_layer_norm", "final_layer_norm"]
        if cross:
            attn(f"{p}.encoder_attn")
            norms.append("encoder_attn_layer_norm")
        for n in norms:
            shapes[f"{p}.{n}.weight"], shapes[f"{p}.{n}.bias"] = (d,), (d,)
        shapes[f"{p}.fc1.weight"], shapes[f"{p}.fc1.bias"] = (f, d), (f,)
        shapes[f"{p}.fc2.weight"], shapes[f"{p}.fc2.bias"] = (d, f), (d,)

    for i in range(cfg["encoder_layers"]):
        layer(f"model.encoder.layers.{i}", False)
    for i in range(cfg["decoder_layers"]):
        layer(f"model.decoder.layers.{i}", True)
    return shapes


VOCAB = {"<|endoftext|>": 0, "<|startoftranscript|>": 1, "<|en|>": 2, "<|hi|>": 3, "<|transcribe|>": 4,
         "<|translate|>": 5, "<|notimestamps|>": 6, "a": 7, "b": 8, "c": 9}  # fmt: skip


def _make_ckpt(folder: Path, tensors: dict[str, np.ndarray], config: dict, code: str = "F32",
               vocab: dict | None = None) -> Path:  # fmt: skip
    folder.mkdir(parents=True, exist_ok=True)
    names = sorted(tensors)
    plan = [(n, tuple(tensors[n].shape), code) for n in names]
    vm.write_safetensors(folder / "model.safetensors", plan, (tensors[n] for n in names))
    (folder / "config.json").write_text(json.dumps(config), encoding="utf-8")
    (folder / "vocab.json").write_text(json.dumps(vocab or VOCAB), encoding="utf-8")
    return folder


def _whisper_ckpt(folder: Path, seed: int, cfg: dict | None = None) -> Path:
    cfg = dict(cfg or WHISPER_TINY)
    rng = np.random.default_rng(seed)
    tensors = {n: rng.standard_normal(s).astype(np.float32) for n, s in _whisper_shapes(cfg).items()}
    _make_ckpt(folder, tensors, cfg)
    gen = {"suppress_tokens": [], "begin_suppress_tokens": [0], "lang_to_id": {"<|en|>": 2, "<|hi|>": 3}}
    (folder / "generation_config.json").write_text(json.dumps(gen), encoding="utf-8")
    return folder


# ---- licence -----------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("licence", ["MIT", "apache-2.0", "Apache-2.0", "bsd-3-clause", "cc-by-4.0", "cc0-1.0"])
def test_permissive_licences_are_accepted(licence):
    assert vm.licence_problem(licence) is None


@pytest.mark.parametrize(
    ("licence", "reason"),
    [
        ("cc-by-nc-4.0", "non-commercial"),
        ("CC-BY-NC-SA-4.0", "non-commercial"),
        ("cc-by-sa-4.0", "share-alike"),
        ("cc-by-nd-4.0", "derivatives"),
        ("gpl-3.0", "copyleft"),
        ("lgpl-2.1", "copyleft"),
        ("agpl-3.0", "copyleft"),
        ("openrail++", "allow-list"),
        ("other", "unknown"),
        ("", "unknown"),
        (None, "unknown"),
    ],
)
def test_non_permissive_or_unknown_licences_are_refused_with_the_reason(licence, reason):
    problem = vm.licence_problem(licence)
    assert problem is not None and reason in problem


def test_a_recipe_with_a_non_commercial_source_is_refused_before_any_work(tmp_path):
    recipe = {"method": "linear", "base": _src(tmp_path / "a", "mit"), "models": [_src(tmp_path / "b", "cc-by-nc-4.0")]}
    with pytest.raises(vm.MergeRefused, match="non-commercial"):
        vm.merge_checkpoints(recipe, tmp_path / "out")
    assert not (tmp_path / "out").exists()


# ---- architecture and vocabulary --------------------------------------------------------------------------------


def _sig(**config_over):
    cfg = {**WHISPER_TINY, **config_over}
    return vm.architecture_signature(cfg, _whisper_shapes(cfg))


def test_identical_architectures_pass():
    vm.check_same_architecture([_sig(), _sig()], ["base", "tuned"])


def test_a_turbo_style_decoder_depth_difference_is_refused():
    with pytest.raises(vm.MergeRefused, match="decoder_layers.*different architectures"):
        vm.check_same_architecture([_sig(decoder_layers=1), _sig(decoder_layers=2)], ["large", "turbo"])


def test_a_tensor_shape_or_name_difference_is_refused():
    a = _sig()
    b = {"config": a["config"], "tensors": {**a["tensors"], "model.decoder.embed_tokens.weight": (13, 8)}}
    with pytest.raises(vm.MergeRefused, match="embed_tokens.weight has shape"):
        vm.check_same_architecture([a, b])
    c = {"config": a["config"], "tensors": {k: v for k, v in a["tensors"].items() if "fc1" not in k}}
    with pytest.raises(vm.MergeRefused, match="tensor names differ"):
        vm.check_same_architecture([a, c])
    with pytest.raises(vm.MergeRefused, match="at least two"):
        vm.check_same_architecture([a])


def test_a_different_token_table_is_refused_even_with_equal_shapes():
    vm.check_same_vocabulary([dict(VOCAB), dict(VOCAB)])
    swapped = {**VOCAB, "a": 8, "b": 7}
    with pytest.raises(vm.MergeRefused, match="vocabulary differs .* 2 tokens"):
        vm.check_same_vocabulary([VOCAB, swapped], ["base", "other"])


# ---- merge math ---------------------------------------------------------------------------------------------------


BASE = np.array([1.0, 1.0, 1.0, 1.0], dtype=np.float32)


def test_linear_is_a_weighted_average_and_task_arithmetic_adds_scaled_deltas():
    other = np.array([3.0, 5.0, -1.0, 1.0], dtype=np.float32)
    lin = vm.merge_tensor("w", BASE, [other], {"method": "linear", "base_weight": 1.0, "models": [{"weight": 1.0}]})
    np.testing.assert_allclose(lin, [2.0, 3.0, 0.0, 1.0])
    lin3 = vm.merge_tensor("w", BASE, [other], {"method": "linear", "base_weight": 1.0, "models": [{"weight": 3.0}]})
    np.testing.assert_allclose(lin3, [2.5, 4.0, -0.5, 1.0])
    ta = vm.merge_tensor("w", BASE, [other, other], {"method": "task_arithmetic", "models": [{"weight": 0.5}] * 2})
    np.testing.assert_allclose(ta, other)


def test_ties_trims_small_deltas_elects_the_sign_and_averages_only_agreeing_models():
    a = BASE + np.array([4.0, 0.1, -2.0, 1.0], dtype=np.float32)
    b = BASE + np.array([2.0, -0.1, 3.0, -3.0], dtype=np.float32)
    out = vm.merge_tensor("w", BASE, [a, b], {"method": "ties", "density": 0.5, "lambda": 1.0, "models": [{}, {}]})
    # a keeps 4 and -2, b keeps 3 and -3 (its 2 is trimmed). Entry 2: -2 vs +3, + wins, only b counts.
    np.testing.assert_allclose(out, BASE + np.array([4.0, 0.0, 3.0, -3.0]))
    both = vm.merge_tensor("w", BASE, [a, a + 2.0], {"method": "ties", "density": 1.0, "models": [{}, {}]})
    # A zero delta never joins the mean (entry 2: only -2 counts).
    np.testing.assert_allclose(both, BASE + np.array([5.0, 1.1, -2.0, 2.0]), rtol=1e-6)
    np.testing.assert_allclose(vm.trim_top(np.array([1.0, -5.0, 2.0, 0.5]), 0.25), [0.0, -5.0, 0.0, 0.0])
    np.testing.assert_allclose(vm.trim_top(np.array([1.0, -5.0]), 1.0), [1.0, -5.0])


def test_dare_drops_and_rescales_reproducibly_and_keeps_the_expectation():
    other = BASE + 1.0
    big_base = np.zeros(40_000, dtype=np.float32)
    recipe = {"method": "dare_linear", "drop": 0.8, "seed": 3, "models": [{"weight": 1.0}]}
    out1 = vm.merge_tensor("layer.w", big_base, [big_base + 1.0], recipe)
    out2 = vm.merge_tensor("layer.w", big_base, [big_base + 1.0], recipe)
    np.testing.assert_array_equal(out1, out2)
    assert set(np.unique(np.round(out1, 4)).tolist()) == {0.0, 5.0}
    assert abs(float(out1.mean()) - 1.0) < 0.05
    other_name = vm.merge_tensor("layer.b", big_base, [big_base + 1.0], recipe)
    assert not np.array_equal(out1, other_name)
    ties = vm.merge_tensor("w", BASE, [other], {"method": "dare_ties", "drop": 0.0, "models": [{"weight": 0.5}]})
    np.testing.assert_allclose(ties, BASE + 0.5)


def test_integer_tensors_keep_the_base_value():
    ids = np.arange(4, dtype=np.int64)
    out = vm.merge_tensor("ids", ids, [ids * 7], {"method": "linear", "models": [{"weight": 1.0}]})
    np.testing.assert_array_equal(out, ids)


@pytest.mark.parametrize(
    ("change", "message"),
    [({"method": "slerp"}, "not one of"), ({"models": []}, "at least one"), ({"density": 0.0}, "density"),
     ({"drop": 1.0}, "drop"), ({"base_weight": -1.0}, "sum above zero")],
)  # fmt: skip
def test_a_bad_recipe_is_refused(tmp_path, change, message):
    recipe = {"method": "linear", "base": _src(tmp_path / "a"), "models": [_src(tmp_path / "b")], **change}
    with pytest.raises(vm.MergeRefused, match=message):
        vm.check_recipe(recipe)


# ---- safetensors and the streaming merge ---------------------------------------------------------------------------


def test_safetensors_round_trip_reads_memory_maps_and_bf16(tmp_path):
    t = {"a": np.arange(6, dtype=np.float32).reshape(2, 3), "b": np.array([1.5, -2.0], dtype=np.float32)}
    _make_ckpt(tmp_path / "c", t, WHISPER_TINY, code="F16")
    ck = vm.Checkpoint(tmp_path / "c")
    assert ck.shapes() == {"a": (2, 3), "b": (2,)} and ck.dtype("a") == "F16"
    np.testing.assert_array_equal(ck.tensor("a"), t["a"])
    raw = (np.array([1.5, -2.0], dtype=np.float32).view(np.uint32) >> 16).astype(np.uint16).tobytes()
    header = json.dumps({"x": {"dtype": "BF16", "shape": [2], "data_offsets": [0, 4]}}).encode()
    header += b" " * (-len(header) % 8)
    folder = tmp_path / "bf"
    folder.mkdir()
    (folder / "model.safetensors").write_bytes(len(header).to_bytes(8, "little") + header + raw)
    (folder / "config.json").write_text("{}", encoding="utf-8")
    np.testing.assert_array_equal(vm.Checkpoint(folder).tensor("x"), [1.5, -2.0])


def test_a_header_whose_offsets_do_not_fit_the_shape_is_refused(tmp_path):
    header = json.dumps({"x": {"dtype": "F32", "shape": [4], "data_offsets": [0, 8]}}).encode()
    header += b" " * (-len(header) % 8)
    folder = tmp_path / "bad"
    folder.mkdir()
    (folder / "model.safetensors").write_bytes(len(header).to_bytes(8, "little") + header + bytes(16))
    (folder / "config.json").write_text("{}", encoding="utf-8")
    with pytest.raises(vm.MergeRefused, match="does not match its shape"):
        vm.Checkpoint(folder).tensor("x")


def test_a_shard_index_that_points_outside_the_folder_is_refused(tmp_path):
    folder = tmp_path / "ck"
    folder.mkdir()
    (folder / "model.safetensors.index.json").write_text(json.dumps({"weight_map": {"a": "../evil.safetensors"}}))
    with pytest.raises(vm.MergeRefused, match="outside the checkpoint folder"):
        vm.Checkpoint(folder)


def test_merge_checkpoints_streams_a_merged_file_with_a_manifest(tmp_path):
    shapes = {"w": (2, 2), "b": (2,)}
    base = _make_ckpt(tmp_path / "base", {n: np.ones(s, np.float32) for n, s in shapes.items()}, WHISPER_TINY, "F16")
    tuned = _make_ckpt(tmp_path / "tuned", {n: np.full(s, 3.0, np.float32) for n, s in shapes.items()}, WHISPER_TINY)
    recipe = {"name": "t", "method": "task_arithmetic", "base": _src(base, "mit"), "models": [_src(tuned, weight=0.5)]}
    manifest = vm.merge_checkpoints(recipe, tmp_path / "out", log=lambda _m: None)
    out = vm.Checkpoint(tmp_path / "out")
    assert out.dtype("w") == "F16"
    np.testing.assert_allclose(out.tensor("w"), np.full((2, 2), 2.0))
    assert manifest["output"]["model.safetensors"] == vm.sha256_file(tmp_path / "out" / "model.safetensors")
    assert manifest["base"]["licence"] == "mit" and manifest["models"][0]["revision"] == "r1"
    assert json.loads((tmp_path / "out" / "merge.json").read_text())["method"] == "task_arithmetic"
    assert (tmp_path / "out" / "vocab.json").is_file()


def test_merge_checkpoints_refuses_a_different_architecture(tmp_path):
    base = _make_ckpt(tmp_path / "base", {"w": np.ones((2, 2), np.float32)}, WHISPER_TINY)
    deeper = _make_ckpt(tmp_path / "deep", {"w": np.ones((2, 2), np.float32)}, {**WHISPER_TINY, "decoder_layers": 4})
    recipe = {"method": "linear", "base": _src(base), "models": [_src(deeper)]}
    with pytest.raises(vm.MergeRefused, match="decoder_layers"):
        vm.merge_checkpoints(recipe, tmp_path / "out")


# ---- CTranslate2 conversion (tiny fake Whisper, no download) --------------------------------------------------------


def test_whisper_view_ties_the_projection_to_the_embedding(tmp_path):
    ck = vm.Checkpoint(_whisper_ckpt(tmp_path / "w", seed=1))
    view = vm.whisper_view(ck)
    assert len(view.model.encoder.layers) == 1 and len(view.model.decoder.layers) == 1
    assert view.model.encoder.layers[0].self_attn.k_proj.bias is None
    assert not hasattr(view.model.encoder.layers[0], "encoder_attn")
    np.testing.assert_array_equal(view.proj_out.weight, view.model.decoder.embed_tokens.weight)


def test_convert_ct2_writes_a_loadable_int8_model(tmp_path):
    import ctranslate2

    src = _whisper_ckpt(tmp_path / "w", seed=2)
    result = vm.convert_ct2(src, tmp_path / "ct2", quantization="int8")
    assert result["model.bin"] == vm.sha256_file(tmp_path / "ct2" / "model.bin")
    vocabulary = json.loads((tmp_path / "ct2" / "vocabulary.json").read_text())
    assert len(vocabulary) == WHISPER_TINY["vocab_size"] and vocabulary[-1] == "<|0.02|>"
    model = ctranslate2.models.Whisper(str(tmp_path / "ct2"), device="cpu")
    assert model.n_mels == WHISPER_TINY["num_mel_bins"]
