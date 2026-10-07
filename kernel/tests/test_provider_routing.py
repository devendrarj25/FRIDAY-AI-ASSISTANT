"""
Provider dispatch contract.

The Gemini bug: the router's stream() dispatch only branched on "ollama" and
"anthropic", so every other provider fell into the generic OpenAI handler,
which appended "/v1/chat/completions" to any base that did not already end in
"/v1". Gemini's base ends in "/v1beta/openai", so the outgoing URL became
.../v1beta/openai/v1/chat/completions — a URL that does not exist, while the
key check (which uses the correct surface) still reported "connected".

These tests pin the real URL for every provider FRIDAY can route to.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import router  # noqa: E402


REFERENCE = {
    "openai": "https://api.openai.com/v1/chat/completions",
    "anthropic": "https://api.anthropic.com/v1/messages",
    "gemini": "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    "groq": "https://api.groq.com/openai/v1/chat/completions",
    "openrouter": "https://openrouter.ai/api/v1/chat/completions",
    "deepseek": "https://api.deepseek.com/v1/chat/completions",
    "mistral": "https://api.mistral.ai/v1/chat/completions",
    "together": "https://api.together.ai/v1/chat/completions",
    "cohere": "https://api.cohere.ai/compatibility/v1/chat/completions",
    "perplexity": "https://api.perplexity.ai/chat/completions",
    "xai": "https://api.x.ai/v1/chat/completions",
    "nvidia": "https://integrate.api.nvidia.com/v1/chat/completions",
    "fireworks": "https://api.fireworks.ai/inference/v1/chat/completions",
    "deepinfra": "https://api.deepinfra.com/v1/openai/chat/completions",
    "cerebras": "https://api.cerebras.ai/v1/chat/completions",
    "huggingface": "https://router.huggingface.co/v1/chat/completions",
    "sambanova": "https://api.sambanova.ai/v1/chat/completions",
    "moonshot": "https://api.moonshot.ai/v1/chat/completions",
    "zhipu": "https://api.z.ai/api/paas/v4/chat/completions",
    "nebius": "https://api.tokenfactory.nebius.com/v1/chat/completions",
}


def test_gemini_url_is_the_openai_compatible_surface():
    base = "https://generativelanguage.googleapis.com/v1beta/openai"
    url = router.openai_chat_url(base)
    assert url == REFERENCE["gemini"]
    assert "/v1beta/v1/" not in url
    assert "/openai/v1/chat" not in url


def test_gemini_native_base_never_gets_a_v1_appended_blindly():
    # If anything ever registers the native surface again, it must not silently
    # become a fake ".../v1beta/v1/chat/completions" URL.
    url = router.openai_chat_url("https://generativelanguage.googleapis.com/v1beta")
    assert url != "https://generativelanguage.googleapis.com/v1beta/v1/chat/completions"


def test_every_provider_has_an_explicit_dispatch_path():
    for provider, expected in REFERENCE.items():
        assert provider in router.PROVIDER_SURFACES, f"{provider} has no dispatch entry"
        assert router.expected_chat_url(provider) == expected, provider


def test_wire_handlers_are_explicit():
    assert router.wire_for("anthropic") == "anthropic"
    assert router.wire_for("ollama") == "ollama"
    assert router.wire_for("gemini") == "openai"
    assert router.wire_for("perplexity") == "openai"


def test_pinned_chat_path_wins():
    assert (
        router.openai_chat_url("https://api.perplexity.ai", "/chat/completions")
        == REFERENCE["perplexity"]
    )


def test_plain_host_still_gets_the_v1_default():
    assert (
        router.openai_chat_url("https://my-gateway.local")
        == "https://my-gateway.local/v1/chat/completions"
    )
