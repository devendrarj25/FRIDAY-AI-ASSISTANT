/**
 * FRIDAY · other-app volume while speaking.
 *
 * Quiet hours do not duck anyone: FRIDAY already lowers its own voice then.
 * Off Windows this returns unsupported and changes nothing. On Windows it
 * asks the audio session API to lower every session except this process,
 * and restores those levels when speech ends. A failure leaves the mixer
 * alone.
 */
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const STATE = path.join(os.tmpdir(), "friday-audio-duck.json");

function shouldDuck({ enabled, speaking, quiet }) {
  return Boolean(enabled && speaking && !quiet);
}

const WINDOWS_SCRIPT = `
$ErrorActionPreference = "Stop"
$on = $env:FRIDAY_DUCK -eq "1"
$keep = [int]$env:FRIDAY_DUCK_PID
$statePath = $env:FRIDAY_DUCK_STATE
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class FridayDuck {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    int NotImpl1();
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
  }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activation, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  }
  [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionManager2 {
    int NotImpl1();
    int NotImpl2();
    [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator enumerator);
  }
  [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionEnumerator {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetSession(int index, out IAudioSessionControl2 session);
  }
  [Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl2 {
    int NotImpl0(); int NotImpl1(); int NotImpl2(); int NotImpl3(); int NotImpl4();
    int NotImpl5(); int NotImpl6(); int NotImpl7(); int NotImpl8(); int NotImpl9();
    int NotImpl10(); int NotImpl11();
    [PreserveSig] int GetProcessId(out int pid);
  }
  [Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface ISimpleAudioVolume {
    [PreserveSig] int SetMasterVolume(float level, ref Guid context);
    [PreserveSig] int GetMasterVolume(out float level);
    [PreserveSig] int SetMute(bool mute, ref Guid context);
    [PreserveSig] int GetMute(out bool mute);
  }
  public static string Run(bool duck, int keepPid, string statePath) {
    var enumerator = (IMMDeviceEnumerator)(object)new MMDeviceEnumerator();
    IMMDevice device;
    if (enumerator.GetDefaultAudioEndpoint(0, 0, out device) != 0) return "unsupported";
    var iid = typeof(IAudioSessionManager2).GUID;
    object raw;
    if (device.Activate(ref iid, 23, IntPtr.Zero, out raw) != 0) return "unsupported";
    var manager = (IAudioSessionManager2)raw;
    IAudioSessionEnumerator sessions;
    if (manager.GetSessionEnumerator(out sessions) != 0) return "unsupported";
    int count;
    sessions.GetCount(out count);
    var saved = new System.Collections.Generic.Dictionary<int, float>();
    if (!duck && System.IO.File.Exists(statePath)) {
      var previous = System.IO.File.ReadAllText(statePath);
      foreach (var line in previous.Split(new[]{'\\n'}, StringSplitOptions.RemoveEmptyEntries)) {
        var bits = line.Split('=');
        int pid; float level;
        if (bits.Length == 2 && int.TryParse(bits[0], out pid) && float.TryParse(bits[1], System.Globalization.CultureInfo.InvariantCulture, out level))
          saved[pid] = level;
      }
    }
    var next = new System.Text.StringBuilder();
    var empty = Guid.Empty;
    for (int i = 0; i < count; i++) {
      IAudioSessionControl2 session;
      if (sessions.GetSession(i, out session) != 0 || session == null) continue;
      int pid;
      if (session.GetProcessId(out pid) != 0 || pid == keepPid || pid == 0) continue;
      var volume = session as ISimpleAudioVolume;
      if (volume == null) continue;
      float level;
      if (volume.GetMasterVolume(out level) != 0) continue;
      if (duck) {
        next.Append(pid.ToString()).Append('=').Append(level.ToString(System.Globalization.CultureInfo.InvariantCulture)).Append('\\n');
        float lowered = level < 0.15f ? level : 0.15f;
        volume.SetMasterVolume(lowered, ref empty);
      } else if (saved.ContainsKey(pid)) {
        volume.SetMasterVolume(saved[pid], ref empty);
      }
    }
    if (duck) System.IO.File.WriteAllText(statePath, next.ToString());
    else if (System.IO.File.Exists(statePath)) System.IO.File.Delete(statePath);
    return duck ? "ducked" : "restored";
  }
}
"@
$result = [FridayDuck]::Run($on, $keep, $statePath)
Write-Output $result
`;

function apply(on) {
  if (process.platform !== "win32") {
    return Promise.resolve({ ok: false, ducked: false, reason: "unsupported" });
  }
  return new Promise((resolve) => {
    execFile(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCRIPT],
      {
        timeout: 8000,
        windowsHide: true,
        env: {
          ...process.env,
          FRIDAY_DUCK: on ? "1" : "0",
          FRIDAY_DUCK_PID: String(process.pid),
          FRIDAY_DUCK_STATE: STATE,
        },
      },
      (error, stdout) => {
        const text = String(stdout || "").trim();
        if (error || !text || text === "unsupported") {
          resolve({ ok: false, ducked: false, reason: "unsupported" });
          return;
        }
        resolve({ ok: true, ducked: text === "ducked", reason: "" });
      },
    );
  });
}

module.exports = { shouldDuck, apply, STATE };
