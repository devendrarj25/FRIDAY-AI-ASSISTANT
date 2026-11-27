"""task.run reports what the planner really did: waiting-approval is not done, and frames carry the request id."""

from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")

_root = Path(tempfile.mkdtemp(prefix="friday-taskrun-"))
os.environ["FRIDAY_DATA_DIR"] = str(_root / "data")
os.environ["FRIDAY_WORKSPACE_ROOT"] = str(_root)
os.environ.setdefault("FRIDAY_BRIDGE_TOKEN", "contract-token")

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "kernel"))

import main  # noqa: E402


def _fake_run(events):
    async def run(goal, **kwargs):
        for event in events:
            yield event

    return run


def _dispatch(monkeypatch, events):
    monkeypatch.setattr(main.planner, "run", _fake_run(events))
    sent: list[dict] = []

    async def send(payload):
        sent.append(payload)

    result = asyncio.run(main.dispatch("task.run", {"goal": "write a file"}, send))
    return result, sent


def test_approval_required_is_waiting_not_done(monkeypatch):
    events = [
        {"taskId": "t1", "type": "created", "goal": "g"},
        {"taskId": "t1", "type": "planned", "steps": []},
        {
            "taskId": "t1",
            "stepId": "s1",
            "type": "approval-required",
            "tool": "fs.write",
            "risk": "write",
            "args": {"path": "a.txt"},
        },
    ]
    result, sent = _dispatch(monkeypatch, events)
    assert result["done"] is False
    assert result["state"] == "waiting-approval"
    assert result["taskId"] == "t1"
    assert result["pendingApproval"] == {
        "stepId": "s1",
        "tool": "fs.write",
        "risk": "write",
        "args": {"path": "a.txt"},
    }
    assert [frame["type"] for frame in sent] == ["task.event"] * 3


def test_terminal_done_is_done_with_results(monkeypatch):
    events = [
        {"taskId": "t2", "type": "created", "goal": "g"},
        {"taskId": "t2", "stepId": "s1", "type": "done", "result": {"ok": True}},
        {"taskId": "t2", "type": "done", "results": [{"stepId": "s1", "result": {"ok": True}}]},
    ]
    result, _ = _dispatch(monkeypatch, events)
    assert result["done"] is True
    assert result["state"] == "done"
    assert result["results"] == [{"stepId": "s1", "result": {"ok": True}}]
    assert "pendingApproval" not in result


def test_a_step_done_event_alone_is_not_the_task_done(monkeypatch):
    events = [
        {"taskId": "t3", "type": "created", "goal": "g"},
        {"taskId": "t3", "stepId": "s1", "type": "done", "result": {"ok": True}},
    ]
    result, _ = _dispatch(monkeypatch, events)
    assert result["done"] is False
    assert result["state"] != "done"


@pytest.mark.parametrize("kind", ["failed", "cancelled"])
def test_failed_and_cancelled_are_not_done(monkeypatch, kind):
    events = [
        {"taskId": "t4", "type": "created", "goal": "g"},
        {"taskId": "t4", "type": kind, "error": "boom", "results": []},
    ]
    result, _ = _dispatch(monkeypatch, events)
    assert result["done"] is False
    assert result["state"] == kind
    if kind == "failed":
        assert result["error"] == "boom"


def test_stream_without_a_terminal_event_is_not_done(monkeypatch):
    result, _ = _dispatch(monkeypatch, [{"taskId": "t5", "type": "created", "goal": "g"}])
    assert result["done"] is False


def test_bridge_stamps_request_id_on_task_event_frames(monkeypatch):
    from starlette.testclient import TestClient

    monkeypatch.setattr(
        main.planner,
        "run",
        _fake_run([{"taskId": "t6", "type": "created", "goal": "g"}, {"taskId": "t6", "type": "done", "results": []}]),
    )
    with TestClient(main.app).websocket_connect("/bridge") as ws:
        ws.send_text(json.dumps({"token": main.TOKEN}))
        assert json.loads(ws.receive_text())["type"] == "ready"
        ws.send_text(json.dumps({"id": "req-9", "method": "task.run", "params": {"goal": "g"}}))
        frames = []
        while True:
            frame = json.loads(ws.receive_text())
            frames.append(frame)
            if frame.get("type") == "result":
                break
    events = [f for f in frames if f["type"] == "task.event"]
    assert len(events) == 2
    assert all(f["requestId"] == "req-9" for f in events)
    # The result frame keeps the single `id` the desktop matches on; event frames must not claim it.
    assert all("id" not in f or f["id"] is None for f in events)
    assert frames[-1]["id"] == "req-9" and frames[-1]["data"]["done"] is True
