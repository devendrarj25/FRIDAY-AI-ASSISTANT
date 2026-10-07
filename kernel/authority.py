"""FRIDAY · tool authorization (kernel side, fail-closed).

The kernel no longer believes a caller that claims a tool call was approved.
Every non-safe tool needs a signed, single-use authorization minted either by
the desktop main process (after the owner's policy or an approval prompt) or
by the kernel's own planner after the owner approved that exact step.

Mirror of ``electron/tool-authority.cjs``: same canonical JSON, same HMAC,
same token layout ``v1.<base64url payload>.<hex signature>``.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from typing import Any

TOKEN_TTL_MS = 30_000


def canonical(value: Any) -> str:
    """Stable JSON matching the Electron signer byte for byte."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            return "null"
        return str(int(value)) if value.is_integer() else repr(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonical(v) for v in value) + "]"
    if isinstance(value, dict):
        keys = sorted(k for k, v in value.items() if v is not None or True)
        parts = [f"{json.dumps(str(k), ensure_ascii=False)}:{canonical(value[k])}" for k in keys]
        return "{" + ",".join(parts) + "}"
    return json.dumps(str(value), ensure_ascii=False)


def hash_args(args: Any) -> str:
    payload = args if isinstance(args, dict) else {}
    return hashlib.sha256(canonical(payload).encode("utf-8")).hexdigest()


class Authority:
    """Mints and verifies tool authorizations. Without a secret it denies all."""

    def __init__(self, secret: str | None = None) -> None:
        self.secret = (secret or os.environ.get("FRIDAY_TOOL_AUTHORITY_SECRET", "")).strip()
        self._spent: dict[str, float] = {}

    @property
    def configured(self) -> bool:
        return bool(self.secret)

    # ------------------------------------------------------------- minting
    def issue(self, tool: str, args: dict | None = None, risk: str = "exec", requester: str = "kernel") -> str:
        if not self.secret:
            raise PermissionError("tool authority secret is not configured")
        payload = {
            "tool": tool,
            "argsHash": hash_args(args or {}),
            "risk": risk,
            "requester": requester,
            "nonce": secrets.token_hex(16),
            "exp": int(time.time() * 1000) + TOKEN_TTL_MS,
        }
        body = base64.urlsafe_b64encode(json.dumps(payload).encode("utf-8")).rstrip(b"=").decode()
        signature = hmac.new(self.secret.encode(), body.encode(), hashlib.sha256).hexdigest()
        return f"v1.{body}.{signature}"

    # ---------------------------------------------------------- verifying
    def verify(self, token: Any, tool: str, args: dict | None = None) -> tuple[bool, str]:
        """(ok, reason). Anything unexpected is a denial — never an allow."""
        if not self.secret:
            return False, "authorization is unavailable (no authority secret)"
        if not isinstance(token, str) or not token.startswith("v1."):
            return False, "this tool needs an owner-approved authorization"
        try:
            _, body, signature = token.split(".", 2)
        except ValueError:
            return False, "malformed authorization"
        expected = hmac.new(self.secret.encode(), body.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, signature):
            return False, "authorization signature is invalid"
        try:
            padding = "=" * (-len(body) % 4)
            payload = json.loads(base64.urlsafe_b64decode(body + padding))
        except Exception:
            return False, "unreadable authorization"
        now = time.time() * 1000
        if float(payload.get("exp", 0)) < now:
            return False, "authorization expired — approve the action again"
        if payload.get("tool") != tool:
            return False, "authorization was issued for a different tool"
        if payload.get("argsHash") != hash_args(args or {}):
            return False, "authorization does not match these arguments"
        nonce = str(payload.get("nonce", ""))
        self._forget_old(now)
        if not nonce or nonce in self._spent:
            return False, "authorization was already used"
        self._spent[nonce] = float(payload["exp"])
        return True, "authorized"

    def _forget_old(self, now: float) -> None:
        for nonce, exp in list(self._spent.items()):
            if exp < now:
                self._spent.pop(nonce, None)
