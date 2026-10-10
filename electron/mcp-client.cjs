/**
 * FRIDAY · MCP client.
 *
 * Uses electron/mcp-protocol.cjs, the same layer as the server. Connector
 * actions stay on this module. A public URL is refused unless the owner
 * turned remote access on for that https server. Tool text stays data.
 */
const { spawn } = require("node:child_process");
const { fetchCompat } = require("./net-fetch.cjs");
const proto = require("./mcp-protocol.cjs");
const privacy = require("./privacy-firewall.cjs");

const PROTOCOL = proto.CURRENT_VERSION;
const pins = new Map();

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

function rememberPins(key, tools) {
  const previous = pins.get(key);
  const next = proto.pinTools(tools, previous);
  pins.set(key, next.pins);
  return next.changes;
}

function namespaceTools(serverId, tools) {
  const prefix = String(serverId || "").trim();
  if (!prefix) return tools;
  return tools.map((tool) => ({
    ...tool,
    rawName: tool.name,
    name: `${prefix}__${tool.name}`,
  }));
}

/* ------------------------------------------------------------------ stdio */

function openStdio(commandLine, { cwd, timeoutMs = 20_000, onServerRequest } = {}) {
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
  const progress = [];
  const inputs = [];
  child.stderr?.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-2000);
  });
  const consume = (chunk) => {
    buf += String(chunk);
    const split = proto.splitFrames(buf);
    buf = split.rest;
    for (const raw of split.messages) {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        continue;
      }
      if (msg?.method === "notifications/progress") {
        progress.push(msg.params || {});
        continue;
      }
      if (msg && msg.method && msg.id != null && !pending.has(msg.id)) {
        if (onServerRequest) onServerRequest(msg, respond);
        else inputs.push(msg);
        continue;
      }
      if (msg && msg.id != null && pending.has(msg.id)) {
        const wait = pending.get(msg.id);
        pending.delete(msg.id);
        wait(msg);
      }
    }
  };
  function respond(id, result, error) {
    const payload = error
      ? proto.jsonRpcError(id, error.code || proto.ERROR.INTERNAL, error.message)
      : proto.jsonRpcResult(id, result);
    child.stdin.write(proto.encodeLine(payload));
  }
  child.stdout?.on("data", consume);
  const closed = new Promise((resolve) => {
    child.on("close", (code) => resolve(code));
  });

  function request(method, params) {
    const id = ++seq;
    child.stdin.write(proto.encodeLine({ jsonrpc: "2.0", id, method, params: params || {} }));
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
    child.stdin.write(proto.encodeLine({ jsonrpc: "2.0", method, params: params || {} }));
  }

  function cancel(requestId) {
    notify("notifications/cancelled", { requestId });
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

  return { request, notify, cancel, close, closed, progress, inputs, protocol: PROTOCOL };
}

/* ------------------------------------------------------------------- http */

async function httpRpc(url, bearer, payload, fetchImpl, extraHeaders) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": proto.CURRENT_VERSION,
    "mcp-method": String(payload?.method || ""),
    ...(extraHeaders || {}),
  };
  if (payload?.method === "tools/call") headers["mcp-name"] = String(payload?.params?.name || "");
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const res = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(payload) });
  const raw = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}${raw ? ` — ${raw.slice(0, 160)}` : ""}`);
  const type = String(res.headers?.get?.("content-type") || "");
  if (type.includes("text/event-stream")) {
    const events = proto.parseSse(raw);
    const match =
      events.find((event) => event && event.id === payload.id) ||
      events.find((event) => event && event.result);
    if (!match) throw new Error("MCP SSE response had no JSON payload.");
    return match;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("MCP HTTP response was not JSON.");
  }
}

function openHttp(url, bearer, fetchImpl = fetchCompat, timeoutMs = 20_000) {
  let seq = 0;
  const progress = [];
  const inputs = [];
  async function request(method, params) {
    const id = ++seq;
    const payload = { jsonrpc: "2.0", id, method, params: params || {} };
    const timer = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`MCP ${method} timed out.`)), timeoutMs);
    });
    const msg = await Promise.race([httpRpc(url, bearer, payload, fetchImpl), timer]);
    const err = rpcError(msg);
    if (err) throw new Error(err);
    return msg.result;
  }
  async function notify(method, params) {
    await httpRpc(url, bearer, { jsonrpc: "2.0", method, params: params || {} }, fetchImpl).catch(
      () => {},
    );
  }
  return {
    request,
    notify,
    cancel: () => {},
    close: () => {},
    progress,
    inputs,
    protocol: PROTOCOL,
  };
}

/* ---------------------------------------------------------------- session */

async function handshake(session) {
  try {
    const init = await session.request("initialize", {
      protocolVersion: proto.CURRENT_VERSION,
      capabilities: { tools: { listChanged: true }, resources: {}, prompts: {}, elicitation: {} },
      clientInfo: proto.clientInfo(),
    });
    session.notify("notifications/initialized", {});
    session.protocol = proto.negotiate(init?.protocolVersion) || proto.LEGACY_VERSION;
    return init || {};
  } catch (error) {
    if (!/method not found|-32601/i.test(String(error?.message || error))) throw error;
    const discovered = await session.request("server/discover", {
      _meta: proto.requestMeta(proto.CURRENT_VERSION, { tools: {}, elicitation: {} }),
    });
    session.protocol = proto.CURRENT_VERSION;
    const info = discovered?._meta?.[proto.META_SERVER_INFO] || {
      name: "MCP server",
      version: "0",
    };
    return {
      protocolVersion: (discovered?.supportedVersions || [proto.CURRENT_VERSION])[0],
      capabilities: discovered?.capabilities || {},
      serverInfo: info,
    };
  }
}

function mapTools(result) {
  const tools = Array.isArray(result?.tools) ? result.tools : [];
  return tools
    .map((tool) => ({
      name: String(tool?.name || "").trim(),
      description: String(tool?.description || ""),
      inputSchema:
        tool?.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : null,
      annotations:
        tool?.annotations && typeof tool.annotations === "object" ? tool.annotations : null,
    }))
    .filter((tool) => tool.name);
}

async function listTools(session) {
  const all = [];
  let cursor = "";
  let pages = 0;
  do {
    pages += 1;
    if (pages > 50) break;
    const result = await session.request("tools/list", cursor ? { cursor } : {});
    all.push(...mapTools(result));
    cursor = result?.nextCursor ? String(result.nextCursor) : "";
  } while (cursor);
  return all;
}

async function listResources(session) {
  const all = [];
  let cursor = "";
  let pages = 0;
  do {
    pages += 1;
    if (pages > 50) break;
    const result = await session.request("resources/list", cursor ? { cursor } : {});
    const rows = Array.isArray(result?.resources) ? result.resources : [];
    all.push(...rows);
    cursor = result?.nextCursor ? String(result.nextCursor) : "";
  } while (cursor);
  return all;
}

async function readResource(session, uri) {
  return session.request("resources/read", { uri });
}

async function listPrompts(session) {
  const result = await session.request("prompts/list", {});
  return Array.isArray(result?.prompts) ? result.prompts : [];
}

async function getPrompt(session, name, args) {
  return session.request("prompts/get", { name, arguments: args || {} });
}

async function callTool(session, name, args) {
  const result = await session.request("tools/call", {
    name,
    arguments: args && typeof args === "object" ? args : {},
  });
  if (result?.resultType === "input_required") {
    session.inputs?.push(result);
  }
  return result;
}

function isLoopbackUrl(value) {
  return proto.isLoopbackUrl(value);
}

function refuseRemote(url, ownerApprovedRemote = false) {
  if (!url) return null;
  if (isLoopbackUrl(url)) return null;
  if (ownerApprovedRemote && /^https:\/\//i.test(String(url))) return null;
  return "A local server must stay on this machine.";
}

function isolateToolOutput(result) {
  return proto.isolateToolOutput(result);
}

const OPENAPI_RISK = {
  get: "read",
  head: "read",
  post: "exec",
  put: "exec",
  patch: "exec",
  delete: "exec",
};

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

function allowed(config, kind) {
  const permissions = config.permissions;
  if (!permissions) return true;
  return permissions[kind] !== false;
}

async function listFromConfig({
  command,
  url,
  bearer,
  cwd,
  fetchImpl,
  ownerAllowed = true,
  ownerApprovedRemote = false,
  serverId,
  permissions,
}) {
  if (!ownerAllowed) return { ok: false, error: "The owner has not allowed this server." };
  if (permissions && permissions.tools === false) {
    return { ok: false, error: "Tools are turned off for this server." };
  }
  const remote = refuseRemote(url, ownerApprovedRemote);
  if (remote) return { ok: false, error: remote };
  const key = url || command || "";
  if (url) {
    const session = openHttp(String(url).trim(), bearer || "", fetchImpl || fetchCompat);
    try {
      const info = await handshake(session);
      const tools = namespaceTools(serverId, await listTools(session));
      const changes = rememberPins(key, tools);
      return {
        ok: true,
        serverName: info?.serverInfo?.name || "MCP server",
        tools,
        changes,
        protocol: session.protocol,
      };
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
      const tools = namespaceTools(serverId, await listTools(session));
      session.close();
      const changes = rememberPins(key, tools);
      return {
        ok: true,
        serverName: info?.serverInfo?.name || "MCP server",
        tools,
        changes,
        protocol: session.protocol,
      };
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

async function callFromConfig(config, name, args) {
  const {
    command,
    url,
    bearer,
    cwd,
    fetchImpl,
    allow,
    ownerAllowed = true,
    ownerApprovedRemote = false,
    samplingAllowed = false,
  } = config;
  if (!ownerAllowed)
    return { ok: false, error: "The owner has not allowed this server.", untrusted: true };
  if (!allowed(config, "tools"))
    return { ok: false, error: "Tools are turned off for this server.", untrusted: true };
  const remote = refuseRemote(url, ownerApprovedRemote);
  if (remote) return { ok: false, error: remote, untrusted: true };
  const rawName = String(name || "").includes("__")
    ? String(name).slice(String(name).indexOf("__") + 2)
    : name;
  if (
    Array.isArray(allow) &&
    !allow.map((item) => String(item)).includes(String(rawName)) &&
    !allow.map(String).includes(String(name))
  ) {
    return { ok: false, error: "That tool is not on this server's allow list.", untrusted: true };
  }
  const finish = (result) => {
    if (result?.resultType === "input_required") {
      return {
        ok: true,
        inputRequired: true,
        result,
        untrusted: true,
        output: isolateToolOutput(result),
      };
    }
    return { ok: true, result, untrusted: true, output: isolateToolOutput(result) };
  };
  if (url) {
    const session = openHttp(String(url).trim(), bearer || "", fetchImpl || fetchCompat);
    try {
      await handshake(session);
      return finish(await callTool(session, rawName, args));
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    } finally {
      session.close();
    }
  }
  if (command) {
    let session;
    try {
      session = openStdio(command, {
        cwd,
        onServerRequest: (msg, respond) =>
          answerServer(msg, respond, samplingAllowed, config.complete),
      });
      await handshake(session);
      const result = await callTool(session, rawName, args);
      session.close();
      return finish(result);
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

function answerServer(message, respond, samplingAllowed, complete) {
  const text = JSON.stringify(message?.params || {});
  if (privacy.classify(text).level === "sensitive") {
    respond(message.id, null, { message: "Sensitive text is not sent to a model." });
    return;
  }
  if (message.method === "sampling/createMessage" || message.method === "elicitation/create") {
    if (!samplingAllowed) {
      respond(message.id, null, {
        message: "FRIDAY does not answer that request until the owner allows it.",
      });
      return;
    }
    if (message.method === "sampling/createMessage" && typeof complete === "function") {
      Promise.resolve()
        .then(() => complete(text))
        .then((answer) => {
          respond(message.id, {
            role: "assistant",
            content: { type: "text", text: String(answer ?? "") },
            model: "friday",
          });
        })
        .catch(() => {
          respond(message.id, null, { message: "FRIDAY could not complete that request." });
        });
      return;
    }
    respond(message.id, null, {
      message: "Show this request in FRIDAY. It is not answered automatically.",
    });
  }
}

async function resourcesFromConfig(config) {
  if (!config.ownerAllowed && config.ownerAllowed !== undefined) {
    return { ok: false, error: "The owner has not allowed this server." };
  }
  if (!allowed(config, "resources"))
    return { ok: false, error: "Resources are turned off for this server." };
  const remote = refuseRemote(config.url, config.ownerApprovedRemote);
  if (remote) return { ok: false, error: remote };
  if (config.url) {
    const session = openHttp(
      String(config.url).trim(),
      config.bearer || "",
      config.fetchImpl || fetchCompat,
    );
    try {
      await handshake(session);
      const resources = await listResources(session);
      return { ok: true, resources };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    } finally {
      session.close();
    }
  }
  if (!config.command) return { ok: false, error: "Give an MCP server URL or a launch command." };
  let session;
  try {
    session = openStdio(config.command, { cwd: config.cwd });
    await handshake(session);
    const resources = await listResources(session);
    session.close();
    return { ok: true, resources };
  } catch (error) {
    try {
      session?.close();
    } catch {
      /* ignore */
    }
    return { ok: false, error: String(error?.message || error) };
  }
}

async function promptsFromConfig(config) {
  if (config.ownerAllowed === false)
    return { ok: false, error: "The owner has not allowed this server." };
  if (!allowed(config, "prompts"))
    return { ok: false, error: "Prompts are turned off for this server." };
  const remote = refuseRemote(config.url, config.ownerApprovedRemote);
  if (remote) return { ok: false, error: remote };
  if (config.url) {
    const session = openHttp(
      String(config.url).trim(),
      config.bearer || "",
      config.fetchImpl || fetchCompat,
    );
    try {
      await handshake(session);
      return { ok: true, prompts: await listPrompts(session) };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    } finally {
      session.close();
    }
  }
  if (!config.command) return { ok: false, error: "Give an MCP server URL or a launch command." };
  let session;
  try {
    session = openStdio(config.command, { cwd: config.cwd });
    await handshake(session);
    const prompts = await listPrompts(session);
    session.close();
    return { ok: true, prompts };
  } catch (error) {
    try {
      session?.close();
    } catch {
      /* ignore */
    }
    return { ok: false, error: String(error?.message || error) };
  }
}

async function healthFromConfig(config = {}) {
  const listed = await listFromConfig(config);
  if (!listed.ok) return listed;
  return {
    ok: true,
    serverName: listed.serverName,
    tools: listed.tools.length,
    changes: listed.changes || [],
    protocol: listed.protocol,
  };
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
  resourcesFromConfig,
  promptsFromConfig,
  openStdio,
  openHttp,
  handshake,
  listTools,
  listResources,
  readResource,
  listPrompts,
  getPrompt,
  callTool,
  namespaceTools,
  rememberPins,
  refuseRemote,
};
