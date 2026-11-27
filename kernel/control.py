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
            proc = subprocess.Popen([target, *args], cwd=cwd or None, close_fds=True, env=child_env())
            pid = proc.pid
        elif WINDOWS:
            # `start` is a cmd builtin. An argument vector keeps Start-menu names
            # without concatenating a shell string.
            proc = subprocess.Popen(
                ["cmd", "/c", "start", "", app, *args],
                cwd=cwd or None,
                env=child_env(),
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


def _uia_raw() -> dict[str, Any]:
    """The raw UI Automation tree of the desktop. Tests replace this."""
    if not WINDOWS:
        raise ControlError("UI Automation is only available on Windows")
    from uia_windows import collect_uia_raw

    return collect_uia_raw()


def _uia_focus() -> dict[str, Any] | None:
    """Only the focused element, read directly. Tests replace this."""
    if not WINDOWS:
        raise ControlError("UI Automation is only available on Windows")
    from uia_windows import collect_focused

    return collect_focused()


# Keys reach whatever has focus, and a clipboard or screen read can hold a secret,
# so for these an unknown screen is a refusal.
_KEY_ACTIONS = frozenset({"type", "hotkey"})
_STRICT_ACTIONS = _KEY_ACTIONS | {"read_text", "clipboard_read"}
_TYPE_CHUNK = 8


def _secure_guard(action: str, points: list[tuple[float, float]] | None = None) -> dict[str, Any]:
    """Fail closed before a raw key, pointer or screen read. Returns the tree it checked.

    A secure prompt (UAC, Windows Security, a credential dialog), a focused password
    field (read directly, so a page deeper than the walk is covered), or a password
    field under a pointer point stops the action. When the tree cannot be read, or was
    cut short while the focused element cannot be read, keys and screen reads are
    refused; a pointer action keeps today's behaviour.
    """
    from uia_tree import focus_unverified, secure_refusal

    try:
        raw = _uia_raw()
    except Exception as exc:
        if action in _STRICT_ACTIONS:
            raise ControlError(
                "FRIDAY could not check the screen for a password field or a secure prompt, "
                f"so it did not {'press any key' if action in _KEY_ACTIONS else 'read the screen'} ({exc})"
            ) from exc
        return {}
    reason = secure_refusal(raw, points)
    if reason == "password":
        raise ControlError("That is a password field. The owner types or reads it, not FRIDAY")
    if reason:
        raise ControlError("A secure prompt is on screen and needs the owner")
    if action in _STRICT_ACTIONS and focus_unverified(raw):
        raise ControlError(
            "FRIDAY could not check the focused field for a password, and the screen is too deep to "
            "scan fully, so it did not " + ("press any key" if action in _KEY_ACTIONS else "read the screen")
        )
    return raw if isinstance(raw, dict) else {}


def _focus_guard(baseline: Any) -> None:
    """Between key chunks: the focused element is still the same ordinary field."""
    from uia_tree import secure_refusal

    try:
        probe = _uia_focus()
    except Exception as exc:
        raise ControlError(
            f"FRIDAY could not check the screen for a password field or a secure prompt, so it stopped typing ({exc})"
        ) from exc
    if not isinstance(probe, dict):
        raise ControlError(
            "FRIDAY could not check the screen for a password field or a secure prompt, so it stopped typing"
        )
    reason = secure_refusal({"focusedElement": probe})
    if reason == "password":
        raise ControlError("That is a password field. The owner types or reads it, not FRIDAY")
    if reason:
        raise ControlError("A secure prompt is on screen and needs the owner")
    start = baseline.get("runtimeId") if isinstance(baseline, dict) else None
    if start and probe.get("runtimeId") != start:
        raise ControlError("The focus changed while FRIDAY was typing, so it stopped")


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
    if choice["via"] == "offscreen":
        raise ControlError("That control is off screen")
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
    body = str(text)
    chunks = [body[i : i + _TYPE_CHUNK] for i in range(0, len(body), _TYPE_CHUNK)] or [""]
    baseline: Any = None
    typed = 0
    for index, chunk in enumerate(chunks):
        try:
            if index == 0:
                seen = _secure_guard("type")
                baseline = seen.get("focusedElement")
            else:
                _focus_guard(baseline)
        except ControlError as exc:
            if not typed:
                raise
            raise ControlError(f"{exc} (typed {typed} of {len(body)} characters)") from exc
        gui.typewrite(chunk, interval=max(0.0, float(interval)))
        typed += len(chunk)
    return {"ok": True, "typed": len(body), "window": focused}


def hotkey(keys: list[str], target: str | None = None, hwnd: int | None = None) -> dict[str, Any]:
    if not keys:
        raise ControlError("at least one key is required")
    gui = _pyautogui()
    focused = _focus_if_asked(target, hwnd)
    _secure_guard("hotkey")
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
        _secure_guard("click", [(float(position[0]), float(position[1]))])
        gui.click(clicks=int(clicks), button=button)
        at = [int(position[0]), int(position[1])]
    else:
        _secure_guard("click", [(float(x), float(y))])
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
    if x is None or y is None:
        position = gui.position()
        point = (float(position[0]), float(position[1]))
    else:
        point = (float(x), float(y))
    _secure_guard("scroll", [point])
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
    _secure_guard("drag", [(float(x), float(y)), (float(x2), float(y2))])
    gui.moveTo(int(x), int(y))
    gui.dragTo(int(x2), int(y2), duration=0.2, button="left")
    return {
        "ok": True,
        "from": [int(x), int(y)],
        "to": [int(x2), int(y2)],
        "window": focused,
        "undoHint": "drag back",
    }


def _windows_clipboard():
    """user32 and kernel32. Missing on a non-Windows type stub, so look them up."""
    import ctypes

    windll = getattr(ctypes, "windll", None)
    if windll is None:
        raise ControlError("clipboard control is only available on Windows")
    return ctypes, windll.user32, windll.kernel32


def clipboard_read() -> dict[str, Any]:
    if not WINDOWS:
        raise ControlError("clipboard control is only available on Windows")
    _secure_guard("clipboard_read")
    ctypes, user32, kernel32 = _windows_clipboard()
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
    ctypes, user32, kernel32 = _windows_clipboard()
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
    """UI Automation tree, then OCR. Text is data. A secure prompt has no content.

    OCR runs only after the same secure check as `read_text`: without the tree (no
    comtypes) FRIDAY cannot rule out a focused password field, so it does not read the
    screen at all, and a thin tree with a focused password field keeps its structure only.
    """
    if not WINDOWS:
        raise ControlError("structured screen perception is only available on Windows")
    from uia_tree import choose_layer, comtypes_missing, focus_unverified, perception_from_raw, secure_refusal

    now = int(time.time() * 1000)
    try:
        raw = _uia_raw()
    except Exception as exc:
        if comtypes_missing(str(exc)):
            raise ControlError(
                "comtypes is not installed in FRIDAY's Python runtime, so FRIDAY cannot check the screen "
                "for a password field and did not read it with OCR either."
            ) from exc
        raise ControlError(str(exc)) from exc
    seen = perception_from_raw(raw, now)
    if seen.get("handoff") or float(seen.get("confidence") or 0) >= 0.75:
        return seen
    if secure_refusal(raw) or focus_unverified(raw):
        return seen
    try:
        ocr = _read_text_unchecked()
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


def _tesseract_binary() -> str | None:
    """The Tesseract engine: PATH (with the folders FRIDAY manages) first, then where its installer puts it.

    The UB-Mannheim installer does not add itself to PATH, so a kernel started before any PATH refresh would
    otherwise report the engine as missing while it sits in Program Files.
    """
    env = child_env()
    found = shutil.which("tesseract", path=env.get("PATH") or env.get("Path"))
    if found or not WINDOWS:
        return found
    for base in (env.get("ProgramFiles"), env.get("ProgramFiles(x86)")):
        if base:
            candidate = os.path.join(base, "Tesseract-OCR", "tesseract.exe")
            if os.path.isfile(candidate):
                return candidate
    local = env.get("LOCALAPPDATA")
    if local:
        candidate = os.path.join(local, "Programs", "Tesseract-OCR", "tesseract.exe")
        if os.path.isfile(candidate):
            return candidate
    return None


def _user_tessdata() -> str:
    """The per-user data folder setup falls back to when Program Files is not writable."""
    local = os.environ.get("LOCALAPPDATA") or os.path.join(os.environ.get("USERPROFILE", ""), "AppData", "Local")
    return os.path.join(local, "FRIDAY", "tools", "tessdata") if WINDOWS and local else ""


def _tesseract_languages(binary: str, env: dict[str, str] | None = None) -> list[str]:
    """The language codes `tesseract --list-langs` reports (the list is on stdout or stderr by version)."""
    try:
        run = subprocess.run(
            [binary, "--list-langs"],
            capture_output=True,
            text=True,
            timeout=8,
            env=env if env is not None else child_env(),
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    codes: list[str] = []
    seen_header = False
    for raw in f"{run.stdout or ''}\n{run.stderr or ''}".splitlines():
        line = raw.strip()
        if line.lower().startswith("list of available languages"):
            seen_header = True
        elif seen_header and line.replace("_", "").isalnum():
            codes.append(line)
    return codes


_OCR_LANG_CACHE: dict[str, tuple[float, str]] = {}


def ocr_language(binary: str) -> str:
    """`hin+eng` when the Hindi data is installed (Hindi, English and Hinglish screens), else `eng`.

    Detects with `tesseract --list-langs`; when only the per-user data folder has it, TESSDATA_PREFIX is pointed
    there for this process (eng and osd are copied beside it by setup). Cached for a minute.
    """
    now = time.monotonic()
    hit = _OCR_LANG_CACHE.get(binary)
    if hit and now - hit[0] < 60:
        return hit[1]

    def pick(codes: list[str]) -> str:
        if "hin" not in codes:
            return ""
        return "hin+eng" if "eng" in codes else "hin"

    lang = pick(_tesseract_languages(binary))
    if not lang:
        folder = _user_tessdata()
        if folder and os.path.isfile(os.path.join(folder, "hin.traineddata")):
            lang = pick(_tesseract_languages(binary, child_env(extra={"TESSDATA_PREFIX": folder})))
            if lang:
                os.environ["TESSDATA_PREFIX"] = folder
    lang = lang or "eng"
    _OCR_LANG_CACHE[binary] = (now, lang)
    return lang


def read_text(region: list[int] | None = None, lang: str | None = None) -> dict[str, Any]:
    """OCR the current screen (or a [left, top, width, height] region).

    `lang` None reads with `hin+eng` when the Hindi data is installed and `eng` otherwise.
    A secure prompt or a focused password field on screen is never read.
    """
    _secure_guard("read_text")
    return _read_text_unchecked(region, lang)


def _read_text_unchecked(region: list[int] | None = None, lang: str | None = None) -> dict[str, Any]:
    """The OCR itself. Only `read_text` and `perceive`, after their own secure check, call this."""
    mss_mod = _require("mss", "mss")
    pytesseract = _require("pytesseract", "pytesseract")
    binary = _tesseract_binary()
    if binary:
        pytesseract.pytesseract.tesseract_cmd = binary
    elif getattr(pytesseract.pytesseract, "tesseract_cmd", "tesseract") in ("", "tesseract"):
        raise ControlError(
            "the Tesseract OCR engine was not found on PATH. Install “Tesseract OCR” "
            "from the Install Manager, then retry."
        )
    chosen = lang or ocr_language(binary or str(pytesseract.pytesseract.tesseract_cmd))
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
    text = pytesseract.image_to_string(image, lang=chosen)
    return {
        "ok": True,
        "region": [box["left"], box["top"], box["width"], box["height"]],
        "chars": len(text),
        "lang": chosen,
        "text": text,
    }
