// FRIDAY · tools/network/network-diagnostics
//
// Real checks only: DNS lookup, TCP connect and HTTPS round-trip timings.
const dns = require("node:dns").promises;
const net = require("node:net");
const https = require("node:https");

const DEFAULT_HOSTS = [
  "registry.npmjs.org",
  "pypi.org",
  "api.openai.com",
  "huggingface.co",
  "github.com",
];

function tcp(host, port = 443, timeout = 4000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port });
    const done = (ok, error) => {
      socket.destroy();
      resolve({ ok, ms: Date.now() - started, ...(error ? { error } : {}) });
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false, `timed out after ${timeout}ms`));
    socket.once("error", (err) => done(false, String(err.message)));
  });
}

function httpsHead(host, timeout = 6000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = https.request({ host, path: "/", method: "HEAD", timeout }, (res) => {
      res.resume();
      resolve({ ok: true, status: res.statusCode, ms: Date.now() - started });
    });
    req.once("timeout", () => {
      req.destroy();
      resolve({ ok: false, ms: Date.now() - started, error: `timed out after ${timeout}ms` });
    });
    req.once("error", (err) =>
      resolve({ ok: false, ms: Date.now() - started, error: String(err.message) }),
    );
    req.end();
  });
}

async function run({ hosts = DEFAULT_HOSTS } = {}) {
  const results = await Promise.all(
    hosts.map(async (host) => {
      const started = Date.now();
      let addresses = [];
      let dnsError = null;
      try {
        addresses = (await dns.lookup(host, { all: true })).map((a) => a.address);
      } catch (error) {
        dnsError = String(error.message || error);
      }
      const dnsMs = Date.now() - started;
      if (dnsError) return { host, dns: { ok: false, ms: dnsMs, error: dnsError } };
      return {
        host,
        dns: { ok: true, ms: dnsMs, addresses },
        tcp: await tcp(host),
        https: await httpsHead(host),
      };
    }),
  );
  const online = results.some((r) => r.https?.ok);
  const latencies = results.filter((r) => r.https?.ok).map((r) => r.https.ms);
  return {
    ok: true,
    online,
    checked: results.length,
    reachable: latencies.length,
    avgLatencyMs: latencies.length
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : null,
    results,
  };
}

module.exports = { run };
