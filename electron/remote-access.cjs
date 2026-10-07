/**
 * FRIDAY · off-LAN companion access (safest option, off by default)
 *
 * The owner sometimes needs the phone companion while away from home. There
 * are two honest ways to do that:
 *
 *   1. A private device network (Tailscale / WireGuard). The phone joins the
 *      owner's own tailnet; traffic is end-to-end encrypted between the two
 *      devices, every device must be authorised in the owner's account, and
 *      NOTHING is published to the public internet — no port forward, no
 *      inbound firewall hole, no relay operated by FRIDAY. FRIDAY simply keeps
 *      listening on the interfaces it already listens on (LAN mode), and the
 *      tailnet address becomes reachable to the owner's own devices only.
 *
 *   2. A public tunnel (Cloudflare/ngrok style). Convenient, but it puts a
 *      publicly resolvable hostname in front of FRIDAY. Anyone who learns the
 *      URL reaches the pairing page. That is strictly weaker.
 *
 * FRIDAY implements (1) only, and it is off until the owner turns it on AND at
 * least one phone is already paired. This module never starts a tunnel, never
 * opens a port and never talks to a third-party relay of ours.
 */
const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");

const CANDIDATES = [
  "tailscale",
  path.join(process.env["ProgramFiles"] || "C:/Program Files", "Tailscale", "tailscale.exe"),
  "/usr/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

function binary() {
  for (const candidate of CANDIDATES) {
    if (candidate.includes(path.sep) || candidate.includes("/")) {
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        /* unreadable path — try the next one */
      }
    } else {
      return candidate; // resolved through PATH; the probe below proves it
    }
  }
  return null;
}

function run(exe, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(exe, args, { timeout, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (err, out) =>
      resolve({ ok: !err, out: String(out || ""), error: err ? String(err.message) : "" }),
    );
  });
}

/** Live probe: is a private device network usable on this machine right now? */
async function probe(port) {
  const exe = binary();
  if (!exe) {
    return {
      available: false,
      backend: "none",
      host: null,
      detail:
        "Tailscale is not installed. Install it and sign in on this PC and on the phone to reach FRIDAY off-network.",
    };
  }
  const status = await run(exe, ["status", "--json"]);
  if (!status.ok) {
    return {
      available: false,
      backend: "none",
      host: null,
      detail: "Tailscale is installed but not running or not signed in.",
    };
  }
  let host = null;
  try {
    const data = JSON.parse(status.out);
    const self = data.Self || {};
    host = (self.DNSName || "").replace(/\.$/, "") || (self.TailscaleIPs || [])[0] || null;
    if (data.BackendState && data.BackendState !== "Running") {
      return {
        available: false,
        backend: "tailscale",
        host,
        detail: `Tailscale is ${data.BackendState}. Sign in to use off-network access.`,
      };
    }
  } catch {
    host = null;
  }
  if (!host) {
    return {
      available: false,
      backend: "tailscale",
      host: null,
      detail: "Tailscale is running but this device has no tailnet address yet.",
    };
  }
  return {
    available: true,
    backend: "tailscale",
    host,
    detail:
      "Reachable only from devices signed into your own Tailscale account, end-to-end encrypted (WireGuard). No public port, no relay.",
    url: `http://${host}:${port}/companion`,
  };
}

/**
 * Report the full state.
 * @param {{ enabled: boolean, port: number, pairedPhones: number }} input
 */
async function state({ enabled, port, pairedPhones }) {
  const found = await probe(port);
  const requiresPairedPhone = enabled && !pairedPhones;
  return {
    enabled: Boolean(enabled),
    available: Boolean(found.available),
    backend: found.backend,
    url: enabled && found.available && !requiresPairedPhone ? found.url || null : null,
    requiresPairedPhone,
    detail: requiresPairedPhone
      ? "Pair a phone on your home WiFi first — off-network access reuses the same pairing token."
      : found.detail,
  };
}

module.exports = { state, probe, binary };
