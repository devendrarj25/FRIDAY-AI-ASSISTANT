/**
 * FRIDAY · native OAuth 2.0 loopback (authorization-code + PKCE).
 *
 * ONE listener: http://127.0.0.1:<port>/oauth/callback. Electron opens the
 * provider's real authorize URL; this module captures the redirect, checks
 * `state`, and returns the authorization code. Token exchange is a real POST
 * to the provider's token URL through net-fetch. Secrets are never logged.
 *
 * Desktop apps register `http://127.0.0.1:18765/oauth/callback` on the
 * provider. If that port is busy we bind an ephemeral port and use that URI
 * for this attempt (Google/Microsoft loopback clients allow it; GitHub OAuth
 * Apps need the registered port).
 */
const http = require("node:http");
const crypto = require("node:crypto");
const { URL } = require("node:url");

const DEFAULT_PORT = 18765;
const CALLBACK_PATH = "/oauth/callback";

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

function pkcePair() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge, method: "S256" };
}

function randomState() {
  return b64url(crypto.randomBytes(24));
}

function htmlPage(title, body) {
  const safeTitle = String(title || "FRIDAY").replace(/[<>]/g, "");
  const safeBody = String(body || "").replace(/[<>]/g, "");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${safeTitle}</title></head>
<body style="font-family:sans-serif;padding:2rem;max-width:40rem">
<h1>${safeTitle}</h1><p>${safeBody}</p></body></html>`;
}

/**
 * Bind 127.0.0.1 and wait for one /oauth/callback hit.
 * @returns {Promise<{ port: number, redirectUri: string, wait: () => Promise<{code:string,state:string}>, close: () => Promise<void> }>}
 */
function listen({ port = DEFAULT_PORT, timeoutMs = 180_000, path = CALLBACK_PATH } = {}) {
  const wanted = Number(port) || DEFAULT_PORT;
  let settle;
  const done = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  let finished = false;
  const finish = (err, value) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (err) settle.reject(err);
    else settle.resolve(value);
  };

  const server = http.createServer((req, res) => {
    try {
      const u = new URL(req.url || "/", "http://127.0.0.1");
      if (u.pathname !== path) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("Not found");
        return;
      }
      const err = u.searchParams.get("error");
      const desc = u.searchParams.get("error_description");
      if (err) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(
          htmlPage(
            "FRIDAY",
            `The provider refused this login (${err}). You can close this window.`,
          ),
        );
        finish(new Error(desc || err));
        return;
      }
      const code = String(u.searchParams.get("code") || "").trim();
      const state = String(u.searchParams.get("state") || "").trim();
      if (!code) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(
          htmlPage("FRIDAY", "No authorization code was returned. You can close this window."),
        );
        finish(new Error("The provider did not return an authorization code."));
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(htmlPage("FRIDAY", "Signed in. You can close this window and return to FRIDAY."));
      finish(null, { code, state });
    } catch (error) {
      finish(error);
    }
  });

  const timer = setTimeout(
    () => {
      finish(new Error("OAuth login timed out. Try Connect again."));
      void close();
    },
    Math.max(5_000, Number(timeoutMs) || 180_000),
  );

  const close = () =>
    new Promise((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });

  const bind = (usePort) =>
    new Promise((resolve, reject) => {
      const onErr = (error) => {
        server.off("listening", onListen);
        reject(error);
      };
      const onListen = () => {
        server.off("error", onErr);
        resolve();
      };
      server.once("error", onErr);
      server.once("listening", onListen);
      server.listen(usePort, "127.0.0.1");
    });

  return bind(wanted)
    .catch((error) => {
      if (error && error.code === "EADDRINUSE" && wanted !== 0) return bind(0);
      throw error;
    })
    .then(() => {
      const addr = server.address();
      const bound = addr && typeof addr === "object" ? addr.port : wanted;
      return {
        port: bound,
        redirectUri: `http://127.0.0.1:${bound}${path}`,
        wait: () => done,
        close,
      };
    });
}

function authorizeUrl(authorizeEndpoint, params) {
  const u = new URL(authorizeEndpoint);
  for (const [key, value] of Object.entries(params || {})) {
    if (value == null || value === "") continue;
    u.searchParams.set(key, String(value));
  }
  return u.toString();
}

/**
 * POST the authorization code to the provider token URL.
 * `body` is a plain object (never logged). Returns the parsed JSON payload.
 */
async function exchangeCode({ tokenUrl, body, headers = {}, fetchImpl, json = false }) {
  if (typeof fetchImpl !== "function")
    throw new Error("Token exchange needs a fetch implementation.");
  const init = {
    method: "POST",
    headers: { ...headers },
  };
  if (json) {
    init.headers["content-type"] = init.headers["content-type"] || "application/json";
    init.body = JSON.stringify(body);
  } else {
    init.headers["content-type"] =
      init.headers["content-type"] || "application/x-www-form-urlencoded";
    init.body = new URLSearchParams(body).toString();
  }
  const res = await fetchImpl(String(tokenUrl), init);
  const raw = await res.text().catch(() => "");
  let payload = raw;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = raw;
  }
  if (!res.ok) {
    const detail =
      (payload &&
        typeof payload === "object" &&
        (payload.error_description || payload.error || payload.message)) ||
      (typeof payload === "string" ? payload.slice(0, 160) : `HTTP ${res.status}`);
    throw new Error(String(detail || `Token endpoint answered ${res.status}.`));
  }
  if (payload && typeof payload === "object" && payload.error && !payload.access_token) {
    throw new Error(String(payload.error_description || payload.error));
  }
  return payload;
}

module.exports = {
  DEFAULT_PORT,
  CALLBACK_PATH,
  pkcePair,
  randomState,
  listen,
  authorizeUrl,
  exchangeCode,
};
