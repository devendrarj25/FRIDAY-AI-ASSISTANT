"""Device URLs and descriptions stay on plain http(s) XML."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import devices_network  # noqa: E402


def test_a_file_url_is_refused_before_it_is_opened(monkeypatch):
    def boom(*_args, **_kwargs):
        raise AssertionError("urlopen")

    monkeypatch.setattr(devices_network.urllib.request, "urlopen", boom)
    with pytest.raises(ValueError):
        devices_network.require_http_url("file:///etc/passwd")
    result = devices_network._soap("file:///tmp/x", "Stop", "<InstanceID>0</InstanceID>")
    assert result["ok"] is False


def test_device_xml_rejects_a_doctype():
    payload = b"""<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe "boom">]><root>&xxe;</root>"""
    with pytest.raises(ValueError):
        devices_network.parse_device_xml(payload)


def test_device_xml_reads_a_plain_description():
    payload = (
        b'<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><friendlyName>Room</friendlyName></root>'
    )
    xml = devices_network.parse_device_xml(payload)
    name = xml.find(".//{urn:schemas-upnp-org:device-1-0}friendlyName")
    assert name is not None
    assert name.text == "Room"


def test_cast_escapes_the_media_url(monkeypatch):
    seen = []

    def fake_soap(_url, action, body):
        seen.append((action, body))
        return {"ok": True, "status": 200}

    monkeypatch.setattr(devices_network, "_soap", fake_soap)
    devices_network.cast("http://127.0.0.1/ctrl", "http://example.com/?a=<b>")
    assert seen[0][0] == "SetAVTransportURI"
    assert "&lt;b&gt;" in seen[0][1]
    assert "<b>" not in seen[0][1]
