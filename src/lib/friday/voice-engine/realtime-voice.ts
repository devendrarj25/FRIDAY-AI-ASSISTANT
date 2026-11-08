/**
 * FRIDAY · realtime voice session: the microphone and the speaker joined to a realtime provider.
 *
 * Capture comes from the one shared microphone stream (`subscribeCaptureFrames`; no second stream), is
 * resampled to the provider rate, sent as PCM16, and never waits for the answer. Answer audio goes to one
 * playback queue; when the owner speaks over it the speaker is flushed first and the provider is told how many
 * milliseconds were really heard. A cloud session also passes the voice router (provider allowed, key saved,
 * quota, paid approval, privacy) and is counted in the usage ledger.
 *
 * Every dependency is injected, so the join is tested without a microphone, a speaker or a network. A live
 * provider session has not been run.
 */
import type { StartResult } from "../realtime-client";
import type { GateInput } from "../realtime-protocol";
import type { SessionSettings } from "../realtime-protocol";
import {
  base64ToPcm16,
  floatToPcm16,
  pcm16ToBase64,
  pcm16ToFloat,
  realtimeFormat,
  StreamResampler,
} from "./audio-format";
import { EchoCanceller } from "./audio-aec";
import type { PcmPlayback, PlaybackStats } from "./playback-scheduler";
import { routeVoice, type UsageLedger, type VoiceCloudSettings } from "./voice-provider-router";

type Start = (input: {
  gate: GateInput;
  cloud?: { provider: string; model: string };
  settings: SessionSettings;
  onAudio?: (base64: string) => void;
  onText?: (assistant: string, heard: string) => void;
  onStop?: (reason: string) => void;
  onBargeIn?: () => number | void;
}) => Promise<StartResult>;

export type RealtimeVoiceDeps = {
  start: Start;
  subscribe: (
    tap: (samples: ArrayLike<number>, fromRate: number, atMono: number) => void,
  ) => () => void;
  playback: PcmPlayback;
  ledger: UsageLedger;
  /** Called after the usage changed so it can be saved. */
  persistLedger?: () => void;
  now?: () => number;
  /** Frames sent but not yet acknowledged; more than this are dropped, never queued. */
  maxInflight?: number;
  /** Reconnect after a drop that was not the owner's doing: at most `max` tries, doubling the wait each time. */
  recovery?: { max: number; baseMs: number; sleep?: (ms: number) => Promise<void> };
  /**
   * Take FRIDAY's own voice out of the microphone before it is sent. `contextToMono` turns an audio-clock time
   * (seconds) into the millisecond clock the microphone frames use. Off when omitted.
   */
  echo?: { contextToMono: (contextSeconds: number) => number };
};

export type RealtimeVoiceRequest = {
  gate: GateInput;
  cloud: { provider: string; model: string };
  settings: SessionSettings;
  router: {
    cloud: VoiceCloudSettings;
    privacyMode: boolean;
    billingAllowsPaid: boolean;
    online: boolean;
  };
  onText?: (assistant: string, heard: string) => void;
  onStop?: (reason: string) => void;
};

export type RealtimeVoiceStats = {
  running: boolean;
  sentFrames: number;
  droppedFrames: number;
  bargeIns: number;
  elapsedMs: number;
  playback: PlaybackStats;
  /** Echo canceller picture, or null when it is off. */
  echo: { delayMs: number; erleDb: number | null; doubleTalkFrames: number } | null;
};

export type RealtimeVoice = {
  start: (
    request: RealtimeVoiceRequest,
  ) => Promise<{ ok: true } | { ok: false; reasons: string[] }>;
  stop: (reason?: string) => Promise<void>;
  setMuted: (muted: boolean) => void;
  stats: () => RealtimeVoiceStats;
};

export function createRealtimeVoice(deps: RealtimeVoiceDeps): RealtimeVoice {
  const now = deps.now ?? Date.now;
  const maxInflight = deps.maxInflight ?? 8;
  let handle: Extract<StartResult, { ok: true }>["handle"] | null = null;
  let unsubscribe: (() => void) | null = null;
  let resampler: StreamResampler | null = null;
  let resamplerRate = 0;
  let muted = false;
  let inflight = 0;
  let sent = 0;
  let dropped = 0;
  let barge = 0;
  let startedAt = 0;
  let provider = "";
  let running = false;
  let canceller: EchoCanceller | null = null;
  let nearIndex: number | null = null;
  let refResampler: StreamResampler | null = null;

  const OWNER_STOPS = new Set(["owner stopped", "stopped", "settings closed"]);
  let reconnecting = false;
  let attemptsMade = 0;

  const finish = async (reason: string, request?: RealtimeVoiceRequest) => {
    if (!running) return;
    const recovery = deps.recovery;
    if (
      recovery &&
      request &&
      !OWNER_STOPS.has(reason) &&
      attemptsMade < recovery.max &&
      !reconnecting
    ) {
      reconnecting = true;
      attemptsMade += 1;
      unsubscribe?.();
      unsubscribe = null;
      deps.playback.onScheduled(null);
      deps.playback.flush();
      const old = handle;
      handle = null;
      if (old) await old.stop();
      deps.ledger.addAudio(provider, (now() - startedAt) / 60_000);
      const sleep = recovery.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      await sleep(recovery.baseMs * 2 ** (attemptsMade - 1));
      running = false;
      reconnecting = false;
      // The router and the quota are asked again; a refusal ends the session with that reason.
      const again = await api.start(request, true);
      if (!again.ok) request.onStop?.(`reconnect refused: ${again.reasons.join("; ")}`);
      return;
    }
    running = false;
    unsubscribe?.();
    unsubscribe = null;
    deps.playback.onScheduled(null);
    canceller = null;
    const current = handle;
    handle = null;
    deps.playback.flush();
    if (current) await current.stop();
    const minutes = (now() - startedAt) / 60_000;
    if (provider) {
      deps.ledger.addAudio(provider, minutes);
      deps.persistLedger?.();
    }
    request?.onStop?.(reason);
  };

  const api: RealtimeVoice & {
    start: (
      request: RealtimeVoiceRequest,
      retry?: boolean,
    ) => Promise<{ ok: true } | { ok: false; reasons: string[] }>;
  } = {
    async start(request, retry = false) {
      if (running) return { ok: false, reasons: ["a realtime voice session is already running"] };
      const decision = routeVoice(
        {
          need: "realtime-audio",
          needInterruption: true,
          sensitive: false,
          privacyMode: request.router.privacyMode,
          billingAllowsPaid: request.router.billingAllowsPaid,
          online: request.router.online,
        },
        request.router.cloud,
        deps.ledger,
      );
      if (decision.active !== "cloud" || decision.provider?.id !== request.cloud.provider) {
        const why = decision.refused.find((r) => r.id === request.cloud.provider)?.why;
        return { ok: false, reasons: [why ?? decision.reason] };
      }
      running = true;
      startedAt = now();
      provider = request.cloud.provider;
      if (!retry) attemptsMade = 0;
      sent = dropped = barge = inflight = 0;
      resampler = null;
      resamplerRate = 0;
      const result = await deps.start({
        gate: request.gate,
        cloud: request.cloud,
        settings: request.settings,
        onAudio: (base64) => void deps.playback.enqueue(base64ToPcm16(base64)),
        onBargeIn: () => {
          barge += 1;
          return deps.playback.flush();
        },
        ...(request.onText ? { onText: request.onText } : {}),
        onStop: (reason) => void finish(reason, request),
      });
      if (!result.ok) {
        running = false;
        provider = "";
        return { ok: false, reasons: result.reasons };
      }
      handle = result.handle;
      // One request is counted when the session opens; audio minutes are added when it ends.
      deps.ledger.record(provider, 0);
      deps.persistLedger?.();
      const inputRate = realtimeFormat(provider).inputRate;
      canceller = null;
      nearIndex = null;
      refResampler = null;
      if (deps.echo) {
        const echo = deps.echo;
        const rate = inputRate;
        canceller = new EchoCanceller({ rate, taps: Math.round(rate * 0.032) });
        refResampler = new StreamResampler(realtimeFormat(provider).outputRate, rate);
        // What is about to leave the speaker is the echo canceller's reference, placed on the microphone clock.
        deps.playback.onScheduled((when, pcm) => {
          if (!canceller || !refResampler) return;
          const ref = refResampler.push(pcm16ToFloat(pcm));
          canceller.pushReference(Math.round((echo.contextToMono(when) * rate) / 1000), ref);
        });
      }
      unsubscribe = deps.subscribe((samples, fromRate, atMono) => {
        if (!running || !handle) return;
        if (!resampler || resamplerRate !== fromRate) {
          resampler = new StreamResampler(fromRate, inputRate);
          resamplerRate = fromRate;
        }
        let audio = resampler.push(samples);
        if (audio.length === 0) return;
        // Every frame goes through the canceller, sent or not, so its picture of the room never has a hole.
        if (canceller) {
          if (nearIndex === null) {
            const frameMs = (samples.length / fromRate) * 1000;
            nearIndex = Math.round(((atMono - frameMs) * inputRate) / 1000);
          }
          audio = canceller.process(audio, nearIndex);
          nearIndex += audio.length;
        }
        if (muted) return;
        if (inflight >= maxInflight) {
          dropped += 1;
          return;
        }
        const pcm = floatToPcm16(audio);
        inflight += 1;
        sent += 1;
        void handle
          .sendAudio(pcm16ToBase64(pcm))
          .catch(() => void (dropped += 1))
          .finally(() => void (inflight -= 1));
      });
      return { ok: true };
    },
    async stop(reason = "stopped") {
      await finish(reason);
    },
    setMuted(value) {
      muted = value;
    },
    stats() {
      return {
        running,
        sentFrames: sent,
        droppedFrames: dropped,
        bargeIns: barge,
        elapsedMs: running ? now() - startedAt : 0,
        playback: deps.playback.stats(),
        echo: canceller
          ? (({ delayMs, erleDb, doubleTalkFrames }) => ({ delayMs, erleDb, doubleTalkFrames }))(
              canceller.stats(),
            )
          : null,
      };
    },
  };
  return api;
}
