"""FRIDAY — Android device control over a USB cable (ADB).

Real `adb` calls only. FRIDAY never asks for, stores or replays a phone's
lock-screen credential: the phone is trusted through Android's own
"Allow USB debugging from this computer?" prompt, and a locked phone is
reported as locked instead of being unlocked by FRIDAY.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

TIMEOUT = 30


def _adb_path() -> str | None:
    return shutil.which("adb")


def _run(args: list[str], timeout: int = TIMEOUT) -> dict:
    exe = _adb_path()
    if not exe:
        return {
            "ok": False,
            "error": "adb (Android Platform Tools) is not installed. Install it from the Install Manager.",
        }
    try:
        proc = subprocess.run([exe, *args], capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"adb timed out after {timeout}s"}
    out = (proc.stdout or "").strip()
    err = (proc.stderr or "").strip()
    return {
        "ok": proc.returncode == 0,
        "code": proc.returncode,
        "stdout": out[:100_000],
        "stderr": err[:20_000],
        "error": None if proc.returncode == 0 else (err or out)[:2_000],
    }


def _target(serial: str | None) -> list[str]:
    return ["-s", serial] if serial else []


def list_devices() -> dict:
    """Every phone attached by cable, with its real authorization state."""
    res = _run(["devices", "-l"], timeout=15)
    if not res.get("ok"):
        return res
    devices = []
    for line in res["stdout"].splitlines()[1:]:
        line = line.strip()
        if not line:
            continue
        parts = line.split()
        serial, state = parts[0], parts[1] if len(parts) > 1 else "unknown"
        model = next((p.split(":", 1)[1] for p in parts[2:] if p.startswith("model:")), serial)
        devices.append(
            {
                "serial": serial,
                "state": state,  # device | unauthorized | offline
                "model": model.replace("_", " "),
                "authorized": state == "device",
                "hint": (
                    "Unlock the phone and tap “Allow USB debugging from this computer”."
                    if state == "unauthorized"
                    else ""
                ),
            }
        )
    return {"ok": True, "devices": devices}


def is_locked(serial: str | None = None) -> dict:
    """True when the phone's keyguard is showing. FRIDAY never unlocks it."""
    res = _run([*_target(serial), "shell", "dumpsys", "window"], timeout=20)
    if not res.get("ok"):
        return res
    text = res["stdout"]
    locked = "mDreamingLockscreen=true" in text or "isStatusBarKeyguard=true" in text
    return {"ok": True, "locked": locked}


def _guard_locked(serial: str | None) -> dict | None:
    state = is_locked(serial)
    if state.get("ok") and state.get("locked"):
        return {
            "ok": False,
            "locked": True,
            "error": "This phone is locked — unlock it on the device and try again.",
        }
    return None


def open_app(app: str, serial: str | None = None) -> dict:
    """Open an app by package name, or by friendly name via a package lookup."""
    blocked = _guard_locked(serial)
    if blocked:
        return blocked
    package = app.strip()
    if "." not in package:
        found = find_package(package, serial)
        if not found.get("ok") or not found.get("packages"):
            return {"ok": False, "error": f"No installed app matched “{app}”."}
        package = found["packages"][0]
    res = _run([*_target(serial), "shell", "monkey", "-p", package, "-c", "android.intent.category.LAUNCHER", "1"])
    res["package"] = package
    return res


def find_package(query: str, serial: str | None = None) -> dict:
    res = _run([*_target(serial), "shell", "pm", "list", "packages"], timeout=25)
    if not res.get("ok"):
        return res
    needle = query.lower().replace(" ", "")
    packages = [line.split(":", 1)[1].strip() for line in res["stdout"].splitlines() if line.startswith("package:")]
    matches = [p for p in packages if needle in p.lower()]
    return {"ok": True, "packages": matches, "count": len(matches)}


def start_activity(component: str, serial: str | None = None) -> dict:
    blocked = _guard_locked(serial)
    if blocked:
        return blocked
    return _run([*_target(serial), "shell", "am", "start", "-n", component])


def tap(x: int, y: int, serial: str | None = None) -> dict:
    blocked = _guard_locked(serial)
    if blocked:
        return blocked
    return _run([*_target(serial), "shell", "input", "tap", str(int(x)), str(int(y))])


def swipe(x1: int, y1: int, x2: int, y2: int, ms: int = 300, serial: str | None = None) -> dict:
    blocked = _guard_locked(serial)
    if blocked:
        return blocked
    return _run(
        [
            *_target(serial),
            "shell",
            "input",
            "swipe",
            str(int(x1)),
            str(int(y1)),
            str(int(x2)),
            str(int(y2)),
            str(int(ms)),
        ]
    )


def type_text(text: str, serial: str | None = None) -> dict:
    blocked = _guard_locked(serial)
    if blocked:
        return blocked
    safe = text.replace(" ", "%s")
    return _run([*_target(serial), "shell", "input", "text", safe])


def push(local: str, remote: str, serial: str | None = None) -> dict:
    path = Path(local)
    if not path.exists():
        return {"ok": False, "error": f"{local} does not exist on this PC."}
    return _run([*_target(serial), "push", str(path), remote], timeout=600)


def pull(remote: str, local: str, serial: str | None = None) -> dict:
    Path(local).parent.mkdir(parents=True, exist_ok=True)
    return _run([*_target(serial), "pull", remote, local], timeout=600)


def mirror(serial: str | None = None) -> dict:
    """Show the phone's screen on the PC with scrcpy (separate window)."""
    exe = shutil.which("scrcpy")
    if not exe:
        return {"ok": False, "error": "scrcpy is not installed. Install it from the Install Manager."}
    try:
        subprocess.Popen(
            [exe, *(["-s", serial] if serial else [])],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception as exc:  # pragma: no cover - environment dependent
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "started": True}
