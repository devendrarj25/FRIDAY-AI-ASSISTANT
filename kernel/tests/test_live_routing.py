"""Phone routing must honour the desktop live snapshot (route + cost + picks)."""

from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from router import Model, ModelRouter  # noqa: E402


class Store:
    def models(self):
        return []

    def upsert_model(self, _row):
        return None


def make_router() -> ModelRouter:
    router = ModelRouter(Store())
    specs = [
        ("ollama:llama3.1", "ollama", "http://127.0.0.1:11434", "local", "free"),
        ("ollama:qwen2.5", "ollama", "http://127.0.0.1:11434", "local", "free"),
        ("gemini:gemini-2.0-flash", "gemini", "https://generativelanguage.googleapis.com", "cloud", "free"),
        ("groq:llama-3.3-70b", "groq", "https://api.groq.com", "cloud", "free"),
        ("openai:gpt-4o", "openai", "https://api.openai.com/v1", "cloud", "paid"),
    ]
    for mid, provider, endpoint, kind, access in specs:
        router._models[mid] = Model(
            id=mid,
            label=mid,
            provider=provider,
            endpoint=endpoint,
            role="brain",
            options={"type": kind, "access": access},
        )
    return router


class LiveRoutingTests(unittest.TestCase):
    def test_paid_only_auto_keeps_only_paid_when_kernel_policy_matches(self):
        router = make_router()
        router.set_billing({"paidAccess": True, "autoPaidUsage": True}, "paid-only")
        ids = router.ids_for_live(
            {"routeMode": "auto", "policy": "paid-only", "selected": []}
        )
        self.assertEqual(ids, ["openai:gpt-4o"])

    def test_local_only_plus_paid_only_is_empty_and_explains(self):
        router = make_router()
        router.set_billing({"paidAccess": True, "autoPaidUsage": True}, "paid-only")
        live = {"routeMode": "local-only", "policy": "paid-only", "selected": []}
        self.assertEqual(router.ids_for_live(live), [])
        self.assertRegex(
            router.explain_unavailable(live),
            r"(?i)no paid local models exist",
        )

    def test_local_only_multi_select_stays_inside_the_picks(self):
        router = make_router()
        ids = router.ids_for_live(
            {
                "routeMode": "local-only",
                "policy": "free-preferred",
                "selected": ["ollama:llama3.1", "ollama:qwen2.5"],
            }
        )
        self.assertEqual(sorted(ids), ["ollama:llama3.1", "ollama:qwen2.5"])

    def test_cloud_only_multi_select_drops_local(self):
        router = make_router()
        ids = router.ids_for_live(
            {
                "routeMode": "cloud-only",
                "policy": "free-preferred",
                "selected": ["gemini:gemini-2.0-flash", "groq:llama-3.3-70b"],
            }
        )
        self.assertEqual(sorted(ids), ["gemini:gemini-2.0-flash", "groq:llama-3.3-70b"])

    def test_stale_kernel_policy_would_empty_paid_only_until_billing_set(self):
        """The bug Part B found: live says paid-only but kernel still free-preferred."""
        router = make_router()
        # Default kernel policy is free-preferred; paid is not spendable.
        ids = router.ids_for_live(
            {"routeMode": "auto", "policy": "paid-only", "selected": []}
        )
        self.assertEqual(ids, [])
        router.set_billing({"paidAccess": True, "autoPaidUsage": True}, "paid-only")
        self.assertEqual(
            router.ids_for_live({"routeMode": "auto", "policy": "paid-only", "selected": []}),
            ["openai:gpt-4o"],
        )

    def test_unpublished_live_state_is_not_permission_to_widen_the_pool(self):
        router = make_router()
        self.assertIsNone(router.ids_for_live(None))
        self.assertIsNone(router.ids_for_live({}))

    def test_desktop_cooldowns_are_removed_from_phone_routing(self):
        router = make_router()
        ids = router.ids_for_live(
            {
                "routeMode": "auto",
                "policy": "free-preferred",
                "selected": [],
                "coolingModelIds": ["ollama:llama3.1", "groq:llama-3.3-70b"],
            }
        )
        self.assertNotIn("ollama:llama3.1", ids)
        self.assertNotIn("groq:llama-3.3-70b", ids)
        self.assertIn("ollama:qwen2.5", ids)

    def test_non_multi_phone_route_retries_only_within_the_authorized_ids(self):
        router = make_router()
        attempted = []

        async def fake_stream(model, _messages, _explicit=False, **_kwargs):
            attempted.append(model.id)
            if model.id == "ollama:llama3.1":
                raise RuntimeError("first failed")
            yield "ok"

        router._stream_one = fake_stream

        async def run():
            return [
                event
                async for event in router.stream(
                    prompt="hello",
                    model_ids=["ollama:llama3.1", "ollama:qwen2.5"],
                    allow_fallback=False,
                    parallel=False,
                )
            ]

        events = asyncio.run(run())
        self.assertEqual(attempted, ["ollama:llama3.1", "ollama:qwen2.5"])
        self.assertEqual(events[-1].get("modelId"), "ollama:qwen2.5")
        self.assertEqual(events[-1].get("delta"), "ok")

    def test_stream_enforces_local_only_boundary(self):
        router = make_router()
        attempted = []

        async def fake_stream(model, _messages, _explicit=False, **_kwargs):
            attempted.append(model.id)
            yield "ok"

        router._stream_one = fake_stream

        async def run():
            return [
                event
                async for event in router.stream(
                    prompt="hello",
                    model_ids=["gemini:gemini-2.0-flash", "ollama:llama3.1"],
                    allow_fallback=True,
                    route_mode="local-only",
                )
            ]

        events = asyncio.run(run())
        # Cloud model "gemini:gemini-2.0-flash" must be filtered out by local-only
        self.assertEqual(attempted, ["ollama:llama3.1"])
        self.assertEqual(events[-1].get("modelId"), "ollama:llama3.1")

    def test_stream_enforces_cloud_only_boundary(self):
        router = make_router()
        attempted = []

        async def fake_stream(model, _messages, _explicit=False, **_kwargs):
            attempted.append(model.id)
            yield "ok"

        router._stream_one = fake_stream

        async def run():
            return [
                event
                async for event in router.stream(
                    prompt="hello",
                    model_ids=["ollama:llama3.1", "gemini:gemini-2.0-flash"],
                    allow_fallback=True,
                    route_mode="cloud-only",
                )
            ]

        events = asyncio.run(run())
        # Local model "ollama:llama3.1" must be filtered out by cloud-only
        self.assertEqual(attempted, ["gemini:gemini-2.0-flash"])
        self.assertEqual(events[-1].get("modelId"), "gemini:gemini-2.0-flash")

    def test_private_stream_does_not_fall_back_to_cloud(self):
        router = make_router()
        attempted = []

        async def fake_stream(model, _messages, _explicit=False, **_kwargs):
            attempted.append(model.id)
            if model.id == "ollama:llama3.1":
                raise RuntimeError("local failed")
            yield "ok"

        router._stream_one = fake_stream

        async def run():
            return [
                event
                async for event in router.stream(
                    prompt="hello",
                    model_ids=["ollama:llama3.1", "gemini:gemini-2.0-flash"],
                    allow_fallback=True,
                    privacy="private",
                )
            ]

        events = asyncio.run(run())
        self.assertIn("ollama:llama3.1", attempted)
        self.assertIn("ollama:qwen2.5", attempted)
        self.assertTrue(all(item.startswith("ollama:") for item in attempted))
        self.assertNotIn("gemini:gemini-2.0-flash", attempted)
        self.assertTrue(any(event.get("delta") == "ok" for event in events))

    def test_private_and_cloud_only_stay_empty(self):
        router = make_router()
        attempted = []

        async def fake_stream(model, _messages, _explicit=False, **_kwargs):
            attempted.append(model.id)
            yield "ok"

        router._stream_one = fake_stream

        async def run():
            return [
                event
                async for event in router.stream(
                    prompt="hello",
                    model_ids=["gemini:gemini-2.0-flash", "ollama:llama3.1"],
                    allow_fallback=True,
                    route_mode="cloud-only",
                    privacy="private",
                )
            ]

        events = asyncio.run(run())
        self.assertEqual(attempted, [])
        self.assertIn("cloud-only", events[-1].get("error", ""))
        self.assertIn("Private", events[-1].get("error", ""))

    def test_private_live_snapshot_drops_cloud_ids(self):
        router = make_router()
        ids = router.ids_for_live(
            {
                "routeMode": "auto",
                "policy": "free-preferred",
                "selected": [],
                "privacy": "private",
            }
        )
        self.assertEqual(sorted(ids), ["ollama:llama3.1", "ollama:qwen2.5"])

    def test_stream_manual_mode_disables_fallback(self):
        router = make_router()
        attempted = []

        async def fake_stream(model, _messages, _explicit=False, **_kwargs):
            attempted.append(model.id)
            raise RuntimeError("primary failed")
            yield "ok"

        router._stream_one = fake_stream

        async def run():
            return [
                event
                async for event in router.stream(
                    prompt="hello",
                    model_ids=["gemini:gemini-2.0-flash"],
                    allow_fallback=True,  # Caller says True, but route_mode='manual' must enforce False
                    route_mode="manual",
                )
            ]

        events = asyncio.run(run())
        # Manual mode must NOT fall back to other models
        self.assertEqual(attempted, ["gemini:gemini-2.0-flash"])
        self.assertTrue(any("error" in e for e in events))


if __name__ == "__main__":
    unittest.main()
