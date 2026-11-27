"""One locality rule: a model is local (and free) only on a loopback endpoint or on the host the owner
set in the engine environment (OLLAMA_HOST). Nothing a row, the renderer or an RPC sends can add a host."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import billing  # noqa: E402
import privacy  # noqa: E402
from router import Model, is_local_model  # noqa: E402

REMOTE = "https://evil.example.test/v1"
LAN = "http://192.168.1.5:11434"


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for row in privacy.local_engines.ENGINES.values():
        if row.get("env"):
            monkeypatch.delenv(row["env"], raising=False)


def model(provider: str, endpoint: str, **options) -> Model:
    return Model(id=f"{provider}:m", label="m", provider=provider, endpoint=endpoint, options=dict(options))


@pytest.mark.parametrize("provider", ["llamacpp", "ollama", "lmstudio", "local"])
def test_forged_remote_engine_row_is_billed_unknown_never_free(provider):
    row = model(provider, REMOTE)
    assert billing.billing_class(row) == "unknown"
    assert billing.is_billable(row)
    assert not privacy.is_local_kind(row)
    assert not is_local_model(row)


def test_forged_remote_row_with_type_local_is_billed_unknown():
    assert billing.billing_class(model("custom", REMOTE, type="local")) == "unknown"
    assert billing.billing_class({"type": "local", "provider": "llamacpp", "endpoint": REMOTE}) == "unknown"


def test_forged_remote_row_cannot_borrow_a_free_stamp_through_its_kind():
    row = model("llamacpp", REMOTE, access="free")
    assert billing.billing_class(row) == "free"  # an owner-set stamp still counts for a cloud row
    assert not is_local_model(row)


def test_loopback_engine_stays_local_and_free():
    for endpoint in ("http://127.0.0.1:8080/v1", "http://localhost:11434", "http://[::1]:1234/v1", ""):
        row = model("llamacpp", endpoint)
        assert billing.billing_class(row) == "free", endpoint
        assert privacy.is_local_kind(row), endpoint


def test_owner_env_host_keeps_a_lan_engine_local_and_free(monkeypatch):
    row = model("ollama", LAN)
    assert billing.billing_class(row) == "unknown"  # not trusted until the owner sets it
    monkeypatch.setenv("OLLAMA_HOST", "192.168.1.5")
    assert billing.billing_class(row) == "free"
    assert privacy.is_local_kind(row)
    assert privacy.endpoint_allows_local(row)
    assert is_local_model(row)


@pytest.mark.parametrize("value", ["192.168.1.5", "192.168.1.5:11434", "http://192.168.1.5:11434/", " 192.168.1.5 "])
def test_env_host_value_shapes(monkeypatch, value):
    monkeypatch.setenv("OLLAMA_HOST", value)
    assert privacy.trusted_engine_hosts() == frozenset({"192.168.1.5"})
    assert privacy.is_loopback_endpoint("http://192.168.1.5:9/v1")


def test_env_host_trusts_only_that_host(monkeypatch):
    monkeypatch.setenv("OLLAMA_HOST", "192.168.1.5")
    assert not privacy.is_loopback_endpoint("http://192.168.1.6:11434")
    assert not privacy.is_loopback_endpoint("http://192.168.1.5.evil.test/v1")
    assert not privacy.is_loopback_endpoint("http://evil.test/192.168.1.5")
    assert not privacy.is_loopback_endpoint("http://192.168.1.5@evil.test/v1")
    assert not privacy.is_loopback_endpoint(REMOTE)
    assert billing.billing_class(model("ollama", "http://192.168.1.6:11434")) == "unknown"


def test_a_row_or_renderer_value_never_adds_a_trusted_host(monkeypatch):
    row = model("ollama", LAN, trustedHost="192.168.1.5", host="192.168.1.5", env={"OLLAMA_HOST": "192.168.1.5"})
    assert privacy.trusted_engine_hosts() == frozenset()
    assert billing.billing_class(row) == "unknown"
    assert not privacy.endpoint_allows_local(row)
    assert not privacy.is_loopback_endpoint(LAN)


def test_empty_or_bad_env_trusts_nothing(monkeypatch):
    for value in ("", "   ", "http://", ":::", "http://[bad"):
        monkeypatch.setenv("OLLAMA_HOST", value)
        assert privacy.trusted_engine_hosts() == frozenset(), value


def test_a_remote_row_on_the_env_host_is_still_not_a_cloud_free_pass(monkeypatch):
    monkeypatch.setenv("OLLAMA_HOST", "192.168.1.5")
    assert billing.billing_class(model("openai", "https://api.openai.com/v1")) == "unknown"
