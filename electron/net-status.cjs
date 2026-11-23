/**
 * FRIDAY · network reachability (main process, authoritative).
 *
 * The router must know whether the machine can actually reach the internet
 * before it considers a cloud model. `navigator.onLine` lies (a connected Wi-Fi
 * with no route still reports online), so this probes real TCP reachability
 * against well-known anycast resolvers and caches the answer briefly.
 *
 * No Electron, no renderer: `electron/main.cjs` and the tests use the same
 * functions.
 */
const net = require("node:net");

/** Anycast endpoints that answer TCP/443 nearly everywhere. */
const PROBES = [
  { host: "1.1.1.1", port: 443 },
  { host: "8.8.8.8", port: 443 },
  { host: "9.9.9.9", port: 443 },
];

/**
 * A machine behind a proxy (a company, a college, a hotel) cannot open a raw TCP connection to those resolvers, yet every
 * HTTPS request through its proxy works. When the TCP probes all fail, a tiny HTTPS request goes through the same
 * network stack the cloud calls use (Chromium's: system proxy, PAC, corporate certificates). Either one answering means
 * online; both failing means offline.
 */
const HTTPS_PROBES = [
  "https://www.gstatic.com/generate_204",
  "https://connectivitycheck.gstatic.com/generate_204",
  "https://www.msftconnecttest.com/connecttest.txt",
];

const FRESH_MS = 15_000;
const PROBE_TIMEOUT_MS = 2500;
const HTTPS_TIMEOUT_MS = 4000;

let state = { online: true, at: 0, checkedAt: 0, detail: "not checked yet" };
let inFlight = null;

/** One TCP connect attempt; resolves true only on a real connection. */
function probeOne({ host, port }, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* already closed */
      }
      resolve(ok);
    };
    const socket = net.createConnection({ host, port }, () => done(true));
    socket.setTimeout(timeoutMs, () => done(false));
    socket.on("error", () => done(false));
  });
}

/** One small HTTPS request through the app's own network stack; true on any HTTP answer below 500. */
async function probeHttps(url, timeoutMs = HTTPS_TIMEOUT_MS, doFetch = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const run = doFetch || require("./net-fetch.cjs").fetchCompat;
    const response = await run(url, {
      method: "GET",
      signal: controller.signal,
      redirect: "manual",
    });
    try {
      await response.body?.cancel?.();
    } catch {
      /* the answer is all that is needed */
    }
    return response.status > 0 && response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** One TCP connect attempt, timed: { ok, ms } where ms is the connect time in whole milliseconds, or null on failure. */
async function probeTimed(
  target,
  timeoutMs = PROBE_TIMEOUT_MS,
  connect = probeOne,
  clock = Date.now,
) {
  const started = clock();
  let ok = false;
  try {
    ok = (await connect(target, timeoutMs)) === true;
  } catch {
    ok = false;
  }
  return { ok, ms: ok ? Math.max(0, Math.round(clock() - started)) : null };
}

const LATENCY_FRESH_MS = 60_000;
let latencyState = { at: 0, ms: null };

/**
 * Round trip to ONE endpoint (the first of PROBES, the one the reachability check already uses), and only when the
 * owner already allows network use. Anything else returns null without touching the network. The answer is cached for
 * a minute and nothing here schedules itself: a caller asks, this answers.
 */
async function measureLatency({ allowNetwork = false, now = Date.now(), timed = probeTimed } = {}) {
  if (allowNetwork !== true) return null;
  if (state.checkedAt > 0 && state.online === false) return null;
  if (latencyState.at && now - latencyState.at < LATENCY_FRESH_MS) return latencyState.ms;
  try {
    const result = await timed(PROBES[0]);
    latencyState = { at: now, ms: result && result.ok ? result.ms : null };
  } catch {
    latencyState = { at: now, ms: null };
  }
  return latencyState.ms;
}

// ---- connection type and cost -----------------------------------------------------------------------------------
// One PowerShell fragment (shared with electron/hardware.cjs, so a single process answers every question) and the pure
// parser for what it prints. Windows' own network list says whether the connection is metered (NetworkCostType: 0
// Unknown, 1 Unrestricted, 2 Fixed, 3 Variable) and which kind of adapter carries it (IANA ifType: 6 ethernet, 71
// Wi-Fi, 243 and 244 cellular). Where that API is not available the active physical adapter's media type is read.
const CONNECTION_SCRIPT = String.raw`try { [void][Windows.Networking.Connectivity.NetworkInformation,Windows.Networking.Connectivity,ContentType=WindowsRuntime]; $pr=[Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile(); if($pr){ $cc=$pr.GetConnectionCost(); $o.net=@{cost=[int]$cc.NetworkCostType;roaming=[bool]$cc.Roaming;overLimit=[bool]$cc.OverDataLimit;iana=[int]$pr.NetworkAdapter.IanaInterfaceType} } else { $o.net=@{none=$true} } } catch {}; try { if(-not $o.net){ $na=Get-NetAdapter -Physical | Where-Object { $_.Status -eq 'Up' } | Select-Object -First 1; if($na){ $o.netAdapter=@{media=[string]$na.PhysicalMediaType} } } } catch {};`;

const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function typeFromIana(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n === 6) return "ethernet";
  if (n === 71) return "wifi";
  if (n === 243 || n === 244) return "cellular";
  return "unknown";
}

function typeFromMedia(text) {
  const media = String(text ?? "").trim();
  if (!media) return null;
  if (/802\.3|ethernet/i.test(media)) return "ethernet";
  if (/wireless wan|wwan|cellular|mobile|broadband/i.test(media)) return "cellular";
  if (/802\.11|wireless lan|wi-?fi/i.test(media)) return "wifi";
  return "unknown";
}

/**
 * What the connection fragment printed, as facts. Every field is null when it was not measured:
 * `type` wifi | ethernet | cellular | unknown; `metered` true for a Fixed or Variable cost, false for Unrestricted.
 */
function parseConnection(net, netAdapter) {
  const out = { connected: null, type: null, metered: null, roaming: null, overDataLimit: null };
  if (isRecord(net)) {
    if (net.none === true) {
      out.connected = false;
      return out;
    }
    out.connected = true;
    out.type = typeFromIana(net.iana);
    const cost = Number(net.cost);
    out.metered = cost === 1 ? false : cost === 2 || cost === 3 ? true : null;
    out.roaming = typeof net.roaming === "boolean" ? net.roaming : null;
    out.overDataLimit = typeof net.overLimit === "boolean" ? net.overLimit : null;
  }
  if (out.type === null && isRecord(netAdapter)) {
    out.type = typeFromMedia(netAdapter.media);
    if (out.connected === null && out.type !== null) out.connected = true;
  }
  return out;
}

const CONNECTION_FRESH_MS = 30_000;
let connectionState = { at: 0, value: null };
let connectionJob = null;

/** The connection type and cost, asked of Windows at most every 30 s, de-duplicated, never throws. Null off Windows. */
async function detectConnection({
  platform = process.platform,
  runPowerShell = null,
  now = Date.now(),
  timeoutMs = 12_000,
} = {}) {
  if (platform !== "win32") return null;
  if (connectionState.at && now - connectionState.at < CONNECTION_FRESH_MS) {
    return connectionState.value;
  }
  if (connectionJob) return connectionJob;
  connectionJob = (async () => {
    let value = null;
    try {
      const run = runPowerShell || require("./probe-exec.cjs").runPowerShell;
      const result = await run(
        `$ErrorActionPreference='Stop'; $o=@{}; ${CONNECTION_SCRIPT} $o | ConvertTo-Json -Depth 4 -Compress`,
        timeoutMs,
      );
      const parsed =
        result && result.ok ? JSON.parse(String(result.stdout || "").trim() || "null") : null;
      value = isRecord(parsed) ? parseConnection(parsed.net, parsed.netAdapter) : null;
    } catch {
      value = null;
    }
    connectionState = { at: now, value };
    return value;
  })().finally(() => {
    connectionJob = null;
  });
  return connectionJob;
}

/**
 * The network facts the router and the Doctor read, from what is already known: the cached reachability, the
 * connection (measured elsewhere or passed in) and, only when the owner allows network use, one timed round trip.
 * Not measured is null, never a guess; `online` stays null until the first reachability check has run.
 */
async function networkFacts({
  connection = null,
  allowNetwork = false,
  now = Date.now(),
  timed = probeTimed,
} = {}) {
  const view = snapshot();
  const conn = isRecord(connection) ? connection : null;
  let latencyMs = null;
  try {
    latencyMs = await measureLatency({ allowNetwork, now, timed });
  } catch {
    latencyMs = null;
  }
  return {
    online:
      view.checkedAt > 0 ? view.online === true : conn && conn.connected === false ? false : null,
    type: conn ? (conn.type ?? null) : null,
    metered: conn && typeof conn.metered === "boolean" ? conn.metered : null,
    roaming: conn && typeof conn.roaming === "boolean" ? conn.roaming : null,
    latencyMs,
  };
}

/** Test seam: forget the cached latency and connection answers. */
function resetNetworkCaches() {
  latencyState = { at: 0, ms: null };
  connectionState = { at: 0, value: null };
  connectionJob = null;
}

/** Current cached view — never blocks. */
function snapshot() {
  return { ...state };
}

/**
 * Real reachability check, de-duplicated and cached.
 * `force` skips the freshness window.
 */
async function check(force = false, now = Date.now()) {
  if (!force && now - state.checkedAt < FRESH_MS) return snapshot();
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const results = await Promise.all(PROBES.map((target) => probeOne(target)));
    let online = results.some(Boolean);
    let via = "tcp";
    if (!online) {
      const answers = await Promise.all(HTTPS_PROBES.map((url) => probeHttps(url)));
      online = answers.some(Boolean);
      via = "https";
    }
    const changed = online !== state.online;
    state = {
      online,
      at: changed ? Date.now() : state.at || Date.now(),
      checkedAt: Date.now(),
      detail: online
        ? via === "https"
          ? "internet reachable through the system proxy"
          : "internet reachable"
        : "no internet route — local models only",
    };
    return { ...snapshot(), changed };
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** True while the last check says the machine is offline. */
function isOffline() {
  return state.online === false;
}

module.exports = {
  PROBES,
  HTTPS_PROBES,
  FRESH_MS,
  snapshot,
  check,
  isOffline,
  probeOne,
  probeHttps,
  probeTimed,
  measureLatency,
  CONNECTION_SCRIPT,
  parseConnection,
  detectConnection,
  networkFacts,
  resetNetworkCaches,
};
