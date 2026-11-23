"""Firewall contract tests found by mutation: each one kills a deliberate break of the privacy or billing firewall.

The mutants were applied to a throwaway copy of the kernel (never this tree). Each test below fails against the
break named in its docstring and passes on the real code. They exercise the one choke point every provider call
passes through (``ModelRouter._stream_one``) and the pure helpers behind it.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import billing  # noqa: E402
import privacy  # noqa: E402
from router import Model, ModelRouter  # noqa: E402


class Store:
    def models(self):
        return []

    def upsert_model(self, _row):
        return None


SENSITIVE_TEXT = "my password is hunter2"
PUBLIC_TEXT = "what is the weather in Jaipur"


def cloud(model_id: str = "cloud-1", **options) -> Model:
    return Model(
        id=model_id,
        label=model_id,
        provider="openai",
        endpoint="https://api.openai.com/v1",
        role="brain",
        options={"type": "cloud", **options},
    )


def local() -> Model:
    return Model(
        id="local-1",
        label="local-1",
        provider="ollama",
        endpoint="http://127.0.0.1:11434",
        role="brain",
        options={"type": "local"},
    )


class Wire:
    """Stands in for the provider connection and records whether anything was sent."""

    def __init__(self, router: ModelRouter):
        self.sent: list[str] = []

        async def handler(model, messages, reasoning_effort=None):
            self.sent.append(model.id)
            yield "ok"

        router._stream_openai = handler  # type: ignore[method-assign]
        router._stream_ollama = handler  # type: ignore[method-assign]


def run(router: ModelRouter, model: Model, text: str, **kwargs):
    async def go():
        return [c async for c in router._stream_one(model, [{"role": "user", "content": text}], **kwargs)]

    return asyncio.run(go())


def unlocked_router(**state) -> tuple[ModelRouter, Wire]:
    router = ModelRouter(Store())
    router.set_billing({"paidAccess": True, "autoPaidUsage": True, **state}, "allow-paid")
    return router, Wire(router)


# ---- privacy firewall at the provider boundary -------------------------------------------------------------------


def test_sensitive_text_never_reaches_a_cloud_model_even_with_a_yes_and_a_free_plan():
    """Kills: dropping the hardStop check in ``_stream_one``; flipping ``hard_stop`` in ``privacy.guard_egress``."""
    router, wire = unlocked_router()
    router.on_privacy_ask = lambda *args: True  # an owner callback that says yes is still not enough
    for confirmed in (False, True):
        with pytest.raises(privacy.PrivacyBlocked):
            run(router, cloud(access="free"), SENSITIVE_TEXT, privacy_confirmed=confirmed)
    assert wire.sent == []
    assert run(router, cloud(access="free"), PUBLIC_TEXT) == ["ok"]  # the same model still answers public text
    assert run(router, local(), SENSITIVE_TEXT) == ["ok"]  # and a local model may read anything
    assert wire.sent == ["cloud-1", "local-1"]


@pytest.mark.parametrize("model", [None, {}, {"type": ""}, {"type": "unknown"}, {"options": {}}, object()])
def test_a_model_of_unknown_kind_is_never_treated_as_local(model):
    """Kills: ``is_local_kind`` returning true for an empty kind."""
    assert privacy.is_local_kind(model) is False
    decision = privacy.guard_egress(model, SENSITIVE_TEXT, connected=True)
    assert decision["external"] is True and decision["hardStop"] is True and decision["autoAllowed"] is False


def test_only_a_known_local_kind_keeps_sensitive_text_on_this_pc():
    for kind in ("local", "ollama"):
        decision = privacy.guard_egress({"type": kind}, SENSITIVE_TEXT, connected=True)
        assert decision["external"] is False and decision["autoAllowed"] is True
    assert privacy.guard_egress({"type": "local"}, SENSITIVE_TEXT, destination="https://example.test")["external"]


def _confirm_branch_router(monkeypatch, *, ask) -> tuple[ModelRouter, Wire]:
    """The confirmation branch of ``_stream_one``: a decision that asks without a hard stop."""
    router, wire = unlocked_router()
    router.on_privacy_ask = ask
    monkeypatch.setattr(
        privacy,
        "guard_egress",
        lambda *a, **k: {"hardStop": False, "requiresConfirmation": True, "reason": "ask first", "external": True},
    )
    return router, wire


def test_a_confirmation_that_is_not_given_blocks_the_send(monkeypatch):
    """Kills: flipping the ``privacy_confirmed`` test; a failing or missing ask treated as a yes."""
    for ask in (None, lambda *a: False, lambda *a: (_ for _ in ()).throw(RuntimeError("ask fell over"))):
        router, wire = _confirm_branch_router(monkeypatch, ask=ask)
        with pytest.raises(privacy.PrivacyBlocked):
            run(router, cloud(access="free"), PUBLIC_TEXT)
        assert wire.sent == []


def test_a_given_confirmation_lets_the_send_through_once_asked(monkeypatch):
    asked: list[str] = []
    router, wire = _confirm_branch_router(
        monkeypatch, ask=lambda model, content, decision: asked.append(model.id) or True
    )
    assert run(router, cloud(access="free"), PUBLIC_TEXT) == ["ok"]
    assert asked == ["cloud-1"] and wire.sent == ["cloud-1"]
    asked.clear()
    assert run(router, cloud(access="free"), PUBLIC_TEXT, privacy_confirmed=True) == ["ok"]
    assert asked == []  # a fresh yes from the owner is not asked for twice


# ---- billing firewall at the provider boundary -------------------------------------------------------------------


def test_a_paid_or_unknown_cost_model_is_blocked_while_paid_access_is_off():
    """Kills: dropping the final billing guard; ignoring a locked paid state."""
    router = ModelRouter(Store())
    wire = Wire(router)
    for access in ("paid", "unknown"):
        with pytest.raises(billing.BillingBlocked):
            run(router, cloud(access=access), PUBLIC_TEXT)
    assert wire.sent == []
    assert run(router, cloud(access="free"), PUBLIC_TEXT) == ["ok"]


def test_free_only_blocks_a_paid_model_even_with_paid_access_on():
    """Kills: a free-only policy that no longer blocks."""
    router, wire = unlocked_router()
    router.set_billing({"paidAccess": True, "autoPaidUsage": True}, "free-only")
    with pytest.raises(billing.BillingBlocked):
        run(router, cloud(access="paid"), PUBLIC_TEXT, explicit_paid=True)
    assert wire.sent == []


def test_the_kill_switch_blocks_every_paid_model():
    """Kills: an ignored kill switch."""
    router, wire = unlocked_router(killSwitch=True)
    with pytest.raises(billing.BillingBlocked):
        run(router, cloud(access="paid"), PUBLIC_TEXT, explicit_paid=True)
    assert wire.sent == []


def test_a_one_shot_grant_is_spent_by_a_paid_request_and_not_by_a_free_one():
    """Kills: a grant that is never spent, or spent by the wrong class of model."""
    router = ModelRouter(Store())
    wire = Wire(router)
    spent: list[dict] = []
    router.on_billing_spent = spent.append
    router.set_billing({"grantScope": "request"}, "allow-paid")
    assert run(router, cloud("free-cloud", access="free"), PUBLIC_TEXT) == ["ok"]
    assert run(router, local(), PUBLIC_TEXT) == ["ok"]
    assert router.billing_state()["billing"]["grantScope"] == "request" and spent == []
    assert run(router, cloud("paid-cloud", access="paid"), PUBLIC_TEXT) == ["ok"]
    assert router.billing_state()["billing"]["grantScope"] == "off"
    assert [s["grantScope"] for s in spent] == ["off"]
    with pytest.raises(billing.BillingBlocked):  # the same unlock cannot be used twice
        run(router, cloud("paid-cloud", access="paid"), PUBLIC_TEXT)
    assert wire.sent == ["free-cloud", "local-1", "paid-cloud"]


def test_paid_access_alone_does_not_let_automatic_routing_spend():
    """Kills: ``guard`` allowing paid usage without an owner say-so, an explicit pick or a grant."""
    verdict = billing.guard(cloud(access="paid"), {"paidAccess": True}, policy="allow-paid")
    assert verdict["allowed"] is False and verdict["requiresApproval"] is True
    assert billing.guard(cloud(access="paid"), {"paidAccess": True}, explicit_paid=True)["allowed"] is True
    assert billing.guard(cloud(access="paid"), {"paidAccess": True, "autoPaidUsage": True})["allowed"] is True


# ---- billing classes ---------------------------------------------------------------------------------------------


@pytest.mark.parametrize("eligibility", ["EXHAUSTED", "NOT_ELIGIBLE"])
def test_an_exhausted_or_ineligible_free_tier_is_never_free(eligibility):
    """Kills: dropping the EXHAUSTED / NOT_ELIGIBLE check in ``billing_class``."""
    record = {"billingMode": "FREE_QUOTA", "eligibility": eligibility, "verification": "VERIFIED"}
    assert billing.billing_class(cloud(accessRecord=record)) == "unknown"
    assert billing.billing_class(cloud(accessRecord={**record, "billingMode": "PAID"})) == "paid"
    ok = {**record, "eligibility": "ELIGIBLE"}
    assert billing.billing_class(cloud(accessRecord=ok)) == "free"


def test_the_session_grant_expires_exactly_at_its_time():
    state = {"grantScope": "session", "grantUntil": 1000}
    assert billing.grant_active(state, now=999) is True
    assert billing.grant_active(state, now=1001) is False
    assert billing.grant_active({"grantScope": "off", "grantUntil": 10**13}, now=1) is False


# ---- routing under the desktop's published cost mode -------------------------------------------------------------


def test_live_routing_offers_only_proven_free_and_local_models_under_a_free_cost_mode():
    """Kills: an unknown-cost model slipping into a free cost mode when paid access happens to be on."""
    router = ModelRouter(Store())
    router.set_billing({"paidAccess": True, "autoPaidUsage": True}, "allow-paid")
    for model in (
        local(),
        cloud("cloud-free", access="free"),
        cloud("cloud-paid", access="paid"),
        cloud("cloud-unknown", access="unknown"),
        cloud("cloud-unlabelled"),
    ):
        router._models[model.id] = model
    for policy in ("free-preferred", "free-only"):
        ids = router.ids_for_live({"routeMode": "auto", "policy": policy, "selected": []})
        assert sorted(ids or []) == ["cloud-free", "local-1"], policy
    paid = router.ids_for_live({"routeMode": "auto", "policy": "paid-only", "selected": []})
    assert paid == ["cloud-paid"]
    private = router.ids_for_live({"routeMode": "auto", "policy": "allow-paid", "privacy": "private", "selected": []})
    assert private == ["local-1"]


def test_live_routing_never_lists_a_model_the_billing_guard_would_refuse():
    """Kills: ``spendable`` that always says yes (the route list and the guard must agree)."""
    router = ModelRouter(Store())
    for model in (local(), cloud("cloud-free", access="free"), cloud("cloud-paid", access="paid")):
        router._models[model.id] = model
    live = {"routeMode": "auto", "policy": "allow-paid", "selected": []}
    router.set_billing({}, "allow-paid")  # the owner has not turned paid access on
    assert sorted(router.ids_for_live(live) or []) == ["cloud-free", "local-1"]
    router.set_billing({"paidAccess": True, "killSwitch": True}, "allow-paid")
    assert sorted(router.ids_for_live(live) or []) == ["cloud-free", "local-1"]
    router.set_billing({"paidAccess": True}, "allow-paid")  # paid access alone does not let routing choose a paid model
    assert sorted(router.ids_for_live(live) or []) == ["cloud-free", "local-1"]
    picked = {"routeMode": "manual", "policy": "allow-paid", "selected": ["cloud-paid"]}
    assert router.ids_for_live(picked) == ["cloud-paid"]  # an explicit pick is the owner's word


def test_a_stale_price_demotes_even_a_verified_free_stamp():
    """Kills: dropping the stale check in ``billing_class``."""
    record = {"billingMode": "FREE_QUOTA", "eligibility": "ELIGIBLE", "verification": "VERIFIED"}
    assert billing.billing_class(cloud(accessRecord=record)) == "free"
    assert billing.billing_class(cloud(accessRecord={**record, "failureReason": "pricing_stale"})) == "unknown"
    assert billing.billing_class(cloud(accessRecord={**record, "evidence": {"stale": True}})) == "unknown"
