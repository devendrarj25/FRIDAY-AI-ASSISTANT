"""The chat window follows the setup plan's record, the same way electron/models.cjs reads it (shared fixture)."""

import asyncio
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import router  # noqa: E402

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "chat_ctx_parity.json").read_text("utf-8"))
CASES = FIXTURE["cases"]


@pytest.fixture(autouse=True)
def _tiers(monkeypatch, tmp_path):
    monkeypatch.delenv("FRIDAY_OLLAMA_NUM_CTX", raising=False)
    monkeypatch.delenv("FRIDAY_ROOT", raising=False)
    path = tmp_path / "chat-tiers.json"
    path.write_text(json.dumps(FIXTURE["tiers"]), encoding="utf-8")
    monkeypatch.setattr(router, "_CHAT_TIERS_PATH", path)


def _record(monkeypatch, tmp_path, record) -> None:
    root = tmp_path / "root"
    (root / "runtime").mkdir(parents=True)
    (root / "runtime" / "chat-ctx.json").write_text(json.dumps(record), encoding="utf-8")
    monkeypatch.setenv("FRIDAY_ROOT", str(root))


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_kernel_window_matches_the_shared_table(case, monkeypatch, tmp_path):
    _record(monkeypatch, tmp_path, case["record"])
    if case["env"]:
        monkeypatch.setenv("FRIDAY_OLLAMA_NUM_CTX", case["env"])
    assert router.ollama_num_ctx(FIXTURE["ramGb"], case["model"]) == case["expected"]


def test_without_a_record_the_ram_ladder_stands(monkeypatch):
    assert router.ollama_num_ctx(16.0, "qwen3.5:9b") == 8192
    assert router.ollama_num_ctx(8.0, "qwen3.5:9b") == 4096
    assert router.ollama_num_ctx(4.0, "qwen3.5:9b") == 2048


def test_a_broken_record_is_ignored(monkeypatch, tmp_path):
    root = tmp_path / "root"
    (root / "runtime").mkdir(parents=True)
    (root / "runtime" / "chat-ctx.json").write_text("{not json", encoding="utf-8")
    monkeypatch.setenv("FRIDAY_ROOT", str(root))
    assert router.ollama_num_ctx(16.0, "qwen3.5:9b") == 8192


@pytest.mark.parametrize("bad", [True, False, 0, -1, -32768, 1.5, "32768", None, [], {}, 1024])
def test_a_garbage_window_in_the_record_falls_back(bad):
    record = {"tag": "unlisted:7b", "numCtx": bad, "voice": None}
    assert router.planned_num_ctx("unlisted:7b", record) is None


def test_a_huge_window_is_bounded_even_for_an_unlisted_model():
    record = {"tag": "unlisted:7b", "numCtx": 10**9, "voice": None}
    assert router.planned_num_ctx("unlisted:7b", record) == router._MAX_NUM_CTX == 131072
    assert router.planned_num_ctx("other:3b", {**record, "tag": "unlisted:7b"}) <= 8192


def test_a_tampered_record_cannot_reach_the_request(monkeypatch, tmp_path):
    _record(monkeypatch, tmp_path, {"tag": "unlisted:7b", "numCtx": 10**9, "voice": None})
    assert router.ollama_num_ctx(16.0, "unlisted:7b") == 131072


class _Lines:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    headers: dict = {}

    def raise_for_status(self):
        return None

    status_code = 200

    async def aiter_lines(self):
        yield json.dumps({"message": {"role": "assistant", "content": "Hi."}, "done": True})


class _Client:
    def __init__(self):
        self.bodies: list[dict] = []

    def stream(self, method, url, json=None, headers=None):
        self.bodies.append(json or {})
        return _Lines()


class _Store:
    def models(self):
        return []

    def upsert_model(self, _row):
        return None


def _request_body(monkeypatch, tag: str) -> dict:
    client = _Client()
    monkeypatch.setattr(router, "_client", lambda: client)
    model = router.Model(
        id=f"ollama:{tag}",
        label=tag,
        provider="ollama",
        endpoint="http://127.0.0.1:11434",
        options={"type": "local", "access": "free", "model": tag},
    )
    engine = router.ModelRouter(_Store())

    async def go():
        return [c async for c in engine._stream_ollama(model, [{"role": "user", "content": "hi"}], None)]

    asyncio.run(go())
    return client.bodies[0]


def test_the_request_carries_the_planned_window_and_the_twin_its_own(monkeypatch, tmp_path):
    _record(monkeypatch, tmp_path, CASES[3]["record"])
    monkeypatch.setattr(router, "total_ram_gb", lambda: 16.0)
    main = _request_body(monkeypatch, "qwen3.5:9b")
    twin = _request_body(monkeypatch, "qwen3.5:0.8b")
    assert main["options"]["num_ctx"] == 32768
    assert twin["options"]["num_ctx"] == 3072
    assert main["keep_alive"] == router.ollama_keep_alive()
