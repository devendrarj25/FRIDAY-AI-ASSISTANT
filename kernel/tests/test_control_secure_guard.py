"""Raw input and raw reads fail closed on a secure prompt or a password field.

The UI Automation tree is injected, so these run without a Windows desktop.
"""

import asyncio
import importlib
import sys
import types
from pathlib import Path
from typing import Any
from unittest import mock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import control  # noqa: E402
from uia_tree import secure_refusal  # noqa: E402

pytest.importorskip("httpx", reason="tool registry needs the kernel runtime deps")
# By name: the repository root also has a `tools/` folder, and the kernel module is meant here.
ToolRegistry = importlib.import_module("tools").ToolRegistry


def _node(name: str, x: int, y: int, w: int, h: int, **extra: Any) -> dict[str, Any]:
    return {"name": name, "controlType": "Edit", "bounds": {"x": x, "y": y, "w": w, "h": h}, **extra}


def _login_tree(password_focused: bool = True) -> dict[str, Any]:
    return {
        "monitors": [{"x": 0, "y": 0, "w": 1920, "h": 1080, "dpi": 96}],
        "windows": [
            {
                "name": "Sign in - Browser",
                "controlType": "Window",
                "focused": True,
                "bounds": {"x": 0, "y": 0, "w": 1920, "h": 1080},
                "children": [
                    _node("User name", 100, 100, 300, 30, focused=not password_focused),
                    _node("Password", 100, 200, 300, 30, isPassword=True, focused=password_focused),
                ],
            }
        ],
    }


def _plain_tree() -> dict[str, Any]:
    return {
        "monitors": [{"x": 0, "y": 0, "w": 1920, "h": 1080, "dpi": 96}],
        "windows": [
            {
                "name": "Untitled - Notepad",
                "controlType": "Window",
                "focused": True,
                "bounds": {"x": 0, "y": 0, "w": 1920, "h": 1080},
                "children": [_node("Text editor", 0, 40, 1920, 1000, focused=True)],
            }
        ],
    }


def _credential_tree() -> dict[str, Any]:
    return {
        "windows": [
            {
                "name": "Windows Security",
                "className": "Credential Dialog Xaml Host",
                "focused": True,
                "bounds": {"x": 600, "y": 300, "w": 500, "h": 400},
                "children": [_node("Enter your credentials", 620, 400, 400, 30)],
            }
        ]
    }


class _Gui:
    def __init__(self, at: tuple[int, int] = (5, 5)):
        self.calls: list[tuple[Any, ...]] = []
        self.at = at

    def typewrite(self, text, interval=0.0):
        self.calls.append(("typewrite", text))

    def hotkey(self, *keys):
        self.calls.append(("hotkey", keys))

    def position(self):
        return self.at

    def click(self, **kwargs):
        self.calls.append(("click", kwargs))

    def scroll(self, amount, x=None, y=None):
        self.calls.append(("scroll", amount, x, y))

    def moveTo(self, x, y):
        self.calls.append(("moveTo", x, y))

    def dragTo(self, x, y, duration=0.0, button="left"):
        self.calls.append(("dragTo", x, y))


@pytest.fixture
def gui(monkeypatch):
    fake = _Gui()
    monkeypatch.setattr(control, "_pyautogui", lambda: fake)
    return fake


def _tree(monkeypatch, raw: dict[str, Any] | None = None, error: Exception | None = None) -> list[str]:
    seen: list[str] = []

    def collect() -> dict[str, Any]:
        seen.append("collect")
        if error is not None:
            raise error
        return raw or {}

    monkeypatch.setattr(control, "_uia_raw", collect)
    return seen


# ------------------------------------------------------------------ typing


def test_type_with_no_target_refuses_a_focused_password_field(monkeypatch, gui):
    _tree(monkeypatch, _login_tree())
    with pytest.raises(control.ControlError, match="password"):
        control.type_text("hunter2")
    assert gui.calls == []


def test_type_refuses_when_the_screen_cannot_be_checked(monkeypatch, gui):
    _tree(monkeypatch, error=RuntimeError("UI Automation is unavailable"))
    with pytest.raises(control.ControlError, match="could not check"):
        control.type_text("hello")
    assert gui.calls == []


def test_type_refuses_a_credential_dialog(monkeypatch, gui):
    _tree(monkeypatch, _credential_tree())
    with pytest.raises(control.ControlError, match="needs the owner"):
        control.type_text("hello")
    assert gui.calls == []


def test_type_into_an_ordinary_field_still_works(monkeypatch, gui):
    _tree(monkeypatch, _plain_tree())
    result = control.type_text("hello")
    assert result["ok"] is True
    assert gui.calls == [("typewrite", "hello")]


def test_the_check_runs_after_focus_moves(monkeypatch, gui):
    order: list[str] = []
    monkeypatch.setattr(control, "focus_window", lambda title, hwnd: order.append("focus") or {"hwnd": hwnd})

    def collect() -> dict[str, Any]:
        order.append("check")
        return _login_tree()

    monkeypatch.setattr(control, "_uia_raw", collect)
    with pytest.raises(control.ControlError):
        control.type_text("hunter2", hwnd=42)
    assert order == ["focus", "check"]
    assert gui.calls == []


def test_hotkey_refuses_a_focused_password_field(monkeypatch, gui):
    _tree(monkeypatch, _login_tree())
    with pytest.raises(control.ControlError, match="password"):
        control.hotkey(["ctrl", "v"])
    assert gui.calls == []


def test_hotkey_refuses_when_the_screen_cannot_be_checked(monkeypatch, gui):
    _tree(monkeypatch, error=RuntimeError("no UIA"))
    with pytest.raises(control.ControlError):
        control.hotkey(["ctrl", "v"])
    assert gui.calls == []


# ------------------------------------------------------------------ pointer


def test_click_on_a_password_field_is_refused_even_when_it_is_not_focused(monkeypatch, gui):
    _tree(monkeypatch, _login_tree(password_focused=False))
    with pytest.raises(control.ControlError, match="password"):
        control.click(x=150, y=210)
    assert gui.calls == []


def test_click_elsewhere_on_the_same_page_still_works(monkeypatch, gui):
    _tree(monkeypatch, _login_tree(password_focused=False))
    result = control.click(x=150, y=110)
    assert result["at"] == [150, 110]
    assert gui.calls and gui.calls[0][0] == "click"


def test_click_at_the_cursor_hit_tests_the_cursor(monkeypatch):
    fake = _Gui(at=(120, 215))
    monkeypatch.setattr(control, "_pyautogui", lambda: fake)
    _tree(monkeypatch, _login_tree(password_focused=False))
    with pytest.raises(control.ControlError, match="password"):
        control.click()
    assert fake.calls == []


def test_click_on_a_credential_dialog_is_refused(monkeypatch, gui):
    _tree(monkeypatch, _credential_tree())
    with pytest.raises(control.ControlError, match="needs the owner"):
        control.click(x=10, y=10)
    assert gui.calls == []


def test_scroll_and_drag_hit_test_their_points(monkeypatch, gui):
    _tree(monkeypatch, _login_tree(password_focused=False))
    with pytest.raises(control.ControlError, match="password"):
        control.scroll(-3, x=150, y=210)
    with pytest.raises(control.ControlError, match="password"):
        control.drag(10, 10, 150, 210)
    assert gui.calls == []
    assert control.scroll(-3, x=10, y=10)["ok"] is True


# ------------------------------------------------------------------ reading


class _Ocr:
    """Fakes mss and pytesseract so a read that slips through is visible."""

    def __init__(self):
        self.grabbed = 0
        outer = self

        class Sct:
            monitors = [None, {"left": 0, "top": 0, "width": 2, "height": 2}]

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def grab(self, box):
                outer.grabbed += 1
                return types.SimpleNamespace(size=(2, 2), bgra=bytes(16))

        class Tess:
            tesseract_cmd = "tesseract"

        self.mss = types.SimpleNamespace(mss=lambda: Sct())
        self.py = types.SimpleNamespace(
            pytesseract=Tess, image_to_string=lambda _image, lang: "Enter your password: secret"
        )

    def run(self, **kwargs):
        pil: Any = types.ModuleType("PIL")
        image = types.SimpleNamespace(frombytes=lambda *a, **k: object())
        pil.Image = image
        with (
            mock.patch.object(control, "_require", side_effect=lambda m, p: self.mss if m == "mss" else self.py),
            mock.patch.object(control, "_tesseract_binary", return_value="/opt/tesseract"),
            mock.patch.object(control, "_tesseract_languages", return_value=["eng"]),
            mock.patch.dict(sys.modules, {"PIL": pil, "PIL.Image": image}),
        ):
            return control.read_text(**kwargs)


def test_read_text_on_a_credential_dialog_returns_no_text(monkeypatch):
    _tree(monkeypatch, _credential_tree())
    ocr = _Ocr()
    with pytest.raises(control.ControlError, match="needs the owner"):
        ocr.run()
    assert ocr.grabbed == 0


def test_read_text_with_a_focused_password_field_returns_no_text(monkeypatch):
    _tree(monkeypatch, _login_tree())
    ocr = _Ocr()
    with pytest.raises(control.ControlError, match="password"):
        ocr.run(region=[0, 0, 10, 10])
    assert ocr.grabbed == 0


def test_read_text_on_an_ordinary_screen_still_reads(monkeypatch):
    _tree(monkeypatch, _plain_tree())
    ocr = _Ocr()
    assert "secret" in ocr.run()["text"]
    assert ocr.grabbed == 1


def test_clipboard_read_refuses_while_a_credential_dialog_is_up(monkeypatch):
    _tree(monkeypatch, _credential_tree())
    monkeypatch.setattr(control, "WINDOWS", True)
    opened: list[int] = []
    user32 = types.SimpleNamespace(OpenClipboard=lambda _h: opened.append(1) or 1)
    monkeypatch.setattr(control, "_windows_clipboard", lambda: (None, user32, None))
    with pytest.raises(control.ControlError, match="needs the owner"):
        control.clipboard_read()
    assert opened == []


# ------------------------------------------------------------------ tool path


def test_the_input_type_tool_goes_through_the_guard(monkeypatch, gui):
    _tree(monkeypatch, _login_tree())
    with pytest.raises(control.ControlError, match="password"):
        asyncio.run(ToolRegistry._input_type(mock.Mock(), {"text": "hunter2"}))
    assert gui.calls == []


def test_the_read_text_tool_goes_through_the_guard(monkeypatch):
    _tree(monkeypatch, _credential_tree())
    called: list[int] = []
    monkeypatch.setattr(control, "_read_text_unchecked", lambda *a, **k: called.append(1) or {"text": "x"})
    with pytest.raises(control.ControlError):
        asyncio.run(ToolRegistry._screen_read_text(mock.Mock(), {}))
    assert called == []


# ------------------------------------------------------------------ pure rule


def test_secure_refusal_rules():
    assert secure_refusal(_plain_tree()) is None
    assert secure_refusal(_credential_tree()) == "credential"
    uac = {"windows": [{"name": "User Account Control", "children": []}]}
    assert secure_refusal(uac) == "uac"
    nested = _login_tree()
    assert secure_refusal(nested) == "password"
    calm = _login_tree(password_focused=False)
    assert secure_refusal(calm) is None
    assert secure_refusal(calm, [(150, 210)]) == "password"
    assert secure_refusal(calm, [(150, 110)]) is None
    assert secure_refusal(None) is None


def test_secure_refusal_survives_a_cyclic_tree():
    root: dict[str, Any] = {"name": "Loop", "children": []}
    root["children"].append(root)
    assert secure_refusal({"root": root}, [(1, 1)]) is None
