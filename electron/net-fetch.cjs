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
  if (chromiumReady()) {
    try {
      return await electron.net.fetch(String(url), init);
    } catch (error) {
      // An aborted request is the caller's own timeout — never retry it.
      if (init?.signal?.aborted || error?.name === "AbortError") throw error;
      // Anything else (an unsupported option, a Chromium-side refusal) falls
      // back to Node's stack rather than reporting the provider as offline.
    }
  }
  return fetch(String(url), init);
}

module.exports = { fetchCompat, chromiumReady };
