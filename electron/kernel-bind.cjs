/**
 * The one kernel port. Readiness, the desktop, and the health probe all use it.
 *
 * A normal launch stays on 8765 unless that port belongs to something else.
 * Readiness always receives a free port. A busy FRIDAY is left alone.
 */
const http = require("node:http");
const net = require("node:net");

const DEFAULT_KERNEL_PORT = 8765;

function initialPort(env = process.env) {
  const raw = String((env && env.FRIDAY_KERNEL_PORT) || "").trim();
  const port = Number(raw);
  if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  return DEFAULT_KERNEL_PORT;
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function redact(text) {
  return String(text || "")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/\bghp_[A-Za-z0-9_]+\b/g, "[redacted]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]+\b/g, "[redacted]")
    .replace(/api[_-]?key\s*[:=]\s*\S+/gi, "api_key=[redacted]");
}

function classifyKernelExit({ code, text } = {}) {
  const lines = redact(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-40);
  const body = lines.join("\n").toLowerCase();
  let kind = "crash";
  if (/eaddrinuse|address already in use|port is in use|10048/.test(body)) kind = "port in use";
  else if (/database is locked|sqlite_busy|database locked/.test(body)) kind = "database locked";
  else if (/modulenotfounderror|importerror|no module named/.test(body))
    kind = "python import error";
  else if (/eacces|eperm|permission denied|access is denied/.test(body)) kind = "permission";
  else if (code === 0) kind = "exit";
  const detail = lines.slice(-3).join(" ").slice(0, 240) || `exit ${code ?? "none"}`;
  return { class: kind, detail, lines };
}

function probeFriday(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const request = http.get(
      { host: "127.0.0.1", port, path: "/health", timeout: timeoutMs },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve(/"ok"\s*:\s*true|friday/i.test(text));
        });
      },
    );
    request.on("error", () => resolve(false));
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
  });
}

module.exports = {
  DEFAULT_KERNEL_PORT,
  initialPort,
  pickFreePort,
  classifyKernelExit,
  probeFriday,
  redact,
};
