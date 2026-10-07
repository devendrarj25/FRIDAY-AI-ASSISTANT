"""FRIDAY · billing authority inside the kernel.

The desktop already owns the billing decision (``electron/billing-policy.cjs``
and ``electron/billing-firewall.cjs``). This module is NOT a second authority:
it is the same rule set, mirrored in Python, so that every request that leaves
the kernel — chat, planner, agent, companion/phone, background work — passes
the identical final check before any HTTP call is made.

The kernel never invents its own state: the desktop pushes the authoritative
billing record with the ``billing.set`` RPC. Until it does, paid and
unknown-cost models remain blocked. Local and verified-free models stay allowed.

Pure logic only (no I/O, no httpx) so it can be unit tested on its own.
"""

from __future__ import annotations

import time
from typing import Any

GRANT_SCOPES = ("off", "request", "session", "always")

DEFAULT_BILLING: dict[str, Any] = {
    "paidAccess": False,
    "autoPaidUsage": False,
    "killSwitch": False,
    "grantScope": "off",
    "grantUntil": 0,
    "grantedAt": 0,
}


class BillingBlocked(RuntimeError):
    """Raised at the provider boundary when a request would cost money."""


def _now_ms() -> int:
    return int(time.time() * 1000)


def _bool(value: Any, fallback: bool = False) -> bool:
    return value if isinstance(value, bool) else fallback


def _num(value: Any) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return 0


def normalise(raw: Any) -> dict[str, Any]:
    """Any stored/received shape becomes a complete, safe billing record."""
    source = raw if isinstance(raw, dict) else {}
    scope = source.get("grantScope")
    return {
        "paidAccess": _bool(source.get("paidAccess")),
        "autoPaidUsage": _bool(source.get("autoPaidUsage")),
        "killSwitch": _bool(source.get("killSwitch")),
        "grantScope": scope if scope in GRANT_SCOPES else "off",
        "grantUntil": _num(source.get("grantUntil")),
        "grantedAt": _num(source.get("grantedAt")),
    }


def grant_active(billing: Any, now: int | None = None) -> bool:
    state = normalise(billing)
    now = _now_ms() if now is None else now
    if state["grantScope"] in ("always", "request"):
        return True
    if state["grantScope"] == "session":
        return state["grantUntil"] > now
    return False


def paid_unlocked(billing: Any, now: int | None = None) -> tuple[bool, str]:
    state = normalise(billing)
    if state["killSwitch"]:
        return False, "emergency kill switch is on — paid models are blocked"
    if state["paidAccess"]:
        return True, "paid AI access is enabled by the owner"
    if grant_active(state, now):
        return True, f"paid usage granted for this {state['grantScope']}"
    return False, "paid AI access is off — free and local models only"


def billing_class(model: Any) -> str:
    """"free" | "paid" | "unknown". Unknown remains distinct from paid."""
    if model is None:
        return "unknown"
    options = getattr(model, "options", None)
    if not isinstance(options, dict):
        options = model if isinstance(model, dict) else {}
    kind = str(options.get("type") or getattr(model, "kind", "") or "").lower()
    provider = str(options.get("provider") or getattr(model, "provider", "") or "").lower()
    local_ids = (
        "ollama",
        "llamacpp",
        "llama.cpp",
        "lmstudio",
        "vllm",
        "localai",
        "jan",
        "mlx",
        "local",
    )
    if kind == "local" or kind in local_ids or provider in local_ids:
        return "free"
    record = options.get("accessRecord")
    if isinstance(record, dict):
        mode = str(record.get("billingMode") or "").upper()
        elig = str(record.get("eligibility") or "").upper()
        ver = str(record.get("verification") or "").upper()
        if elig in ("EXHAUSTED", "NOT_ELIGIBLE"):
            return "paid" if mode == "PAID" else "unknown"
        if ver == "VERIFIED" and mode in ("ZERO_COST", "FREE_QUOTA", "FREE_CREDIT") and elig in (
            "ELIGIBLE",
            "RATE_LIMITED",
        ):
            return "free"
        if mode == "PAID":
            return "paid"
        return "unknown"
    access = str(options.get("access") or options.get("billingClass") or "").lower()
    if access in ("free", "paid"):
        return access
    return "unknown"


def is_billable(model: Any) -> bool:
    return billing_class(model) != "free"


def guard(
    model: Any,
    billing: Any,
    *,
    explicit_paid: bool = False,
    policy: str | None = None,
    now: int | None = None,
) -> dict[str, Any]:
    """The final check. Mirrors ``guardProviderRequest`` in the main process."""
    klass = billing_class(model)
    if policy == "paid-only" and klass != "paid":
        return {
            "allowed": False,
            "billingClass": klass,
            "requiresApproval": False,
            "reason": "the current cost mode is paid-only — free and unverified models are excluded",
        }
    if klass == "free":
        return {"allowed": True, "billingClass": klass, "reason": "free or local model"}

    if policy == "free-only":
        return {
            "allowed": False,
            "billingClass": klass,
            "requiresApproval": True,
            "reason": "usage policy is free only",
        }

    unlocked, reason = paid_unlocked(billing, now)
    if not unlocked:
        return {"allowed": False, "billingClass": klass, "requiresApproval": True, "reason": reason}

    state = normalise(billing)
    if explicit_paid or grant_active(state, now):
        return {"allowed": True, "billingClass": klass, "reason": "owner authorised this request"}
    if state["autoPaidUsage"]:
        return {
            "allowed": True,
            "billingClass": klass,
            "reason": "automatic paid usage is enabled by the owner",
        }
    return {
        "allowed": False,
        "billingClass": klass,
        "requiresApproval": True,
        "reason": "automatic routing may not spend — pick this model explicitly",
    }


def consume_grant(billing: Any) -> dict[str, Any]:
    """Spend a one-shot ("this request") unlock.

    Mirrors ``consumeGrant`` in ``electron/billing-policy.cjs``. The kernel is
    the process that actually opens the provider connection, so it must spend
    the grant itself the moment it authorises a billable request — otherwise a
    second kernel-side request (planner, companion, agent) could ride the same
    one-shot unlock before the desktop's own record reaches us again.
    """
    state = normalise(billing)
    if state["grantScope"] != "request":
        return state
    return {**state, "grantScope": "off", "grantUntil": 0}


def describe_block(verdict: dict[str, Any], model: Any) -> str:
    label = getattr(model, "label", None) or getattr(model, "id", None) or "this model"
    kind = verdict.get("billingClass")
    prefix = "paid model" if kind == "paid" else "model with unverified billing"
    return f"{label} is a {prefix} — blocked: {verdict.get('reason', 'not authorised')}"

