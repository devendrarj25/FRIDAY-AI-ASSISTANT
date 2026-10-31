/**
 * Which of several mirrors of the same installer is fastest right now.
 *
 * An installer has one pinned SHA-256, so every mirror of it is the same file and any order is safe. When there
 * is more than one source this asks each for its first few hundred kilobytes (a ranged request, read through
 * the app's own network stack so proxies and certificates apply) and orders them by measured speed. A source
 * that does not answer in time goes last, in its original place among the failures. With one source, or when
 * every probe fails, the order is unchanged and nothing extra is downloaded.
 */
const { fetchCompat } = require("./net-fetch.cjs");

const PROBE_BYTES = 256 * 1024;
const PROBE_TIMEOUT_MS = 6000;
const MAX_PROBED = 4;

async function probeRate(
  url,
  { bytes = PROBE_BYTES, timeout = PROBE_TIMEOUT_MS, fetchImpl = fetchCompat, now = Date.now } = {},
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const started = now();
  try {
    const res = await fetchImpl(url, {
      headers: { range: `bytes=0-${bytes - 1}`, "user-agent": "FRIDAY-InstallManager" },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!(res.ok || res.status === 206) || !res.body?.getReader)
      return { url, ok: false, bps: 0, ttfbMs: 0 };
    const reader = res.body.getReader();
    let got = 0;
    let firstAt = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!firstAt) firstAt = now();
      got += value.byteLength;
      if (got >= bytes) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
    const ended = now();
    const seconds = Math.max((ended - (firstAt || started)) / 1000, 0.001);
    if (!got) return { url, ok: false, bps: 0, ttfbMs: 0 };
    return { url, ok: true, bps: Math.round(got / seconds), ttfbMs: (firstAt || ended) - started };
  } catch {
    return { url, ok: false, bps: 0, ttfbMs: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/** Same urls, fastest first. Unprobed or failed sources keep their relative order after the measured ones. */
async function orderByRate(urls, options = {}) {
  const unique = [...new Set((urls || []).filter(Boolean))];
  if (unique.length < 2) return { urls: unique, probes: [] };
  const probed = unique.slice(0, MAX_PROBED);
  const rest = unique.slice(MAX_PROBED);
  const probes = await Promise.all(probed.map((url) => probeRate(url, options)));
  const good = probes.filter((p) => p.ok).sort((a, b) => b.bps - a.bps || a.ttfbMs - b.ttfbMs);
  if (!good.length) return { urls: unique, probes };
  const bad = probes.filter((p) => !p.ok).map((p) => p.url);
  return { urls: [...good.map((p) => p.url), ...bad, ...rest], probes };
}

module.exports = { probeRate, orderByRate, PROBE_BYTES };
