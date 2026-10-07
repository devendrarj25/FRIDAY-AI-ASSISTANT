/**
 * FRIDAY · real foreground-window tracker (Windows)
 *
 * One long-lived PowerShell helper calls the actual Win32 APIs
 * (GetForegroundWindow / DwmGetWindowAttribute / GetWindowRect /
 * GetWindowThreadProcessId) and prints a compact JSON line whenever the
 * foreground window really changes. No polling happens in the main process,
 * nothing is simulated, and the helper is only alive while a follow mode is
 * switched on — it is terminated the moment nothing needs it.
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { screen } = require("electron");

const SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public struct FRECT { public int Left; public int Top; public int Right; public int Bottom; }
public class FridayWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out FRECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out FRECT val, int size);
}
"@
$last = ''
while ($true) {
  $h = [FridayWin]::GetForegroundWindow()
  if ($h -ne [IntPtr]::Zero) {
    $sb = New-Object System.Text.StringBuilder 512
    [void][FridayWin]::GetWindowTextW($h, $sb, 512)
    $r = New-Object FRECT
    $ok = $false
    if ([FridayWin]::DwmGetWindowAttribute($h, 9, [ref]$r, 16) -eq 0) { $ok = $true }
    if (-not $ok) { $ok = [FridayWin]::GetWindowRect($h, [ref]$r) }
    $pid2 = 0
    [void][FridayWin]::GetWindowThreadProcessId($h, [ref]$pid2)
    $proc = ''
    try { $proc = (Get-Process -Id $pid2 -ErrorAction Stop).ProcessName } catch { $proc = '' }
    $payload = [ordered]@{
      hwnd = [int64]$h
      title = $sb.ToString()
      process = $proc
      pid = [int]$pid2
      left = $r.Left; top = $r.Top; right = $r.Right; bottom = $r.Bottom
      maximized = [bool][FridayWin]::IsZoomed($h)
      minimized = [bool][FridayWin]::IsIconic($h)
    }
    $json = $payload | ConvertTo-Json -Compress
    if ($json -ne $last) { $last = $json; Write-Output $json }
  }
  Start-Sleep -Milliseconds 220
}
`;

function scriptPath() {
  const file = path.join(os.tmpdir(), "friday-window-tracker.ps1");
  try {
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== SCRIPT) {
      fs.writeFileSync(file, SCRIPT, "utf8");
    }
  } catch {
    return null;
  }
  return file;
}

class WindowTracker {
  constructor(log = () => {}) {
    this.log = log;
    this.child = null;
    this.listeners = new Set();
    this.last = null;
    this.buffer = "";
    this.supported = process.platform === "win32";
  }

  subscribe(fn) {
    this.listeners.add(fn);
    this.start();
    if (this.last) fn(this.last);
    return () => {
      this.listeners.delete(fn);
      if (!this.listeners.size) this.stop();
    };
  }

  snapshot() {
    return this.last;
  }

  start() {
    if (this.child || !this.supported) return;
    const file = scriptPath();
    if (!file) return;
    try {
      this.child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (error) {
      this.log(`character: window tracker failed to start — ${String(error?.message || error)}`);
      this.child = null;
      return;
    }
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.consume(chunk));
    this.child.on("exit", () => {
      this.child = null;
      // Restart only while somebody is still listening (a crash must not kill
      // the follow modes, and an idle tracker must not respawn forever).
      if (this.listeners.size) setTimeout(() => this.start(), 1500);
    });
  }

  stop() {
    if (!this.child) return;
    try {
      this.child.kill();
    } catch {
      /* already gone */
    }
    this.child = null;
    this.buffer = "";
  }

  consume(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      const text = line.trim();
      if (!text.startsWith("{")) continue;
      let raw = null;
      try {
        raw = JSON.parse(text);
      } catch {
        continue;
      }
      this.publish(raw);
    }
  }

  publish(raw) {
    const bounds = {
      x: Number(raw.left) || 0,
      y: Number(raw.top) || 0,
      width: Math.max(0, Number(raw.right) - Number(raw.left)),
      height: Math.max(0, Number(raw.bottom) - Number(raw.top)),
    };
    let display = null;
    try {
      display = screen.getDisplayMatching(
        bounds.width && bounds.height ? bounds : screen.getPrimaryDisplay().bounds,
      );
    } catch {
      display = null;
    }
    // A window that covers its whole monitor with no visible chrome is a real
    // fullscreen application (game, video, presentation).
    const fullscreen = Boolean(
      display &&
      bounds.width >= display.bounds.width - 2 &&
      bounds.height >= display.bounds.height - 2 &&
      bounds.x <= display.bounds.x + 1 &&
      bounds.y <= display.bounds.y + 1,
    );
    const info = {
      at: Date.now(),
      hwnd: raw.hwnd,
      title: String(raw.title || ""),
      process: String(raw.process || ""),
      pid: Number(raw.pid) || 0,
      bounds,
      maximized: Boolean(raw.maximized),
      minimized: Boolean(raw.minimized),
      fullscreen,
      display: display
        ? {
            id: display.id,
            bounds: display.bounds,
            workArea: display.workArea,
            scale: display.scaleFactor,
          }
        : null,
      // Real title-bar strip height for the "follow title bar" mode.
      titleBarHeight: raw.maximized ? 32 : 36,
    };
    this.last = info;
    this.listeners.forEach((fn) => {
      try {
        fn(info);
      } catch {
        /* one bad listener must not stop the others */
      }
    });
  }
}

module.exports = { WindowTracker };
