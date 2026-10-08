"""A model-requested tool that never returns must not stall the first chat token."""

from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from router import MODEL_TOOL_BUDGET_SECONDS, MODEL_TOOL_TIMEOUT_SECONDS, ModelRouter


class Store:
    def models(self):
        return []


class SlowTools:
    async def execute_for_model(self, name, args):
        await asyncio.sleep(30)
        return {"ok": True, "name": name}


class InstantTools:
    async def execute_for_model(self, name, args):
        return {"ok": True, "name": name}


def test_tool_deadlines_are_well_under_the_140s_watchdog():
    assert 1.0 <= MODEL_TOOL_TIMEOUT_SECONDS <= 15.0
    assert 5.0 <= MODEL_TOOL_BUDGET_SECONDS <= 40.0
    assert MODEL_TOOL_BUDGET_SECONDS + MODEL_TOOL_TIMEOUT_SECONDS < 140.0


@pytest.mark.asyncio
async def test_a_hung_model_tool_fails_within_the_timeout():
    engine = ModelRouter(Store())
    engine.tools = SlowTools()
    started = time.perf_counter()
    payload = await engine._run_model_tool("bluetooth_scan", "{}")
    elapsed = time.perf_counter() - started
    body = json.loads(payload)
    assert elapsed < MODEL_TOOL_TIMEOUT_SECONDS + 2.0
    assert body["ok"] is False
    assert "timed out" in body["error"]


@pytest.mark.asyncio
async def test_an_already_spent_tool_budget_skips_remaining_calls():
    engine = ModelRouter(Store())
    engine.tools = InstantTools()
    spent = time.perf_counter() - (MODEL_TOOL_BUDGET_SECONDS + 1)
    payloads, exhausted = await engine._tool_payloads(
        [{"name": "network_discover", "arguments": "{}"}],
        spent,
    )
    assert exhausted is True
    body = json.loads(payloads[0])
    assert body["ok"] is False
    assert "budget" in body["error"]


def test_kernel_model_tools_do_not_include_web_search():
    from tools import MODEL_TOOL_PARAMS

    names = " ".join(MODEL_TOOL_PARAMS)
    assert "search" not in names
    assert "web" not in names
    assert "browser" not in names
