"""A row the renderer can push never becomes local, free or Core by its name alone: the endpoint decides."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import privacy  # noqa: E402
from router import CORE_MODEL_ID, Model, ModelRouter, escalate, is_local_model  # noqa: E402

REMOTE = "https://evil.example.test/v1"
SENSITIVE_PROMPT = "my password is hunter2 and my card number is 4111 1111 1111 1111"


class Store:
    def models(self):
        return []

    def upsert_model(self, row):
        pass


def spec(model_id: str = CORE_MODEL_ID, **extra) -> dict:
    return {
        "id": model_id,
        "label": model_id,
        "provider": "llamacpp",
        "endpoint": "http://127.0.0.1:50321/v1",
        "role": "brain",
        "apiKey": "k-123",
        **extra,
    }


def router_with(*rows: dict) -> ModelRouter:
    router = ModelRouter(Store())
    for row in rows:
        router.register(row)
    return router


@pytest.mark.parametrize(
    "endpoint",
    [
        REMOTE,
        "http://127.0.0.1.evil.example.test:50321/v1",
        "http://localhost:50321/v1",
        "http://127.0.0.1@evil.example.test:50321/v1",
        "http://192.168.1.9:50321/v1",
        "http://127.0.0.1:50321/other",
        "https://127.0.0.1:50321/v1",
        "http://127.0.0.1/v1",
        "http://example.test/?http://127.0.0.1:1/v1",
    ],
)
def test_a_forged_core_row_with_a_non_loopback_endpoint_is_refused(endpoint):
    router = ModelRouter(Store())
    with pytest.raises(ValueError):
        router.register(spec(endpoint=endpoint))
    assert CORE_MODEL_ID not in router._models
    assert router.sync([spec(endpoint=endpoint)])["registered"] == 0
    assert CORE_MODEL_ID not in router._models


def test_a_core_row_without_an_endpoint_is_only_accepted_as_unavailable():
    router = ModelRouter(Store())
    with pytest.raises(ValueError):
        router.register(spec(endpoint="", status="ready"))
    model = router.register(spec(endpoint="", status="unavailable"))
    assert model.status == "unavailable" and router.pick_escalated({}) is None


@pytest.mark.parametrize("endpoint", ["http://127.0.0.1:50321/v1", "http://[::1]:50321/v1"])
def test_the_real_loopback_core_row_is_local_and_picked(endpoint):
    router = router_with(spec(endpoint=endpoint))
    core = router._models[CORE_MODEL_ID]
    assert is_local_model(core) and privacy.guard_egress(core, SENSITIVE_PROMPT)["external"] is False
    pick = router.pick_escalated({"sensitive": True, "privacy_mode": "private", "hard_reasoning": True})
    assert pick is not None and pick.id == CORE_MODEL_ID


def test_a_remote_endpoint_is_not_local_whatever_the_provider_says():
    for provider in ("llamacpp", "ollama", "lmstudio", "local"):
        model = Model(id="x", label="x", provider=provider, endpoint=REMOTE)
        assert is_local_model(model) is False
        typed = Model(id="x", label="x", provider=provider, endpoint=REMOTE, options={"type": "local"})
        assert is_local_model(typed) is False
        assert privacy.guard_egress(typed, SENSITIVE_PROMPT)["external"] is True
        assert privacy.is_local_kind({"type": "local", "endpoint": REMOTE}) is False
    for endpoint in ("http://127.0.0.1:11434", "http://localhost:11434/v1", "http://[::1]:11434"):
        assert is_local_model(Model(id="x", label="x", provider="ollama", endpoint=endpoint))
    assert is_local_model(Model(id="x", label="x", provider="ollama", endpoint=""))


def test_a_remote_row_claiming_a_local_provider_is_not_a_local_pick():
    router = router_with(spec("forged:big", endpoint=REMOTE, options={"tier": "heavy", "type": "local"}))
    forged = router._models["forged:big"]
    assert not is_local_model(forged)
    assert router.escalation_meta({})["local_heavy"] is False
    for meta in ({"video_seconds": 90, "sensitive": True}, {"video_seconds": 90, "privacy_mode": "private"}):
        assert router.pick_escalated(meta) is None


@pytest.mark.parametrize(
    "meta",
    [
        {"sensitive": True, "hard_reasoning": True},
        {"privacy_mode": "private", "video_seconds": 90},
        {"sensitive": True, "privacy_mode": "Private", "generation": "image", "cloud_cost": "free"},
    ],
)
def test_sensitive_and_private_turns_never_resolve_to_a_non_loopback_row(meta):
    forged = spec("forged:cloud", endpoint=REMOTE, options={"type": "local", "access": "free"})
    router = router_with(spec(endpoint="http://127.0.0.1:50321/v1"), forged)
    pick = router.pick_escalated(meta)
    assert pick is not None and pick.id == CORE_MODEL_ID
    assert escalate(router.escalation_meta(meta)) == "core"


def test_a_core_row_forced_remote_is_never_picked_for_a_sensitive_turn():
    router = router_with(spec())
    router._models[CORE_MODEL_ID].endpoint = REMOTE
    assert router.pick_escalated({"sensitive": True}) is None
    assert router.pick_escalated({}) is None


def test_the_stream_firewall_blocks_a_sensitive_turn_to_a_forged_local_row():
    router = router_with(spec("forged:cloud", endpoint=REMOTE, options={"type": "local"}))
    forged = router._models["forged:cloud"]

    async def run() -> None:
        async for _ in router._stream_one(forged, [{"role": "user", "content": SENSITIVE_PROMPT}]):
            pass

    with pytest.raises(privacy.PrivacyBlocked):
        asyncio.run(run())
