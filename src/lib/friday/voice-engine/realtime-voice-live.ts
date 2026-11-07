/**
 * FRIDAY · the live realtime voice session (glue to the real microphone tap, speaker and stores).
 *
 * `createRealtimeVoice` is tested with stand-ins; this file only supplies the real parts: the shared microphone
 * tap, a 24 kHz audio context for the speaker, the usage store and the bridge to the main process. The audio
 * context is made on a click (a browser rule) and closed when the session ends. Only Auto mode may start one.
 */
import { subscribeCaptureFrames } from "../pcm-capture";
import { startRealtime } from "../realtime-client";
import { REALTIME_RATE } from "./audio-format";
import { PcmPlayback, type ContextLike } from "./playback-scheduler";
import { createRealtimeVoice, type RealtimeVoice } from "./realtime-voice";
import { loadLedger, saveLedger } from "./voice-cloud-settings";

let live: { voice: RealtimeVoice; close: () => void } | null = null;

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The current session controller, made on first use. Call from a click handler. */
export function realtimeVoiceSession(): {
  voice: RealtimeVoice;
  ledgerOf: () => ReturnType<typeof loadLedger>;
} {
  if (!live) {
    const context = new AudioContext({ sampleRate: REALTIME_RATE });
    const ledger = loadLedger(storage());
    const voice = createRealtimeVoice({
      start: startRealtime,
      subscribe: subscribeCaptureFrames,
      playback: new PcmPlayback(context as unknown as ContextLike, { rate: REALTIME_RATE }),
      ledger,
      persistLedger: () => saveLedger(storage(), ledger),
    });
    live = { voice, close: () => void context.close().catch(() => undefined) };
    sessionLedger = ledger;
  }
  return { voice: live.voice, ledgerOf: () => sessionLedger! };
}

let sessionLedger: ReturnType<typeof loadLedger> | null = null;

/** Release the audio context after a session. The next start makes a fresh one. */
export function closeRealtimeVoice(): void {
  live?.close();
  live = null;
  sessionLedger = null;
}
