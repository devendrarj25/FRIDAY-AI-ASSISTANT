"""Embedding-model reranking through the owner's local Ollama.

The built-in memory index uses hashed n-grams, which is offline and stable but shallow. When the owner has an
embedding model pulled in Ollama (``bge-m3`` is FRIDAY's default assignment) this module asks it for vectors and
re-orders a short list of already-found candidates by cosine similarity. It only ever talks to the loopback
Ollama, sends nothing anywhere else, and fails soft: when Ollama or the model is missing it says so and the
original order stands. A failure is remembered for a minute so a missing model costs one try, not one per search.

This is a bi-encoder re-order, not a cross-encoder. Whether it improves recall on the owner's data is measured
by the ``retrieval-accuracy`` category, not assumed.
"""

from __future__ import annotations

import math
import time

import httpx

BASE = "http://127.0.0.1:11434"
DEFAULT_MODEL = "bge-m3"
_RETRY_AFTER = 60.0
_failed_until = 0.0
MAX_TEXTS = 40
MAX_CHARS = 1500


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=False))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def reset() -> None:
    global _failed_until
    _failed_until = 0.0


async def rank(query: str, texts: list[str], model: str = "", base: str = BASE) -> dict:
    """Similarity of each text to the query, in the order given, or ``{"ok": False, "reason": ...}``."""
    global _failed_until
    if time.monotonic() < _failed_until:
        return {"ok": False, "reason": "the embedding model was unavailable a moment ago"}
    if not query.strip() or not texts:
        return {"ok": False, "reason": "nothing to rank"}
    if not base.startswith(("http://127.0.0.1", "http://localhost")):
        return {"ok": False, "reason": "embeddings are only requested from a model on this PC"}
    wanted = (model or DEFAULT_MODEL).strip()
    batch = [query[:MAX_CHARS], *[text[:MAX_CHARS] for text in texts[:MAX_TEXTS]]]
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.post(f"{base}/api/embed", json={"model": wanted, "input": batch})
        if resp.status_code != 200:
            raise RuntimeError(f"HTTP {resp.status_code}")
        vectors = resp.json().get("embeddings")
        if not isinstance(vectors, list) or len(vectors) != len(batch):
            raise RuntimeError("unexpected answer")
    except Exception as exc:
        _failed_until = time.monotonic() + _RETRY_AFTER
        return {"ok": False, "reason": f"embedding model {wanted} did not answer ({type(exc).__name__})"}
    head, rest = vectors[0], vectors[1:]
    return {"ok": True, "model": wanted, "scores": [round(_cosine(head, vec), 6) for vec in rest]}
