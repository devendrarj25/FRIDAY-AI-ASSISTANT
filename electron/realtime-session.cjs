/**
 * The connection to a speech-to-speech engine that runs on this PC.
 *
 * A realtime engine speaks the Realtime-style JSON events over a WebSocket. This is only the pipe: it opens one
 * connection to a loopback address (127.0.0.1, localhost or ::1), passes JSON events both ways and closes it. What the events
 * mean, and whether a session may start at all, is decided in the renderer (`realtime-protocol.ts`). The main
 * process refuses anything that is not a loopback address, so a cloud engine cannot be reached through here: the
 * WebSocket client built into Node cannot send an authorization header, and microphone audio leaving this PC is a
 * separate, gated decision that is not made in this file.
 */
const LOOPBACK = /^wss?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i;
const MAX_MESSAGE = 4 * 1024 * 1024;

function createRealtimeSessions({ WebSocketImpl = globalThis.WebSocket } = {}) {
  /** @type {Map<string, any>} */
  const open = new Map();

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
    open.set(id, socket);
    socket.addEventListener("open", () => handlers.onOpen?.());
    socket.addEventListener("message", (event) => {
      const data = event.data;
      if (typeof data !== "string" || data.length > MAX_MESSAGE) return;
      try {
        handlers.onEvent?.(JSON.parse(data));
      } catch {
        /* a frame that is not JSON is ignored */
      }
    });
    socket.addEventListener("close", () => {
      open.delete(id);
      handlers.onClose?.("closed");
    });
    socket.addEventListener("error", () => handlers.onClose?.("error"));
    return { ok: true };
  }

  function send(id, event) {
    const socket = open.get(id);
    if (!socket || socket.readyState !== 1) return { ok: false, error: "the session is not open" };
    const text = JSON.stringify(event);
    if (text.length > MAX_MESSAGE) return { ok: false, error: "that message is too large" };
    socket.send(text);
    return { ok: true };
  }

  function close(id) {
    const socket = open.get(id);
    if (!socket) return { ok: true };
    open.delete(id);
    try {
      socket.close();
    } catch {
      /* already closed */
    }
    return { ok: true };
  }

  return { start, send, close, count: () => open.size, LOOPBACK };
}

module.exports = { createRealtimeSessions, LOOPBACK };
