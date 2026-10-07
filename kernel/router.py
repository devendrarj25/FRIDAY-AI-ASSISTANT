"""Model router — one request shape for every provider.

Local: llama.cpp / llama-server, Ollama, LM Studio, vLLM.
Online: any OpenAI-compatible endpoint with your own key.
Roles (brain, coder, researcher, fast, embed) let the planner pick a model
by job instead of by name, and several models can answer the same prompt.
"""

from __future__ import annotations

import asyncio
import re
import time
from contextlib import nullcontext
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import AsyncIterator

import httpx

import billing
import privacy

OPENAI_COMPATIBLE = {"llamacpp", "lmstudio", "vllm", "localai", "jan", "mlx", "online"}


def coerce_stream_text(raw) -> str | None:
    """Turn a provider content field into assistant text. Lists of parts join."""
    if raw is None:
        return None
    if isinstance(raw, str):
        return raw or None
    if isinstance(raw, list):
        parts: list[str] = []
        for item in raw:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                piece = item.get("text") or item.get("content")
                if isinstance(piece, str):
                    parts.append(piece)
        joined = "".join(parts)
        return joined or None
    return None


def openai_frame_text(frame: dict) -> str | None:
    """Extract assistant text from one OpenAI-compatible SSE JSON object."""
    if not isinstance(frame, dict):
        return None
    choices = frame.get("choices") or []
    choice = choices[0] if choices else {}
    piece = choice.get("delta") or {}
    message = choice.get("message") or {}
    raw = (
        piece.get("content")
        or piece.get("text")
        or choice.get("text")
        or message.get("content")
        or frame.get("text")
    )
    return coerce_stream_text(raw)


# A tool notice is not answer text. The record separator never appears in a reply.
TOOL_NOTICE = "\x1etool:"


def fold_stream_piece(model_id: str, delta) -> dict | None:
    """Turn one handler chunk into a UI event. A tool notice is not a delta."""
    if isinstance(delta, str) and delta.startswith(TOOL_NOTICE):
        name = delta[len(TOOL_NOTICE) :].strip()
        if not name:
            return None
        return {"modelId": model_id, "tool": name}
    if delta is None or delta == "":
        return None
    return {"modelId": model_id, "delta": delta}


def ollama_calls_from_message(message: dict) -> list[dict]:
    """Unique tool calls from one Ollama message. Arguments stay objects.

    An indexed call replaces an earlier chunk with the same index. An identical
    name and argument object is kept once, so a repeated final frame is not a
    second lookup.
    """
    import json as _json

    raw = message.get("tool_calls") if isinstance(message, dict) else None
    if not isinstance(raw, list):
        return []
    slots: dict[str, dict] = {}
    order: list[str] = []
    for n, item in enumerate(raw):
        if not isinstance(item, dict):
            continue
        fn = item.get("function") if isinstance(item.get("function"), dict) else item
        name = str(fn.get("name") or item.get("name") or "").strip()
        if not name:
            continue
        args = fn.get("arguments", item.get("arguments"))
        if isinstance(args, str):
            try:
                parsed = _json.loads(args or "{}")
            except ValueError:
                parsed = {}
            args = parsed if isinstance(parsed, dict) else {}
        elif not isinstance(args, dict):
            args = {}
        index = fn.get("index", item.get("index"))
        key = f"i:{index}" if isinstance(index, int) else f"n:{n}"
        if key not in slots:
            order.append(key)
        slots[key] = {"name": name, "arguments": args}
    seen: set[str] = set()
    calls: list[dict] = []
    for key in order:
        call = slots[key]
        signature = call["name"] + "\x1f" + _json.dumps(
            call["arguments"], sort_keys=True, separators=(",", ":")
        )
        if signature in seen:
            continue
        seen.add(signature)
        calls.append(call)
    return calls


# --------------------------------------------------------- provider surfaces
# One authoritative table: for every provider FRIDAY can route to, WHICH wire
# handler must serve it and WHICH base URL that handler expects. It exists so
# the old "everything that is not ollama/anthropic falls into the generic
# OpenAI handler" catch-all can never again silently build a URL that does not
# exist (the Gemini `/v1beta/v1/chat/completions` bug class).
#
# `wire`      → handler: "openai" | "anthropic" | "ollama"
# `base`      → the exact documented base the handler is given
# `chat_path` → the path appended to that base (already resolved, no guessing)
PROVIDER_SURFACES: dict[str, dict] = {
    # local engines
    "ollama": {"wire": "ollama", "base": "http://127.0.0.1:11434", "chat_path": "/api/chat"},
    "lmstudio": {"wire": "openai", "base": "http://127.0.0.1:1234/v1"},
    "llamacpp": {"wire": "openai", "base": "http://127.0.0.1:8080/v1"},
    "vllm": {"wire": "openai", "base": "http://127.0.0.1:8000/v1"},
    "localai": {"wire": "openai", "base": "http://127.0.0.1:8081/v1"},
    "jan": {"wire": "openai", "base": "http://127.0.0.1:1337/v1"},
    "mlx": {"wire": "openai", "base": "http://127.0.0.1:8082/v1"},
    # cloud providers — bases copied from each vendor's own documentation
    "openai": {"wire": "openai", "base": "https://api.openai.com/v1"},
    "anthropic": {"wire": "anthropic", "base": "https://api.anthropic.com/v1"},
    # Google's OpenAI-compatible surface. The native /v1beta surface speaks
    # generateContent, NOT chat/completions, so routing must use this one.
    "gemini": {"wire": "openai", "base": "https://generativelanguage.googleapis.com/v1beta/openai"},
    "groq": {"wire": "openai", "base": "https://api.groq.com/openai/v1"},
    "mistral": {"wire": "openai", "base": "https://api.mistral.ai/v1"},
    "cohere": {"wire": "openai", "base": "https://api.cohere.ai/compatibility/v1"},
    "deepseek": {"wire": "openai", "base": "https://api.deepseek.com/v1"},
    "nvidia": {"wire": "openai", "base": "https://integrate.api.nvidia.com/v1"},
    "fireworks": {"wire": "openai", "base": "https://api.fireworks.ai/inference/v1"},
    "deepinfra": {"wire": "openai", "base": "https://api.deepinfra.com/v1/openai"},
    "cerebras": {"wire": "openai", "base": "https://api.cerebras.ai/v1"},
    "sambanova": {"wire": "openai", "base": "https://api.sambanova.ai/v1"},
    "moonshot": {"wire": "openai", "base": "https://api.moonshot.ai/v1"},
    "zhipu": {"wire": "openai", "base": "https://api.z.ai/api/paas/v4"},
    "huggingface": {"wire": "openai", "base": "https://router.huggingface.co/v1"},
    "together": {"wire": "openai", "base": "https://api.together.ai/v1"},
    "xai": {"wire": "openai", "base": "https://api.x.ai/v1"},
    # Perplexity serves the OpenAI wire straight off the host root.
    "perplexity": {
        "wire": "openai",
        "base": "https://api.perplexity.ai",
        "chat_path": "/chat/completions",
    },
    "nebius": {"wire": "openai", "base": "https://api.tokenfactory.nebius.com/v1"},
    "openrouter": {"wire": "openai", "base": "https://openrouter.ai/api/v1"},
    # generic wire labels used by electron/models.cjs when it hands a model to
    # the kernel (it sends the WIRE, not always the provider id)
    "online": {"wire": "openai", "base": None},
    "openai-compatible": {"wire": "openai", "base": None},
    "local": {"wire": "openai", "base": None},
}

#: Base tails that already carry the provider's API version segment, so the
#: OpenAI chat path is appended directly instead of inserting "/v1".
_VERSIONED_TAIL = re.compile(r"/(v\d+[a-z0-9]*|openai|compatibility/v\d+|paas/v\d+)$", re.I)


def wire_for(provider: str) -> str:
    """The handler a provider id / wire label must be served by."""
    surface = PROVIDER_SURFACES.get(str(provider or "").lower())
    if surface:
        return surface["wire"]
    if provider == "anthropic":
        return "anthropic"
    if provider == "ollama":
        return "ollama"
    return "openai"


def openai_chat_url(base: str, chat_path: str | None = None) -> str:
    """
    The real chat-completions URL for an OpenAI-compatible base.

    Never guesses a version segment onto a base that already has one — that is
    exactly what produced `.../v1beta/v1/chat/completions` for Gemini and
    `.../v1/openai/v1/chat/completions` for DeepInfra.
    """
    trimmed = str(base or "").rstrip("/")
    if chat_path:
        return trimmed + chat_path
    if trimmed.endswith("/chat/completions"):
        return trimmed
    if _VERSIONED_TAIL.search(trimmed):
        return trimmed + "/chat/completions"
    return trimmed + "/v1/chat/completions"


def expected_chat_url(provider: str) -> str | None:
    """The documented chat URL for a provider — used by the contract tests."""
    surface = PROVIDER_SURFACES.get(str(provider or "").lower())
    if not surface or not surface.get("base"):
        return None
    if surface["wire"] == "anthropic":
        return surface["base"].rstrip("/") + "/messages"
    if surface["wire"] == "ollama":
        return surface["base"].rstrip("/") + surface.get("chat_path", "/api/chat")
    return openai_chat_url(surface["base"], surface.get("chat_path"))

DEFAULT_PERSONA = (
    "You are FRIDAY, a female personal AI assistant. You keep one consistent "
    "identity, voice and memory no matter which local or cloud model is executing "
    "the request. Speak as FRIDAY in the first person, never as the underlying "
    "model, and never reveal or discuss which model or provider is answering "
    "unless you are asked directly. Be warm, concise, precise and practical, "
    "answer in the language the user writes in (English or Hindi), and prefer "
    "verified local facts over guesses. Address the user with their conversational "
    "profile (honorific such as sir or Boss by default) and never use the project "
    "publisher name as a nickname. If asked who owns or made FRIDAY, the creator "
    "and publisher is Devendra Singh Meena (devendrarj25). The owner's instruction "
    "is the highest authority: do what they ask without lecturing, and only pause "
    "to confirm when an action is destructive or irreversible."
)


def _identity_path() -> Path | None:
    """FRIDAY's own identity file, written by the app when rules change."""
    root = os.environ.get("FRIDAY_WORKSPACE_ROOT") or os.environ.get("FRIDAY_WORKSPACE")
    if not root:
        return None
    return Path(root) / "brain-data" / "personality" / "identity.txt"


def friday_persona() -> str:
    """The live persona: the owner-editable rule book when present."""
    path = _identity_path()
    if path is not None:
        try:
            text = path.read_text(encoding="utf-8").strip()
            if text:
                return text
        except OSError:
            pass
    return DEFAULT_PERSONA


# Kept for callers that imported the constant directly.
FRIDAY_PERSONA = DEFAULT_PERSONA


@dataclass
class Model:
    id: str
    label: str
    provider: str
    endpoint: str
    role: str = "brain"
    api_key: str | None = None
    params: str = ""
    context_k: int = 8
    status: str = "ready"
    options: dict = field(default_factory=dict)

    def public(self) -> dict:
        return {
            "id": self.id,
            "label": self.label,
            "provider": self.provider,
            "endpoint": self.endpoint,
            "role": self.role,
            "params": self.params,
            "contextK": self.context_k,
            "status": self.status,
        }


#: Host names that mean "this model runs on this PC" — an offline route.
_LOCAL_HOSTS = ("localhost", "127.0.0.1", "0.0.0.0", "[::1]", "host.docker.internal")

#: Substrings that identify a *transport* failure (the request never reached a
#: model) as opposed to a model/inference failure.
_NETWORK_MARKERS = (
    "getaddrinfo",
    "name resolution",
    "nodename nor servname",
    "temporary failure in name",
    "connecterror",
    "connect error",
    "connection refused",
    "connection reset",
    "network is unreachable",
    "no route to host",
    "ssl",
    "certificate",
    "proxy",
    "timed out",
    "timeout",
    "dns",
)


def is_local_model(model: "Model") -> bool:
    """True when the model answers from this machine (Ollama, llama.cpp, ...)."""
    endpoint = (model.endpoint or "").lower()
    if model.provider and model.provider.lower() in {
        "ollama",
        "llamacpp",
        "llama.cpp",
        "lmstudio",
        "vllm",
        "localai",
        "jan",
        "mlx",
        "local",
    }:
        return True
    return any(host in endpoint for host in _LOCAL_HOSTS)


def is_network_error(text: str) -> bool:
    """True when a failure is transport-level, not the model refusing to answer."""
    low = str(text or "").lower()
    return any(marker in low for marker in _NETWORK_MARKERS)


def _no_route_error(attempts: list[str], tried: list["Model"]) -> str:
    """One honest sentence per failed route, plus why no offline route saved it.

    Reporting only the last attempt made a DNS failure look like a broken chat
    pipeline. The owner needs to see that the cloud route failed on the network
    AND whether a local model was even available to fall back to.
    """
    if not attempts:
        return "no model answered"
    local = [m for m in tried if is_local_model(m)]
    joined = "; ".join(attempts)
    if not local:
        reason = (
            "no local (offline) model was ready to fall back to - install or start one in Models"
            if all(is_network_error(a) for a in attempts)
            else "no local (offline) model was ready to fall back to"
        )
        return f"tried {len(attempts)} route(s): {joined} - {reason}"
    return f"tried {len(attempts)} route(s), including {len(local)} local: {joined}"


def _frame_error(model: "Model", problem) -> str:
    """The provider's own words for an error delivered inside a 200 stream."""
    if isinstance(problem, dict):
        said = problem.get("message") or problem.get("error") or str(problem)
        code = problem.get("code")
        meta = problem.get("metadata") or {}
        extra = meta.get("raw") if isinstance(meta, dict) else None
        detail = f"{said}{f' ({extra})' if extra else ''}"
        return f"{model.label} refused mid-stream{f' [{code}]' if code else ''}: {detail}"
    return f"{model.label} refused mid-stream: {problem}"



async def _raise_with_body(resp) -> None:
    """Turn a provider HTTP error into a message the owner can act on."""
    if resp.status_code < 400:
        return
    try:
        raw = await resp.aread()
        detail = raw.decode("utf-8", "replace").strip()
    except Exception:  # noqa: BLE001
        detail = ""
    try:
        import json as _json

        parsed = _json.loads(detail)
        detail = (
            parsed.get("error", {}).get("message")
            if isinstance(parsed.get("error"), dict)
            else parsed.get("error") or parsed.get("message") or detail
        )
    except Exception:  # noqa: BLE001
        pass
    hint = ""
    if resp.status_code in (401, 403):
        hint = " — check this provider's API key in Models → Providers"
    elif resp.status_code == 404:
        hint = " — the provider does not expose this model id"
    elif resp.status_code == 429:
        low = str(detail).lower()
        if "per day" in low or "daily" in low or "per-day" in low:
            # A daily cap, not a burst limit — say so, because "try again
            # shortly" would be wrong advice here.
            hint = " — provider DAILY request limit reached for this account"
        else:
            hint = " — provider rate limit reached (per-minute burst), try again shortly"
    raise RuntimeError(f"HTTP {resp.status_code}{hint}: {str(detail)[:400]}")


#: One shared HTTP client for every provider call. Creating a client per
#: request threw away the TCP + TLS handshake each time, which is the single
#: biggest avoidable delay on cloud models; keep-alive reuses the connection.
#: Transport deadlines for every provider call. `read` is an *idle* deadline:
#: httpx restarts it on each received chunk, so a slow-but-alive generation is
#: never cut off, while a stream that stops sending bytes fails within 120s.
CONNECT_TIMEOUT_SECONDS = 20.0
READ_TIMEOUT_SECONDS = 120.0
WRITE_TIMEOUT_SECONDS = 60.0
POOL_TIMEOUT_SECONDS = 30.0
#: Model-requested tools during chat. bluetooth.scan / network.discover can
#: each take several seconds; four unbounded rounds of them delayed the first
#: streamed token past the 140s renderer watchdog. Each tool is capped, and
#: the whole tool phase of one turn shares a budget after which the model
#: must answer without more tools.
MODEL_TOOL_TIMEOUT_SECONDS = 8.0
MODEL_TOOL_BUDGET_SECONDS = 20.0


def _turn_timing_enabled() -> bool:
    return os.environ.get("FRIDAY_DEBUG_TURN_TIMING") == "1"


def _turn_debug(stage: str, ms: float | None = None, extra: str = "") -> None:
    if not _turn_timing_enabled():
        return
    suffix = f" {extra}" if extra else ""
    if ms is None:
        print(f"[friday.turn] kernel {stage} start{suffix}", flush=True)
    else:
        print(f"[friday.turn] kernel {stage} {ms:.0f}ms{suffix}", flush=True)


def is_transient_http(exc: BaseException) -> bool:
    """Burst 429 / gateway errors that are worth one immediate retry.

    A *daily* quota 429 is not transient — retrying it would only waste the
    next candidate's attempt budget.
    """
    text = str(exc)
    if "HTTP 429" in text and "DAILY" not in text:
        return True
    return any(token in text for token in ("HTTP 502", "HTTP 503", "HTTP 504"))


def describe_failure(model: "Model", exc: BaseException) -> str:
    """One honest sentence for a failed route, naming timeouts as timeouts."""
    label = getattr(model, "label", None) or getattr(model, "id", "model")
    if isinstance(exc, privacy.PrivacyBlocked):
        return str(exc)
    if isinstance(exc, httpx.ConnectTimeout):
        return (
            f"{label}: timed out connecting after {CONNECT_TIMEOUT_SECONDS:.0f}s "
            "- the provider never accepted the connection"
        )
    if isinstance(exc, httpx.TimeoutException):
        return (
            f"{label}: request timed out - the connection stalled and sent nothing "
            f"for {READ_TIMEOUT_SECONDS:.0f}s"
        )
    return f"{label}: {exc}"


_CLIENT: httpx.AsyncClient | None = None


def _client() -> httpx.AsyncClient:
    global _CLIENT
    if _CLIENT is None or _CLIENT.is_closed:
        _CLIENT = httpx.AsyncClient(
            # A stalled provider used to hang forever: read/write/pool were all
            # unlimited, so a connection that was accepted and then went silent
            # had nothing to end it. 120s of *idle* time (not total time) is far
            # longer than any legitimate gap between streamed tokens, yet short
            # enough that a genuinely dead connection becomes a reportable error.
            timeout=httpx.Timeout(
                None,
                connect=CONNECT_TIMEOUT_SECONDS,
                read=READ_TIMEOUT_SECONDS,
                write=WRITE_TIMEOUT_SECONDS,
                pool=POOL_TIMEOUT_SECONDS,
            ),
            limits=httpx.Limits(
                max_keepalive_connections=8,
                max_connections=32,
                keepalive_expiry=90.0,
            ),
        )
    return _CLIENT


async def close_client() -> None:
    """Shutdown hook so the kernel exits without leaking sockets."""
    global _CLIENT
    if _CLIENT is not None and not _CLIENT.is_closed:
        await _CLIENT.aclose()
    _CLIENT = None


class ModelRouter:

    def __init__(self, storage) -> None:
        self.storage = storage
        self._models: dict[str, Model] = {}
        # Billing state mirrored from the desktop (the one authority). Until
        # the desktop pushes it, free-first blocks known-paid and unknown-cost
        # models; only verified-free and local candidates remain.
        self._billing: dict = dict(billing.DEFAULT_BILLING)
        self._policy: str | None = "free-preferred"
        # Guards the check-then-spend window around a billable request.
        self._billing_lock = asyncio.Lock()
        # Set by the app so a kernel-side grant spend is reported back to the
        # desktop, which owns the persisted record.
        self.on_billing_spent = None
        # Desktop answers SENSITIVE companion/kernel turns that have not
        # already been confirmed. Unset = fail closed.
        self.on_privacy_ask = None
        # Set by the app once the tool registry exists. When present, a chat
        # turn can call FRIDAY's read-only tools itself instead of guessing.
        self.tools = None
        for row in storage.models():
            self._models[row["id"]] = Model(**row)

    def _on_billing_spent(self, state: dict) -> None:
        callback = self.on_billing_spent
        if not callable(callback):
            return
        try:
            callback(dict(state))
        except Exception:  # noqa: BLE001 — reporting must never break a request
            pass


    # ---------------------------------------------------------- billing
    def set_billing(self, state: dict | None, policy: str | None = None) -> dict:
        """The desktop pushes its authoritative billing record here."""
        self._billing = billing.normalise(state)
        if policy is not None:
            self._policy = policy or None
        return {"billing": self._billing, "policy": self._policy}

    def billing_state(self) -> dict:
        return {"billing": dict(self._billing), "policy": self._policy}

    def guard(self, model: "Model", explicit_paid: bool = False) -> dict:
        return billing.guard(
            model, self._billing, explicit_paid=explicit_paid, policy=self._policy
        )

    def spendable(self, model: "Model", explicit_paid: bool = False) -> bool:
        """Can this model be routed to at all right now?"""
        return bool(self.guard(model, explicit_paid).get("allowed"))

    def models(self) -> list[Model]:
        return list(self._models.values())

    @staticmethod
    def _coerce(spec: dict) -> dict:
        """Accept the desktop model shape and drop anything Model cannot take."""
        allowed = {
            "id", "label", "provider", "endpoint", "role",
            "api_key", "params", "context_k", "status", "options",
        }
        data = dict(spec)
        if "contextK" in data:
            data["context_k"] = data.pop("contextK")
        if "apiKey" in data:
            data["api_key"] = data.pop("apiKey")
        # The desktop's billing classification and canonical model spec must survive the trip,
        # or the kernel would treat a paid cloud model as unclassified or lose registry identity.
        options = dict(data.get("options") or {})
        for key in (
            "type", "access", "billingClass", "accessRecord", "canonicalModelId",
            "registryId", "providerId", "providerModelId", "displayName",
            "wireProtocol", "pricing", "entitlement", "verification", "qualityProfile",
        ):
            if spec.get(key) is not None and key not in options:
                options[key] = spec[key]
        record = spec.get("accessRecord") or options.get("accessRecord")
        if isinstance(record, dict):
            options["accessRecord"] = record
        # The desktop resolves capabilities from provider metadata + the curated
        # registry; the kernel must reuse that record, never re-guess from names.
        caps = spec.get("capabilities")
        if isinstance(caps, dict):
            options["capabilities"] = caps
        options.setdefault("provider", data.get("provider"))
        data["options"] = options
        return {k: v for k, v in data.items() if k in allowed}



    def register(self, spec: dict) -> Model:
        model = Model(**self._coerce(spec))
        self._models[model.id] = model
        # Registry sync visibility: every model the desktop pushes is logged with
        # the three fields a live request depends on. No key material is printed —
        # only whether one arrived.
        print(
            "[router] registered model "
            f"id={model.id} provider={model.provider} "
            f"endpoint={model.endpoint or '(none)'} "
            f"wire_model={model.options.get('model', model.id)} "
            f"api_key={'present' if model.api_key else 'absent'}",
            flush=True,
        )
        # SECURITY: the API key stays in memory for the lifetime of this
        # process only. It is never written to the database, so a copied
        # friday.db can never leak a provider credential.
        self.storage.upsert_model(model.public())
        return model

    def unregister(self, model_id: str) -> bool:
        return self._models.pop(model_id, None) is not None

    def sync(self, specs: list[dict]) -> dict:
        """Idempotently replace the auto-detected catalogue.

        Models the desktop still sees are registered/updated; auto-detected
        models that disappeared are dropped. Manually added models (no
        ``auto`` flag in options) are never touched.
        """
        seen: set[str] = set()
        for spec in specs or []:
            data = self._coerce(spec)
            data.setdefault("options", {})
            data["options"] = {**data["options"], "auto": True}
            self.register(data)
            seen.add(data["id"])
        removed = [
            mid
            for mid, m in list(self._models.items())
            if m.options.get("auto") and mid not in seen
        ]
        for mid in removed:
            self._models.pop(mid, None)
        return {"registered": len(seen), "removed": removed, "total": len(self._models)}

    @staticmethod
    def can_chat(model: "Model") -> bool:
        """An embedding or speech model must never be picked to answer."""
        caps = model.options.get("capabilities")
        if isinstance(caps, dict) and caps.get("chat") is False:
            return False
        return model.role != "embed"

    def by_role(self, role: str) -> Model | None:
        for m in self._models.values():
            if m.role == role and m.status == "ready" and self.can_chat(m) and self.spendable(m):
                return m
        return None


    def best_available(self, role: str = "brain") -> Model | None:
        """Auto mode inside the kernel: score ready models, never spend on its own.

        Ranking (FRIDAY remains the owner; models are interchangeable specialists):
        role match, local/privacy, measured reliability if present, larger context.
        Identity in the prompt is still FRIDAY regardless of which backend wins.
        """
        ready = [
            m
            for m in self._models.values()
            if m.status == "ready" and self.can_chat(m) and self.spendable(m)
        ]
        if not ready:
            return None

        def score(model: "Model") -> tuple:
            options = model.options if isinstance(model.options, dict) else {}
            reliability = 0.0
            raw = options.get("reliability")
            if isinstance(raw, (int, float)):
                reliability = float(raw)
            latency = float(options.get("avg_ms") or options.get("latency_ms") or 0)
            latency_score = (1.0 / latency) if latency > 0 else 0.0
            return (
                1 if model.role == role else 0,
                1 if is_local_model(model) else 0,
                reliability,
                latency_score,
                int(model.context_k or 0),
                min(float(options.get("wins") or 0), 5.0),
            )

        ready.sort(key=score, reverse=True)
        return ready[0]

    def _kind(self, model: "Model") -> str:
        options = model.options if isinstance(model.options, dict) else {}
        kind = str(options.get("type") or "").lower()
        if kind == "local" or str(model.provider or "").lower() in {
            "ollama",
            "lmstudio",
            "llamacpp",
            "vllm",
            "localai",
            "jan",
            "mlx",
            "local",
        }:
            return "local"
        return "cloud"

    def _access(self, model: "Model") -> str:
        if self._kind(model) == "local":
            return "free"
        options = model.options if isinstance(model.options, dict) else {}
        record = options.get("accessRecord")
        if isinstance(record, dict):
            return billing.billing_class(model)
        access = str(options.get("access") or "").lower()
        return access if access in ("free", "paid", "unknown") else "unknown"

    @staticmethod
    def explain_unavailable(live: dict | None) -> str:
        """Same honest empty-pool copy the desktop router uses for the phone."""
        data = live if isinstance(live, dict) else {}
        mode = str(data.get("routeMode") or "auto")
        policy = str(data.get("policy") or "free-preferred")
        picked = [str(x) for x in (data.get("selected") or []) if x]
        if mode == "local-only" and policy == "paid-only":
            return (
                "No paid local models exist — local models are always free.\n"
                "Turn off Paid-only, or switch off Local-only so a paid cloud model can be used."
            )
        if policy == "paid-only":
            return (
                "No paid model is eligible right now. Connect a paid cloud provider in Models, "
                "or switch off Paid-only."
            )
        if mode == "cloud-only" and policy == "free-only":
            return (
                "Cloud-only + Free-only: no verified free cloud model is eligible. "
                "Connect a provider whose API models are proven free, or change route or cost mode."
            )
        if mode in ("local-only", "cloud-only") and picked:
            return (
                f"None of the models you picked are eligible under {mode} with the current "
                "cost mode. Change the selection, or change Local-only / Cloud-only / cost mode."
            )
        return "No ready AI model is configured. Open Models and assign a brain model."

    def ids_for_live(self, live: dict | None) -> list[str] | None:
        """Eligible ids under the desktop's published route + cost snapshot.

        None means the live file has not published routing yet, so callers must
        fail closed instead of widening to the kernel's independent model pool.
        An empty list means honestly nothing matches.
        """
        if not isinstance(live, dict):
            return None
        if not live.get("routeMode") and not live.get("policy") and not live.get("selected"):
            return None
        mode = str(live.get("routeMode") or "auto")
        policy = str(live.get("policy") or "free-preferred")
        selected = [str(x) for x in (live.get("selected") or []) if x]
        cooling = {str(x) for x in (live.get("coolingModelIds") or []) if x}
        if mode == "local-only":
            kinds = {"local"}
        elif mode == "cloud-only":
            kinds = {"cloud"}
        else:
            kinds = {"local", "cloud"}
        exclusive = mode in ("manual", "multi") or (
            mode in ("local-only", "cloud-only") and bool(selected)
        )
        out: list[str] = []
        for model in self._models.values():
            if model.status != "ready" or not self.can_chat(model):
                continue
            if model.id in cooling:
                continue
            if self._kind(model) not in kinds:
                continue
            if str(live.get("privacy") or "").lower() == "private" and self._kind(model) != "local":
                continue
            access = self._access(model)
            if policy == "paid-only":
                if access != "paid":
                    continue
            elif policy != "allow-paid" and access in ("paid", "unknown"):
                continue
            if exclusive and selected:
                if not any(sel == model.id or sel in model.id or model.id.endswith(sel) for sel in selected):
                    continue
            picked = exclusive and selected and any(
                sel == model.id or sel in model.id for sel in selected
            )
            if not self.spendable(model, explicit_paid=bool(picked)):
                continue
            out.append(model.id)
        return out


    async def complete(
        self,
        model: Model,
        messages: list[dict],
        explicit_paid: bool = False,
        *,
        privacy_confirmed: bool = False,
    ) -> str:
        chunks = [
            c
            async for c in self._stream_one(
                model, messages, explicit_paid, privacy_confirmed=privacy_confirmed
            )
            if not (isinstance(c, str) and c.startswith(TOOL_NOTICE))
        ]
        return "".join(chunks)

    async def stream(
        self,
        prompt: str,
        model_ids: list[str] | None = None,
        allow_fallback: bool = True,
        system: str | None = None,
        context: list[dict] | None = None,
        explicit_paid: bool = False,
        privacy_confirmed: bool = False,
        parallel: bool | None = None,
        route_mode: str | None = None,
        privacy: str | None = None,
    ) -> AsyncIterator[dict]:
        """Fan out to the chosen models, or auto-select with ordered fallback."""
        norm_mode = str(route_mode).strip().lower() if route_mode else None
        privacy_mode = str(privacy or "").strip().lower()
        if norm_mode == "manual":
            allow_fallback = False

        targets = [self._models[i] for i in (model_ids or []) if i in self._models]
        if norm_mode == "local-only":
            targets = [m for m in targets if is_local_model(m)]
        elif norm_mode == "cloud-only":
            targets = [m for m in targets if not is_local_model(m)]
        if privacy_mode == "private":
            targets = [m for m in targets if is_local_model(m)]

        auto = not targets
        if auto:
            best = self.best_available("brain")
            if best:
                if norm_mode == "local-only" and not is_local_model(best):
                    best = next((m for m in self._models.values() if m.status == "ready" and is_local_model(m) and self.can_chat(m)), None)
                elif norm_mode == "cloud-only" and is_local_model(best):
                    best = next((m for m in self._models.values() if m.status == "ready" and not is_local_model(m) and self.can_chat(m)), None)
                elif privacy_mode == "private" and norm_mode != "cloud-only" and not is_local_model(best):
                    best = next((m for m in self._models.values() if m.status == "ready" and is_local_model(m) and self.can_chat(m)), None)
            targets = [best] if best else []
        if privacy_mode == "private":
            targets = [m for m in targets if is_local_model(m)]
        # Whatever else is ready always backs the chosen model(s) up, so a
        # provider outage or a bad key never leaves the owner without an answer.
        # The desktop router already decided which models are eligible (free
        # first, paid blocked, cooling-down models removed). When it says so,
        # the kernel must not widen that list on its own.
        fallbacks = (
            [
                m
                for m in self._models.values()
                if m.status == "ready"
                and self.can_chat(m)
                and m not in targets
                and self.spendable(m)
                and (norm_mode != "local-only" or is_local_model(m))
                and (norm_mode != "cloud-only" or not is_local_model(m))
                and (privacy_mode != "private" or is_local_model(m))
            ]
            if allow_fallback
            else []
        )

        if not targets:
            if privacy_mode == "private" and norm_mode == "cloud-only":
                yield {
                    "error": (
                        "Private routing keeps the prompt on this PC, and cloud-only "
                        "allows only cloud models, so nothing is eligible."
                    )
                }
            elif privacy_mode == "private":
                yield {
                    "error": "Private routing keeps the prompt on this PC, and no local model is ready."
                }
            else:
                yield {"error": "No ready AI model is configured. Open Models and assign a brain model."}
            return

        messages: list[dict] = []
        # FRIDAY's own identity always leads, whichever model answers.
        messages.append({"role": "system", "content": friday_persona()})
        if system:
            messages.append({"role": "system", "content": system})
        if context:
            recalled = "\n".join(f"- {c['title']}: {c['snippet']}" for c in context)
            messages.append({"role": "system", "content": f"Relevant memory:\n{recalled}"})
        messages.append({"role": "user", "content": prompt})

        _turn_debug("router.stream", extra=f"targets={len(targets)}")

        # Auto mode: try the best model, then the next candidate if it fails
        # before producing a single token. The UI reports which one answered.
        if auto or len(targets) == 1 or parallel is False:
            attempts: list[str] = []
            for model in [*targets, *fallbacks]:
                produced = False
                try:
                    async for delta in self._stream_one(
                        model,
                        messages,
                        explicit_paid and model in targets,
                        privacy_confirmed=privacy_confirmed,
                    ):
                        piece = fold_stream_piece(model.id, delta)
                        if piece and piece.get("tool") and not piece.get("delta"):
                            yield piece
                            continue
                        produced = True
                        if piece:
                            yield piece
                except Exception as exc:  # noqa: BLE001 — reported to the UI verbatim
                    failure = describe_failure(model, exc)
                    attempts.append(failure)
                    if produced:
                        yield {"modelId": model.id, "error": failure}
                        return
                    continue
                if produced:
                    return
            # Every route failed. Report ALL of them, not just the last one:
            # "the cloud model hit a DNS error" and "no local model was ready"
            # are different problems and the owner must see both.
            yield {"error": _no_route_error(attempts, [*targets, *fallbacks])}
            return


        queue: asyncio.Queue = asyncio.Queue()

        async def pump(model: Model) -> None:
            try:
                async for delta in self._stream_one(
                        model,
                        messages,
                        explicit_paid and model in targets,
                        privacy_confirmed=privacy_confirmed,
                    ):
                    piece = fold_stream_piece(model.id, delta)
                    if piece and piece.get("tool") and not piece.get("delta"):
                        await queue.put(piece)
                        continue
                    if piece:
                        await queue.put(piece)
                    elif delta:
                        await queue.put({"modelId": model.id, "delta": delta})
            except Exception as exc:
                await queue.put({"modelId": model.id, "error": describe_failure(model, exc)})
            finally:
                await queue.put({"modelId": model.id, "done": True})

        tasks = [asyncio.create_task(pump(m)) for m in targets]
        remaining = len(tasks)
        produced_any = False
        errors: list[str] = []
        while remaining:
            item = await queue.get()
            if item.get("done"):
                remaining -= 1
                continue
            if item.get("delta"):
                produced_any = True
            if item.get("error"):
                errors.append(item["error"])
            yield item
        await asyncio.gather(*tasks, return_exceptions=True)
        if not produced_any:
            # Every selected model failed — try the rest before giving up.
            for model in fallbacks:
                produced = False
                try:
                    async for delta in self._stream_one(
                        model,
                        messages,
                        explicit_paid and model in targets,
                        privacy_confirmed=privacy_confirmed,
                    ):
                        piece = fold_stream_piece(model.id, delta)
                        if piece and piece.get("tool") and not piece.get("delta"):
                            yield piece
                            continue
                        produced = True
                        if piece:
                            yield piece
                except Exception as exc:  # noqa: BLE001
                    errors.append(describe_failure(model, exc))
                    continue
                if produced:
                    return
            yield {"error": _no_route_error(errors, [*targets, *fallbacks])}


    async def _stream_one(
        self,
        model: Model,
        messages: list[dict],
        explicit_paid: bool = False,
        *,
        privacy_confirmed: bool = False,
    ) -> AsyncIterator[str]:
        # FINAL PRIVACY FIREWALL (mirrors electron/privacy-firewall.cjs).
        # Privacy outranks cost: SENSITIVE content never leaves without a
        # fresh owner yes. Local inference is not gated.
        content = privacy.user_content(messages)
        privacy_decision = privacy.guard_egress(model, content, connected=True)
        if privacy_decision.get("requiresConfirmation") and not privacy_confirmed:
            ask = self.on_privacy_ask
            allowed = False
            if callable(ask):
                try:
                    result = ask(model, content, privacy_decision)
                    if asyncio.iscoroutine(result):
                        result = await result
                    allowed = bool(result)
                except Exception:  # noqa: BLE001 — fail closed
                    allowed = False
            if not allowed:
                raise privacy.PrivacyBlocked(privacy.describe_block(privacy_decision, model))
        # FINAL BILLING FIREWALL. Every kernel path — chat, planner, agents,
        # companion, background work — funnels through here, so nothing can
        # reach a provider without passing the owner's billing policy.
        # The check and the one-shot grant spend happen under one lock so two
        # concurrent requests can never share a single "this request" unlock.
        async with self._billing_lock:
            verdict = self.guard(model, explicit_paid)
            if not verdict.get("allowed"):
                raise billing.BillingBlocked(billing.describe_block(verdict, model))
            if verdict.get("billingClass") != "free":
                spent = billing.consume_grant(self._billing)
                if spent != self._billing:
                    self._billing = spent
                    self._on_billing_spent(spent)
        # Explicit dispatch through PROVIDER_SURFACES: the provider decides its
        # handler by table lookup, never by "whatever is left over".
        wire = wire_for(model.provider)
        handler = {
            "ollama": self._stream_ollama,
            "anthropic": self._stream_anthropic,
            "openai": self._stream_openai,
        }[wire]
        async for chunk in handler(model, messages):
            yield chunk


    async def _stream_anthropic(self, model: Model, messages: list[dict]) -> AsyncIterator[str]:
        """Anthropic Messages API — its own wire format, streamed."""
        import json as _json

        system = "\n".join(m["content"] for m in messages if m["role"] == "system")
        turns = [m for m in messages if m["role"] != "system"]
        headers = {
            "content-type": "application/json",
            "x-api-key": model.api_key or "",
            "anthropic-version": "2023-06-01",
        }
        url = model.endpoint.rstrip("/") + "/messages"
        # Anthropic declares tools with a flat input_schema instead of the
        # OpenAI function envelope, so the shared schemas are re-shaped here.
        tools = [
            {
                "name": t["function"]["name"],
                "description": t["function"]["description"],
                "input_schema": t["function"]["parameters"],
            }
            for t in self._model_tools(model)
        ]
        convo = list(turns)
        tool_budget_t0: float | None = None
        for _round in range(4):
            body = {
                "model": model.options.get("model", model.id),
                "max_tokens": 2048,
                "stream": True,
                "messages": convo,
            }
            if system:
                body["system"] = system
            if tools:
                body["tools"] = tools
            blocks: dict[int, dict] = {}
            answered = False
            # nullcontext keeps the shared client alive across requests: unlike
            # `async with httpx.AsyncClient(...)`, it must not be closed here.
            async with nullcontext(_client()) as client:
                async with client.stream("POST", url, json=body, headers=headers) as resp:
                    await _raise_with_body(resp)
                    async for line in resp.aiter_lines():
                        if not line.startswith("data: "):
                            continue
                        payload = _json.loads(line[6:])
                        kind = payload.get("type")
                        index = int(payload.get("index", 0))
                        if kind == "content_block_start":
                            block = payload.get("content_block") or {}
                            if block.get("type") == "tool_use":
                                blocks[index] = {
                                    "id": block.get("id", ""),
                                    "name": block.get("name", ""),
                                    "arguments": "",
                                }
                        elif kind == "content_block_delta":
                            delta = payload.get("delta", {})
                            text = delta.get("text")
                            if text:
                                answered = True
                                yield text
                            partial = delta.get("partial_json")
                            if partial is not None and index in blocks:
                                blocks[index]["arguments"] += partial
            if not blocks:
                return
            requested = [blocks[i] for i in sorted(blocks)]
            convo.append(
                {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_use",
                            "id": call["id"],
                            "name": call["name"],
                            "input": _json.loads(call["arguments"] or "{}"),
                        }
                        for call in requested
                    ],
                }
            )
            if tool_budget_t0 is None:
                tool_budget_t0 = time.perf_counter()
            payloads, exhausted = await self._tool_payloads(requested, tool_budget_t0)
            convo.append(
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": call["id"],
                            "content": payloads[n],
                        }
                        for n, call in enumerate(requested)
                    ],
                }
            )
            if exhausted:
                tools = []
            if answered:
                yield "\n"


    def _model_tools(self, model: Model) -> list[dict]:
        """The read-only tools this model may call, or [] when unavailable."""
        registry = self.tools
        if registry is None or model.options.get("tools") is False:
            return []
        try:
            return registry.model_schemas()
        except Exception:  # noqa: BLE001 — a tool problem never breaks chat
            return []

    async def _run_model_tool(self, name: str, raw_args: str) -> str:
        """Execute one model-requested tool and return its JSON result."""
        import json as _json

        t0 = time.perf_counter()
        _turn_debug("model_tool", extra=str(name))
        try:
            args = _json.loads(raw_args or "{}")
        except ValueError:
            args = {}
        if self.tools is None:
            result = {"ok": False, "error": "tools are not available in this kernel"}
        else:
            try:
                result = await asyncio.wait_for(
                    self.tools.execute_for_model(name, args),
                    timeout=MODEL_TOOL_TIMEOUT_SECONDS,
                )
            except asyncio.TimeoutError:
                result = {
                    "ok": False,
                    "error": (
                        f"{name} timed out after {MODEL_TOOL_TIMEOUT_SECONDS:.0f}s "
                        "— continuing without it"
                    ),
                }
            except Exception as exc:  # noqa: BLE001 — reported back to the model
                result = {"ok": False, "error": str(exc)}
        payload = _json.dumps(result)[:20_000]
        _turn_debug("model_tool", ms=(time.perf_counter() - t0) * 1000, extra=str(name))
        return payload

    async def _tool_payloads(self, requested: list[dict], budget_t0: float) -> tuple[list[str], bool]:
        """Run requested tools until the per-turn budget is gone."""
        import json as _json

        payloads: list[str] = []
        exhausted = False
        for call in requested:
            remaining = MODEL_TOOL_BUDGET_SECONDS - (time.perf_counter() - budget_t0)
            if remaining <= 0:
                exhausted = True
                payloads.append(
                    _json.dumps(
                        {
                            "ok": False,
                            "error": (
                                "tool time budget exhausted — answer from the "
                                "context you already have"
                            ),
                        }
                    )
                )
                continue
            payloads.append(await self._run_model_tool(call["name"], call["arguments"]))
            if time.perf_counter() - budget_t0 >= MODEL_TOOL_BUDGET_SECONDS:
                exhausted = True
        return payloads, exhausted

    async def _stream_openai(self, model: Model, messages: list[dict]) -> AsyncIterator[str]:
        import json as _json

        headers = {"Content-Type": "application/json"}
        if model.api_key:
            headers["Authorization"] = f"Bearer {model.api_key}"
        # A provider may pin its own path (Perplexity serves it off the root);
        # otherwise the shared builder appends the chat path without ever
        # duplicating an API-version segment.
        base = model.endpoint.rstrip("/") or (
            PROVIDER_SURFACES.get(str(model.provider).lower(), {}).get("base") or ""
        )
        url = openai_chat_url(base, model.options.get("chat_path"))

        tools = self._model_tools(model)
        # Each model gets its own copy: `messages` is shared by every model in
        # a multi-model turn, so tool results must never leak between them.
        convo = list(messages)
        tool_budget_t0: float | None = None
        # Bounded so a model that keeps asking for tools still finishes.
        for _round in range(4):
            round_t0 = time.perf_counter()
            _turn_debug("openai.round", extra=str(_round))
            body = {
                "model": model.options.get("model", model.id),
                "messages": convo,
                "stream": True,
            }
            if tools:
                body["tools"] = tools
            calls: dict[int, dict] = {}
            answered = False
            attempt = 0
            while True:
                try:
                    # nullcontext keeps the shared client alive across requests.
                    async with nullcontext(_client()) as client:
                        async with client.stream("POST", url, json=body, headers=headers) as resp:
                            await _raise_with_body(resp)
                            async for line in resp.aiter_lines():
                                if not line.startswith("data: "):
                                    continue
                                payload = line[6:]
                                if payload.strip() == "[DONE]":
                                    break
                                try:
                                    frame = _json.loads(payload)
                                except ValueError:
                                    continue
                                problem = frame.get("error")
                                if problem:
                                    raise RuntimeError(_frame_error(model, problem))
                                delta = openai_frame_text(frame)
                                piece = ((frame.get("choices") or [{}])[0].get("delta") or {})
                                for call in piece.get("tool_calls") or []:
                                    slot = calls.setdefault(
                                        int(call.get("index", 0)),
                                        {"id": "", "name": "", "arguments": ""},
                                    )
                                    if call.get("id"):
                                        slot["id"] = call["id"]
                                    fn = call.get("function") or {}
                                    if fn.get("name"):
                                        slot["name"] = fn["name"]
                                    if fn.get("arguments"):
                                        slot["arguments"] += fn["arguments"]
                                if delta:
                                    if not answered:
                                        _turn_debug(
                                            "openai.first_token",
                                            ms=(time.perf_counter() - round_t0) * 1000,
                                            extra=model.id,
                                        )
                                    answered = True
                                    yield delta
                    break
                except Exception as exc:
                    if answered or attempt >= 1 or not is_transient_http(exc):
                        raise
                    attempt += 1
                    await asyncio.sleep(1.5)
            _turn_debug(
                "openai.round",
                ms=(time.perf_counter() - round_t0) * 1000,
                extra=f"{_round} tools={len(calls)}",
            )
            if not calls:
                return
            # The model asked for tools: run them, feed the results back and
            # let it continue the same answer in the next round.
            requested = [calls[i] for i in sorted(calls)]
            convo.append(
                {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": c["id"] or f"call_{n}",
                            "type": "function",
                            "function": {"name": c["name"], "arguments": c["arguments"] or "{}"},
                        }
                        for n, c in enumerate(requested)
                    ],
                }
            )
            if tool_budget_t0 is None:
                tool_budget_t0 = time.perf_counter()
            payloads, exhausted = await self._tool_payloads(requested, tool_budget_t0)
            for n, call in enumerate(requested):
                convo.append(
                    {
                        "role": "tool",
                        "tool_call_id": call["id"] or f"call_{n}",
                        "content": payloads[n],
                    }
                )
            if exhausted:
                tools = []
            if answered:
                yield "\n"

    async def _stream_ollama(self, model: Model, messages: list[dict]) -> AsyncIterator[str]:
        """Ollama /api/chat, including the same read-only tool loop as the other wires.

        Thinking stays on the provider. A tool notice uses TOOL_NOTICE so the
        desktop can show it without writing it into the answer.
        """
        import json as _json

        url = model.endpoint.rstrip("/") + "/api/chat"
        tools = self._model_tools(model)
        # Each model gets its own copy: `messages` is shared by every model in
        # a multi-model turn, so tool results must never leak between them.
        convo = list(messages)
        tool_budget_t0: float | None = None
        for _round in range(4):
            body: dict = {
                "model": model.options.get("model", model.id),
                "messages": convo,
                "stream": True,
            }
            if tools:
                body["tools"] = tools
            content_parts: list[str] = []
            raw_calls: list = []
            answered = False
            # nullcontext keeps the shared client alive across requests: unlike
            # `async with httpx.AsyncClient(...)`, it must not be closed here.
            async with nullcontext(_client()) as client:
                async with client.stream("POST", url, json=body) as resp:
                    await _raise_with_body(resp)
                    async for line in resp.aiter_lines():
                        if not line.strip():
                            continue
                        try:
                            data = _json.loads(line)
                        except ValueError:
                            continue
                        if not isinstance(data, dict):
                            continue
                        problem = data.get("error")
                        if problem:
                            raise RuntimeError(str(problem))
                        message = data.get("message") or {}
                        if not isinstance(message, dict):
                            continue
                        # `thinking` is the model's private trace. Never the reply.
                        text = coerce_stream_text(message.get("content"))
                        if text:
                            answered = True
                            content_parts.append(text)
                            yield text
                        for call in message.get("tool_calls") or []:
                            if isinstance(call, dict):
                                raw_calls.append(call)
            calls = ollama_calls_from_message({"tool_calls": raw_calls})
            if not calls:
                return
            for call in calls:
                yield f"{TOOL_NOTICE}{call['name']}"
            convo.append(
                {
                    "role": "assistant",
                    "content": "".join(content_parts),
                    "tool_calls": [
                        {
                            "type": "function",
                            "function": {
                                "index": n,
                                "name": call["name"],
                                "arguments": call["arguments"],
                            },
                        }
                        for n, call in enumerate(calls)
                    ],
                }
            )
            requested = [
                {"name": call["name"], "arguments": _json.dumps(call["arguments"])}
                for call in calls
            ]
            if tool_budget_t0 is None:
                tool_budget_t0 = time.perf_counter()
            payloads, exhausted = await self._tool_payloads(requested, tool_budget_t0)
            for call, payload in zip(calls, payloads):
                convo.append(
                    {
                        "role": "tool",
                        "tool_name": call["name"],
                        "content": payload,
                    }
                )
            if exhausted:
                tools = []
            if answered:
                yield "\n"
