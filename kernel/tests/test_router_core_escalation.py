"""Core escalation: a pure rule, run before best_available, never around the billing or privacy guard."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from router import CORE_MODEL_ID, ModelRouter, escalate  # noqa: E402

KEY = "core-run-key-7f3a91"
SENSITIVE_PROMPT = "my password is hunter2 and my card number is 4111 1111 1111 1111"


class Store:
    def __init__(self) -> None:
        self.rows: list[dict] = []

    def models(self):
        return list(self.rows)

    def upsert_model(self, row):
        self.rows.append(dict(row))


def core_spec(**extra) -> dict:
    return {
        "id": CORE_MODEL_ID,
        "label": "FRIDAY Core",
        "provider": "llamacpp",
        "endpoint": "http://127.0.0.1:50321/v1",
        "role": "brain",
        "apiKey": KEY,
        "capabilities": {"vision": True, "audio": True, "tools": True},
        **extra,
    }


def cloud_spec(mid: str, access: str, **extra) -> dict:
    return {
        "id": mid,
        "label": mid,
        "provider": "openai",
        "endpoint": "https://api.example.test/v1",
        "role": "brain",
        "options": {"type": "cloud", "access": access},
        **extra,
    }


def heavy_spec() -> dict:
    return {
        "id": "ollama:big",
        "label": "big",
        "provider": "ollama",
        "endpoint": "http://127.0.0.1:11434",
        "role": "brain",
        "options": {"tier": "heavy"},
    }


def build(*specs: dict) -> ModelRouter:
    router = ModelRouter(Store())
    for spec in specs:
        router.register(spec)
    return router


UP_RULES = [
    {"generation": "image"},
    {"hard_reasoning": True},
    {"code_beyond_core": True},
    {"context_tokens": 32769},
    {"audio_seconds": 31},
    {"video_seconds": 61},
]
OPEN_CLOUD = {"cloud_cost": "free"}


def test_plain_turn_and_limits_stay_on_core():
    assert escalate(None) == "core"
    assert escalate({}) == "core"
    at_limit = {"context_tokens": 32768, "audio_seconds": 30, "video_seconds": 60}
    assert escalate({**at_limit, **OPEN_CLOUD, "local_heavy": True}) == "core"


@pytest.mark.parametrize("rule", UP_RULES)
def test_each_rule_goes_up_to_cloud_when_that_is_open(rule):
    assert escalate({**rule, **OPEN_CLOUD}) == "cloud"


@pytest.mark.parametrize("rule", UP_RULES)
def test_each_rule_prefers_a_local_heavy_model_over_cloud(rule):
    assert escalate({**rule, **OPEN_CLOUD, "local_heavy": True}) == "local_heavy"


@pytest.mark.parametrize("rule", UP_RULES)
def test_sensitive_never_goes_to_cloud(rule):
    assert escalate({**rule, **OPEN_CLOUD, "sensitive": True}) == "core"
    assert escalate({**rule, **OPEN_CLOUD, "sensitive": True, "local_heavy": True}) == "local_heavy"


@pytest.mark.parametrize("rule", UP_RULES)
def test_private_mode_never_goes_to_cloud(rule):
    assert escalate({**rule, **OPEN_CLOUD, "privacy_mode": "Private"}) == "core"


def test_unknown_cost_is_never_cloud_and_paid_needs_paid_access():
    assert escalate({"hard_reasoning": True, "cloud_cost": "unknown"}) == "core"
    assert escalate({"hard_reasoning": True}) == "core"
    assert escalate({"hard_reasoning": True, "cloud_cost": "paid"}) == "core"
    assert escalate({"hard_reasoning": True, "cloud_cost": "paid", "paid_unlocked": True}) == "cloud"


def test_core_is_picked_before_best_available_and_unready_core_falls_through():
    router = build(core_spec(), cloud_spec("cloud-free", "free"))
    pick = router.pick_escalated({})
    assert pick is not None and pick.id == CORE_MODEL_ID
    router._models[CORE_MODEL_ID].status = "unavailable"
    assert router.pick_escalated({}) is None
    best = router.best_available("brain")
    assert best is not None and best.id == "cloud-free"


def test_escalated_pick_follows_the_billing_gate():
    router = build(core_spec(), cloud_spec("cloud-paid", "paid"), cloud_spec("cloud-unknown", "unknown"))
    stays = router.pick_escalated({"hard_reasoning": True})
    assert stays is not None and stays.id == CORE_MODEL_ID
    router.set_billing({"paidAccess": True, "autoPaidUsage": True})
    pick = router.pick_escalated({"hard_reasoning": True})
    assert pick is not None and pick.id == "cloud-paid"


def test_unknown_cost_model_is_never_auto_picked_even_when_paid_is_open():
    router = build(core_spec(), cloud_spec("cloud-unknown", "unknown"))
    router.set_billing({"paidAccess": True, "autoPaidUsage": True})
    pick = router.pick_escalated({"hard_reasoning": True})
    assert pick is not None and pick.id == CORE_MODEL_ID


def test_local_heavy_is_picked_for_a_hard_turn():
    router = build(core_spec(), heavy_spec(), cloud_spec("cloud-free", "free"))
    pick = router.pick_escalated({"video_seconds": 90})
    assert pick is not None and pick.id == "ollama:big"


def _drive(router: ModelRouter, prompt: str, **kw):
    called: list[str] = []

    async def wire(model, _messages, _effort=None, **_kw):
        called.append(model.id)
        yield "ok"

    setattr(router, "_stream_openai", wire)  # noqa: B010 — a fake provider wire; guards in _stream_one stay real

    async def run():
        return [e async for e in router.stream(prompt=prompt, **kw)]

    return called, asyncio.run(run())


def test_stream_runs_escalation_before_best_available_through_the_real_guards():
    router = build(
        core_spec(), cloud_spec("cloud-free", "free", options={"type": "cloud", "access": "free", "avg_ms": 5})
    )
    called, events = _drive(router, "hello there")
    assert called == [CORE_MODEL_ID]
    assert any(e.get("delta") == "ok" for e in events)


def test_stream_hard_turn_with_sensitive_text_never_reaches_cloud():
    router = build(cloud_spec("cloud-free", "free"))
    called, events = _drive(router, SENSITIVE_PROMPT, escalation={"hard_reasoning": True})
    assert called == []
    assert any(e.get("error") for e in events)


def test_stream_private_mode_never_reaches_cloud_on_a_hard_turn():
    router = build(core_spec(), cloud_spec("cloud-free", "free"))
    called, _ = _drive(router, "prove this theorem", escalation={"hard_reasoning": True}, privacy="private")
    assert called == [CORE_MODEL_ID]


def test_stream_billing_guard_still_blocks_a_paid_pick():
    router = build(cloud_spec("cloud-paid", "paid"))
    called, events = _drive(router, "hello", escalation={"hard_reasoning": True})
    assert called == []
    assert any(e.get("error") for e in events)


def test_the_caller_cannot_clear_sensitive_or_a_private_mode():
    meta = ModelRouter._turn_meta(
        {"sensitive": False, "privacy_mode": "public"}, SENSITIVE_PROMPT, None, None, "private"
    )
    assert meta["sensitive"] is True and meta["privacy_mode"] == "private"


def gen_spec(mid: str, access: str, kind: str = "image", local: bool = False) -> dict:
    base = (
        {"provider": "llamacpp", "endpoint": "http://127.0.0.1:9000/v1", "options": {"type": "local"}}
        if local
        else cloud_spec(mid, access)
    )
    return {**base, "id": mid, "label": mid, "capabilities": {f"{kind}Generation": True}}


def test_generation_is_chosen_only_among_models_both_guards_allow():
    router = build(gen_spec("img-unknown", "unknown"), gen_spec("img-paid", "paid"))
    refused = router.route_generation("image", "a red apple")
    assert refused["ok"] is False and refused["modelId"] is None
    router.register(gen_spec("img-free", "free"))
    choice = router.route_generation("image", "a red apple")
    assert (choice["ok"], choice["target"], choice["modelId"]) == (True, "cloud", "img-free")


def test_generation_keeps_sensitive_and_private_jobs_off_cloud():
    router = build(gen_spec("img-free", "free"))
    assert router.route_generation("image", SENSITIVE_PROMPT)["ok"] is False
    assert router.route_generation("image", "a red apple", privacy_mode="private")["ok"] is False
    router.register(gen_spec("img-local", "free", local=True))
    local = router.route_generation("image", SENSITIVE_PROMPT)
    assert (local["target"], local["modelId"]) == ("local_heavy", "img-local")


def test_generation_needs_the_matching_capability_and_a_known_kind():
    router = build(gen_spec("img-free", "free"))
    assert router.route_generation("video", "a wave")["ok"] is False
    assert router.route_generation("poem", "x")["ok"] is False


def test_the_key_is_memory_only(capsys):
    store = Store()
    router = ModelRouter(store)
    model = router.register(core_spec())
    router.set_billing({})
    out = capsys.readouterr()
    assert model.api_key == KEY
    assert KEY not in out.out + out.err
    assert KEY not in repr(model.public()) and KEY not in repr(store.rows)
    assert store.rows[-1]["endpoint"] == "" and store.rows[-1]["status"] == "unavailable"


def test_a_stored_core_row_never_loads_as_ready():
    store = Store()
    store.rows.append(
        {
            "id": CORE_MODEL_ID,
            "label": "FRIDAY Core",
            "provider": "llamacpp",
            "endpoint": "http://127.0.0.1:1/v1",
            "status": "ready",
        }
    )
    core = ModelRouter(store)._models[CORE_MODEL_ID]
    assert core.status == "unavailable" and core.endpoint == ""


def test_seed_entry_is_a_local_brain_with_no_endpoint_or_key():
    seed = Path(__file__).resolve().parents[2] / "config" / "models.yaml"
    entry = next(m for m in yaml.safe_load(seed.read_text(encoding="utf-8"))["models"] if m["id"] == CORE_MODEL_ID)
    assert (entry["provider"], entry["role"], entry["endpoint"]) == ("llamacpp", "brain", "")
    assert entry["capabilities"] == {"vision": True, "audio": True, "tools": True}
    assert not {"api_key", "apiKey", "api_key_env"} & set(entry)
    router = ModelRouter(Store())
    router.register(router.seed_row(dict(entry)))
    assert router._models[CORE_MODEL_ID].status == "unavailable"
    assert router.pick_escalated({}) is None
