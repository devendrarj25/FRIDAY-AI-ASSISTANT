"""FRIDAY — devices on the same local network.

Honest scope: FRIDAY can only discover and talk to devices that already speak
a standard protocol (mDNS/Bonjour advertisement, DLNA/UPnP media renderers) or
that run FRIDAY's own phone companion. It never probes or tries to control a
device that has not opted in.
"""

from __future__ import annotations

import re
import socket
import urllib.parse
import urllib.request
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape

SSDP_ADDR = ("239.255.255.250", 1900)
SSDP_QUERY = (
    "M-SEARCH * HTTP/1.1\r\n"
    "HOST: 239.255.255.250:1900\r\n"
    'MAN: "ssdp:discover"\r\n'
    "MX: 2\r\n"
    "ST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n"
)


def lan_address() -> dict:
    """This PC's address on the local network (never a public address)."""
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.connect(("8.8.8.8", 80))
        ip = sock.getsockname()[0]
        sock.close()
        return {"ok": True, "ip": ip, "hostname": socket.gethostname()}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def discover_mdns(seconds: float = 4.0) -> dict:
    """mDNS/Bonjour services advertised on this network."""
    try:
        from zeroconf import ServiceBrowser, Zeroconf  # type: ignore
    except Exception:
        return {
            "ok": False,
            "error": "The mDNS library (zeroconf) is not installed. Install it from the Install Manager.",
        }
    import time

    found: list[dict] = []
    zc = Zeroconf()

    class Listener:
        def add_service(self, zeroconf, service_type, name):
            info = zeroconf.get_service_info(service_type, name, timeout=1500)
            if not info:
                return
            addresses = [socket.inet_ntoa(a) for a in info.addresses if len(a) == 4]
            found.append(
                {
                    "name": name.split(".")[0],
                    "type": service_type,
                    "addresses": addresses,
                    "port": info.port,
                }
            )

        def update_service(self, zeroconf, service_type, name):
            return

        def remove_service(self, zeroconf, service_type, name):
            return

    types = [
        "_googlecast._tcp.local.",
        "_airplay._tcp.local.",
        "_spotify-connect._tcp.local.",
        "_printer._tcp.local.",
        "_http._tcp.local.",
    ]
    browsers = [ServiceBrowser(zc, t, Listener()) for t in types]
    time.sleep(max(1.0, float(seconds)))
    for browser in browsers:
        browser.cancel()
    zc.close()
    return {"ok": True, "devices": found}


def require_http_url(url: str) -> str:
    """Device description and control URLs stay on http or https."""
    parsed = urllib.parse.urlparse(str(url or "").strip())
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("a device URL must use http or https")
    return str(url).strip()


def parse_device_xml(payload: bytes):
    """Read a device description. A doctype or entity declaration is refused."""
    sample = payload[:4096].lower()
    if b"<!doctype" in sample or b"<!entity" in sample:
        raise ValueError("a device description must not declare a doctype or an entity")
    return ET.fromstring(payload)  # noqa: S314


def discover_dlna(seconds: float = 3.0) -> dict:
    """DLNA/UPnP media renderers (TVs, speakers) that advertise themselves."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.settimeout(max(1.0, float(seconds)))
    renderers: dict[str, dict] = {}
    try:
        sock.sendto(SSDP_QUERY.encode(), SSDP_ADDR)
        while True:
            try:
                data, addr = sock.recvfrom(65507)
            except TimeoutError:
                break
            text = data.decode("utf-8", "replace")
            location = re.search(r"LOCATION:\s*(\S+)", text, re.I)
            if not location:
                continue
            url = location.group(1)
            try:
                require_http_url(url)
            except ValueError:
                continue
            renderers[url] = {"location": url, "address": addr[0], "name": addr[0]}
    finally:
        sock.close()

    for url, entry in renderers.items():
        try:
            with urllib.request.urlopen(require_http_url(url), timeout=3) as resp:  # noqa: S310
                xml = parse_device_xml(resp.read())
            ns = {"u": "urn:schemas-upnp-org:device-1-0"}
            name = xml.find(".//u:friendlyName", ns)
            control = xml.find(".//u:serviceType[.='urn:schemas-upnp-org:service:AVTransport:1']/../u:controlURL", ns)
            if name is not None and name.text:
                entry["name"] = name.text
            if control is not None and control.text:
                base = url.rsplit("/", 1)[0]
                entry["controlUrl"] = (
                    control.text if control.text.startswith("http") else base + "/" + control.text.lstrip("/")
                )
        except Exception:  # noqa: S112 — one renderer that does not answer is skipped
            continue
    return {"ok": True, "devices": list(renderers.values())}


def _soap(control_url: str, action: str, body: str) -> dict:
    try:
        safe = require_http_url(control_url)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    envelope = (
        '<?xml version="1.0"?>'
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
        's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>'
        f'<u:{action} xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">{body}</u:{action}>'
        "</s:Body></s:Envelope>"
    ).encode()
    request = urllib.request.Request(  # noqa: S310
        safe,
        data=envelope,
        headers={
            "Content-Type": 'text/xml; charset="utf-8"',
            "SOAPAction": f'"urn:schemas-upnp-org:service:AVTransport:1#{action}"',
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=8) as resp:  # noqa: S310
            return {"ok": 200 <= resp.status < 300, "status": resp.status}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def cast(control_url: str, media_url: str) -> dict:
    """Play a media URL on a DLNA renderer that advertised AVTransport."""
    prepared = _soap(
        control_url,
        "SetAVTransportURI",
        f"<InstanceID>0</InstanceID><CurrentURI>{escape(media_url)}</CurrentURI>"
        "<CurrentURIMetaData></CurrentURIMetaData>",
    )
    if not prepared.get("ok"):
        return {
            "ok": False,
            "error": prepared.get("error")
            or "This device did not accept the cast request — it may not support DLNA playback.",
        }
    return _soap(control_url, "Play", "<InstanceID>0</InstanceID><Speed>1</Speed>")


def stop(control_url: str) -> dict:
    return _soap(control_url, "Stop", "<InstanceID>0</InstanceID>")
