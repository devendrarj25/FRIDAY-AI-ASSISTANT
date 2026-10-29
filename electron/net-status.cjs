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

const FRESH_MS = 15_000;
const PROBE_TIMEOUT_MS = 2500;

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
    const online = results.some(Boolean);
    const changed = online !== state.online;
    state = {
      online,
      at: changed ? Date.now() : state.at || Date.now(),
      checkedAt: Date.now(),
      detail: online ? "internet reachable" : "no internet route — local models only",
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

module.exports = { PROBES, FRESH_MS, snapshot, check, isOffline, probeOne };
