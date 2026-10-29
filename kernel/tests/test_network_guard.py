"""The suite refuses a public socket unless the node id is listed."""

from __future__ import annotations

import socket
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from network_guard import ALLOW_FILE, allow_list, node_allowed  # noqa: E402


def test_public_dns_is_refused():
    with pytest.raises(AssertionError, match="public DNS"):
        socket.getaddrinfo("example.com", 443)


def test_public_ip_connect_is_refused():
    with pytest.raises(AssertionError, match="public connection"):
        socket.create_connection(("1.1.1.1", 443), timeout=0.2)


def test_loopback_literal_still_resolves():
    infos = socket.getaddrinfo("127.0.0.1", 9)
    assert infos[0][4][0] in {"127.0.0.1", "::1"}


def test_allow_list_file_is_visible_and_empty():
    text = ALLOW_FILE.read_text(encoding="utf-8")
    assert "NETWORK_ALLOW" not in text or "node id" in text
    assert allow_list() == []
    assert node_allowed("kernel/tests/test_network_guard.py::test_public_dns_is_refused") is False
