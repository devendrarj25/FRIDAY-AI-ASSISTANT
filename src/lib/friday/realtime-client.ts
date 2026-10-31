/**
 * FRIDAY · realtime session client (renderer side)
 *
 * Joins the session protocol (`realtime-protocol.ts`) to the pipe in the main process (`window.friday.realtime*`).
 * `start` asks the gate first: nothing is opened unless every condition holds, and the reasons are returned
 * when it does not. Once open, the engine's events move the session state, assistant audio and text are handed to
 * the caller, and a barge-in sends the cancel and truncate events. This file attaches no microphone and no speaker:
 * the caller feeds PCM16 chunks in with `sendAudio` and plays what `onAudio` hands back.
 */
import {
  applyServerEvent,
  clientEvents,
  newSession,
  realtimeGate,
  shouldBargeIn,
  type GateInput,
  type RealtimeServerEvent,
  type RealtimeSession,
  type SessionSettings,
} from "./realtime-protocol";

type Bridge = {
  realtimeOpen?: (id: string, url: string) => Promise<{ ok: boolean; error?: string }>;
  realtimeSend?: (id: string, event: unknown) => Promise<{ ok: boolean; error?: string }>;
  realtimeClose?: (id: string) => Promise<{ ok: boolean }>;
  onRealtimeOpened?: (cb: (payload: { id: string }) => void) => () => void;
  onRealtimeEvent?: (cb: (payload: { id: string; event: { type: string } }) => void) => () => void;
  onRealtimeClosed?: (cb: (payload: { id: string; reason: string }) => void) => () => void;
};

export type RealtimeHandle = {
  session: () => RealtimeSession;
  sendAudio: (base64: string) => Promise<void>;
  bargeIn: (playedMs: number) => Promise<void>;
  stop: () => Promise<void>;
};

export type StartResult = { ok: true; handle: RealtimeHandle } | { ok: false; reasons: string[] };

export async function startRealtime(input: {
  gate: GateInput;
  settings: SessionSettings;
  onAudio?: (base64: string) => void;
  onText?: (assistant: string, heard: string) => void;
  onStop?: (reason: string) => void;
  bridge?: Bridge | undefined;
  id?: string;
}): Promise<StartResult> {
  const verdict = realtimeGate(input.gate);
  if (!verdict.allowed) return { ok: false, reasons: verdict.reasons };
  if (input.gate.engine === "cloud-realtime") {
    // The pipe in the main process is loopback only. A cloud session is a separate transport that is not built.
    return { ok: false, reasons: ["a cloud realtime connection is not available in this version"] };
  }
  const bridge =
    input.bridge ??
    (typeof window === "undefined" ? undefined : (window.friday as unknown as Bridge));
  if (!bridge?.realtimeOpen || !bridge.realtimeSend || !bridge.onRealtimeEvent) {
    return { ok: false, reasons: ["realtime speech runs in the installed desktop app"] };
  }
  const id = input.id ?? `rt-${Date.now().toString(36)}`;
  let session = newSession();
  let seenAudio = 0;
  const offs: (() => void)[] = [];
  const cleanup = () => offs.splice(0).forEach((off) => off());

  offs.push(
    bridge.onRealtimeEvent((payload) => {
      if (payload.id !== id) return;
      const event = payload.event as RealtimeServerEvent;
      const over = shouldBargeIn(session, event);
      session = applyServerEvent(session, event);
      if (session.audio.length > seenAudio) {
        for (const chunk of session.audio.slice(seenAudio)) input.onAudio?.(chunk);
        seenAudio = session.audio.length;
      } else if (session.audio.length === 0) seenAudio = 0;
      input.onText?.(session.assistantText, session.heardText);
      if (over) void handle.bargeIn(session.playedMs);
      if (session.state === "failed") {
        void handle.stop();
        input.onStop?.(session.error ?? "the session failed");
      }
    }),
  );
  if (bridge.onRealtimeClosed) {
    offs.push(
      bridge.onRealtimeClosed((payload) => {
        if (payload.id !== id) return;
        session = { ...session, state: "closed" };
        cleanup();
        input.onStop?.(payload.reason);
      }),
    );
  }

  const opened = await bridge.realtimeOpen(id, input.gate.url);
  if (!opened.ok) {
    cleanup();
    return { ok: false, reasons: [opened.error ?? "the engine could not be reached"] };
  }
  await bridge.realtimeSend(id, clientEvents.start(input.settings));

  const handle: RealtimeHandle = {
    session: () => session,
    sendAudio: async (base64) => {
      if (session.state === "closed" || session.state === "failed") return;
      await bridge.realtimeSend!(id, clientEvents.audio(base64));
    },
    bargeIn: async (playedMs) => {
      session = { ...session, playedMs };
      for (const event of clientEvents.bargeIn(session)) await bridge.realtimeSend!(id, event);
    },
    stop: async () => {
      cleanup();
      session = { ...session, state: "closed" };
      await bridge.realtimeClose?.(id);
    },
  };
  return { ok: true, handle };
}
