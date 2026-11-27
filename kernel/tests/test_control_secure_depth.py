"""The raw-input guard holds when the UI tree is cut short, unreadable, or changes mid-action.

Everything is injected (`_uia_raw`, `_uia_focus`, a fake pointer and keyboard), so
these run without a Windows desktop.
"""

import sys
import types
from pathlib import Path
from typing import Any
from unittest import mock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import control  # noqa: E402
from uia_tree import secure_refusal  # noqa: E402

MONITORS = [{"x": 0, "y": 0, "w": 1920, "h": 1080, "dpi": 96}]


def _page(**top: Any) -> dict[str, Any]:
    """A browser page whose tree was cut: only the shell is in the tree."""
    return {
        "monitors": MONITORS,
        "windows": [
            {
                "name": "Sign in - Browser",
                "controlType": "Window",
                "focused": True,
                "bounds": {"x": 0, "y": 0, "w": 1920, "h": 1080},
                "children": [],
            }
        ],
        **top,
    }


def _focus(**extra: Any) -> dict[str, Any]:
    base = {"controlType": "Edit", "isPassword": False, "name": "Search", "className": "", "runtimeId": [42, 1]}
    return {**base, **extra}


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


def _raw(monkeypatch, raw: dict[str, Any] | None = None, error: Exception | None = None) -> None:
    def collect() -> dict[str, Any]:
        if error is not None:
            raise error
        return raw or {}

    monkeypatch.setattr(control, "_uia_raw", collect)


# --------------------------------------------- F1: the focused element, read directly


def test_a_deep_focused_password_is_refused_even_though_the_walk_never_reached_it(monkeypatch, gui):
    _raw(monkeypatch, _page(truncated=True, focusedElement=_focus(isPassword=True, controlType="Password")))
    with pytest.raises(control.ControlError, match="password"):
        control.type_text("hunter2")
    with pytest.raises(control.ControlError, match="password"):
        control.hotkey(["ctrl", "v"])
    assert gui.calls == []


def test_keys_are_refused_when_the_walk_was_cut_and_the_focus_cannot_be_read(monkeypatch, gui):
    _raw(monkeypatch, _page(truncated=True, focusedElement=None))
    with pytest.raises(control.ControlError, match="could not check"):
        control.type_text("hello")
    with pytest.raises(control.ControlError, match="could not check"):
        control.hotkey(["ctrl", "v"])
    assert gui.calls == []


def test_keys_are_allowed_when_the_walk_was_cut_but_the_focus_is_a_plain_field(monkeypatch, gui):
    _raw(monkeypatch, _page(truncated=True, focusedElement=_focus()))
    assert control.type_text("hello")["ok"] is True
    assert control.hotkey(["ctrl", "v"])["ok"] is True
    assert [c[0] for c in gui.calls] == ["typewrite", "hotkey"]


def test_a_whole_tree_with_no_focus_reading_still_types(monkeypatch, gui):
    _raw(monkeypatch, _page())
    assert control.type_text("hello")["ok"] is True


def test_a_cut_walk_does_not_stop_a_pointer_action(monkeypatch, gui):
    _raw(monkeypatch, _page(truncated=True, focusedElement=None))
    assert control.click(x=10, y=10)["at"] == [10, 10]


def test_a_focused_credential_prompt_read_directly_is_refused(monkeypatch, gui):
    prompt = _focus(name="Windows Security", className="Credential Dialog Xaml Host")
    _raw(monkeypatch, _page(truncated=True, focusedElement=prompt))
    with pytest.raises(control.ControlError, match="needs the owner"):
        control.type_text("hello")


# --------------------------------------------- F5: reads and perception


class _Ocr:
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
        self.py = types.SimpleNamespace(pytesseract=Tess, image_to_string=lambda _image, lang: "visible words")

    def run(self, fn, *args, **kwargs):
        pil: Any = types.ModuleType("PIL")
        image = types.SimpleNamespace(frombytes=lambda *a, **k: object())
        pil.Image = image
        with (
            mock.patch.object(control, "_require", side_effect=lambda m, p: self.mss if m == "mss" else self.py),
            mock.patch.object(control, "_tesseract_binary", return_value="/opt/tesseract"),
            mock.patch.object(control, "_tesseract_languages", return_value=["eng"]),
            mock.patch.dict(sys.modules, {"PIL": pil, "PIL.Image": image}),
        ):
            return fn(*args, **kwargs)


def test_read_text_refuses_when_the_tree_cannot_be_read(monkeypatch):
    _raw(monkeypatch, error=RuntimeError("UI Automation is unavailable"))
    ocr = _Ocr()
    with pytest.raises(control.ControlError, match="could not check"):
        ocr.run(control.read_text)
    assert ocr.grabbed == 0


def test_read_text_refuses_a_deep_focused_password(monkeypatch):
    _raw(monkeypatch, _page(truncated=True, focusedElement=_focus(isPassword=True)))
    ocr = _Ocr()
    with pytest.raises(control.ControlError, match="password"):
        ocr.run(control.read_text)
    assert ocr.grabbed == 0


def test_clipboard_read_refuses_when_the_tree_cannot_be_read(monkeypatch):
    _raw(monkeypatch, error=RuntimeError("UI Automation is unavailable"))
    monkeypatch.setattr(control, "WINDOWS", True)
    opened: list[int] = []
    user32 = types.SimpleNamespace(OpenClipboard=lambda _h: opened.append(1) or 1)
    monkeypatch.setattr(control, "_windows_clipboard", lambda: (None, user32, None))
    with pytest.raises(control.ControlError, match="could not check"):
        control.clipboard_read()
    assert opened == []


def test_perceive_without_comtypes_does_not_ocr_a_screen_it_cannot_check(monkeypatch):
    monkeypatch.setattr(control, "WINDOWS", True)
    _raw(monkeypatch, error=RuntimeError("comtypes is not installed in FRIDAY's Python runtime."))
    called: list[int] = []
    monkeypatch.setattr(control, "_read_text_unchecked", lambda *a, **k: called.append(1) or {"text": "x"})
    with pytest.raises(control.ControlError, match="comtypes"):
        control.perceive()
    assert called == []


def test_perceive_second_ocr_skips_a_focused_password_field(monkeypatch):
    monkeypatch.setattr(control, "WINDOWS", True)
    thin = _page(truncated=True, focusedElement=_focus(isPassword=True, controlType="Password"))
    _raw(monkeypatch, thin)
    called: list[int] = []
    monkeypatch.setattr(control, "_read_text_unchecked", lambda *a, **k: called.append(1) or {"text": "x"})
    seen = control.perceive()
    assert called == []
    assert seen["source"] == "uia"
    assert "x" not in seen["text"]


def test_perceive_second_ocr_skips_when_the_focus_cannot_be_read_on_a_cut_tree(monkeypatch):
    monkeypatch.setattr(control, "WINDOWS", True)
    _raw(monkeypatch, _page(truncated=True, focusedElement=None))
    called: list[int] = []
    monkeypatch.setattr(control, "_read_text_unchecked", lambda *a, **k: called.append(1) or {"text": "x"})
    assert control.perceive()["source"] == "uia"
    assert called == []


def test_perceive_second_ocr_still_runs_on_an_ordinary_thin_tree(monkeypatch):
    monkeypatch.setattr(control, "WINDOWS", True)
    _raw(monkeypatch, _page(truncated=True, focusedElement=_focus()))
    called: list[int] = []
    monkeypatch.setattr(control, "_read_text_unchecked", lambda *a, **k: called.append(1) or {"text": "words"})
    control.perceive()
    assert called == [1]


# --------------------------------------------- F6: typing in chunks


def _focus_feed(monkeypatch, probes: list[Any]) -> list[str]:
    """`_uia_focus` hands out `probes` in order. An Exception is raised."""
    log: list[str] = []
    queue = list(probes)

    def read() -> Any:
        log.append("focus")
        item = queue.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    monkeypatch.setattr(control, "_uia_focus", read)
    return log


def test_typing_goes_in_chunks_of_eight_and_rechecks_the_focus_between_them(monkeypatch, gui):
    _raw(monkeypatch, _page(focusedElement=_focus()))
    log = _focus_feed(monkeypatch, [_focus(), _focus()])
    result = control.type_text("a" * 8 + "b" * 8 + "c" * 3)
    assert gui.calls == [("typewrite", "a" * 8), ("typewrite", "b" * 8), ("typewrite", "c" * 3)]
    assert result["typed"] == 19
    assert log == ["focus", "focus"]


def test_a_credential_prompt_that_appears_mid_typing_stops_the_rest(monkeypatch, gui):
    _raw(monkeypatch, _page(focusedElement=_focus()))
    prompt = _focus(name="Windows Security", className="Credential Dialog Xaml Host")
    _focus_feed(monkeypatch, [prompt])
    with pytest.raises(control.ControlError, match="needs the owner"):
        control.type_text("x" * 20)
    assert gui.calls == [("typewrite", "x" * 8)]


def test_focus_moving_onto_a_password_field_mid_typing_stops_the_rest(monkeypatch, gui):
    _raw(monkeypatch, _page(focusedElement=_focus()))
    _focus_feed(monkeypatch, [_focus(), _focus(isPassword=True, controlType="Password", runtimeId=[42, 2])])
    with pytest.raises(control.ControlError, match="password"):
        control.type_text("x" * 30)
    assert len(gui.calls) == 2


def test_focus_moving_to_another_field_mid_typing_stops_the_rest(monkeypatch, gui):
    _raw(monkeypatch, _page(focusedElement=_focus()))
    _focus_feed(monkeypatch, [_focus(runtimeId=[42, 9])])
    with pytest.raises(control.ControlError, match="focus changed"):
        control.type_text("x" * 20)
    assert gui.calls == [("typewrite", "x" * 8)]


def test_an_unreadable_focus_mid_typing_stops_the_rest(monkeypatch, gui):
    _raw(monkeypatch, _page(focusedElement=_focus()))
    _focus_feed(monkeypatch, [RuntimeError("secure desktop")])
    with pytest.raises(control.ControlError, match="could not check"):
        control.type_text("x" * 20)
    assert gui.calls == [("typewrite", "x" * 8)]


def test_a_short_text_is_one_chunk_and_never_rechecks(monkeypatch, gui):
    _raw(monkeypatch, _page(focusedElement=_focus()))
    log = _focus_feed(monkeypatch, [])
    control.type_text("12345678")
    assert gui.calls == [("typewrite", "12345678")]
    assert log == []


# --------------------------------------------- an unreadable tree stops the pointer too, and so does a nameless start


def test_click_and_drag_are_refused_when_the_screen_cannot_be_read(monkeypatch, gui):
    _raw(monkeypatch, error=RuntimeError("UI Automation is unavailable"))
    with pytest.raises(control.ControlError, match="could not check.*did not click"):
        control.click(x=10, y=10)
    with pytest.raises(control.ControlError, match="could not check.*did not click"):
        control.click()
    with pytest.raises(control.ControlError, match="could not check.*did not click"):
        control.drag(1, 2, 30, 40)
    assert gui.calls == []


def test_scroll_still_moves_when_the_screen_cannot_be_read(monkeypatch, gui):
    _raw(monkeypatch, error=RuntimeError("UI Automation is unavailable"))
    assert control.scroll(-3, x=10, y=10)["ok"] is True


def test_typing_in_chunks_is_refused_when_the_starting_field_has_no_runtime_id(monkeypatch, gui):
    _raw(monkeypatch, _page(focusedElement=_focus(runtimeId=None)))
    log = _focus_feed(monkeypatch, [_focus(), _focus()])
    with pytest.raises(control.ControlError, match="could not identify"):
        control.type_text("x" * 20)
    assert gui.calls == [] and log == []


def test_the_between_chunk_guard_fails_closed_without_a_starting_runtime_id(monkeypatch):
    monkeypatch.setattr(control, "_uia_focus", lambda: _focus())
    with pytest.raises(control.ControlError, match="could not identify"):
        control._focus_guard({"controlType": "Edit"})
    with pytest.raises(control.ControlError, match="could not identify"):
        control._focus_guard(None)


# --------------------------------------------- F13: a password with unknown bounds


def _tree_with_password(bounds: Any) -> dict[str, Any]:
    password: dict[str, Any] = {"name": "", "controlType": "Password", "isPassword": True}
    if bounds is not None:
        password["bounds"] = bounds
    return {
        "monitors": MONITORS,
        "windows": [
            {
                "name": "Sign in",
                "controlType": "Window",
                "focused": True,
                "bounds": {"x": 0, "y": 0, "w": 1920, "h": 1080},
                "children": [password],
            }
        ],
    }


@pytest.mark.parametrize(
    "bounds",
    [None, {"x": 0, "y": 0, "w": 0, "h": 0}, {"x": 5, "y": 5, "w": 0, "h": 30}, "garbage"],
)
def test_a_password_node_with_unknown_bounds_refuses_every_pointer_point(bounds):
    tree = _tree_with_password(bounds)
    assert secure_refusal(tree, [(900, 500)]) == "password"
    assert secure_refusal(tree) is None


def test_pointer_actions_refuse_a_page_with_a_boundless_password(monkeypatch, gui):
    _raw(monkeypatch, _tree_with_password({"x": 0, "y": 0, "w": 0, "h": 0}))
    with pytest.raises(control.ControlError, match="password"):
        control.click(x=900, y=500)
    with pytest.raises(control.ControlError, match="password"):
        control.scroll(-3, x=900, y=500)
    with pytest.raises(control.ControlError, match="password"):
        control.drag(1, 1, 900, 500)
    assert gui.calls == []


def test_a_password_with_real_bounds_still_only_blocks_its_own_box():
    tree = _tree_with_password({"x": 100, "y": 200, "w": 300, "h": 30})
    assert secure_refusal(tree, [(900, 500)]) is None
    assert secure_refusal(tree, [(150, 210)]) == "password"
