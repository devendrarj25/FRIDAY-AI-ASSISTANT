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
};
