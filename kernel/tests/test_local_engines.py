"""One table of local engines (kernel/local_engines.json): every consumer reads it, a bad table never crashes."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import billing
import local_engines
import privacy
import router

KERNEL = Path(__file__).resolve().parents[1]
FILE_IDS = [row["id"] for row in json.loads((KERNEL / "local_engines.json").read_text(encoding="utf-8"))["engines"]]

# What every engine was before the table existed (ports are the vendors' documented defaults).
EXPECTED = {
    "ollama": ("ollama", "http://127.0.0.1:11434"),
    "lmstudio": ("openai", "http://127.0.0.1:1234/v1"),
    "llamacpp": ("openai", "http://127.0.0.1:8080/v1"),
    "vllm": ("openai", "http://127.0.0.1:8000/v1"),
    "localai": ("openai", "http://127.0.0.1:8081/v1"),
    "jan": ("openai", "http://127.0.0.1:1337/v1"),
    "koboldcpp": ("openai", "http://127.0.0.1:5001/v1"),
    "transformers": ("openai", "http://127.0.0.1:8083/v1"),
    "gpt4all": ("openai", "http://127.0.0.1:4891/v1"),
    "mlx": ("openai", "http://127.0.0.1:8082/v1"),
}


class Store:
    def models(self):
        return []

    def upsert_model(self, _row):
        return None


def _write(tmp_path: Path, text: str) -> Path:
    path = tmp_path / "local_engines.json"
    path.write_text(text, encoding="utf-8")
    return path


def test_the_shipped_table_keeps_every_existing_engine() -> None:
    assert sorted(FILE_IDS) == sorted(EXPECTED)
    for engine_id, (wire, base) in EXPECTED.items():
        surface = router.PROVIDER_SURFACES[engine_id]
        assert (surface["wire"], surface["base"]) == (wire, base)
    assert router.PROVIDER_SURFACES["ollama"]["chat_path"] == "/api/chat"
    assert router.PROVIDER_SURFACES["local"] == {"wire": "openai", "base": None}


def test_every_engine_reaches_each_kernel_consumer() -> None:
    for engine_id in local_engines.engine_ids():
        model = router.Model(id=f"{engine_id}:m", label="m", provider=engine_id, endpoint="")
        assert engine_id in router.PROVIDER_SURFACES
        assert router.is_local_model(model)
        assert router.ModelRouter(Store())._kind(model) == "local"
        assert router.ModelRouter.seed_row({"provider": engine_id})["status"] == "unavailable"
        assert billing.billing_class(model) == "free"
        assert engine_id in privacy.LOCAL_KINDS
        assert (engine_id in router.OPENAI_COMPATIBLE) == (EXPECTED[engine_id][0] == "openai")
    assert "llama.cpp" in privacy.LOCAL_KINDS
    assert "local" in privacy.LOCAL_KINDS
    assert "online" in router.OPENAI_COMPATIBLE


def test_registry_prefix_is_stripped_only_for_engines_that_say_so() -> None:
    stripped = {"ollama", "lmstudio", "llamacpp", "jan", "koboldcpp"}
    assert local_engines.registry_prefix_ids() == stripped
    for engine_id in local_engines.engine_ids():
        model = router.Model(id=f"{engine_id}:qwen3:4b", label="m", provider=engine_id, endpoint="")
        assert model.wire_model == ("qwen3:4b" if engine_id in stripped else f"{engine_id}:qwen3:4b")


def test_a_cloud_provider_is_never_local() -> None:
    for name in ("openai", "anthropic", "gemini", "openrouter", "", None):
        assert not local_engines.is_local_kind(name)


def test_hints_are_data_not_code() -> None:
    assert local_engines.supports("ollama", "keepAlive")
    assert local_engines.supports("ollama", "offloadHint")
    assert local_engines.supports("lmstudio", "needsLoad")
    assert not local_engines.supports("lmstudio", "keepAlive")
    assert not local_engines.supports("nope", "keepAlive")
    assert not local_engines.supports("ollama", "chatPath")


def test_a_new_engine_is_one_row(tmp_path: Path) -> None:
    row = {"id": "newengine", "name": "New", "wire": "openai", "endpoint": "http://127.0.0.1:9999/", "apiPath": "/v1"}
    rows, generic = local_engines.load_table(
        _write(tmp_path, json.dumps({"engines": [row], "genericKinds": ["local"]}))
    )
    assert list(rows) == ["newengine"]
    assert local_engines.surface_for(rows["newengine"]) == {"wire": "openai", "base": "http://127.0.0.1:9999/v1"}
    assert "newengine" in local_engines.kinds_of(rows, generic)


def test_unknown_or_broken_rows_are_ignored(tmp_path: Path) -> None:
    good = {"id": "good", "wire": "openai", "endpoint": "http://127.0.0.1:1/", "apiPath": "/v1"}
    rows = [
        None,
        "text",
        7,
        {"id": "nowire", "endpoint": "http://127.0.0.1:2"},
        {"id": "badwire", "wire": "grpc", "endpoint": "http://127.0.0.1:3"},
        {"id": "noendpoint", "wire": "openai"},
        {"id": "file-endpoint", "wire": "openai", "endpoint": "file:///etc/passwd"},
        {"id": "Bad Id!", "wire": "openai", "endpoint": "http://127.0.0.1:4"},
        {"id": "", "wire": "openai", "endpoint": "http://127.0.0.1:5"},
        good,
        {**good, "endpoint": "http://127.0.0.1:99"},
    ]
    table, _ = local_engines.load_table(_write(tmp_path, json.dumps({"engines": rows, "unknownTop": 1})))
    assert list(table) == ["good"]
    assert table["good"]["endpoint"] == "http://127.0.0.1:1"
    assert table["good"]["modelsPath"] == "/v1/models"
    assert table["good"]["keepAlive"] is False


def test_a_flag_must_be_a_real_true() -> None:
    row = local_engines.clean_row(
        {"id": "x", "wire": "openai", "endpoint": "http://h:1", "keepAlive": "yes", "needsLoad": 1, "offloadHint": True}
    )
    assert row is not None
    assert (row["keepAlive"], row["needsLoad"], row["offloadHint"]) == (False, False, True)


def test_missing_or_malformed_file_falls_back(tmp_path: Path) -> None:
    broken = ("{not json", "[]", "null", '{"engines": "x"}', '{"engines": []}', '{"engines": [{"id": 1}]}', "")
    for text in (None, *broken):
        path = tmp_path / "t.json" if text is not None else tmp_path / "absent.json"
        if text is not None:
            path.write_text(text, encoding="utf-8")
        rows, generic = local_engines.load_table(path)
        assert {"ollama", "lmstudio", "llamacpp"} <= set(rows)
        assert "local" in generic
        assert local_engines.surface_for(rows["ollama"])["chat_path"] == "/api/chat"


def test_invalid_utf8_file_falls_back(tmp_path: Path) -> None:
    path = tmp_path / "bin.json"
    path.write_bytes(b"\xff\xfe\x00bad")
    rows, _ = local_engines.load_table(path)
    assert "ollama" in rows


def test_the_built_in_fallback_agrees_with_the_file() -> None:
    fallback = {r["id"]: r for r in (local_engines.clean_row(x) for x in local_engines.FALLBACK_ROWS) if r}
    for engine_id, row in fallback.items():
        assert row == local_engines.ENGINES[engine_id], engine_id


def test_no_engine_list_is_hard_coded_in_the_kernel() -> None:
    """Adding an engine is one row in the table: no kernel module may spell the engines out again."""
    literal = re.compile(r"""["'](koboldcpp|gpt4all|localai|transformers)["']""")
    offenders = []
    for path in sorted(KERNEL.glob("*.py")):
        if path.name == "local_engines.py":
            continue
        if literal.search(path.read_text(encoding="utf-8")):
            offenders.append(path.name)
    assert offenders == []
    assert not re.search(r"127\.0\.0\.1:(1234|8080|1337|4891)", (KERNEL / "router.py").read_text(encoding="utf-8"))


def test_a_file_saved_with_a_byte_order_mark_still_loads(tmp_path: Path) -> None:
    path = tmp_path / "bom.json"
    row = {"id": "bomengine", "wire": "openai", "endpoint": "http://127.0.0.1:7"}
    path.write_bytes(b"\xef\xbb\xbf" + json.dumps({"engines": [row]}).encode())
    rows, _ = local_engines.load_table(path)
    assert list(rows) == ["bomengine"]
