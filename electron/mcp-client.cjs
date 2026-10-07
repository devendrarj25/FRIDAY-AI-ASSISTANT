/**
 * FRIDAY · MCP client (JSON-RPC 2.0).
 *
 * Speaks initialize → notifications/initialized → tools/list → tools/call
 * over stdio (newline JSON or LSP Content-Length) or HTTP POST. This is the
 * ONE MCP client; connector actions are then flattened through connectorTools()
 * like every other connector. No second tool registry.
 *
 * Launch commands are owner-supplied. Callers treat tools/call as write/exec
 * and keep the existing governance gate.
 */
const { spawn } = require("node:child_process");
const { fetchCompat } = require("./net-fetch.cjs");

const PROTOCOL = "2024-11-05";
const CLIENT_INFO = { name: "FRIDAY", version: "1.0.0.2" };

function parseCommand(line) {
  const raw = String(line || "").trim();
  if (!raw) return null;
  const parts = [];
  let cur = "";
  let quote = "";
  for (const ch of raw) {
    if (quote) {
      if (ch === quote) quote = "";
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur) parts.push(cur);
  return parts.length ? parts : null;
}

function rpcError(payload) {
  if (!payload || typeof payload !== "object") return "MCP server returned an empty response.";
  if (payload.error) {
    const err = payload.error;
    return String(err.message || err.code || "MCP error");
  }
  return null;
}

/* ------------------------------------------------------------------ stdio */

function splitFrames(buffer) {
  const messages = [];
  let rest = buffer;
  while (rest.length) {
    if (rest.startsWith("Content-Length:")) {
      const headerEnd = rest.indexOf("\r\n\r\n");
      const altEnd = rest.indexOf("\n\n");
      const splitAt = headerEnd >= 0 ? headerEnd : altEnd;
      if (splitAt < 0) break;
      const header = rest.slice(0, splitAt);
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      const len = match ? Number(match[1]) : 0;
      const start = splitAt + (headerEnd >= 0 ? 4 : 2);
      if (rest.length < start + len) break;
      messages.push(rest.slice(start, start + len));
      rest = rest.slice(start + len);
      continue;
    }
    const nl = rest.indexOf("\n");
    if (nl < 0) break;
    const line = rest.slice(0, nl).trim();
    rest = rest.slice(nl + 1);
    if (line) messages.push(line);
  }
  return { messages, rest };
}

function openStdio(commandLine, { cwd, timeoutMs = 20_000 } = {}) {
  const parts = parseCommand(commandLine);
  if (!parts) throw new Error("Give a launch command for the MCP server.");
  const child = spawn(parts[0], parts.slice(1), {
    cwd: cwd || process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, NO_COLOR: "1" },
  });
  let buf = "";
  const pending = new Map();
  let seq = 0;
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-2000);
  });
  const consume = (chunk) => {
    buf += String(chunk);
    const split = splitFrames(buf);
    buf = split.rest;
    for (const raw of split.messages) {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        continue;
      }
      if (msg && msg.id != null && pending.has(msg.id)) {
        const wait = pending.get(msg.id);
        pending.delete(msg.id);
        wait(msg);
      }
    }
  };
  child.stdout?.on("data", consume);
  const closed = new Promise((resolve) => {
    child.on("close", (code) => resolve(code));
  });

  function request(method, params) {
    const id = ++seq;
    const payload = { jsonrpc: "2.0", id, method, params: params || {} };
    child.stdin.write(`${JSON.stringify(payload)}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP ${method} timed out.${stderr ? ` ${stderr.slice(-200)}` : ""}`));
      }, timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        const err = rpcError(msg);
        if (err) reject(new Error(err));
        else resolve(msg.result);
      });
    });
  }

  function notify(method, params) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params: params || {} })}\n`);
  }

  function close() {
    try {
      child.stdin.end();
    } catch {
      /* already gone */
    }
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }

  return { request, notify, close, closed };
}

/* ------------------------------------------------------------------- http */

async function httpRpc(url, bearer, payload, fetchImpl) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const res = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(payload) });
  const raw = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}${raw ? ` — ${raw.slice(0, 160)}` : ""}`);
  const type = String(res.headers?.get?.("content-type") || "");
  if (type.includes("text/event-stream")) {
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      try {
        return JSON.parse(trimmed.slice(5).trim());
      } catch {
        /* next event */
      }
    }
    throw new Error("MCP SSE response had no JSON payload.");
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("MCP HTTP response was not JSON.");
  }
}

function openHttp(url, bearer, fetchImpl = fetchCompat, timeoutMs = 20_000) {
  let seq = 0;
  async function request(method, params) {
    const id = ++seq;
    const payload = { jsonrpc: "2.0", id, method, params: params || {} };
    const timer = setTimeout(() => {}, timeoutMs);
    try {
      const msg = await httpRpc(url, bearer, payload, fetchImpl);
      const err = rpcError(msg);
      if (err) throw new Error(err);
      return msg.result;
    } finally {
      clearTimeout(timer);
    }
  }
  async function notify(method, params) {
    await httpRpc(url, bearer, { jsonrpc: "2.0", method, params: params || {} }, fetchImpl).catch(
      () => {},
    );
  }
  return { request, notify, close: () => {} };
}

/* ---------------------------------------------------------------- session */

async function handshake(session) {
  const init = await session.request("initialize", {
    protocolVersion: PROTOCOL,
    capabilities: { tools: {} },
    clientInfo: CLIENT_INFO,
  });
  session.notify("notifications/initialized", {});
  return init || {};
}

async function listTools(session) {
  const result = await session.request("tools/list", {});
  const tools = Array.isArray(result?.tools) ? result.tools : [];
  return tools
    .map((tool) => ({
      name: String(tool?.name || "").trim(),
      description: String(tool?.description || ""),
      inputSchema:
        tool?.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : null,
    }))
    .filter((tool) => tool.name);
}

async function callTool(session, name, args) {
  return session.request("tools/call", {
    name,
    arguments: args && typeof args === "object" ? args : {},
  });
}

/**
 * Open, handshake, list tools, then close (HTTP) or keep (stdio, caller closes).
 * For verify we list then close.
 */
function isLoopbackUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function refuseRemote(url) {
  if (!url) return null;
  if (!isLoopbackUrl(url)) return "A local server must stay on this machine.";
  return null;
}

function isolateToolOutput(result) {
  const raw = typeof result === "string" ? result : JSON.stringify(result ?? "");
  const secret = /(?:password|passwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*\S+/gi;
  const text = String(raw).replace(secret, "[redacted]").slice(0, 8000);
  return { untrusted: true, instruction: false, text };
}

const OPENAPI_RISK = {
  get: "read",
  head: "read",
  post: "exec",
  put: "exec",
  patch: "exec",
  delete: "exec",
};

/** Local OpenAPI document becomes tools at the same read/exec split. No hosted server. */
function importOpenApi(spec) {
  const servers = Array.isArray(spec?.servers) ? spec.servers : [];
  const serverUrl = String(servers[0]?.url || "");
  if (!isLoopbackUrl(serverUrl)) {
    return { ok: false, reason: "OpenAPI import stays on this machine.", tools: [] };
  }
  const tools = [];
  const paths = spec?.paths && typeof spec.paths === "object" ? spec.paths : {};
  for (const [route, item] of Object.entries(paths)) {
    if (!item || typeof item !== "object") continue;
    for (const method of Object.keys(item)) {
      const risk = OPENAPI_RISK[method.toLowerCase()];
      if (!risk) continue;
      const op = item[method] || {};
      const raw = String(op.operationId || `${method}_${route}`);
      tools.push({
        name: raw.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80),
        description: String(op.summary || route),
        risk,
        method: method.toUpperCase(),
        path: route,
      });
    }
  }
  return { ok: true, tools };
}

async function listFromConfig({ command, url, bearer, cwd, fetchImpl, ownerAllowed = true }) {
  if (!ownerAllowed) return { ok: false, error: "The owner has not allowed this server." };
  const remote = refuseRemote(url);
  if (remote) return { ok: false, error: remote };
  if (url) {
    const session = openHttp(String(url).trim(), bearer || "", fetchImpl || fetchCompat);
    try {
      const info = await handshake(session);
      const tools = await listTools(session);
      const serverName = info?.serverInfo?.name || "MCP server";
      return { ok: true, serverName, tools };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    } finally {
      session.close();
    }
  }
  if (command) {
    let session;
    try {
      session = openStdio(command, { cwd });
      const info = await handshake(session);
      const tools = await listTools(session);
      session.close();
      const serverName = info?.serverInfo?.name || "MCP server";
      return { ok: true, serverName, tools };
    } catch (error) {
      try {
        session?.close();
      } catch {
        /* ignore */
      }
      return { ok: false, error: String(error?.message || error) };
    }
  }
  return { ok: false, error: "Give an MCP server URL or a launch command." };
}

async function callFromConfig(
  { command, url, bearer, cwd, fetchImpl, allow, ownerAllowed = true },
  name,
  args,
) {
  if (!ownerAllowed)
    return { ok: false, error: "The owner has not allowed this server.", untrusted: true };
  const remote = refuseRemote(url);
  if (remote) return { ok: false, error: remote, untrusted: true };
  if (Array.isArray(allow) && !allow.map((item) => String(item)).includes(String(name))) {
    return { ok: false, error: "That tool is not on this server's allow list.", untrusted: true };
  }
  if (url) {
    const session = openHttp(String(url).trim(), bearer || "", fetchImpl || fetchCompat);
    try {
      await handshake(session);
      const result = await callTool(session, name, args);
      return { ok: true, result, untrusted: true, output: isolateToolOutput(result) };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    } finally {
      session.close();
    }
  }
  if (command) {
    let session;
    try {
      session = openStdio(command, { cwd });
      await handshake(session);
      const result = await callTool(session, name, args);
      session.close();
      return { ok: true, result, untrusted: true, output: isolateToolOutput(result) };
    } catch (error) {
      try {
        session?.close();
      } catch {
        /* ignore */
      }
      return { ok: false, error: String(error?.message || error) };
    }
  }
  return { ok: false, error: "Give an MCP server URL or a launch command." };
}

async function healthFromConfig(config = {}) {
  const listed = await listFromConfig(config);
  if (!listed.ok) return listed;
  return { ok: true, serverName: listed.serverName, tools: listed.tools.length };
}

module.exports = {
  PROTOCOL,
  parseCommand,
  isLoopbackUrl,
  importOpenApi,
  isolateToolOutput,
  listFromConfig,
  callFromConfig,
  healthFromConfig,
  openStdio,
  openHttp,
  handshake,
  listTools,
  callTool,
};
