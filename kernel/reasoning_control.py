"""Steer how much a model thinks, in the field its provider actually takes.

The desktop resolves one control per model (``reasoningControl`` in the capability record, see
``electron/model-capabilities.cjs``) and the turn carries a requested effort. This module turns the pair
into request fields for each wire, and keeps the pieces a provider needs back across tool turns.

* ``effort``           Claude 4.6 and later (adaptive thinking plus an effort level), OpenAI o-series and gpt-5
                       (``reasoning_effort``), gpt-oss on Ollama (``think`` level).
* ``budget``           Older Claude models: ``thinking`` with a token budget (minimum 1,024, below ``max_tokens``).
* ``enable_thinking``  Qwen3: on or off. On an OpenAI-compatible server this is a chat-template switch, on
                       Ollama it is ``think``.
* ``always`` / ``none``  The model reasons by itself (R1 family) or has no control: nothing is sent.

A model whose record says ``none`` gets exactly the request it got before this module existed. The Ollama
``think`` field and the ``chat_template_kwargs`` field are the documented shapes for those servers but were not
checked against a live server in this session.

Thinking text is never answer text and is never stored. It is kept only for the rest of the same turn, when the
record says the provider needs it back across tool calls.
"""

from __future__ import annotations

from dataclasses import dataclass

EFFORTS = ("low", "medium", "high")
CONTROLS = ("effort", "budget", "enable_thinking", "always", "none")
_BUDGET_BY_EFFORT = {"low": 1024, "medium": 4096, "high": 16000}
MIN_BUDGET = 1024


@dataclass(frozen=True)
class Spec:
    control: str
    effort: str
    budget: int
    keep: bool

    @property
    def active(self) -> bool:
        return self.control in {"effort", "budget", "enable_thinking"}


NONE = Spec("none", "medium", 0, False)


def spec_for(options: dict | None, requested: str | None) -> Spec:
    """The control for this model and this turn. Anything unknown or malformed is ``none``."""
    caps = (options or {}).get("capabilities")
    raw = caps.get("reasoningControl") if isinstance(caps, dict) else None
    if not isinstance(raw, dict):
        raw = (
            (options or {}).get("reasoningControl")
            if isinstance((options or {}).get("reasoningControl"), dict)
            else None
        )
    if not isinstance(raw, dict):
        return NONE
    control = str(raw.get("control") or "none")
    if control not in CONTROLS:
        return NONE
    effort = str(requested or raw.get("effort") or "medium").lower()
    if effort not in EFFORTS:
        effort = "medium"
    try:
        budget = int(raw.get("budget") or _BUDGET_BY_EFFORT[effort])
    except (TypeError, ValueError):
        budget = _BUDGET_BY_EFFORT[effort]
    return Spec(control, effort, max(MIN_BUDGET, budget), bool(raw.get("keepAcrossToolTurns")))


def anthropic_fields(spec: Spec, body: dict) -> dict:
    """Add the thinking fields to a Messages API body. ``max_tokens`` is raised so a budget fits under it."""
    if spec.control == "effort":
        body["thinking"] = {"type": "adaptive"}
        body["output_config"] = {"effort": spec.effort}
        # Thinking shares the output limit, so the answer must still have room after it.
        body["max_tokens"] = max(int(body.get("max_tokens") or 0), _BUDGET_BY_EFFORT[spec.effort] + 2048)
    elif spec.control == "budget":
        body["thinking"] = {"type": "enabled", "budget_tokens": spec.budget}
        body["max_tokens"] = max(int(body.get("max_tokens") or 0), spec.budget + 2048)
    return body


def openai_fields(spec: Spec, body: dict) -> dict:
    if spec.control == "effort":
        body["reasoning_effort"] = spec.effort
    elif spec.control == "enable_thinking":
        body["chat_template_kwargs"] = {"enable_thinking": spec.effort != "low"}
    return body


def ollama_fields(spec: Spec, body: dict) -> dict:
    if spec.control == "effort":
        body["think"] = spec.effort
    elif spec.control == "enable_thinking":
        body["think"] = spec.effort != "low"
    return body


class ThinkingKeeper:
    """Collects the thinking a provider needs back on the next tool round of the same turn."""

    def __init__(self) -> None:
        self.blocks: dict[int, dict] = {}
        self.text: list[str] = []

    # Anthropic stream events -------------------------------------------------
    def anthropic_start(self, index: int, block: dict) -> None:
        kind = block.get("type")
        if kind == "thinking":
            self.blocks[index] = {"type": "thinking", "thinking": "", "signature": ""}
        elif kind == "redacted_thinking":
            self.blocks[index] = {"type": "redacted_thinking", "data": block.get("data", "")}

    def anthropic_delta(self, index: int, delta: dict) -> None:
        block = self.blocks.get(index)
        if not block:
            return
        if delta.get("type") == "thinking_delta":
            block["thinking"] += str(delta.get("thinking") or "")
        elif delta.get("type") == "signature_delta":
            block["signature"] = str(delta.get("signature") or "")

    def anthropic_blocks(self) -> list[dict]:
        return [self.blocks[i] for i in sorted(self.blocks)]

    # OpenAI-compatible stream frames -----------------------------------------
    def openai_piece(self, piece: dict) -> None:
        text = piece.get("reasoning_content") or piece.get("reasoning")
        if isinstance(text, str) and text:
            self.text.append(text)

    def openai_text(self) -> str:
        return "".join(self.text)
