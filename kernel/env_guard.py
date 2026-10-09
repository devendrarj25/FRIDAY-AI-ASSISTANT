"""FRIDAY · environment and network guards for anything FRIDAY spawns or fetches.

Two rules live here, shared by every kernel module that runs a command or
opens a URL, so neither can be forgotten in one place and enforced in another:

1. A subprocess never sees a credential. Commands FRIDAY runs are written by a
   model or by a plugin; if such a command inherited the kernel environment it
   could print the tool-authority secret and mint its own approvals for shell,
   filesystem and PC control, defeating the whole permission system.
2. A "safe"-tier fetch never reaches a non-public address. Otherwise the one
   tool that runs WITHOUT owner approval becomes an SSRF lever pointed at
   FRIDAY's own kernel on loopback, at the LAN, or at a metadata endpoint.
"""

from __future__ import annotations

import ipaddress
import os
import re
import socket
from urllib.parse import urlsplit

SECRET_ENV_PATTERN = re.compile(
    r"(SECRET|TOKEN|API_?KEY|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_?KEY|SIGNING|SESSION)",
    re.IGNORECASE,
)

#: Kernel-internal vars a child never needs, secret-looking or not.
SECRET_ENV_NAMES = {
    "FRIDAY_TOOL_AUTHORITY_SECRET",
    "FRIDAY_BRIDGE_TOKEN",
}


def child_env(base: dict | None = None, extra: dict | None = None) -> dict:
    """The environment a spawned tool/command/app is allowed to see."""
    source = dict(os.environ if base is None else base)
    clean = {
        key: value
        for key, value in source.items()
        if key not in SECRET_ENV_NAMES and not SECRET_ENV_PATTERN.search(key)
    }
    if extra:
        clean.update(extra)
    return clean


def _blocked_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local  # covers 169.254.169.254 (cloud metadata)
        or ip.is_reserved
        or ip.is_multicast
        or ip.is_unspecified
    )


def guard_public_url(url: str, resolve=None) -> None:
    """Refuse anything that is not a plain public http(s) address.

    Blocks loopback, private ranges, link-local/metadata, reserved space and
    non-http schemes (file:, ftp:, gopher:), resolving the host first so a
    name that points at 127.0.0.1 is caught too. Raises PermissionError.

    `resolve` defaults to `socket.getaddrinfo`. Tests pass a fake so a public
    name is classified without a live DNS lookup. Production callers omit it.
    """
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise PermissionError(f"blocked URL scheme: {parts.scheme or 'none'}")
    host = (parts.hostname or "").strip("[]")
    if not host:
        raise PermissionError("blocked URL: no host")
    lookup = socket.getaddrinfo if resolve is None else resolve
    port = parts.port or (443 if parts.scheme == "https" else 80)
    try:
        infos = lookup(host, port)
    except OSError as exc:
        raise PermissionError(f"blocked URL: {host} does not resolve ({exc})") from exc
    for info in infos:
        address = ipaddress.ip_address(info[4][0])
        if _blocked_ip(address):
            raise PermissionError(f"blocked URL: {host} resolves to non-public {address}")
