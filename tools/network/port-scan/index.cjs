// FRIDAY · tools/network/port-scan
const net = require("node:net");

function parsePorts(raw) {
  if (Array.isArray(raw)) return raw.map((n) => Number(n)).filter((n) => n > 0 && n < 65536);
  const text = String(raw || "").trim();
  if (!text) return [];
  const out = [];
  for (const part of text.split(/[,\s]+/).filter(Boolean)) {
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (b - a + 1 > 64) return { error: "Port ranges larger than 64 are refused." };
      for (let p = a; p <= b; p += 1) out.push(p);
      continue;
    }
    const n = Number(part);
    if (n > 0 && n < 65536) out.push(n);
  }
  return out;
}

function probe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port });
    const done = (open, error) => {
      socket.destroy();
      resolve({ port, open, ms: Date.now() - started, ...(error ? { error } : {}) });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false, "timeout"));
    socket.once("error", (err) => done(false, String(err.message)));
  });
}

async function run(input = {}) {
  const host = String(input.host || "").trim();
  if (!host) return { ok: false, error: "A host name is required." };
  const parsed = parsePorts(input.ports == null ? input.port : input.ports);
  if (parsed && parsed.error) return { ok: false, error: parsed.error };
  const ports = Array.isArray(parsed) ? parsed : [];
  if (!ports.length) return { ok: false, error: "Give an explicit port list (max 64)." };
  if (ports.length > 64) return { ok: false, error: "More than 64 ports are refused." };
  const timeoutMs = Math.min(Number(input.timeoutMs) || 800, 4000);
  const results = [];
  for (const port of ports) results.push(await probe(host, port, timeoutMs));
  return {
    ok: true,
    host,
    scanned: ports.length,
    open: results.filter((row) => row.open).map((row) => row.port),
    results,
  };
}

module.exports = { run };
