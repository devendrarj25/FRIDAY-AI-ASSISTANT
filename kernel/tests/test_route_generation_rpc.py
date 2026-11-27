"""model.route_generation: the bridge method the desktop asks before it draws a picture.

It only chooses. It forwards the kind, the prompt, the explicit-paid flag and the privacy mode to the router,
and answers with the router's own verdict, so billing and privacy refusals reach the desktop unchanged.
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")

_root = Path(tempfile.mkdtemp(prefix="friday-route-generation-"))
os.environ["FRIDAY_DATA_DIR"] = str(_root / "data")
os.environ["FRIDAY_WORKSPACE_ROOT"] = str(_root)
os.environ.setdefault("FRIDAY_BRIDGE_TOKEN", "contract-token")

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "kernel"))

import main  # noqa: E402
from router import ModelRouter  # noqa: E402

SENSITIVE_PROMPT = "my password is hunter2 and my card number is 4111 1111 1111 1111"


class Store:
    def __init__(self) -> None:
        self.rows: list[dict] = []

    def models(self):
        return list(self.rows)

    def upsert_model(self, row):
        self.rows.append(dict(row))


def image_spec(mid: str, access: str) -> dict:
    return {
        "id": mid,
        "label": mid,
        "provider": "openai",
        "endpoint": "https://api.example.test/v1",
        "role": "brain",
        "options": {"type": "cloud", "access": access},
        "capabilities": {"imageGeneration": True},
    }


def with_router(monkeypatch, *specs: dict) -> ModelRouter:
    router = ModelRouter(Store())
    for spec in specs:
        router.register(spec)
    monkeypatch.setattr(main, "router", router)
    return router


async def _ask(**params):
    async def send(_payload: dict) -> None:
        return None

    return await main.dispatch("model.route_generation", params, send)


@pytest.mark.asyncio
async def test_a_free_image_model_is_returned_as_the_router_chose_it(monkeypatch):
    with_router(monkeypatch, image_spec("img-free", "free"))
    choice = await _ask(kind="image", content="a red apple")
    assert (choice["ok"], choice["target"], choice["modelId"]) == (True, "cloud", "img-free")


@pytest.mark.asyncio
async def test_billing_refusal_reaches_the_desktop(monkeypatch):
    with_router(monkeypatch, image_spec("img-unknown", "unknown"), image_spec("img-paid", "paid"))
    refused = await _ask(kind="image", content="a red apple")
    assert refused["ok"] is False and refused["modelId"] is None and refused["reason"]


@pytest.mark.asyncio
async def test_privacy_refusal_reaches_the_desktop(monkeypatch):
    with_router(monkeypatch, image_spec("img-free", "free"))
    assert (await _ask(kind="image", content=SENSITIVE_PROMPT))["modelId"] is None
    private = await _ask(kind="image", content="a red apple", privacyMode="private")
    assert private["ok"] is False and private["modelId"] is None


@pytest.mark.asyncio
async def test_only_a_strict_true_counts_as_an_explicit_paid_yes(monkeypatch):
    with_router(monkeypatch, image_spec("img-paid", "paid"))
    seen: list[bool] = []
    real = main.router.route_generation

    def spy(kind, content="", *, explicit_paid=False, privacy_mode=""):
        seen.append(explicit_paid)
        return real(kind, content, explicit_paid=explicit_paid, privacy_mode=privacy_mode)

    monkeypatch.setattr(main.router, "route_generation", spy)
    await _ask(kind="image", content="a red apple", explicitPaid="yes")
    await _ask(kind="image", content="a red apple", explicitPaid=True)
    assert seen == [False, True]


@pytest.mark.asyncio
async def test_missing_or_unknown_kind_is_refused_not_raised(monkeypatch):
    with_router(monkeypatch, image_spec("img-free", "free"))
    assert (await _ask())["ok"] is False
    assert (await _ask(kind="poem", content="x"))["ok"] is False
