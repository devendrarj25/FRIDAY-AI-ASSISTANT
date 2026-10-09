"""Pure UI Automation tree normalizer.

The Windows collector in ``uia_windows`` only gathers a raw tree. This module
turns that JSON into one perception: one coordinate space, budgets, a stable
selector, and no secret content. It does not call Windows.
"""

from __future__ import annotations

import re
from typing import Any

# Physical pixels from BoundingRectangle, then one 96-DPI virtual desktop.
# https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-screenscaling
DEFAULT_BUDGET = {"maxDepth": 8, "maxNodes": 400, "maxMs": 1500}
CONFIDENT = 0.45

_SECURE = re.compile(r"user account control|secure desktop", re.I)
_CREDENTIAL = re.compile(r"windows security|credential", re.I)
_PASSWORD = re.compile(r"password", re.I)

_ROLE = {
    "Button": "button",
    "CheckBox": "button",
    "Edit": "edit",
    "Document": "edit",
    "Text": "text",
    "Window": "window",
    "Pane": "pane",
}


_CLICK = ("Invoke", "Toggle", "SelectionItem", "ExpandCollapse")
_HANDOFF_ROLES = {"password", "payment", "captcha", "uac"}


def prefer_pattern(control: dict[str, Any] | None, intent: str) -> dict[str, str]:
    """Use a control pattern before a synthetic mouse or key."""
    row = control or {}
    if row.get("enabled") is False:
        return {"via": "disabled", "pattern": ""}
    if row.get("offscreen") is True:
        return {"via": "offscreen", "pattern": ""}
    if str(row.get("role") or "") in _HANDOFF_ROLES:
        return {"via": "handoff", "pattern": ""}
    patterns = [str(item) for item in row.get("patterns") or []]
    if intent == "type":
        if "Value" in patterns:
            return {"via": "pattern", "pattern": "Value"}
        return {"via": "input", "pattern": "input.type"}
    if intent == "scroll":
        if "Scroll" in patterns:
            return {"via": "pattern", "pattern": "Scroll"}
        return {"via": "input", "pattern": "input.scroll"}
    for name in _CLICK:
        if name in patterns:
            return {"via": "pattern", "pattern": name}
    return {"via": "input", "pattern": "input.click"}


def resolve_control(perception: dict[str, Any] | None, selector: str) -> dict[str, Any]:
    """Re-find a control in a fresh tree. A match on the unfocused window is refused."""
    windows = (perception or {}).get("windows") or []
    wanted = str(selector or "")
    focused = [window for window in windows if window.get("focused")]
    pool = focused or windows[:1]

    def hit(window: dict[str, Any]) -> dict[str, Any] | None:
        for control in window.get("controls") or []:
            if control.get("selector") == wanted or str(control.get("name") or "") == wanted:
                return control
        return None

    for window in pool:
        found = hit(window)
        if not found:
            continue
        if found.get("enabled") is False:
            return {"via": "disabled", "control": found}
        return {"via": "ok", "control": found}
    for window in windows:
        if window in pool:
            continue
        if hit(window):
            return {"via": "wrong-window", "control": None}
    return {"via": "missing", "control": None}


def choose_layer(layers: list[dict[str, Any]] | None) -> dict[str, Any]:
    """UIA, then OCR, then vision. A handoff never falls through to pixels."""
    rows = [row for row in (layers or []) if isinstance(row, dict)]
    if not rows:
        return {
            "ok": False,
            "source": "none",
            "confidence": 0,
            "untrusted": True,
            "text": "",
            "windows": [],
            "freshAt": 0,
        }
    for row in rows:
        if row.get("handoff"):
            return {**row, "untrusted": True, "text": "", "windows": []}
        if float(row.get("confidence") or 0) >= CONFIDENT:
            return {**row, "untrusted": True}
    last = dict(rows[-1])
    last["untrusted"] = True
    return last


def perception_from_raw(
    raw: dict[str, Any] | None,
    now_ms: int,
    budgets: dict[str, int] | None = None,
    step_ms: int = 0,
) -> dict[str, Any]:
    limits = {**DEFAULT_BUDGET, **(budgets or {})}
    tree = raw if isinstance(raw, dict) else {}
    monitors = _monitors(tree.get("monitors"))
    roots = _roots(tree)
    handoff = _tree_handoff(roots)
    fresh = int(now_ms)
    if handoff:
        return {
            "ok": True,
            "source": "uia",
            "confidence": 0.97,
            "untrusted": True,
            "handoff": handoff,
            "freshAt": fresh,
            "windows": [],
            "text": "",
            "truncated": False,
            "cyclic": False,
            "elapsedMs": 0,
            "nodeCount": 0,
            "dpi": int(monitors[0]["dpi"]),
            "monitor": 1,
        }

    state = {"count": 0, "elapsed": 0, "truncated": False, "cyclic": False}
    windows: list[dict[str, Any]] = []
    for index, root in enumerate(roots):
        built = _walk(root, 0, "", monitors, limits, int(step_ms), state, set())
        if not built:
            continue
        controls = _flatten(built.get("children") or [])
        windows.append(
            {
                "id": built["selector"],
                "title": built["name"],
                "focused": bool(root.get("focused")),
                "controls": controls,
            }
        )
        if state["truncated"]:
            break
        if index > limits["maxNodes"]:
            state["truncated"] = True
            break

    text = _public_text(windows)
    focused = _focused_monitor(windows, monitors)
    confidence = 0.93 if _any_control(windows) else 0.55
    if state["truncated"]:
        confidence = min(confidence, 0.7)
    return {
        "ok": True,
        "source": "uia",
        "confidence": confidence,
        "untrusted": True,
        "freshAt": fresh,
        "windows": windows,
        "text": text,
        "truncated": bool(state["truncated"]),
        "cyclic": bool(state["cyclic"]),
        "elapsedMs": int(state["elapsed"]),
        "nodeCount": int(state["count"]),
        "dpi": int(focused["dpi"]),
        "monitor": int(focused["index"]),
    }


def _monitors(value: Any) -> list[dict[str, Any]]:
    rows = value if isinstance(value, list) and value else [{"x": 0, "y": 0, "w": 0, "h": 0, "dpi": 96}]
    cleaned = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        dpi = float(row.get("dpi") or 96) or 96
        cleaned.append(
            {
                "x": float(row.get("x") or 0),
                "y": float(row.get("y") or 0),
                "w": float(row.get("w") or 0),
                "h": float(row.get("h") or 0),
                "dpi": dpi,
            }
        )
    return _place(cleaned or [{"x": 0, "y": 0, "w": 0, "h": 0, "dpi": 96}])


def _place(monitors: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ordered = sorted(monitors, key=lambda item: (item["y"], item["x"]))
    placed: list[dict[str, Any]] = []
    row_y: float | None = None
    cursor_x = 0.0
    row_dip_y = 0.0
    row_height = 0.0
    for index, mon in enumerate(ordered, start=1):
        scale = mon["dpi"] / 96.0
        dip_w = mon["w"] / scale
        dip_h = mon["h"] / scale
        if row_y is None:
            row_y = mon["y"]
        elif abs(mon["y"] - row_y) > 80:
            row_dip_y += row_height
            cursor_x = 0.0
            row_height = 0.0
            row_y = mon["y"]
        placed.append({**mon, "dipX": cursor_x, "dipY": row_dip_y, "scale": scale, "index": index})
        cursor_x += dip_w
        row_height = max(row_height, dip_h)
    return placed


def _roots(tree: dict[str, Any]) -> list[dict[str, Any]]:
    windows = tree.get("windows")
    if isinstance(windows, list):
        return [row for row in windows if isinstance(row, dict)]
    root = tree.get("root")
    if isinstance(root, dict):
        return [root]
    return []


def _tree_handoff(nodes: list[dict[str, Any]], seen: set[int] | None = None) -> str | None:
    visited = seen if seen is not None else set()
    for node in nodes:
        marker = id(node)
        if marker in visited:
            continue
        visited.add(marker)
        kind = _node_handoff(node)
        if kind:
            return kind
        children = node.get("children")
        if isinstance(children, list):
            nested = _tree_handoff([child for child in children if isinstance(child, dict)], visited)
            if nested:
                return nested
    return None


def _node_handoff(node: dict[str, Any]) -> str | None:
    blob = f"{node.get('name') or ''} {node.get('className') or ''}"
    if node.get("elevated") is True or _SECURE.search(blob):
        return "uac"
    if _CREDENTIAL.search(blob):
        return "credential"
    return None


def _password(node: dict[str, Any]) -> bool:
    if node.get("isPassword") is True:
        return True
    return bool(_PASSWORD.search(str(node.get("controlType") or "")))


def _walk(
    node: dict[str, Any],
    depth: int,
    parent: str,
    monitors: list[dict[str, Any]],
    limits: dict[str, int],
    step_ms: int,
    state: dict[str, Any],
    seen: set[int],
) -> dict[str, Any] | None:
    if state["truncated"]:
        return None
    marker = id(node)
    if marker in seen:
        state["cyclic"] = True
        return None
    seen.add(marker)
    if depth > int(limits["maxDepth"]):
        state["truncated"] = True
        return None
    if int(state["count"]) >= int(limits["maxNodes"]):
        state["truncated"] = True
        return None
    if int(state["elapsed"]) + step_ms > int(limits["maxMs"]) and int(state["count"]) > 0:
        state["truncated"] = True
        return None
    state["elapsed"] = int(state["elapsed"]) + step_ms
    state["count"] = int(state["count"]) + 1
    built = _control(node, parent, monitors)
    children = node.get("children") if isinstance(node.get("children"), list) else []
    nested: list[dict[str, Any]] = []
    seen_selectors: dict[str, int] = {}
    for child in children:
        if not isinstance(child, dict):
            continue
        item = _walk(child, depth + 1, built["selector"], monitors, limits, step_ms, state, seen)
        if item:
            base = str(item.get("selector") or "")
            seen_selectors[base] = seen_selectors.get(base, 0) + 1
            if seen_selectors[base] > 1:
                unique = f"{base}~{seen_selectors[base]}"
                item["selector"] = unique
                item["id"] = unique
            nested.append(item)
        if state["truncated"]:
            break
    built["children"] = nested
    return built


def _control(node: dict[str, Any], parent: str, monitors: list[dict[str, Any]]) -> dict[str, Any]:
    control_type = str(node.get("controlType") or "Control")
    name = str(node.get("name") or "")
    auto = str(node.get("automationId") or "").strip()
    key = f"id:{auto}" if auto else f"name:{name}|type:{control_type}"
    selector = f"{parent}/{key}" if parent else key
    secret = _password(node)
    bounds, mon = _bounds(node.get("bounds"), monitors)
    role = "password" if secret else _ROLE.get(control_type, "text")
    patterns = [str(item) for item in node.get("patterns") or [] if str(item)]
    return {
        "id": selector,
        "name": name,
        "role": role,
        "value": "" if secret else str(node.get("value") or ""),
        "bounds": bounds,
        "enabled": node.get("enabled", True) is not False,
        "focused": bool(node.get("focused")),
        "offscreen": bool(node.get("offscreen")),
        "automationId": auto,
        "className": str(node.get("className") or ""),
        "controlType": control_type,
        "patterns": patterns,
        "selector": selector,
        "parentPath": parent,
        "children": [],
        "monitor": int(mon["index"]),
        "dpi": int(mon["dpi"]),
    }


def _bounds(value: Any, monitors: list[dict[str, Any]]) -> tuple[dict[str, float], dict[str, Any]]:
    box = value if isinstance(value, dict) else {}
    x = float(box.get("x") or 0)
    y = float(box.get("y") or 0)
    w = float(box.get("w") or 0)
    h = float(box.get("h") or 0)
    cx = x + (w / 2)
    cy = y + (h / 2)
    mon = monitors[0]
    for item in monitors:
        if item["x"] <= cx < item["x"] + max(item["w"], 1) and item["y"] <= cy < item["y"] + max(item["h"], 1):
            mon = item
            break
    scale = float(mon["scale"])
    local_x = (x - float(mon["x"])) / scale
    local_y = (y - float(mon["y"])) / scale
    return (
        {
            "x": round(float(mon["dipX"]) + local_x, 2),
            "y": round(float(mon["dipY"]) + local_y, 2),
            "w": round(w / scale, 2),
            "h": round(h / scale, 2),
        },
        mon,
    )


def _flatten(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    flat: list[dict[str, Any]] = []
    for node in nodes:
        children = node.get("children") or []
        copy = {key: value for key, value in node.items() if key != "children"}
        flat.append(copy)
        flat.extend(_flatten(children if isinstance(children, list) else []))
    return flat


def _public_text(windows: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    for window in windows:
        title = str(window.get("title") or "").strip()
        if title:
            lines.append(title)
        for control in window.get("controls") or []:
            if control.get("role") == "password":
                lines.append(str(control.get("name") or "Password"))
                continue
            bits = f"{control.get('name') or ''} {control.get('value') or ''}".strip()
            if bits:
                lines.append(bits)
    return "\n".join(lines)


def _any_control(windows: list[dict[str, Any]]) -> bool:
    return any(window.get("controls") for window in windows)


IDLE_CPU_PERCENT = 1.0


def idle_within(samples: list[float] | None, budget: float = IDLE_CPU_PERCENT) -> bool:
    """True when the injected idle samples stay at or under the budget."""
    rows = [float(item) for item in (samples or [])]
    if not rows:
        return True
    return (sum(rows) / len(rows)) <= float(budget)


def comtypes_missing(detail: str | None) -> bool:
    return "comtypes is not installed" in str(detail or "")


def ocr_fallback(now_ms: int, text: str) -> dict[str, Any]:
    """Used when the Windows collector cannot load comtypes. The text stays data."""
    return {
        "ok": True,
        "source": "ocr",
        "confidence": 0.62,
        "untrusted": True,
        "freshAt": int(now_ms),
        "text": str(text or ""),
        "windows": [],
        "fallback": "comtypes-missing",
    }


def _focused_monitor(windows: list[dict[str, Any]], monitors: list[dict[str, Any]]) -> dict[str, Any]:
    for window in windows:
        for control in window.get("controls") or []:
            if control.get("focused"):
                index = int(control.get("monitor") or 1)
                found = next((item for item in monitors if int(item["index"]) == index), monitors[0])
                return {"dpi": found["dpi"], "index": index}
    return {"dpi": monitors[0]["dpi"], "index": int(monitors[0]["index"])}
