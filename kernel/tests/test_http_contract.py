"""Loopback HTTP contract: health, version, OpenAPI snapshot, bridge token."""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")

_root = Path(tempfile.mkdtemp(prefix="friday-http-contract-"))
os.environ["FRIDAY_DATA_DIR"] = str(_root / "data")
os.environ["FRIDAY_WORKSPACE_ROOT"] = str(_root)
os.environ["FRIDAY_BRIDGE_TOKEN"] = "contract-token"

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "kernel"))

import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from http_contract import product_version, route_rows, websocket_paths  # noqa: E402
from starlette.websockets import WebSocketDisconnect  # noqa: E402

SNAPSHOT = REPO / "kernel" / "openapi.snapshot.json"
CLIENT_FILES = (
    "electron/main.cjs",
    "electron/readiness.cjs",
    "electron/service-health.cjs",
    "electron/remote-access.cjs",
)


def _client() -> TestClient:
    return TestClient(main.app)


def test_health_happy_path_keeps_the_readiness_fields():
    response = _client().get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["version"] == main.app.version
    assert body["data_dir"]
    assert isinstance(body["models"], list)


def test_version_reports_the_product_line_without_a_token():
    response = _client().get("/version")
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["product"] == product_version(REPO)
    assert body["product"] == "1.0.1.2"
    assert body["kernel"] == main.app.version


def test_version_rejects_the_wrong_method():
    response = _client().post("/version")
    assert response.status_code == 405
    assert "detail" in response.json()


def test_companion_features_fail_closed_when_phone_access_is_off():
    response = _client().get("/companion/features")
    assert response.status_code == 403
    assert response.json()["detail"]


def test_bridge_refuses_a_bad_token_and_accepts_the_launch_token():
    client = _client()
    with pytest.raises(WebSocketDisconnect) as refused:
        with client.websocket_connect("/bridge") as ws:
            ws.send_text(json.dumps({"token": "wrong"}))
            ws.receive_text()
    assert refused.value.code == 4401

    with client.websocket_connect("/bridge") as ws:
        ws.send_text(json.dumps({"token": "contract-token"}))
        ready = json.loads(ws.receive_text())
        assert ready["type"] == "ready"
        ws.send_text(json.dumps({"id": "1", "method": "kernel.status", "params": {}}))
        result = json.loads(ws.receive_text())
        assert result["type"] == "result"
        assert result["data"]["connected"] is True


def test_openapi_snapshot_matches_the_app():
    live = {
        "openapi": main.app.openapi(),
        "websockets": websocket_paths(main.app),
    }
    saved = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    assert live == saved
    rows = route_rows(live["openapi"])
    assert ("GET", "/health") in rows
    assert ("GET", "/version") in rows
    assert live["websockets"] == ["/bridge", "/companion/ws"]


def test_phone_chat_uses_the_companion_sender(monkeypatch):
    sender = object()
    token = main._PHONE_SENDER.set(sender)
    sent = []

    def append_chat(*_args, **_kwargs):
        return None

    async def recall(_prompt):
        return ""

    class Router:
        def ids_for_live(self, _live):
            return ["local"]

        def explain_unavailable(self, _live):
            return "none"

        async def stream(self, **_kwargs):
            yield {"delta": "ok", "modelId": "local"}

    async def send(payload):
        sent.append(payload)

    monkeypatch.setattr(main, "storage", type("S", (), {"append_chat": staticmethod(append_chat)})())
    monkeypatch.setattr(main, "memory", type("M", (), {"recall": staticmethod(recall)})())
    monkeypatch.setattr(main, "router", Router())
    monkeypatch.setattr(main, "companion_live", lambda: {"routeMode": "auto", "privacy": ""})
    monkeypatch.setattr(main, "DESKTOP_CLIENTS", set())
    try:
        import asyncio

        asyncio.run(main.companion_chat("hello", send))
    finally:
        main._PHONE_SENDER.reset(token)
        main._PHONE_COGNIZE_SENDER.pop("main", None)
    assert main._PHONE_SENDER is not None
    assert any(item.get("type") == "delta" and item.get("text") == "ok" for item in sent)
    assert "main" not in main._PHONE_COGNIZE_SENDER


def test_electron_kernel_calls_match_the_openapi_snapshot():
    saved = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    known = set(saved["openapi"]["paths"]) | set(saved["websockets"])
    found: set[str] = set()
    for rel in CLIENT_FILES:
        text = (REPO / rel).read_text(encoding="utf-8")
        found.update(re.findall(r"KERNEL_PORT\}(/[A-Za-z0-9_./-]*)", text))
        found.update(re.findall(r"kernelUrl\}(/[A-Za-z0-9_./-]*)", text))
        found.update(re.findall(r"port\}(/companion)\b", text))
    assert found
    missing = sorted(path for path in found if path not in known)
    assert missing == []
