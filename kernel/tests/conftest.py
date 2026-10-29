"""Kernel suite fixtures. The network guard applies to every test."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from network_guard import install  # noqa: E402


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "allow_network: public sockets are still refused unless NETWORK_ALLOW.txt lists the node",
    )


@pytest.fixture(autouse=True)
def _no_public_network(request, monkeypatch):
    install(monkeypatch, request.node.nodeid)
