"""Fail a kernel test that opens a public network socket.

Loopback stays open so a local stub server can bind and accept. A test that
must use the public network lists its node id in NETWORK_ALLOW.txt. IP
literals are resolved locally (no DNS). A connect to a public address is
refused even when the address is an IP literal.
"""

from __future__ import annotations

import ipaddress
import socket
from pathlib import Path
from typing import Any

ALLOW_FILE = Path(__file__).with_name("NETWORK_ALLOW.txt")

_LOOPBACK_NAMES = {"localhost", "localhost.localdomain"}


def allow_list() -> list[str]:
    if not ALLOW_FILE.is_file():
        return []
    rows = []
    for line in ALLOW_FILE.read_text(encoding="utf-8").splitlines():
        text = line.split("#", 1)[0].strip()
        if text:
            rows.append(text)
    return rows


def node_allowed(nodeid: str) -> bool:
    return any(row == nodeid or nodeid.endswith(row) for row in allow_list())


def _text(value) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return str(value)


def host_of(address) -> str:
    if isinstance(address, tuple) and address:
        return _text(address[0]).strip("[]")
    return _text(address).strip("[]")


def _ip(host: str):
    try:
        return ipaddress.ip_address(host)
    except ValueError:
        return None


def is_loopback_host(host: str) -> bool:
    name = host.lower().rstrip(".")
    if name in _LOOPBACK_NAMES:
        return True
    ip = _ip(name)
    if ip is None:
        return False
    return bool(ip.is_loopback or ip.is_unspecified)


def is_ip_literal(host: str) -> bool:
    return _ip(host) is not None


def _refuse(kind: str, host: str) -> None:
    raise AssertionError(
        f"kernel test opened a public {kind} to {host!r}. "
        "List the full node id in kernel/tests/NETWORK_ALLOW.txt to allow it."
    )


def install(monkeypatch, nodeid: str) -> None:
    """Patch socket DNS and connect for one test. Loopback is unchanged."""
    if node_allowed(nodeid):
        return
    real_getaddrinfo = socket.getaddrinfo
    real_connect = socket.socket.connect
    real_create = socket.create_connection

    def guarded_getaddrinfo(host, port, *args, **kwargs):
        name = _text(host).strip("[]")
        if not is_loopback_host(name) and not is_ip_literal(name):
            _refuse("DNS lookup", name)
        return real_getaddrinfo(host, port, *args, **kwargs)

    def guarded_connect(self, address):
        if not isinstance(address, str):
            name = host_of(address)
            if not is_loopback_host(name):
                _refuse("connection", name)
        return real_connect(self, address)

    def guarded_create(address, *args, **kwargs):
        if not isinstance(address, str):
            name = host_of(address)
            if not is_loopback_host(name):
                _refuse("connection", name)
        target: Any = address
        return real_create(target, *args, **kwargs)

    monkeypatch.setattr(socket, "getaddrinfo", guarded_getaddrinfo)
    monkeypatch.setattr(socket.socket, "connect", guarded_connect)
    monkeypatch.setattr(socket, "create_connection", guarded_create)
