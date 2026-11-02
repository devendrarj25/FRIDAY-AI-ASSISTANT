"""The status poll and a runtime install must not stall the event loop.

`kernel.status` ran `nvidia-smi` and the inference probe on the event loop at every poll, and `runtime.install`
ran `winget` there for minutes, so every other request (chat, memory, the WebSocket) waited behind them.
"""

import asyncio
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import runtimes  # noqa: E402
from runtimes import RuntimeManager  # noqa: E402


async def worst_gap_while(coro) -> tuple[Any, float]:
    """Run `coro` and report the longest time the loop went without getting a turn."""
    worst = 0.0
    stop = asyncio.Event()

    async def heartbeat() -> None:
        nonlocal worst
        last = time.perf_counter()
        while not stop.is_set():
            await asyncio.sleep(0.005)
            now = time.perf_counter()
            worst = max(worst, now - last)
            last = now

    beat = asyncio.create_task(heartbeat())
    try:
        result = await coro
    finally:
        stop.set()
        await beat
    return result, worst


def manager() -> RuntimeManager:
    return RuntimeManager(Path(tempfile.mkdtemp()), storage=None)


def test_hardware_status_leaves_the_loop_free_and_is_remembered():
    mgr = manager()
    calls = {"gpu": 0, "inference": 0}

    def slow_gpu() -> str:
        calls["gpu"] += 1
        time.sleep(0.3)
        return "GPU 0"

    def slow_inference() -> dict:
        calls["inference"] += 1
        time.sleep(0.3)
        return {"onnxruntime": {"installed": None, "providers": [], "gpu": None}}

    mgr.gpu_info = slow_gpu  # type: ignore[method-assign]
    mgr.inference_runtimes = slow_inference  # type: ignore[method-assign]

    result, worst = asyncio.run(worst_gap_while(mgr.hardware_status()))
    assert result["gpu"] == "GPU 0"
    assert "onnxruntime" in result["inference"]
    assert worst < 0.15, f"the loop was blocked for {worst:.2f}s"

    # A second poll inside the freshness window reads the remembered answer: no program is run again.
    again = asyncio.run(mgr.hardware_status())
    assert again == result
    assert calls == {"gpu": 1, "inference": 1}


def test_a_stale_hardware_answer_is_read_again():
    mgr = manager()
    seen = []
    mgr.gpu_info = lambda: seen.append(1) or f"GPU {len(seen)}"  # type: ignore[method-assign]
    clock = {"t": 1000.0}
    first = mgr._remembered("gpu", mgr.gpu_info, now=lambda: clock["t"])
    clock["t"] += runtimes.HARDWARE_TTL_S + 1
    second = mgr._remembered("gpu", mgr.gpu_info, now=lambda: clock["t"])
    assert (first, second) == ("GPU 1", "GPU 2")


def test_runtime_install_leaves_the_loop_free(monkeypatch):
    mgr = manager()

    def slow_winget(*_args, **_kwargs):
        time.sleep(0.3)
        return subprocess.CompletedProcess(args=["winget"], returncode=0, stdout="installed", stderr="")

    monkeypatch.setattr(runtimes.subprocess, "run", slow_winget)
    monkeypatch.setattr(mgr, "_installed", lambda name: "v1")

    async def drain() -> list[dict]:
        return [event async for event in mgr.install("Git")]

    events, worst = asyncio.run(worst_gap_while(drain()))
    assert [e["state"] for e in events] == ["installing", "done"]
    assert events[-1]["installed"] == "v1"
    assert worst < 0.15, f"the loop was blocked for {worst:.2f}s"
