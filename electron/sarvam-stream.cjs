/**
 * Sarvam streaming speech over WebSocket, in the main process so a key never reaches the renderer.
 *
 * Two fixed endpoints, read from the provider's own pages on 2026-11-08 (nothing here has run against a live account):
 *   speech to text   wss://api.sarvam.ai/speech-to-text-realtime/ws   query: language_code, model, stream_type, mode,
 *                    endpointing, encoding, sample_rate, silence_duration_ms, keyterms (saaras:v4 only, up to 50 x 64)
 *                    client: {event:"audio_input", audio:<base64 PCM16>}, {event:"end"}; ping keeps it alive
 *                    server: session.begin, vad.speech_start, transcript.partial, vad.speech_end, transcript.final,
 *                            config.updated, pong, session.end{audio_duration_s}, error{code,is_fatal,message}
 *   text to speech   wss://api.sarvam.ai/text-to-speech/ws?model=bulbul:v4-flash&send_completion_event=true
 *                    client: {type:"config",data:{...}} then {type:"text",data:{text}} then {type:"flush"}
 *                    server: {type:"audio",data:{content_type,audio,request_id}}, {type:"event",data:{event_type:"final"}},
 *                            {type:"error",data:{message,code}}
 * The key goes in the `api-subscription-key` header (the WebSocket in Node and Electron accepts a `headers` option, as
 * `realtime-session.cjs` already relies on). The renderer never names an address: only a kind ("stt" or "tts") and a
 * small, validated option set. An error text is scrubbed of the key. Gates are the ones `voice-cloud.cjs` applies
 * (cloud voice on, provider allowed, privacy mode off, a key saved).
 */
const HOST = "api.sarvam.ai";
const MAX_MESSAGE = 4 * 1024 * 1024;
const MAX_AUDIO_B64 = 256 * 1024;
const MAX_TEXT = 2500;
const MAX_SESSIONS = 4;
const KEYTERM_LIMIT = 50;
const KEYTERM_LENGTH = 64;
const PING_MS = 15_000;

const STT_LANGS = new Set([
  "auto",
  "en-IN",
  "hi-IN",
  "bn-IN",
  "kn-IN",
  "ml-IN",
  "mr-IN",
  "or-IN",
  "pa-IN",
  "ta-IN",
  "te-IN",
  "gu-IN",
  "ur-IN",
  "ne-IN",
]);
const STT_MODELS = new Set(["saaras:v3-realtime", "saaras:v4"]);
const STT_STREAMS = new Set(["fast", "balanced", "simulated"]);
const STT_RATES = new Set([8000, 16000]);
const TTS_MODELS = new Set(["bulbul:v2", "bulbul:v3", "bulbul:v4-flash"]);
const TTS_LANGS = /^(bn|en|gu|hi|kn|ml|mr|od|pa|ta|te)-IN$/;
const TTS_RATES = new Set([8000, 16000, 22050, 24000]);
const SPEAKER = /^[a-z0-9_]{2,48}$/;
// The provider page says mp3 is the only codec supported today; a caller may name another, and it is passed through.
const CODECS = new Set(["mp3", "wav", "opus", "flac", "aac", "linear16"]);

const scrub = (text, key) => {
  const raw = String(text ?? "");
  return key ? raw.split(key).join("[key]") : raw;
};

function cleanKeyterms(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    const term = String(item ?? "").trim();
    if (term && term.length <= KEYTERM_LENGTH && !out.includes(term)) out.push(term);
    if (out.length >= KEYTERM_LIMIT) break;
  }
  return out;
}

/** @returns {{ok: true, url: string}|{ok: false, error: string}} */
function buildSttUrl(options = {}) {
  const language = String(options.language ?? "auto");
  if (!STT_LANGS.has(language))
    return { ok: false, error: "that language is not offered by the realtime speech-to-text" };
  const model = String(options.model ?? "saaras:v4");
  if (!STT_MODELS.has(model))
    return { ok: false, error: "that speech-to-text model is not offered" };
  const stream = String(options.streamType ?? "fast");
  if (!STT_STREAMS.has(stream)) return { ok: false, error: "that stream type is not offered" };
  const rate = Number(options.sampleRate ?? 16000);
  if (!STT_RATES.has(rate))
    return { ok: false, error: "the realtime speech-to-text takes 8000 or 16000 Hz audio only" };
  const params = new URLSearchParams({
    language_code: language,
    model,
    stream_type: stream,
    encoding: "linear16",
    sample_rate: String(rate),
    endpointing: options.endpointing === "manual" ? "manual" : "vad",
  });
  if (options.hinglish !== false) params.set("mode", "codemix");
  const silence = Number(options.silenceMs);
  if (Number.isFinite(silence) && silence >= 100 && silence <= 3000)
    params.set("silence_duration_ms", String(Math.round(silence)));
  const terms = model === "saaras:v4" ? cleanKeyterms(options.keyterms) : [];
  if (terms.length) params.set("keyterms", JSON.stringify(terms));
  return { ok: true, url: `wss://${HOST}/speech-to-text-realtime/ws?${params.toString()}` };
}

/** @returns {{ok: true, url: string, config: object}|{ok: false, error: string}} */
function buildTtsSession(options = {}) {
  const model = String(options.model ?? "bulbul:v4-flash");
  if (!TTS_MODELS.has(model)) return { ok: false, error: "that voice model is not offered" };
  const language = String(options.language ?? "hi-IN");
  if (!TTS_LANGS.test(language)) return { ok: false, error: "name the language as hi-IN or en-IN" };
  const speaker = String(options.speaker ?? "");
  if (!SPEAKER.test(speaker))
    return {
      ok: false,
      error: "name a voice (for bulbul:v4-flash a persona such as aparna_hi_customer)",
    };
  const rate = Number(options.sampleRate ?? 24000);
  if (!TTS_RATES.has(rate)) return { ok: false, error: "that sample rate is not offered" };
  const codec = String(options.codec ?? "mp3");
  if (!CODECS.has(codec)) return { ok: false, error: "that audio codec is not offered" };
  const data = {
    model,
    language_code: language,
    speaker,
    speech_sample_rate: String(rate),
    output_audio_codec: codec,
  };
  const pace = Number(options.pace);
  if (Number.isFinite(pace) && Math.abs(pace - 1) > 0.01)
    data.pace = Math.min(2, Math.max(0.5, Math.round(pace * 100) / 100));
  return {
    ok: true,
    url: `wss://${HOST}/text-to-speech/ws?model=${encodeURIComponent(model)}&send_completion_event=true`,
    config: { type: "config", data },
  };
}

/** One server frame of the speech-to-text socket, as a small normalised event. */
function parseSttEvent(frame) {
  if (!frame || typeof frame !== "object") return null;
  const type = String(frame.event ?? frame.type ?? "");
  const body = frame.data && typeof frame.data === "object" ? frame.data : frame;
  switch (type) {
    case "session.begin":
      return { type: "begin" };
    case "vad.speech_start":
      return { type: "speech-start" };
    case "vad.speech_end":
      return { type: "speech-end" };
    case "transcript.partial":
    case "transcript.final": {
      const text = String(body.text ?? body.transcript ?? "").trim();
      const out = { type: type === "transcript.partial" ? "partial" : "final", text };
      if (body.language) out.language = String(body.language);
      if (typeof body.language_confidence === "number")
        out.languageConfidence = body.language_confidence;
      return out;
    }
    case "session.end": {
      const seconds = Number(body.audio_duration_s);
      return { type: "end", ...(Number.isFinite(seconds) ? { audioSeconds: seconds } : {}) };
    }
    case "config.updated":
      return { type: "config" };
    case "pong":
      return { type: "pong" };
    case "error":
      return {
        type: "error",
        code: Number.isFinite(Number(body.code)) ? Number(body.code) : 0,
        fatal: body.is_fatal === true,
        message: String(body.message ?? "the provider reported an error"),
      };
    default:
      return null;
  }
}

/** What a close code means for a retry, from the provider's page. */
function classifyClose(code) {
  switch (Number(code)) {
    case 1003:
      return { retry: false, reason: "the key, quota or rate limit was refused" };
    case 1008:
      return { retry: true, reason: "the connection sat idle" };
    case 1011:
      return { retry: true, reason: "the provider had an internal error" };
    case 4000:
      return {
        retry: false,
        reason: "the model, language or an option was refused, or the account is not enabled",
      };
    default:
      return { retry: Number(code) !== 1000, reason: "the connection closed" };
  }
}

/** One server frame of the text-to-speech socket. */
function parseTtsEvent(frame) {
  if (!frame || typeof frame !== "object") return null;
  const body = frame.data && typeof frame.data === "object" ? frame.data : {};
  if (frame.type === "audio") {
    const audio = typeof body.audio === "string" ? body.audio : "";
    if (!audio || audio.length > MAX_AUDIO_B64 * 8) return null;
    return {
      type: "audio",
      audioBase64: audio,
      mime: String(body.content_type ?? "audio/mp3"),
      ...(body.request_id ? { requestId: String(body.request_id) } : {}),
    };
  }
  if (frame.type === "event") return body.event_type === "final" ? { type: "complete" } : null;
  if (frame.type === "error") {
    return {
      type: "error",
      code: Number.isFinite(Number(body.code)) ? Number(body.code) : 0,
      message: String(body.message ?? "the provider reported an error"),
    };
  }
  return null;
}

function createSarvamStreams({
  WebSocketImpl = globalThis.WebSocket,
  gate,
  setInterval: setIntervalImpl = globalThis.setInterval,
  clearInterval: clearIntervalImpl = globalThis.clearInterval,
} = {}) {
  /** @type {Map<string, {socket: any, kind: string, key: string, timer: any, cfg?: object}>} */
  const sessions = new Map();

  function open(id, kind, options, handlers) {
    if (typeof WebSocketImpl !== "function")
      return { ok: false, error: "this app has no WebSocket" };
    if (kind !== "stt" && kind !== "tts")
      return { ok: false, error: "name the stream as stt or tts" };
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id))
      return { ok: false, error: "that stream id is not valid" };
    if (sessions.has(id)) return { ok: false, error: "that stream is already open" };
    if (sessions.size >= MAX_SESSIONS)
      return { ok: false, error: "too many speech streams are open" };
    const allowed = gate("sarvam");
    if (!allowed.ok) return allowed;
    const spec = kind === "stt" ? buildSttUrl(options) : buildTtsSession(options);
    if (!spec.ok) return spec;
    let socket;
    try {
      socket = new WebSocketImpl(spec.url, { headers: { "api-subscription-key": allowed.key } });
    } catch (error) {
      return {
        ok: false,
        error: `could not connect (${scrub(error?.message || error, allowed.key)})`,
      };
    }
    socket.binaryType = "arraybuffer";
    const session = { socket, kind, key: allowed.key, timer: null };
    sessions.set(id, session);
    const parse = kind === "stt" ? parseSttEvent : parseTtsEvent;
    socket.addEventListener("open", () => {
      if (kind === "tts" && spec.config) socket.send(JSON.stringify(spec.config));
      session.timer = setIntervalImpl(() => {
        if (socket.readyState === 1)
          socket.send(JSON.stringify(kind === "stt" ? { event: "ping" } : { type: "ping" }));
      }, PING_MS);
      session.timer?.unref?.();
      handlers.onOpen?.();
    });
    socket.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : "";
      if (!raw || raw.length > MAX_MESSAGE) return;
      let json;
      try {
        json = JSON.parse(raw);
      } catch {
        return;
      }
      const next = parse(json);
      if (next) handlers.onEvent?.(next);
    });
    const finish = (code, reason) => {
      if (!sessions.has(id)) return;
      clearIntervalImpl(session.timer);
      sessions.delete(id);
      const verdict = classifyClose(code);
      handlers.onClose?.({
        code: Number(code) || 0,
        retry: verdict.retry,
        reason: scrub(reason || verdict.reason, session.key),
      });
    };
    socket.addEventListener("close", (event) => finish(event?.code, event?.reason));
    socket.addEventListener("error", () => finish(1011, "the connection failed"));
    return { ok: true, id, kind };
  }

  function send(id, message) {
    const session = sessions.get(id);
    if (!session || session.socket.readyState !== 1)
      return { ok: false, error: "that stream is not open" };
    const m = message || {};
    let frame = null;
    if (session.kind === "stt") {
      if (m.type === "audio") {
        const audio = String(m.audioBase64 ?? "");
        if (!audio || audio.length > MAX_AUDIO_B64)
          return { ok: false, error: "that audio chunk is the wrong size" };
        frame = { event: "audio_input", audio };
      } else if (m.type === "end") frame = { event: "end" };
      else if (m.type === "flush") frame = { event: "flush" };
    } else if (m.type === "text") {
      const text = String(m.text ?? "").trim();
      if (!text || text.length > MAX_TEXT)
        return { ok: false, error: `send 1 to ${MAX_TEXT} characters at a time` };
      frame = { type: "text", data: { text } };
    } else if (m.type === "flush") frame = { type: "flush" };
    if (!frame) return { ok: false, error: "that message is not allowed on this stream" };
    session.socket.send(JSON.stringify(frame));
    return { ok: true };
  }

  function close(id) {
    const session = sessions.get(id);
    if (!session) return { ok: true };
    try {
      session.socket.close(1000);
    } catch {
      /* already closing */
    }
    return { ok: true };
  }

  const count = () => sessions.size;
  return { open, send, close, count };
}

module.exports = {
  createSarvamStreams,
  buildSttUrl,
  buildTtsSession,
  parseSttEvent,
  parseTtsEvent,
  classifyClose,
  cleanKeyterms,
  HOST,
};
