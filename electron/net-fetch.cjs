/**
 * FRIDAY · outbound HTTP from the main process
 *
 * Node's built-in `fetch` (undici) ignores everything Windows knows about the
 * network: the system proxy, PAC scripts, corporate root certificates and
 * enterprise TLS inspection. On such a machine every provider call fails with
 * a bare "fetch failed" even though the same URL opens fine in a browser —
 * which is exactly what "network error while connecting a cloud model" is.
 *
 * Electron's `net.fetch` speaks through Chromium's network stack, so it picks
 * all of that up. This module is the ONE place that decides which stack to
 * use: Chromium when Electron is ready, Node's fetch otherwise (tests, CLI
 * scripts, or if Chromium refuses the request).
 */
let electron = null;
try {
  electron = require("electron");
} catch {
  electron = null;
}

let dispatcher = null;
let egressPolicy = null;

function setEgressPolicy(fn) {
  egressPolicy = typeof fn === "function" ? fn : null;
  return egressPolicy;
}

function hostOf(url) {
  try {
    return new URL(String(url)).hostname;
  } catch {
    return "";
  }
}

function isLoopback(host) {
  const name = String(host || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return name === "localhost" || name === "127.0.0.1" || name === "::1";
}

function egressDecision(url) {
  if (!egressPolicy) return { allow: true };
  let policy = {};
  try {
    policy = egressPolicy() || {};
  } catch {
    policy = {};
  }
  if (policy.localOnly && !isLoopback(hostOf(url))) {
    return { allow: false, code: "LOCAL_ONLY" };
  }
  return { allow: true };
}

function nodeDispatcher() {
  if (!dispatcher) {
    const { Agent } = require("undici");
    dispatcher = new Agent({ keepAliveTimeout: 30_000, connections: 8 });
  }
  return dispatcher;
}

const chromiumReady = () => {
  try {
    return Boolean(electron?.net?.fetch && electron.app?.isReady?.());
  } catch {
    return false;
  }
};

/**
 * fetch() with Chromium's network stack when it is available.
 * The signature is the standard one, so callers need no special handling.
 */
async function fetchCompat(url, init = {}) {
  const decision = egressDecision(url);
  if (!decision.allow) {
    const error = new Error("privacy mode keeps this request on the device");
    error.code = decision.code || "LOCAL_ONLY";
    throw error;
  }
  let chromiumError = null;
  if (chromiumReady()) {
    try {
      return await electron.net.fetch(String(url), init);
    } catch (error) {
      // An aborted request is the caller's own timeout — never retry it.
      if (init?.signal?.aborted || error?.name === "AbortError") throw error;
      // Anything else (an unsupported option, a Chromium-side refusal) falls
      // back to Node's stack rather than reporting the provider as offline.
      chromiumError = error;
    }
  }
  const { fetch: undiciFetch } = require("undici");
  try {
    return await undiciFetch(String(url), {
      ...init,
      dispatcher: init.dispatcher || nodeDispatcher(),
    });
  } catch (error) {
    throw combinedNetworkError(chromiumError, error);
  }
}

/**
 * Node's own message is a bare "fetch failed". When Chromium also refused the
 * request, its reason (net::ERR_PROXY_CONNECTION_FAILED, a certificate error)
 * is the one the owner can act on, so it leads.
 */
function combinedNetworkError(chromiumError, nodeError) {
  if (!chromiumError) return nodeError;
  const nodeCause = nodeError?.cause?.code || nodeError?.cause?.message || nodeError?.message;
  const error = new Error(
    `${chromiumError.message || String(chromiumError)} (Node fallback: ${nodeCause || "fetch failed"})`,
  );
  error.cause = nodeError;
  error.code = chromiumError.code || nodeError?.code;
  return error;
}

module.exports = {
  fetchCompat,
  combinedNetworkError,
  chromiumReady,
  nodeDispatcher,
  setEgressPolicy,
  egressDecision,
};
