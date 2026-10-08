"""Fallback reporting: why CHAT failed must never be reduced to one error.

A cloud model failing on DNS and no local model being ready are two different
problems with opposite fixes. The router reports both.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from router import Model, _no_route_error, is_local_model, is_network_error, is_transient_http


def cloud(label="OpenAI GPT"):
    return Model(id=label, label=label, provider="openai", endpoint="https://api.openai.com/v1")


def local(label="Ollama llama3"):
    return Model(id=label, label=label, provider="ollama", endpoint="http://localhost:11434")


def test_local_models_are_recognised_as_offline_routes():
    assert is_local_model(local()) is True
    assert is_local_model(cloud()) is False
    assert is_local_model(Model(id="x", label="x", provider="openai-compatible", endpoint="http://127.0.0.1:8080/v1"))


def test_dns_failures_are_classified_as_network_not_inference():
    assert is_network_error("[Errno -3] Temporary failure in name resolution")
    assert is_network_error("ConnectError: getaddrinfo ENOTFOUND api.openai.com")
    assert not is_network_error("HTTP 400: model refused the request")


def test_network_only_failure_says_no_local_route_existed():
    message = _no_route_error(
        ["OpenAI GPT: ConnectError getaddrinfo failed", "Claude: ConnectError getaddrinfo failed"],
        [cloud("OpenAI GPT"), cloud("Claude")],
    )
    assert "tried 2 route(s)" in message
    # BOTH failures are visible, not just the last one.
    assert "OpenAI GPT" in message and "Claude" in message
    assert "no local (offline) model was ready" in message
    assert "Models" in message


def test_a_tried_local_route_is_reported_as_such():
    message = _no_route_error(
        ["OpenAI GPT: getaddrinfo failed", "Ollama llama3: model not loaded"],
        [cloud("OpenAI GPT"), local()],
    )
    assert "including 1 local" in message
    assert "no local (offline) model" not in message


def test_no_attempts_keeps_the_plain_message():
    assert _no_route_error([], []) == "no model answered"


def test_burst_429_and_gateways_are_transient_daily_quota_is_not():
    assert is_transient_http(RuntimeError("HTTP 429 — provider rate limit reached (per-minute burst)"))
    assert is_transient_http(RuntimeError("HTTP 503: unavailable"))
    assert is_transient_http(RuntimeError("HTTP 502: bad gateway"))
    assert not is_transient_http(RuntimeError("HTTP 429 — provider DAILY request limit reached for this account"))
    assert not is_transient_http(RuntimeError("HTTP 401 — check this provider's API key"))
    assert not is_transient_http(RuntimeError("HTTP 400: invalid request"))
    assert not is_transient_http(RuntimeError("HTTP 422: unsupported parameter"))
