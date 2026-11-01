"""The bridge keeps a connection alive through a malformed frame, and refuses a malformed first frame cleanly."""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")

_root = Path(tempfile.mkdtemp(prefix="friday-bridge-robust-"))
os.environ["FRIDAY_DATA_DIR"] = str(_root / "data")
os.environ["FRIDAY_WORKSPACE_ROOT"] = str(_root)
# The kernel module reads its token once, at import; share the contract suite's value so import order does not matter.
os.environ.setdefault("FRIDAY_BRIDGE_TOKEN", "contract-token")

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "kernel"))

import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from starlette.websockets import WebSocketDisconnect  # noqa: E402

TOKEN = main.TOKEN


def _open(client: TestClient):
    ws = client.websocket_connect("/bridge")
    sock = ws.__enter__()
    sock.send_text(json.dumps({"token": TOKEN}))
    assert json.loads(sock.receive_text())["type"] == "ready"
    return ws, sock


@pytest.mark.parametrize("frame", ["not json", "[1, 2]", '"just a string"', "null", "42", "{"])
def test_a_bad_frame_gets_an_error_and_the_connection_stays_up(frame: str):
    client = TestClient(main.app)
    ws, sock = _open(client)
    try:
        sock.send_text(frame)
        reply = json.loads(sock.receive_text())
        assert reply["type"] == "error"
        assert "malformed" in reply["error"]
        # The same socket still answers a real call afterwards.
        sock.send_text(json.dumps({"id": 7, "method": "no.such.method", "params": {}}))
        after = json.loads(sock.receive_text())
        assert after["id"] == 7
        assert after["type"] == "error"
        assert "unknown method" in after["error"]
    finally:
        ws.__exit__(None, None, None)


@pytest.mark.parametrize("params", ["x", [1], 5, True])
def test_params_that_are_not_an_object_are_refused_with_the_call_id(params):
    client = TestClient(main.app)
    ws, sock = _open(client)
    try:
        sock.send_text(json.dumps({"id": 11, "method": "memory.search", "params": params}))
        reply = json.loads(sock.receive_text())
        assert reply == {"id": 11, "type": "error", "error": "params must be an object"}
    finally:
        ws.__exit__(None, None, None)


@pytest.mark.parametrize("first", ["garbage", "[]", "null", '"x"'])
def test_a_bad_first_frame_closes_the_socket_cleanly_instead_of_crashing(first: str):
    client = TestClient(main.app)
    with pytest.raises(WebSocketDisconnect) as closed:
        with client.websocket_connect("/bridge") as sock:
            sock.send_text(first)
            sock.receive_text()
    assert closed.value.code == 4400


def test_a_wrong_token_is_still_refused():
    client = TestClient(main.app)
    with pytest.raises(WebSocketDisconnect) as closed:
        with client.websocket_connect("/bridge") as sock:
            sock.send_text(json.dumps({"token": "nope"}))
            sock.receive_text()
    assert closed.value.code == 4401


def test_a_missing_or_mistyped_parameter_is_named_not_leaked_as_a_python_error():
    client = TestClient(main.app)
    ws, sock = _open(client)
    try:
        sock.send_text(json.dumps({"id": 21, "method": "model.remove", "params": {}}))
        missing = json.loads(sock.receive_text())
        assert missing == {"id": 21, "type": "error", "error": "missing parameter: id"}
        sock.send_text(json.dumps({"id": 22, "method": "model.remove", "params": {"id": {"a": 1}}}))
        wrong = json.loads(sock.receive_text())
        assert wrong["type"] == "error"
        assert wrong["error"].startswith("invalid parameter type:")
    finally:
        ws.__exit__(None, None, None)
