"""HTTP hints and privacy stay on the existing kernel router."""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from router import ModelRouter, http_error_hint, is_transient_http


class FakeStorage:
    def models(self):
        return []

    def upsert_model(self, _row):
        return None


def test_http_hints_keep_a_key_a_model_and_a_daily_cap_apart():
    key = http_error_hint(401, "invalid api key")
    assert "API key" in key
    assert "DAILY" not in key
    denied = http_error_hint(403, "permission denied")
    assert "cannot use this model" in denied
    assert "API key" not in denied
    region = http_error_hint(403, "not available in your region")
    assert "region" in region
    paid = http_error_hint(402, "insufficient credit")
    assert "paid access" in paid
    tier = http_error_hint(403, "free tier is not enabled")
    assert "cannot use this model" in tier
    missing = http_error_hint(404, "model not found")
    assert "model id" in missing
    daily = http_error_hint(429, "per day limit")
    burst = http_error_hint(429, "too many requests")
    assert "DAILY" in daily
    assert "DAILY" not in burst
    assert is_transient_http(RuntimeError(f"HTTP 429{burst}"))
    assert not is_transient_http(RuntimeError(f"HTTP 429{daily}"))
    assert not is_transient_http(RuntimeError(f"HTTP 401{key}"))


def test_privacy_mode_never_calls_a_cloud_model():
    router = ModelRouter(FakeStorage())
    called = []

    async def fake_stream(model, messages, explicit_paid=False, privacy_confirmed=False, **_kwargs):
        called.append(model.id)
        yield "ok"

    router._stream_one = fake_stream
    router.register(
        {
            "id": "cloud-brain",
            "label": "cloud-brain",
            "provider": "openai",
            "endpoint": "https://api.openai.com/v1",
            "role": "brain",
            "options": {"type": "cloud", "access": "free"},
        }
    )
    router.register(
        {
            "id": "local-coder",
            "label": "local-coder",
            "provider": "ollama",
            "endpoint": "http://127.0.0.1:11434",
            "role": "coder",
            "options": {"type": "local"},
        }
    )

    async def once(privacy):
        called.clear()
        async for _chunk in router.stream("hello", privacy=privacy, allow_fallback=False):
            pass
        return list(called)

    assert asyncio.run(once(None)) == ["cloud-brain"]
    assert asyncio.run(once("private")) == ["local-coder"]

    router._models.pop("local-coder")

    async def private_without_local():
        called.clear()
        chunks = []
        async for chunk in router.stream("hello", privacy="private", allow_fallback=False):
            chunks.append(chunk)
        return chunks

    chunks = asyncio.run(private_without_local())
    assert called == []
    assert chunks and "local" in str(chunks[0].get("error", "")).lower()
