"""A provider that accepts the connection and then sends nothing must fail.

With `timeout=httpx.Timeout(None, connect=20.0)` the read timeout was None, so
a stalled stream hung forever. These tests use a real socket server that
accepts and never replies, and assert a bounded, typed, reportable failure.
"""

import asyncio
import sys
import time
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import router
from router import Model, describe_failure


def a_model():
    return Model(id="stalled/model", label="Stalled Model", provider="openai", endpoint="http://x")


def test_client_has_a_finite_read_timeout_and_keeps_connect_at_20s():
    client = router._client()
    assert client.timeout.connect == 20.0
    assert client.timeout.read == router.READ_TIMEOUT_SECONDS
    assert 90.0 <= router.READ_TIMEOUT_SECONDS <= 120.0
    assert client.timeout.write is not None
    assert client.timeout.pool is not None


def test_a_timeout_is_described_as_a_timeout_not_a_bare_exception():
    said = describe_failure(a_model(), httpx.ReadTimeout("timed out"))
    assert "Stalled Model" in said
    assert "timed out" in said.lower()
    assert "stalled" in said.lower()
    assert router.is_network_error(said)


def test_connect_timeout_is_distinguished_from_a_mid_stream_stall():
    said = describe_failure(a_model(), httpx.ConnectTimeout("nope"))
    assert "connecting" in said


@pytest.mark.asyncio
async def test_a_stalled_server_fails_within_the_read_timeout_instead_of_hanging():
    async def stall(reader, writer):
        try:
            await asyncio.sleep(3)  # accept, then send nothing at all
        finally:
            # Python >= 3.12.1: Server.wait_closed() waits for every accepted
            # connection to be closed, so a handler that never closes its
            # writer makes the test hang forever instead of finishing.
            writer.close()

    server = await asyncio.start_server(stall, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    async with httpx.AsyncClient(timeout=httpx.Timeout(None, connect=20.0, read=1.0, write=1.0, pool=1.0)) as client:
        started = time.monotonic()
        with pytest.raises(httpx.TimeoutException) as caught:
            await client.post(f"http://127.0.0.1:{port}/v1/chat/completions", json={})
        elapsed = time.monotonic() - started
    server.close()
    await asyncio.wait_for(server.wait_closed(), timeout=10)

    assert elapsed < 5.0, f"stall took {elapsed:.1f}s — it should be bounded"
    said = describe_failure(a_model(), caught.value)
    assert "timed out" in said.lower()
