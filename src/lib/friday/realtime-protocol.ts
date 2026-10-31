/**
 * FRIDAY · realtime speech session protocol (no network in this file)
 *
 * The event shapes of a Realtime-style speech-to-speech session (the OpenAI Realtime wire format, which local
 * servers also copy): what FRIDAY sends (session settings, microphone audio, barge-in) and how what comes back
 * (audio, transcripts, errors) changes the session's state. It is a pure state machine so it can be tested with
 * scripted events, and a transport (a WebSocket in the main process, started only by the owner) can drive it
 * later. Nothing here opens a socket or a microphone.
 *
 * The gate decides whether a session may start at all. A cloud engine sends microphone audio off this PC, so
 * it needs paid access, a saved key, privacy mode off, Auto mode, and the owner's yes for this session.
 * A local engine must be on loopback. Neither is ever on by default.
 */

export type RealtimeServerEvent = { type: string; [key: string]: unknown };

export type SessionState = "idle" | "listening" | "thinking" | "speaking" | "failed" | "closed";

export type RealtimeSession = {
  state: SessionState;
  /** Assistant audio received for the current response, as base64 PCM16 chunks, oldest first. */
  audio: string[];
  assistantText: string;
  heardText: string;
  itemId: string | null;
  /** Milliseconds of assistant audio played so far, set by the player; used to truncate on barge-in. */
  playedMs: number;
  error: string | null;
};

export const newSession = (): RealtimeSession => ({
  state: "idle",
  audio: [],
  assistantText: "",
  heardText: "",
  itemId: null,
  playedMs: 0,
  error: null,
});

/** The PCM16 mono audio the session expects, as base64. `samples` are floats in -1..1. */
export function pcm16Base64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, i) => {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  });
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export type SessionSettings = {
  instructions: string;
  voice?: string;
  /** Server-side turn detection. FRIDAY's own endpointing stays the default; this is for engines that insist. */
  serverVad?: boolean;
};

export const clientEvents = {
  start: (settings: SessionSettings) => ({
    type: "session.update",
    session: {
      modalities: ["audio", "text"],
      instructions: settings.instructions.slice(0, 4000),
      ...(settings.voice ? { voice: settings.voice } : {}),
      input_audio_format: "pcm16",
      output_audio_format: "pcm16",
      input_audio_transcription: { model: "whisper-1" },
      turn_detection: settings.serverVad ? { type: "server_vad" } : null,
    },
  }),
  audio: (base64: string) => ({ type: "input_audio_buffer.append", audio: base64 }),
  commit: () => ({ type: "input_audio_buffer.commit" }),
  respond: () => ({ type: "response.create" }),
  /** The owner spoke over the answer: stop it and cut the item at what was actually heard. */
  bargeIn: (session: RealtimeSession) => [
    { type: "response.cancel" },
    ...(session.itemId
      ? [
          {
            type: "conversation.item.truncate",
            item_id: session.itemId,
            content_index: 0,
            audio_end_ms: Math.max(0, Math.round(session.playedMs)),
          },
        ]
      : []),
  ],
};

/** Apply one server event. Unknown events change nothing, so a newer server cannot break an older client. */
export function applyServerEvent(
  session: RealtimeSession,
  event: RealtimeServerEvent,
): RealtimeSession {
  if (session.state === "closed" || session.state === "failed") return session;
  switch (event.type) {
    case "session.created":
    case "session.updated":
      return { ...session, state: "listening" };
    case "input_audio_buffer.speech_started":
      // Speech over the assistant is a barge-in the caller must act on (see `shouldBargeIn`).
      return { ...session, state: session.state === "speaking" ? "speaking" : "listening" };
    case "input_audio_buffer.speech_stopped":
      return { ...session, state: "thinking" };
    case "conversation.item.input_audio_transcription.completed":
      return { ...session, heardText: String(event["transcript"] ?? "").slice(0, 2000) };
    case "response.created":
      return { ...session, state: "thinking", audio: [], assistantText: "", playedMs: 0 };
    case "response.output_item.added": {
      const item = event["item"] as { id?: string } | undefined;
      return item?.id ? { ...session, itemId: item.id } : session;
    }
    case "response.audio.delta":
    case "response.output_audio.delta":
      return {
        ...session,
        state: "speaking",
        audio: [...session.audio, String(event["delta"] ?? "")],
      };
    case "response.audio_transcript.delta":
    case "response.output_audio_transcript.delta":
      return { ...session, assistantText: session.assistantText + String(event["delta"] ?? "") };
    case "response.done":
      return { ...session, state: "listening" };
    case "error": {
      const detail = event["error"] as { message?: string } | undefined;
      return {
        ...session,
        state: "failed",
        error: String(detail?.message ?? "the session reported an error").slice(0, 300),
      };
    }
    default:
      return session;
  }
}

/** Speech that starts while the assistant is speaking is a barge-in. Playback must stop within the budget. */
export function shouldBargeIn(session: RealtimeSession, event: RealtimeServerEvent): boolean {
  return session.state === "speaking" && event.type === "input_audio_buffer.speech_started";
}

export type EngineKind = "local-speech-to-speech" | "cloud-realtime";

export type GateInput = {
  engine: EngineKind;
  /** The address the transport would connect to. */
  url: string;
  surface: "auto" | "manual";
  paused: boolean;
  paidAccess: boolean;
  cloudKey: boolean;
  privacyMode: boolean;
  /** The owner said yes to sending microphone audio to this provider for this session. */
  sessionConsent: boolean;
  /** Stop everything is on. */
  halted: boolean;
};

export type GateResult = { allowed: boolean; reasons: string[] };

const LOOPBACK = /^wss?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i;

export function realtimeGate(input: GateInput): GateResult {
  const reasons: string[] = [];
  if (input.halted) reasons.push("Stop everything is on");
  if (input.surface !== "auto") reasons.push("only Auto mode opens the microphone");
  if (input.paused) reasons.push("listening is paused");
  if (input.engine === "local-speech-to-speech") {
    if (!LOOPBACK.test(input.url))
      reasons.push("a local engine must be on this PC (127.0.0.1 or localhost)");
  } else {
    if (!/^wss:\/\//i.test(input.url))
      reasons.push("a cloud session must use an encrypted wss:// address");
    if (LOOPBACK.test(input.url))
      reasons.push("that address is on this PC, so it is a local engine");
    if (!input.paidAccess) reasons.push("paid access is off");
    if (!input.cloudKey) reasons.push("no provider key is saved");
    if (input.privacyMode)
      reasons.push("Keep speech on this PC is on, so microphone audio stays here");
    if (!input.sessionConsent)
      reasons.push(
        "microphone audio would leave this PC and you have not said yes for this session",
      );
  }
  return { allowed: reasons.length === 0, reasons };
}
