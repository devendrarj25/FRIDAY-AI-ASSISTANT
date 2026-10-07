"""FRIDAY — real Windows PC/app control.

Every function here performs a real action on the machine. Nothing is
simulated: when a dependency (pywin32, PyAutoGUI, mss, pytesseract/Tesseract)
is missing, the call fails with the exact package to install from the Install
Manager instead of pretending it worked.

All of these are registered as `exec` risk in kernel/tools.py, so they can only
run after the owner approves them in the desktop approval prompt.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
from typing import Any

from env_guard import child_env

WINDOWS = sys.platform.startswith("win")


class ControlError(RuntimeError):
    """Raised with an actionable message when a real action cannot be done."""


def _require(module: str, package: str):
    try:
        return __import__(module)
    except Exception as exc:  # pragma: no cover - depends on the machine
        raise ControlError(
            f"{package} is not installed in FRIDAY's Python runtime "
            f"(import {module} failed: {exc}). Install “{package}” from the "
            f"Install Manager, then retry."
        ) from exc


def _win32():
    if not WINDOWS:
        raise ControlError("window control is only available on Windows")
    _require("win32gui", "pywin32")
    import win32con  # noqa: F401  (imported for the caller)
    import win32gui
    import win32process

    return win32gui, win32process


def _pyautogui():
    gui = _require("pyautogui", "PyAutoGUI")
    gui.FAILSAFE = True
    return gui


# ------------------------------------------------------------------ windows


def list_windows() -> dict[str, Any]:
    win32gui, win32process = _win32()
    found: list[dict[str, Any]] = []

    def visit(hwnd: int, _ctx) -> None:
        if not win32gui.IsWindowVisible(hwnd):
            return
        title = win32gui.GetWindowText(hwnd)
        if not title.strip():
            return
        try:
            _, pid = win32process.GetWindowThreadProcessId(hwnd)
        except Exception:
            pid = None
        found.append({"hwnd": hwnd, "title": title, "pid": pid})

    win32gui.EnumWindows(visit, None)
    return {"ok": True, "windows": found, "count": len(found)}


def _resolve_window(title: str | None = None, hwnd: int | None = None) -> tuple[int, str]:
    win32gui, _ = _win32()
    if hwnd:
        text = win32gui.GetWindowText(int(hwnd))
        return int(hwnd), text
    if not title:
        raise ControlError("a window title or hwnd is required")
    needle = title.lower()
    for window in list_windows()["windows"]:
        if needle in window["title"].lower():
            return window["hwnd"], window["title"]
    raise ControlError(f"no visible window matching “{title}”")


def focus_window(title: str | None = None, hwnd: int | None = None) -> dict[str, Any]:
    win32gui, _ = _win32()
    import win32con

    handle, text = _resolve_window(title, hwnd)
    if win32gui.IsIconic(handle):
        win32gui.ShowWindow(handle, win32con.SW_RESTORE)
    try:
        win32gui.SetForegroundWindow(handle)
    except Exception as exc:
        raise ControlError(f"Windows refused focus for “{text}”: {exc}") from exc
    time.sleep(0.15)
    active = win32gui.GetForegroundWindow()
    return {"ok": active == handle, "hwnd": handle, "title": text, "foreground": active == handle}


def close_window(title: str | None = None, hwnd: int | None = None) -> dict[str, Any]:
    win32gui, _ = _win32()
    import win32con

    handle, text = _resolve_window(title, hwnd)
    win32gui.PostMessage(handle, win32con.WM_CLOSE, 0, 0)
    time.sleep(0.4)
    still_open = bool(win32gui.IsWindow(handle) and win32gui.IsWindowVisible(handle))
    return {"ok": not still_open, "hwnd": handle, "title": text, "closed": not still_open}


# ------------------------------------------------------------ applications


def launch_app(app: str, args: list[str] | None = None, cwd: str | None = None) -> dict[str, Any]:
    """Start a real application by name or absolute path."""
    if not app or not str(app).strip():
        raise ControlError("an application name or path is required")
    app = str(app).strip()
    args = [str(a) for a in (args or [])]
    target = app if os.path.isabs(app) and os.path.exists(app) else (shutil.which(app) or app)
    try:
        if os.path.exists(target):
            # A launched application inherits the environment MINUS FRIDAY's
            # own credentials — a model-chosen app is not a trusted child.
            proc = subprocess.Popen(
                [target, *args], cwd=cwd or None, close_fds=True, env=child_env()
            )
            pid = proc.pid
        elif WINDOWS:
            # Shell resolution (Start-menu names, file associations, URLs).
            quoted = " ".join(f'"{a}"' if " " in a else a for a in args)
            proc = subprocess.Popen(
                f'start "" "{app}" {quoted}'.strip(), shell=True, cwd=cwd or None, env=child_env()
            )
            pid = proc.pid
        else:
            raise ControlError(f"“{app}” was not found on PATH")
    except ControlError:
        raise
    except Exception as exc:
        raise ControlError(f"could not launch “{app}”: {exc}") from exc
    time.sleep(0.6)
    return {"ok": True, "app": app, "resolved": target, "pid": pid}


# ------------------------------------------------------------------- input


def _focus_if_asked(target: str | None, hwnd: int | None) -> dict[str, Any] | None:
    if target or hwnd:
        return focus_window(target, hwnd)
    return None


def invoke_pattern(selector: str, intent: str, value: str = "") -> dict[str, Any]:
    """Prefer a UI Automation pattern. Off Windows this fails closed."""
    if not WINDOWS:
        raise ControlError("UI Automation actions are only available on Windows")
    from uia_tree import perception_from_raw, prefer_pattern, resolve_control
    from uia_windows import collect_uia_raw, perform_pattern

    try:
        raw = collect_uia_raw()
    except Exception as exc:
        raise ControlError(str(exc)) from exc
    seen = perception_from_raw(raw, int(time.time() * 1000))
    if seen.get("handoff"):
        raise ControlError("A secure prompt needs the owner")
    resolved = resolve_control(seen, selector)
    if resolved["via"] == "wrong-window":
        raise ControlError("focus is on a different window")
    if resolved["via"] == "missing":
        raise ControlError("control is not in the fresh tree")
    if resolved["via"] == "disabled":
        raise ControlError("That control is disabled")
    choice = prefer_pattern(resolved.get("control"), intent)
    if choice["via"] == "handoff":
        raise ControlError("That control needs the owner")
    if choice["via"] == "disabled":
        raise ControlError("That control is disabled")
    if choice["via"] != "pattern":
        raise ControlError("no pattern")
    try:
        return perform_pattern(str(resolved["control"]["selector"]), choice["pattern"], value)
    except Exception as exc:
        raise ControlError(str(exc)) from exc


def type_text(
    text: str,
    target: str | None = None,
    hwnd: int | None = None,
    interval: float = 0.01,
) -> dict[str, Any]:
    if text is None:
        raise ControlError("text is required")
    if WINDOWS and target:
        try:
            return invoke_pattern(str(target), "type", str(text))
        except ControlError as exc:
            if "no pattern" not in str(exc):
                raise
    gui = _pyautogui()
    focused = _focus_if_asked(target, hwnd)
    gui.typewrite(str(text), interval=max(0.0, float(interval)))
    return {"ok": True, "typed": len(str(text)), "window": focused}


def hotkey(keys: list[str], target: str | None = None, hwnd: int | None = None) -> dict[str, Any]:
    if not keys:
        raise ControlError("at least one key is required")
    gui = _pyautogui()
    focused = _focus_if_asked(target, hwnd)
    gui.hotkey(*[str(k).lower() for k in keys])
    return {"ok": True, "keys": keys, "window": focused}


def click(
    x: int | None = None,
    y: int | None = None,
    button: str = "left",
    clicks: int = 1,
    target: str | None = None,
    hwnd: int | None = None,
) -> dict[str, Any]:
    if WINDOWS and target and x is None and y is None:
        try:
            return invoke_pattern(str(target), "click")
        except ControlError as exc:
            if "no pattern" not in str(exc):
                raise
    gui = _pyautogui()
    focused = _focus_if_asked(target, hwnd)
    if button not in {"left", "right", "middle"}:
        raise ControlError("button must be left, right or middle")
    if x is None or y is None:
        position = gui.position()
        gui.click(clicks=int(clicks), button=button)
        at = [int(position[0]), int(position[1])]
    else:
        gui.click(x=int(x), y=int(y), clicks=int(clicks), button=button)
        at = [int(x), int(y)]
    return {"ok": True, "at": at, "button": button, "clicks": int(clicks), "window": focused}


def scroll(
    amount: int = -3,
    x: int | None = None,
    y: int | None = None,
    target: str | None = None,
    hwnd: int | None = None,
) -> dict[str, Any]:
    gui = _pyautogui()
    focused = _focus_if_asked(target, hwnd)
    gui.scroll(int(amount), x=None if x is None else int(x), y=None if y is None else int(y))
    return {"ok": True, "amount": int(amount), "window": focused, "undoHint": "scroll back"}


def drag(
    x: int,
    y: int,
    x2: int,
    y2: int,
    target: str | None = None,
    hwnd: int | None = None,
) -> dict[str, Any]:
    gui = _pyautogui()
    focused = _focus_if_asked(target, hwnd)
    gui.moveTo(int(x), int(y))
    gui.dragTo(int(x2), int(y2), duration=0.2, button="left")
    return {
        "ok": True,
        "from": [int(x), int(y)],
        "to": [int(x2), int(y2)],
        "window": focused,
        "undoHint": "drag back",
    }


def clipboard_read() -> dict[str, Any]:
    if not WINDOWS:
        raise ControlError("clipboard control is only available on Windows")
    import ctypes

    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    if not user32.OpenClipboard(None):
        raise ControlError("Windows refused the clipboard")
    try:
        handle = user32.GetClipboardData(13)  # CF_UNICODETEXT
        if not handle:
            return {"ok": True, "text": "", "untrusted": True}
        pointer = kernel32.GlobalLock(handle)
        if not pointer:
            return {"ok": True, "text": "", "untrusted": True}
        try:
            text = ctypes.wstring_at(pointer)
        finally:
            kernel32.GlobalUnlock(handle)
    finally:
        user32.CloseClipboard()
    return {"ok": True, "text": text, "untrusted": True}


def clipboard_write(text: str) -> dict[str, Any]:
    if not WINDOWS:
        raise ControlError("clipboard control is only available on Windows")
    import ctypes

    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    data = str(text or "")
    if not user32.OpenClipboard(None):
        raise ControlError("Windows refused the clipboard")
    try:
        user32.EmptyClipboard()
        size = (len(data) + 1) * 2
        handle = kernel32.GlobalAlloc(0x0002, size)
        pointer = kernel32.GlobalLock(handle)
        ctypes.memmove(pointer, ctypes.create_unicode_buffer(data), size)
        kernel32.GlobalUnlock(handle)
        user32.SetClipboardData(13, handle)
    finally:
        user32.CloseClipboard()
    return {"ok": True, "chars": len(data), "undoHint": "restore the previous clipboard"}


def perceive() -> dict[str, Any]:
    """UI Automation tree, then OCR. Text is data. A secure prompt has no content."""
    if not WINDOWS:
        raise ControlError("structured screen perception is only available on Windows")
    from uia_tree import choose_layer, perception_from_raw
    from uia_windows import collect_uia_raw

    try:
        raw = collect_uia_raw()
    except Exception as exc:
        raise ControlError(str(exc)) from exc
    now = int(time.time() * 1000)
    seen = perception_from_raw(raw, now)
    if seen.get("handoff") or float(seen.get("confidence") or 0) >= 0.75:
        return seen
    try:
        ocr = read_text()
    except ControlError:
        return seen
    return choose_layer(
        [
            seen,
            {
                "ok": True,
                "source": "ocr",
                "confidence": 0.62,
                "untrusted": True,
                "freshAt": now,
                "text": str(ocr.get("text") or ""),
                "windows": [],
            },
        ]
    )


# ------------------------------------------------------------------ screen


def read_text(region: list[int] | None = None, lang: str = "eng") -> dict[str, Any]:
    """OCR the current screen (or a [left, top, width, height] region)."""
    mss_mod = _require("mss", "mss")
    pytesseract = _require("pytesseract", "pytesseract")
    if not shutil.which("tesseract") and not getattr(
        pytesseract.pytesseract, "tesseract_cmd", None
    ):
        raise ControlError(
            "the Tesseract OCR engine was not found on PATH. Install “Tesseract OCR” "
            "from the Install Manager, then retry."
        )
    from PIL import Image  # Pillow ships with pytesseract usage

    with mss_mod.mss() as sct:
        if region and len(region) == 4:
            box = {
                "left": int(region[0]),
                "top": int(region[1]),
                "width": int(region[2]),
                "height": int(region[3]),
            }
        else:
            box = sct.monitors[1]
        shot = sct.grab(box)
    image = Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")
    text = pytesseract.image_to_string(image, lang=lang)
    return {
        "ok": True,
        "region": [box["left"], box["top"], box["width"], box["height"]],
        "chars": len(text),
        "text": text,
    }
