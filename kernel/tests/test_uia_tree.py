"""UI Automation fixtures normalize without a Windows desktop."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from uia_tree import choose_layer, perception_from_raw  # noqa: E402


def _monitors():
    return [
        {"x": 0, "y": 0, "w": 1920, "h": 1080, "dpi": 96},
        {"x": 1920, "y": 0, "w": 1920, "h": 1080, "dpi": 144},
    ]


def _tree():
    return {
        "monitors": _monitors(),
        "windows": [
            {
                "name": "Notes",
                "controlType": "Window",
                "automationId": "Notes",
                "className": "Notepad",
                "bounds": {"x": 10, "y": 20, "w": 400, "h": 300},
                "enabled": True,
                "focused": True,
                "children": [
                    {
                        "name": "Save",
                        "controlType": "Button",
                        "automationId": "SaveBtn",
                        "className": "Button",
                        "bounds": {"x": 2064, "y": 40, "w": 144, "h": 48},
                        "patterns": ["Invoke"],
                        "enabled": True,
                    },
                    {
                        "name": "Password",
                        "controlType": "Edit",
                        "isPassword": True,
                        "value": "s3cret-value",
                        "bounds": {"x": 40, "y": 80, "w": 120, "h": 24},
                    },
                ],
            }
        ],
    }


def test_tree_uses_one_coordinate_space_and_hides_password_text():
    seen = perception_from_raw(_tree(), 1000)
    assert seen["source"] == "uia"
    assert seen["untrusted"] is True
    assert seen["freshAt"] == 1000
    assert seen["confidence"] == 0.93
    blob = json.dumps(seen)
    assert "s3cret-value" not in blob
    save = next(row for row in seen["windows"][0]["controls"] if row["name"] == "Save")
    assert save["selector"] == "id:Notes/id:SaveBtn"
    assert save["patterns"] == ["Invoke"]
    assert save["bounds"] == {"x": 2016.0, "y": 26.67, "w": 96.0, "h": 32.0}
    assert save["monitor"] == 2
    password = next(row for row in seen["windows"][0]["controls"] if row["role"] == "password")
    assert password["value"] == ""


def test_secure_desktop_returns_handoff_with_no_content():
    raw = {
        "monitors": _monitors(),
        "windows": [
            {
                "name": "User Account Control",
                "controlType": "Window",
                "className": "$$$Secure UAP Dummy Window",
                "children": [{"name": "Yes", "value": "s3cret-value", "controlType": "Button"}],
            }
        ],
    }
    seen = perception_from_raw(raw, 5)
    assert seen["handoff"] == "uac"
    assert seen["windows"] == []
    assert seen["text"] == ""
    assert "s3cret-value" not in json.dumps(seen)
    assert "Yes" not in json.dumps(seen)


def test_budgets_stop_the_walk():
    raw = _tree()
    seen = perception_from_raw(raw, 8, {"maxDepth": 0, "maxNodes": 1, "maxMs": 10}, step_ms=0)
    assert seen["truncated"] is True
    assert seen["nodeCount"] == 1
    timed = perception_from_raw(raw, 8, {"maxDepth": 8, "maxNodes": 50, "maxMs": 1500}, step_ms=1000)
    assert timed["truncated"] is True
    assert timed["nodeCount"] == 1


def test_layer_keeps_a_handoff_ahead_of_ocr():
    uia = perception_from_raw(
        {"windows": [{"name": "Windows Security", "controlType": "Window", "value": "s3cret-value"}]},
        3,
    )
    picked = choose_layer(
        [uia, {"source": "ocr", "confidence": 0.9, "text": "s3cret-value", "windows": [{"title": "x"}]}]
    )
    assert picked["handoff"] == "credential"
    assert picked["text"] == ""
    assert picked["windows"] == []
    weak = choose_layer(
        [
            {"source": "uia", "confidence": 0.2, "untrusted": True},
            {"source": "ocr", "confidence": 0.62, "untrusted": True},
        ]
    )
    assert weak["source"] == "ocr"
    vision = choose_layer([{"source": "vision", "confidence": 0.41}])
    assert vision["source"] == "vision"
    assert vision["untrusted"] is True
