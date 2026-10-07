"""Free-now rows and the model view stay on the existing router."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from router import ModelRouter, free_now_entry, model_view, quota_meter


class FakeStorage:
    def models(self):
        return []

    def upsert_model(self, _row):
        return None


def test_model_view_keeps_the_system_line_and_the_tail():
    messages = [{"role": "system", "content": "rules"}]
    messages += [{"role": "user", "content": str(i)} for i in range(10)]
    view = model_view(messages, 3)
    assert view[0]["content"] == "rules"
    assert [row["content"] for row in view[1:]] == ["7", "8", "9"]
    assert len(messages) == 11


def test_free_now_shows_source_and_age_and_hides_paid():
    router = ModelRouter(FakeStorage())
    router.register(
        {
            "id": "local-brain",
            "label": "local",
            "provider": "ollama",
            "endpoint": "http://127.0.0.1:11434",
            "role": "brain",
            "context_k": 128,
            "options": {
                "capabilities": {"tools": True},
                "accessRecord": {"evidence": {"source": "local_runtime", "checkedAt": 1000}},
                "cooldownUntil": 0,
            },
        }
    )
    router.register(
        {
            "id": "paid",
            "label": "paid",
            "provider": "openai",
            "endpoint": "https://api.openai.com/v1",
            "options": {"access": "paid", "type": "cloud"},
        }
    )
    local = free_now_entry(router._models["local-brain"], 1500)
    assert local is not None
    assert local["source"] == "local_runtime"
    assert local["ageMs"] == 500
    assert "tools" in local["tags"]
    assert "local" in local["tags"]
    assert "long context" in local["tags"]
    assert free_now_entry(router._models["paid"], 1500) is None

    router._models["local-brain"].options["cooldownUntil"] = 2000
    cooling = free_now_entry(router._models["local-brain"], 1500)
    assert cooling is not None
    assert cooling["cooling"] is True


def test_quota_meter_reads_headers_and_ignores_an_empty_map():
    openai = quota_meter(
        {
            "x-ratelimit-remaining-requests": "59",
            "x-ratelimit-limit-requests": "60",
            "x-ratelimit-reset-requests": "1s",
        }
    )
    assert openai is not None
    assert openai["source"] == "response-headers"
    assert openai["remainingRequests"] == 59
    assert openai["limitRequests"] == 60
    assert openai["reset"] == "1s"
    anthropic = quota_meter({"anthropic-ratelimit-requests-remaining": "999"})
    assert anthropic is not None
    assert anthropic["remainingRequests"] == 999
    assert quota_meter({}) is None
    assert quota_meter({"authorization": "Bearer secret"}) is None
    router = ModelRouter(FakeStorage())
    router.note_response_headers({"x-ratelimit-remaining-tokens": "10"})
    assert router.last_quota["remainingTokens"] == 10
    router.note_response_headers(None)
    assert router.last_quota["remainingTokens"] == 10
