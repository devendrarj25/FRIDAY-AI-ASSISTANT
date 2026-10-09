"""FRIDAY — Bluetooth devices.

BLE discovery/connection through `bleak` (optional dependency) and the real
Windows paired-device list through PowerShell/PnP for classic Bluetooth
(audio, HID, OBEX file transfer). Every capability that a specific device does
not actually support is reported honestly instead of being faked.
"""

from __future__ import annotations

import asyncio
import json
import platform
import shutil
import subprocess

WIN = platform.system() == "Windows"


def _powershell(script: str, timeout: int = 25) -> dict:
    exe = shutil.which("powershell") or shutil.which("pwsh")
    if not exe:
        return {"ok": False, "error": "PowerShell is not available on this machine."}
    try:
        proc = subprocess.run(
            [exe, "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "PowerShell timed out"}
    if proc.returncode != 0:
        return {"ok": False, "error": (proc.stderr or proc.stdout or "").strip()[:2000]}
    return {"ok": True, "stdout": (proc.stdout or "").strip()}


def paired_devices() -> dict:
    """Classic + BLE devices Windows has already paired (OS-level trust)."""
    if not WIN:
        return {"ok": True, "devices": [], "note": "Paired-device listing is Windows-only."}
    res = _powershell(
        "Get-PnpDevice -Class Bluetooth -ErrorAction SilentlyContinue | "
        "Select-Object FriendlyName,InstanceId,Status | ConvertTo-Json -Compress"
    )
    if not res.get("ok"):
        return res
    raw = res["stdout"] or "[]"
    try:
        parsed = json.loads(raw)
    except Exception:
        return {"ok": False, "error": "Bluetooth device list could not be read."}
    if isinstance(parsed, dict):
        parsed = [parsed]
    devices = [
        {
            "name": item.get("FriendlyName") or "Bluetooth device",
            "id": item.get("InstanceId") or "",
            "status": item.get("Status") or "Unknown",
            "connected": (item.get("Status") or "").upper() == "OK",
            "kind": "classic",
        }
        for item in parsed
        if item.get("FriendlyName")
    ]
    return {"ok": True, "devices": devices}


async def _scan_ble(seconds: float) -> dict:
    try:
        from bleak import BleakScanner  # type: ignore
    except Exception:
        return {
            "ok": False,
            "error": "The Bluetooth LE library (bleak) is not installed. Install it from the Install Manager.",
        }
    found = await BleakScanner.discover(timeout=seconds)
    return {
        "ok": True,
        "devices": [{"name": d.name or "Unknown", "id": d.address, "kind": "ble", "connected": False} for d in found],
    }


def scan(seconds: float = 6.0) -> dict:
    """Nearby BLE devices advertising right now."""
    try:
        return asyncio.run(_scan_ble(float(seconds)))
    except RuntimeError:
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(_scan_ble(float(seconds)))
        finally:
            loop.close()
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def set_enabled(enabled: bool) -> dict:
    """Turn the PC's Bluetooth radio on or off (Windows radio manager)."""
    if not WIN:
        return {"ok": False, "error": "Radio control is Windows-only."}
    state = "On" if enabled else "Off"
    return _powershell(
        "$radios = [Windows.Devices.Radios.Radio,Windows.System.Devices,ContentType=WindowsRuntime];"
        "Write-Output 'unsupported'"
        if False
        else f"Get-PnpDevice -Class Bluetooth | Where-Object {{$_.FriendlyName -like '*Bluetooth*'}} | "
        f"ForEach-Object {{ if ('{state}' -eq 'On') {{ Enable-PnpDevice -InstanceId $_.InstanceId -Confirm:$false }} "
        f"else {{ Disable-PnpDevice -InstanceId $_.InstanceId -Confirm:$false }} }}"
    )


MEDIA_KEYS = {
    "play": 0xB3,  # VK_MEDIA_PLAY_PAUSE
    "pause": 0xB3,
    "next": 0xB0,
    "previous": 0xB1,
    "stop": 0xB2,
    "volume_up": 0xAF,
    "volume_down": 0xAE,
    "mute": 0xAD,
}


def media(command: str) -> dict:
    """Send a media key to the active audio route (the paired BT speaker/headset).

    This is exactly how Windows routes play/pause to a connected A2DP/AVRCP
    device. If nothing is connected the OS handles it locally — we say so.
    """
    key = MEDIA_KEYS.get(command.lower())
    if key is None:
        return {"ok": False, "error": f"Unsupported media command “{command}”."}
    if not WIN:
        return {"ok": False, "error": "Media control is Windows-only."}
    try:
        import ctypes

        windll = getattr(ctypes, "windll", None)
        if windll is None:
            return {"ok": False, "error": "Media control is Windows-only."}
        user32 = windll.user32
        user32.keybd_event(key, 0, 0, 0)
        user32.keybd_event(key, 0, 2, 0)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
    audio = [d for d in (paired_devices().get("devices") or []) if d.get("connected")]
    return {
        "ok": True,
        "command": command,
        "routedTo": audio[0]["name"] if audio else "this PC (no Bluetooth audio device connected)",
    }


def send_file(path: str, device: str) -> dict:
    """OBEX push. Windows exposes this through fsquirt; unsupported devices are reported."""
    if not WIN:
        return {"ok": False, "error": "Bluetooth file transfer is Windows-only."}
    exe = shutil.which("fsquirt")
    if not exe:
        return {"ok": False, "error": "Windows Bluetooth file transfer (fsquirt) is unavailable."}
    try:
        subprocess.Popen([exe, "-send", path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
    return {
        "ok": True,
        "started": True,
        "device": device,
        "note": "Windows Bluetooth transfer opened — pick the paired device to finish sending.",
    }
