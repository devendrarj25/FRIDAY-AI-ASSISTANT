/**
 * The connection to a speech-to-speech engine: on this PC, or one named cloud provider.
 *
 * A realtime engine speaks the Realtime-style JSON events over a WebSocket. This is only the pipe: it opens one
 * connection, passes JSON events both ways and closes it. What the events mean, and whether a session may start
 * at all, is decided in the renderer (`realtime-protocol.ts`).
 *
 * `start` accepts only a loopback address (127.0.0.1, localhost or ::1).
 * `startCloud` accepts only a provider id from the fixed `CLOUD_REALTIME` table, never an address from the
 * renderer. It sends the API key as an Authorization header (the WebSocket built into Node and Electron accepts a
 * `headers` option; checked against a local server) and the key is handed in by the main process, which reads it
 * from the encrypted store. The key never reaches the renderer or a log, and an error text is scrubbed of it.
 * The cloud path is paid, sends microphone audio off this PC and is unverified against the live provider; the
 * conditions that allow it (paid access, a saved key, privacy mode off, this session's consent) are re-checked in
 * `main.cjs` before this file is called.
 */
const { createGeminiAdapter } = require("./realtime-adapters.cjs");

const LOOPBACK = /^wss?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i;
const MAX_MESSAGE = 4 * 1024 * 1024;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/**
 * The only cloud realtime endpoints. The address is built here from a provider id and a model id. No model is
 * defaulted: a realtime model costs money, so the owner names it.
 */
const CLOUD_REALTIME = {
  openai: {
    label: "OpenAI Realtime",
    host: "api.openai.com",
    url: (model) => `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`,
    headers: (key) => ({ Authorization: `Bearer ${key}`, "OpenAI-Beta": "realtime=v1" }),
  },
};

CLOUD_REALTIME.xai = {
  label: "xAI Grok Voice",
  host: "api.x.ai",
  // Same event vocabulary as the OpenAI style. The default audio is 24 kHz PCM16 according to secondary sources
  // only (the xAI pages read do not state a format), so this entry is unverified.
  url: (model) => `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(model)}`,
  headers: (key) => ({ Authorization: `Bearer ${key}` }),
};

CLOUD_REALTIME.gemini = {
  label: "Google Gemini Live",
  host: "generativelanguage.googleapis.com",
  // The key travels in the query string here (Google's SDK does the same). It is never logged and is scrubbed
  // from every error text.
  url: (_model, key) =>
    `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(key)}`,
  headers: () => ({}),
  adapter: (model) => createGeminiAdapter({ model }),
};

const scrub = (text, key) => {
  const raw = String(text ?? "");
  return key ? raw.split(key).join("[key]") : raw;
};

function createRealtimeSessions({ WebSocketImpl = globalThis.WebSocket } = {}) {
  /** @type {Map<string, any>} */
  const open = new Map();
  /** @type {Map<string, any>} */
  const adapters = new Map();

  /** Binary frames carry JSON for some providers (Gemini). Text and binary are read the same way, in order. */
  async function frameText(data) {
    if (typeof data === "string") return data;
    if (data && typeof data.text === "function") return data.size > MAX_MESSAGE ? "" : data.text();
    if (data instanceof ArrayBuffer)
      return data.byteLength > MAX_MESSAGE ? "" : Buffer.from(data).toString("utf8");
    return "";
  }

  function attach(id, socket, handlers, adapter = null) {
    open.set(id, socket);
    if (adapter) adapters.set(id, adapter);
    let chain = Promise.resolve();
    socket.addEventListener("open", () => handlers.onOpen?.());
    socket.addEventListener("message", (event) => {
      chain = chain
        .then(async () => {
          const text = await frameText(event.data);
          if (!text || text.length > MAX_MESSAGE) return;
          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch {
            return; // a frame that is not JSON is ignored
          }
          if (!adapter) return handlers.onEvent?.(parsed);
          const { events, replies } = adapter.decode(parsed);
          for (const reply of replies) {
            if (socket.readyState === 1) socket.send(JSON.stringify(reply));
          }
          for (const next of events) handlers.onEvent?.(next);
        })
        .catch(() => undefined);
    });
    socket.addEventListener("close", () => {
      open.delete(id);
      adapters.delete(id);
      handlers.onClose?.("closed");
    });
    socket.addEventListener("error", () => handlers.onClose?.("error"));
  }

  function start(id, url, handlers) {
    if (typeof WebSocketImpl !== "function")
      return { ok: false, error: "this runtime has no WebSocket client" };
    if (!LOOPBACK.test(String(url || ""))) {
      return {
        ok: false,
        error: "only an engine on this PC (127.0.0.1 or localhost) can be connected here",
      };
    }
    if (open.size >= 1) return { ok: false, error: "a realtime session is already open" };
    let socket;
    try {
      socket = new WebSocketImpl(url);
    } catch (error) {
      return { ok: false, error: `could not open the connection (${error?.message || error})` };
    }
    attach(id, socket, handlers);
    return { ok: true };
  }

  /** A cloud provider named in CLOUD_REALTIME. `apiKey` comes from the main process, never from the renderer. */
  function startCloud(id, providerId, model, apiKey, handlers) {
    if (typeof WebSocketImpl !== "function")
      return { ok: false, error: "this runtime has no WebSocket client" };
    const provider = Object.hasOwn(CLOUD_REALTIME, providerId) ? CLOUD_REALTIME[providerId] : null;
    if (!provider) return { ok: false, error: "that provider has no realtime connection here" };
    if (!MODEL_ID.test(String(model || "")))
      return { ok: false, error: "name the realtime model to use (letters, digits, . _ : -)" };
    if (!apiKey || typeof apiKey !== "string")
      return { ok: false, error: "no provider key is saved" };
    if (open.size >= 1) return { ok: false, error: "a realtime session is already open" };
    let socket;
    try {
      socket = new WebSocketImpl(provider.url(model, apiKey), {
        headers: provider.headers(apiKey),
      });
    } catch (error) {
      return {
        ok: false,
        error: `could not open the connection (${scrub(error?.message || error, apiKey)})`,
      };
    }
    attach(id, socket, handlers, provider.adapter ? provider.adapter(model) : null);
    return { ok: true, provider: providerId, host: provider.host };
  }

  function send(id, event) {
    const socket = open.get(id);
    if (!socket || socket.readyState !== 1) return { ok: false, error: "the session is not open" };
    const adapter = adapters.get(id);
    const messages = adapter ? adapter.encode(event) : [event];
    for (const message of messages) {
      const text = JSON.stringify(message);
      if (text.length > MAX_MESSAGE) return { ok: false, error: "that message is too large" };
      socket.send(text);
    }
    return { ok: true };
  }

  function close(id) {
    const socket = open.get(id);
    if (!socket) return { ok: true };
    open.delete(id);
    adapters.delete(id);
    try {
      socket.close();
    } catch {
      /* already closed */
    }
    return { ok: true };
  }

  return { start, startCloud, send, close, count: () => open.size, LOOPBACK };
}

module.exports = { createRealtimeSessions, LOOPBACK, CLOUD_REALTIME };
