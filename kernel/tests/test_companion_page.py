"""Phone companion page: pairing overlay, icons, pairing HTTP."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

fastapi = pytest.importorskip("fastapi")
httpx = pytest.importorskip("httpx")

from companion import (  # noqa: E402
    COMPANION_HTML,
    COMPANION_SW,
    MANIFEST,
    CompanionStore,
    _png_payload_from_ico,
    build_router,
    companion_icon_png,
    companion_whats_new,
    parse_changelog_sections,
)
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

REPO = Path(__file__).resolve().parents[2]


def _app(
    tmp_path: Path,
    enabled: bool = True,
    history: list | None = None,
    live: dict | None = None,
) -> tuple[FastAPI, CompanionStore]:
    store = CompanionStore(tmp_path / "phones.json")

    async def chat(_prompt, send):
        await send({"type": "delta", "text": "ok"})

    async def speak(_text):
        return ""

    api = FastAPI()
    api.include_router(
        build_router(
            store,
            chat,
            speak,
            lambda: enabled,
            features_provider=lambda: [
                {
                    "id": "/models",
                    "label": "Models",
                    "group": "Main",
                    "read": "model.list",
                    "field": "models",
                    "prompt": "status",
                }
            ],
            capabilities_provider=lambda: [
                {"id": "model:a", "type": "model", "name": "A", "available": True, "health": "ready"}
            ],
            history_provider=(lambda: history) if history is not None else None,
            live_provider=(lambda: live) if live is not None else None,
        )
    )
    return api, store


def test_pair_hidden_rule_wins_over_display_flex():
    css_start = COMPANION_HTML.index("#pair{padding:24px;display:flex")
    hidden_rule = COMPANION_HTML.index("#pair[hidden],#composer[hidden]{display:none}")
    assert hidden_rule > css_start
    assert "el('pair').hidden=true" in COMPANION_HTML
    assert "localStorage.setItem(KEY,data.token);connect();" in COMPANION_HTML


def test_unpaired_markup_shows_pair_and_hides_composer():
    assert '<div id="pair" hidden>' in COMPANION_HTML
    assert '<footer id="composer" hidden>' in COMPANION_HTML
    assert "if(!token){el('pair').hidden=false;el('composer').hidden=true" in COMPANION_HTML


def test_manifest_and_html_point_at_real_icons():
    srcs = {icon["src"] for icon in MANIFEST["icons"]}
    assert "/companion/icon-192.png" in srcs
    assert "/companion/icon-512.png" in srcs
    assert 'rel="icon" href="/companion/icon-192.png"' in COMPANION_HTML
    assert 'rel="apple-touch-icon" href="/companion/icon-192.png"' in COMPANION_HTML
    assert 'src="/companion/icon-192.png"' in COMPANION_HTML
    assert 'name="apple-mobile-web-app-capable" content="yes"' in COMPANION_HTML
    assert 'name="apple-mobile-web-app-status-bar-style" content="black-translucent"' in COMPANION_HTML
    assert 'name="apple-mobile-web-app-title" content="FRIDAY"' in COMPANION_HTML


def test_icon_bytes_come_from_existing_friday_ico():
    ico = (REPO / "resources" / "icons" / "friday.ico").read_bytes()
    extracted = _png_payload_from_ico(ico)
    served = companion_icon_png()
    assert extracted is not None and extracted.startswith(b"\x89PNG")
    assert served == extracted


def test_http_page_manifest_icons_and_pair(tmp_path):
    api, store = _app(tmp_path)
    client = TestClient(api)

    page = client.get("/companion")
    assert page.status_code == 200
    assert "#pair[hidden],#composer[hidden]{display:none}" in page.text
    assert 'rel="icon" href="/companion/icon-192.png"' in page.text

    manifest = client.get("/companion/manifest.json")
    assert manifest.status_code == 200
    icons = manifest.json()["icons"]
    assert icons
    assert all(item["src"].startswith("/companion/icon-") for item in icons)

    icon = client.get("/companion/icon-192.png")
    assert icon.status_code == 200
    assert icon.headers["content-type"].startswith("image/png")
    assert icon.content.startswith(b"\x89PNG")
    assert client.get("/companion/icon-512.png").content == icon.content

    pending = store.new_code()
    bad = client.post("/companion/pair", json={"code": "000000", "label": "test"})
    assert bad.status_code == 401

    ok = client.post("/companion/pair", json={"code": pending["code"], "label": "test"})
    assert ok.status_code == 200
    assert ok.json()["token"]
    assert store.valid(ok.json()["token"])


def test_ws_replays_history_and_live(tmp_path):
    api, store = _app(
        tmp_path,
        history=[
            {"role": "user", "text": "hello from desktop", "origin": "desktop"},
            {"role": "assistant", "text": "hi"},
        ],
        live={
            "voice": "LISTENING",
            "doctor": {"problems": 1, "warnings": 0, "scanning": False},
            "connectors": [],
            "cloud": [],
        },
    )
    pending = store.new_code()
    client = TestClient(api)
    token = client.post("/companion/pair", json={"code": pending["code"], "label": "test"}).json()["token"]
    with client.websocket_connect("/companion/ws") as ws:
        ws.send_json({"token": token})
        ready = ws.receive_json()
        assert ready["type"] == "ready"
        hist = ws.receive_json()
        assert hist["type"] == "history"
        assert hist["messages"][0]["text"] == "hello from desktop"
        assert hist["messages"][0]["origin"] == "desktop"
        live_msg = ws.receive_json()
        assert live_msg["type"] == "live"
        assert live_msg["live"]["voice"] == "LISTENING"


def test_html_uses_kernel_reconnect_backoff():
    assert "const DELAYS=[0,2000,8000]" in COMPANION_HTML
    assert "function scheduleReconnect()" in COMPANION_HTML
    assert "setTimeout(connect,4000)" not in COMPANION_HTML
    assert "if(m.type==='history')" in COMPANION_HTML
    assert "if(m.type==='live')" in COMPANION_HTML


def test_whats_new_comes_from_changelog_not_invented_text():
    news = companion_whats_new(REPO)
    assert news["source"] == "CHANGELOG.md"
    assert news["version"]
    assert news["current"]
    assert news["current"]["version"] == news["version"]
    assert news["current"]["body"].startswith(f"## v{news['version']}")
    changelog = (REPO / "CHANGELOG.md").read_text(encoding="utf-8")
    assert news["current"]["body"] in changelog
    sections = parse_changelog_sections(changelog)
    assert sections
    assert sections[0]["version"] == news["version"]


def test_whats_new_missing_file_is_honest(tmp_path):
    empty = companion_whats_new(tmp_path)
    assert empty["source"] is None
    assert empty["current"] is None
    assert empty["history"] == []
    assert "cannot be shown" in empty["detail"]


def test_service_worker_and_whats_new_http(tmp_path):
    api, store = _app(tmp_path)
    client = TestClient(api)

    sw = client.get("/companion/sw.js")
    assert sw.status_code == 200
    assert "periodicsync" in sw.text.lower() or "periodicsync" in COMPANION_SW.lower()
    assert "skipWaiting" in sw.text
    assert MANIFEST["serviceworker"]["src"] == "/companion/sw.js"

    pending = store.new_code()
    token = client.post("/companion/pair", json={"code": pending["code"], "label": "test"}).json()["token"]
    features = client.get("/companion/features", params={"token": token})
    assert features.status_code == 200
    body = features.json()
    assert "whatsNew" in body
    assert body["whatsNew"]["source"] == "CHANGELOG.md"
    assert body["whatsNew"]["current"]["body"]

    news = client.get("/companion/whats-new", params={"token": token})
    assert news.status_code == 200
    assert news.json()["source"] == "CHANGELOG.md"
    assert client.get("/companion/whats-new", params={"token": "nope"}).status_code == 401


def test_html_keeps_pairing_and_permission_honesty():
    assert "#pair[hidden],#composer[hidden]{display:none}" in COMPANION_HTML
    assert "getUserMedia({video:true" in COMPANION_HTML
    assert 'id="cam"' in COMPANION_HTML
    assert "type:'camera'" in COMPANION_HTML
    assert "not requested — tap 📷 or Ask to use the camera" in COMPANION_HTML
    assert ".play().catch(()=>{})" not in COMPANION_HTML
    assert "This browser blocked autoplay" in COMPANION_HTML
    assert "max-width:430px" not in COMPANION_HTML
    assert "window.isSecureContext" in COMPANION_HTML
    assert "getRegistration('/companion')" in COMPANION_HTML
    assert "navigator.serviceWorker.ready" not in COMPANION_HTML
    assert "typeof live.line==='string'" in COMPANION_HTML
    assert "function isRunnable(c)" in COMPANION_HTML
    assert "const RUNNABLE=" not in COMPANION_HTML


def test_storage_chat_origin_roundtrip(tmp_path):
    from db import Storage  # noqa: E402

    db = Storage(tmp_path / "friday.sqlite3")
    db.migrate()
    db.append_chat("main", "user", "hello from pc", origin="desktop")
    db.append_chat("main", "user", "hello from phone", origin="phone")
    rows = db.chat_history("main")
    assert rows[0]["origin"] == "desktop"
    assert rows[1]["origin"] == "phone"


def test_storage_replace_chat_clears_and_maps_friday_role(tmp_path):
    from db import Storage  # noqa: E402

    db = Storage(tmp_path / "friday.sqlite3")
    db.migrate()
    db.append_chat("main", "user", "stale", origin="desktop")
    assert db.replace_chat("main", []) == 0
    assert db.chat_history("main") == []
    count = db.replace_chat(
        "main",
        [
            {"role": "user", "text": "hi", "origin": "desktop"},
            {"role": "friday", "text": "hello"},
        ],
    )
    assert count == 2
    rows = db.chat_history("main")
    assert rows[0]["role"] == "user"
    assert rows[0]["text"] == "hi"
    assert rows[1]["role"] == "assistant"
    assert rows[1]["text"] == "hello"
