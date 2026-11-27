"""The numbered click overlay is built from one perception, offers only safe controls and expires.

Everything here is pure data: no Windows call is made. A real UIA tree, DPI and multi-monitor placement are
UNVERIFIED on this Linux machine; the owner's Windows PC is the only proof of those.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from uia_overlay import MAX_TARGETS, TTL_MS, build_overlay, resolve_target, speak_label  # noqa: E402
from uia_tree import perception_from_raw  # noqa: E402

NOW = 1_000_000


def ctl(name, x=0, y=0, role="button", patterns=("Invoke",), enabled=True, offscreen=False, selector=None):
    return {
        "id": selector or f"id:{name}",
        "name": name,
        "role": role,
        "bounds": {"x": x, "y": y, "w": 80, "h": 24},
        "enabled": enabled,
        "offscreen": offscreen,
        "patterns": list(patterns),
        "selector": selector or f"id:{name}",
        "controlType": "Button",
    }


def perception(*windows, handoff=None):
    base = {"ok": True, "source": "uia", "freshAt": NOW, "windows": list(windows), "truncated": False}
    if handoff:
        base["handoff"] = handoff
    return base


def window(controls, title="Notes", focused=True, wid="id:Notes"):
    return {"id": wid, "title": title, "focused": focused, "controls": controls}


def names(overlay):
    return [t["name"] for t in overlay["targets"]]


def test_auto_mode_off_refuses_and_lists_nothing():
    out = build_overlay(perception(window([ctl("Save")])), NOW, auto_mode=False)
    assert out["ok"] is False and out["reason"] == "auto-mode-only"
    assert out["targets"] == []


def test_handoff_perception_gives_zero_targets_and_no_content():
    raw = {
        "monitors": [{"x": 0, "y": 0, "w": 1920, "h": 1080, "dpi": 96}],
        "windows": [{"name": "User Account Control", "controlType": "Window", "children": []}],
    }
    out = build_overlay(perception_from_raw(raw, NOW), NOW, auto_mode=True)
    assert out["ok"] is False
    assert out["handoff"] == "uac"
    assert out["targets"] == []
    assert "User Account Control" not in str(out)


def test_password_payment_offscreen_and_disabled_controls_get_no_number():
    controls = [
        ctl("Save"),
        ctl("Secret", role="password", patterns=("Value",)),
        ctl("Pay now"),
        ctl("Card number"),
        ctl("Place order"),
        ctl("CVV"),
        ctl("Enter PIN"),
        ctl("Verify OTP"),
        ctl("Captcha"),
        ctl("Hidden", offscreen=True),
        ctl("Greyed", enabled=False),
        ctl("Label", role="text", patterns=()),
        ctl("Gate", role="captcha"),
        ctl("Shop", role="payment"),
        ctl("Cancel", x=100),
    ]
    out = build_overlay(perception(window(controls)), NOW, auto_mode=True)
    assert out["ok"] is True
    assert names(out) == ["Save", "Cancel"]
    assert [t["n"] for t in out["targets"]] == [1, 2]


def test_a_word_inside_another_word_is_not_a_secret():
    out = build_overlay(perception(window([ctl("Pinned items"), ctl("Spinner")])), NOW, auto_mode=True)
    assert names(out) == ["Pinned items", "Spinner"]


def test_forty_controls_give_exactly_thirty_numbers():
    controls = [ctl(f"Item {i:02d}", y=i * 30) for i in range(40)]
    out = build_overlay(perception(window(controls)), NOW, auto_mode=True)
    assert len(out["targets"]) == MAX_TARGETS == 30
    assert [t["n"] for t in out["targets"]] == list(range(1, 31))
    assert names(out)[0] == "Item 00" and names(out)[-1] == "Item 29"


def test_limit_is_capped_at_thirty():
    controls = [ctl(f"Item {i:02d}", y=i * 30) for i in range(40)]
    assert len(build_overlay(perception(window(controls)), NOW, auto_mode=True, limit=5)["targets"]) == 5
    assert len(build_overlay(perception(window(controls)), NOW, auto_mode=True, limit=99)["targets"]) == 30


def test_order_is_focused_window_first_then_rows_then_columns_and_is_stable():
    other = window([ctl("Other", x=0, y=0)], title="Other", focused=False, wid="id:Other")
    main = window(
        [
            ctl("Low left", x=0, y=200),
            ctl("Top right", x=300, y=100),
            ctl("Top left", x=10, y=104),  # inside the 8 px row tolerance of the one above
            ctl("Mid", x=50, y=150),
        ]
    )
    shuffled = perception(other, main)
    first = build_overlay(shuffled, NOW, auto_mode=True)
    assert names(first) == ["Top left", "Top right", "Mid", "Low left", "Other"]
    again = build_overlay(perception(other, main), NOW, auto_mode=True)
    assert again == first


def test_each_target_carries_selector_intent_and_bounds():
    controls = [
        ctl("Save", patterns=("Invoke",)),
        ctl("Dark mode", x=100, patterns=("Toggle",)),
        ctl("Row", x=200, patterns=("SelectionItem",)),
        ctl("More", x=300, patterns=("ExpandCollapse",)),
    ]
    out = build_overlay(perception(window(controls)), NOW, auto_mode=True)
    assert [t["intent"] for t in out["targets"]] == ["click", "toggle", "select", "expand"]
    first = out["targets"][0]
    assert first["selector"] == "id:Save" and first["role"] == "button"
    assert first["bounds"] == {"x": 0, "y": 0, "w": 80, "h": 24}
    assert out["freshAt"] == NOW and out["expiresAt"] == NOW + TTL_MS


def test_names_are_trimmed_to_forty_and_scrubbed():
    long_name = "Open the very long settings page for the account\n  details"
    out = build_overlay(perception(window([ctl(long_name), ctl("Send 4111111111111111 now", x=200)])), NOW, True)
    first, second = out["targets"]
    assert len(first["name"]) <= 40 and "\n" not in first["name"] and "  " not in first["name"]
    assert "4111111111111111" not in second["name"]


def test_resolve_target_ok_expired_missing_and_stale_window():
    out = build_overlay(perception(window([ctl("Save"), ctl("Cancel", x=100)])), NOW, auto_mode=True)
    ok = resolve_target(out, 2, NOW + 1000)
    assert ok["via"] == "ok" and ok["target"]["name"] == "Cancel"
    assert resolve_target(out, 2, NOW + TTL_MS)["via"] == "ok"
    assert resolve_target(out, 2, NOW + TTL_MS + 1)["via"] == "expired"
    assert "target" not in resolve_target(out, 2, NOW + TTL_MS + 1)
    for bad in (0, 3, 31, -1):
        assert resolve_target(out, bad, NOW)["via"] == "missing"
    assert resolve_target(out, 1, NOW, focused_window="id:Notes")["via"] == "ok"
    assert resolve_target(out, 1, NOW, focused_window="id:Browser")["via"] == "stale-window"


def test_a_refused_overlay_resolves_to_missing():
    refused = build_overlay(perception(window([ctl("Save")])), NOW, auto_mode=False)
    assert resolve_target(refused, 1, NOW)["via"] == "missing"
    assert resolve_target(None, 1, NOW)["via"] == "missing"


def test_a_non_number_is_missing_not_an_error():
    out = build_overlay(perception(window([ctl("Save")])), NOW, auto_mode=True)
    assert resolve_target(out, "1", NOW)["via"] == "missing"
    assert resolve_target(out, True, NOW)["via"] == "missing"


def test_speak_label_in_three_languages():
    out = build_overlay(perception(window([ctl("Save")])), NOW, auto_mode=True)
    target = out["targets"][0]
    assert speak_label(target, "en") == "1: Save button"
    assert speak_label(target, "hinglish") == "1 number: Save button"
    hindi = speak_label(target, "hi")
    assert hindi.startswith("1: Save") and "बटन" in hindi
    assert speak_label({**target, "name": ""}, "en") == "1: button"


def test_missing_perception_is_refused():
    assert build_overlay(None, NOW, auto_mode=True)["ok"] is False
    assert build_overlay({"ok": False}, NOW, auto_mode=True)["targets"] == []
