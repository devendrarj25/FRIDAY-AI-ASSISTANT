"""Thin Windows UI Automation collector.

Imports nothing from UI Automation until a Windows call. The raw tree is
normalized by ``uia_tree.perception_from_raw``. A password value is never copied.
"""

from __future__ import annotations

import sys
from typing import Any

WINDOWS = sys.platform.startswith("win")

_PATTERNS = (
    ("Invoke", 10000),
    ("Value", 10002),
    ("Scroll", 10004),
    ("ExpandCollapse", 10005),
    ("SelectionItem", 10010),
    ("Toggle", 10015),
)
_TYPES = {
    50000: "Button",
    50002: "CheckBox",
    50003: "ComboBox",
    50004: "Edit",
    50011: "ListItem",
    50020: "Text",
    50025: "Custom",
    50032: "Window",
    50033: "Pane",
    50036: "TitleBar",
}
_NAME = 30005
_CONTROL = 30003
_BOUNDS = 30001
_CLASS = 30012
_ENABLED = 30010
_FOCUS = 30008
_AUTO = 30011
_OFFSCREEN = 30022
_PASSWORD = 30019
_RUNTIME_ID = 30000


def guarded_collect(body, initialize, uninitialize):
    """Pair COM startup with cleanup, including when the walk raises."""
    initialize()
    try:
        return body()
    finally:
        uninitialize()


def collect_uia_raw(max_depth: int = 8, max_nodes: int = 400) -> dict[str, Any]:
    if not WINDOWS:
        raise RuntimeError("UI Automation collection is only available on Windows")
    try:
        import comtypes.client
    except Exception as exc:  # pragma: no cover - Windows helper
        raise RuntimeError(
            "comtypes is not installed in FRIDAY's Python runtime. "
            "Install comtypes from the Install Manager, then retry."
        ) from exc
    import comtypes

    def _body() -> dict[str, Any]:
        _dpi_aware()
        return collect_from(_automation(comtypes), _monitors(), max_depth, max_nodes)

    return guarded_collect(_body, comtypes.CoInitialize, comtypes.CoUninitialize)


def collect_focused() -> dict[str, Any] | None:
    """Only the focused element, read directly: cheap enough to repeat between key chunks.

    None when it cannot be read (the secure desktop, a closed window, no comtypes).
    """
    if not WINDOWS:
        raise RuntimeError("UI Automation collection is only available on Windows")
    try:
        import comtypes
        import comtypes.client
    except Exception as exc:  # pragma: no cover - Windows helper
        raise RuntimeError("comtypes is not installed in FRIDAY's Python runtime.") from exc
    return guarded_collect(lambda: read_focused(_automation(comtypes)), comtypes.CoInitialize, comtypes.CoUninitialize)


def _automation(comtypes: Any) -> Any:  # pragma: no cover - Windows helper
    import comtypes.client

    comtypes.client.GetModule("UIAutomationCore.dll")
    from comtypes.gen.UIAutomationClient import CUIAutomation, IUIAutomation

    return comtypes.CoCreateInstance(
        CUIAutomation._reg_clsid_,
        interface=IUIAutomation,
        clsctx=comtypes.CLSCTX_INPROC_SERVER,
    )


def collect_from(uia: Any, monitors: list[dict[str, int]], max_depth: int, max_nodes: int) -> dict[str, Any]:
    """Walk the desktop with `uia`, say if the walk was cut, and read the focused element directly."""
    state: dict[str, Any] = {"count": 0, "truncated": False}
    root = uia.GetRootElement()
    windows = []
    walker = uia.ControlViewWalker
    child = walker.GetFirstChildElement(root)
    while child is not None:
        if state["count"] >= max_nodes:
            state["truncated"] = True
            break
        built = _node(walker, child, 1, max_depth, max_nodes, state)
        if built:
            windows.append(built)
        child = walker.GetNextSiblingElement(child)
    return {
        "monitors": monitors,
        "windows": windows,
        "truncated": bool(state["truncated"]),
        "focusedElement": read_focused(uia),
    }


def read_focused(uia: Any) -> dict[str, Any] | None:
    """The focused element's type, password flag and identity, or None when any of it cannot be read.

    The password flag is read without the quiet fallback `_prop` has: a failed read is
    "unknown", never "not a password". A password field's name is never copied.
    """
    try:
        element = uia.GetFocusedElement()
        if element is None:
            return None
        secret = bool(element.GetCurrentPropertyValue(_PASSWORD))
        control_id = element.GetCurrentPropertyValue(_CONTROL)
    except Exception:
        return None
    runtime = _prop(element, _RUNTIME_ID)
    return {
        "controlType": "Password" if secret else _TYPES.get(int(control_id or 0), "Control"),
        "isPassword": secret,
        "name": "" if secret else str(_prop(element, _NAME) or ""),
        "className": str(_prop(element, _CLASS) or ""),
        "runtimeId": [int(part) for part in runtime] if isinstance(runtime, (list, tuple)) else None,
    }


def _node(
    walker: Any, element: Any, depth: int, max_depth: int, max_nodes: int, state: dict[str, Any]
) -> dict[str, Any] | None:
    if depth > max_depth or state["count"] >= max_nodes:
        state["truncated"] = True
        return None
    state["count"] += 1
    secret = bool(_prop(element, _PASSWORD))
    box = _prop(element, _BOUNDS)
    bounds = {"x": 0, "y": 0, "w": 0, "h": 0}
    if isinstance(box, (list, tuple)) and len(box) >= 4:
        bounds = {"x": float(box[0]), "y": float(box[1]), "w": float(box[2]), "h": float(box[3])}
    control_id = _prop(element, _CONTROL)
    node: dict[str, Any] = {
        "name": "" if secret else str(_prop(element, _NAME) or ""),
        "controlType": _TYPES.get(int(control_id or 0), "Control"),
        "automationId": str(_prop(element, _AUTO) or ""),
        "className": str(_prop(element, _CLASS) or ""),
        "bounds": bounds,
        "enabled": _prop(element, _ENABLED) is not False,
        "focused": bool(_prop(element, _FOCUS)),
        "offscreen": bool(_prop(element, _OFFSCREEN)),
        "isPassword": secret,
        "value": "",
        "patterns": _patterns(element),
        "children": [],
    }
    if secret:
        node["controlType"] = "Password"
        return node
    child = walker.GetFirstChildElement(element)
    if depth >= max_depth:
        if child is not None:
            state["truncated"] = True
        return node
    while child is not None:
        if state["count"] >= max_nodes:
            state["truncated"] = True
            break
        built = _node(walker, child, depth + 1, max_depth, max_nodes, state)
        if built:
            node["children"].append(built)
        child = walker.GetNextSiblingElement(child)
    return node


def _prop(element: Any, prop_id: int) -> Any:
    try:
        return element.GetCurrentPropertyValue(prop_id)
    except Exception:
        return None


def _patterns(element: Any) -> list[str]:
    found: list[str] = []
    for name, prop_id in _PATTERNS:
        try:
            if element.GetCurrentPattern(prop_id) is not None:
                found.append(name)
        except Exception:  # noqa: S112 — this element does not support the pattern
            continue
    return found


def perform_pattern(selector: str, pattern: str, value: str = "") -> dict[str, Any]:
    """Invoke one pattern on a freshly resolved element. Windows only."""
    if not WINDOWS:
        raise RuntimeError("UI Automation actions are only available on Windows")
    import comtypes.client

    comtypes.client.GetModule("UIAutomationCore.dll")
    from comtypes.gen.UIAutomationClient import (
        CUIAutomation,
        IUIAutomation,
        IUIAutomationExpandCollapsePattern,
        IUIAutomationInvokePattern,
        IUIAutomationScrollPattern,
        IUIAutomationSelectionItemPattern,
        IUIAutomationTogglePattern,
        IUIAutomationValuePattern,
    )

    uia = comtypes.CoCreateInstance(
        CUIAutomation._reg_clsid_,
        interface=IUIAutomation,
        clsctx=comtypes.CLSCTX_INPROC_SERVER,
    )
    found: dict[str, Any] = {}

    def walk(element: Any, parent: str, depth: int) -> None:
        if found or depth > 8:
            return
        name = str(_prop(element, _NAME) or "")
        auto = str(_prop(element, _AUTO) or "").strip()
        control_id = _prop(element, _CONTROL)
        control_type = _TYPES.get(int(control_id or 0), "Control")
        key = f"id:{auto}" if auto else f"name:{name}|type:{control_type}"
        path = f"{parent}/{key}" if parent else key
        if path == selector or name == selector:
            found["element"] = element
            return
        child = uia.ControlViewWalker.GetFirstChildElement(element)
        while child is not None and not found:
            walk(child, path, depth + 1)
            child = uia.ControlViewWalker.GetNextSiblingElement(child)

    root = uia.GetRootElement()
    child = uia.ControlViewWalker.GetFirstChildElement(root)
    while child is not None and not found:
        walk(child, "", 1)
        child = uia.ControlViewWalker.GetNextSiblingElement(child)
    element = found.get("element")
    if element is None:
        raise RuntimeError("control is not in the fresh tree")
    ids = {
        "Invoke": (10000, IUIAutomationInvokePattern, "Invoke"),
        "Toggle": (10015, IUIAutomationTogglePattern, "Toggle"),
        "SelectionItem": (10010, IUIAutomationSelectionItemPattern, "Select"),
        "ExpandCollapse": (10005, IUIAutomationExpandCollapsePattern, "Expand"),
        "Value": (10002, IUIAutomationValuePattern, "SetValue"),
        "Scroll": (10004, IUIAutomationScrollPattern, "Scroll"),
    }
    spec = ids.get(pattern)
    if not spec:
        raise RuntimeError("no pattern")
    prop_id, interface, method = spec
    unknown = element.GetCurrentPattern(prop_id)
    if unknown is None:
        raise RuntimeError("no pattern")
    target = unknown.QueryInterface(interface)
    if pattern == "Value":
        target.SetValue(value)
    elif pattern == "Scroll":
        target.Scroll(0, -1)
    else:
        getattr(target, method)()
    return {
        "ok": True,
        "via": "pattern",
        "pattern": pattern,
        "selector": selector,
        "undoHint": "reverse this pattern if the control still offers one",
    }


def _win_desktop():
    """user32/shcore. A non-Windows type stub has no windll, so look it up."""
    import ctypes

    windll = getattr(ctypes, "windll", None)
    factory = getattr(ctypes, "WINFUNCTYPE", None)
    if windll is None or factory is None:
        raise RuntimeError("Windows desktop APIs are unavailable")
    return ctypes, windll, factory


def _dpi_aware() -> None:
    try:
        _ctypes, windll, _factory = _win_desktop()
    except RuntimeError:
        return
    try:
        windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            windll.user32.SetProcessDPIAware()
        except Exception:
            return


def _monitors() -> list[dict[str, int]]:
    import ctypes
    from ctypes import wintypes

    _ctypes, windll, factory = _win_desktop()
    found: list[dict[str, int]] = []
    user32 = windll.user32

    @factory(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(wintypes.RECT), ctypes.c_void_p)
    def _cb(hmon, _hdc, rect, _data):
        box = rect.contents
        dpi_x = ctypes.c_uint(96)
        dpi_y = ctypes.c_uint(96)
        try:
            windll.shcore.GetDpiForMonitor(ctypes.c_void_p(hmon), 0, ctypes.byref(dpi_x), ctypes.byref(dpi_y))
        except Exception:  # noqa: S110 — older Windows keeps the 96 DPI default
            pass
        found.append(
            {
                "x": int(box.left),
                "y": int(box.top),
                "w": int(box.right - box.left),
                "h": int(box.bottom - box.top),
                "dpi": int(dpi_x.value or 96),
            }
        )
        return 1

    user32.EnumDisplayMonitors(None, None, _cb, 0)
    return found or [{"x": 0, "y": 0, "w": 0, "h": 0, "dpi": 96}]
