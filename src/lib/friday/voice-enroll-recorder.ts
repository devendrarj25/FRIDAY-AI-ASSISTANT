/**
 * FRIDAY · recording one enrollment sample.
 *
 * The owner presses Record in Settings → Voice. This joins the ONE shared microphone capture (voiceGate, the only
 * file that opens an audio stream) as its own named holder, listens to the frames it already produces, and gives
 * the sample back as a 16 kHz mono WAV. It records only between Record and Stop (or the hard cap), shows a level,
 * and lets go of the microphone at once: when Auto mode holds it, Auto mode carries on; when nothing else does,
 * the microphone closes.
 */
import { encodeWav, preRollFrom, subscribeCaptureFrames } from "./pcm-capture";
import { voiceGate } from "./voice-audio";

const HOLDER = "voice-enrollment";
/** Longest sample. The kernel refuses longer ones, and a sentence is never this long. */
export const MAX_SAMPLE_MS = 12_000;

export type EnrollRecording = {
  wavBytes: Uint8Array;
  durationMs: number;
  /** Loudest short-term level seen, 0..1. */
  peakLevel: number;
};

export type EnrollRecorder = {
  /** Stop and return what was recorded. Safe to call twice. */
  stop: () => Promise<EnrollRecording>;
  /** Stop and throw the audio away. */
  cancel: () => void;
};

export type StartResult = { ok: true; recorder: EnrollRecorder } | { ok: false; error: string };

export async function startEnrollRecording(options: {
  deviceId?: string | null;
  /** Called about ten times a second with the current level (0..1). */
  onLevel?: (level: number) => void;
  /** Called when the hard cap stopped the recording, with the finished sample. */
  onAutoStop?: (recording: EnrollRecording) => void;
  now?: () => number;
}): Promise<StartResult> {
  const now = options.now ?? (() => performance.now());
  const opened = await voiceGate.acquire(HOLDER, options.deviceId ?? undefined);
  if (!opened) {
    const failure = voiceGate.lastCaptureFailure();
    return {
      ok: false,
      error:
        failure?.reason ||
        "The microphone could not be opened. Check the device and its permission.",
    };
  }
  const startedAt = now();
  let peak = 0;
  let lastReport = 0;
  let finished: EnrollRecording | null = null;
  let released = false;
  const unsubscribe = subscribeCaptureFrames((samples) => {
    let sum = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const v = samples[i] ?? 0;
      sum += v * v;
    }
    const level = Math.min(1, Math.sqrt(sum / Math.max(1, samples.length)) * 4);
    if (level > peak) peak = level;
    const t = now();
    if (t - lastReport >= 100) {
      lastReport = t;
      options.onLevel?.(level);
    }
  });
  let timer: ReturnType<typeof setTimeout> | null = null;

  const release = () => {
    if (released) return;
    released = true;
    unsubscribe();
    if (timer) clearTimeout(timer);
    voiceGate.release(HOLDER);
  };

  const finish = (): EnrollRecording => {
    if (finished) return finished;
    const pcm = preRollFrom(startedAt, 0);
    release();
    finished = {
      wavBytes: encodeWav(pcm),
      durationMs: Math.round((pcm.length / 16_000) * 1000),
      peakLevel: peak,
    };
    return finished;
  };

  timer = setTimeout(() => {
    if (!finished) options.onAutoStop?.(finish());
  }, MAX_SAMPLE_MS);

  return {
    ok: true,
    recorder: {
      stop: async () => finish(),
      cancel: () => {
        finished = finished ?? { wavBytes: new Uint8Array(0), durationMs: 0, peakLevel: 0 };
        release();
      },
    },
  };
}
