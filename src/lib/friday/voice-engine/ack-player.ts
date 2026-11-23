/**
 * FRIDAY · plays one short line that was made in advance (the instant acknowledgement), from raw samples in memory.
 *
 * Local samples only: nothing here calls a voice engine, a cloud service or the network. It has its own small player so
 * the acknowledgement never touches the reply's playback queue; the conductor decides whether the line may sound
 * (`instant-ack.ts`) and asks again after the wait for the audio context (`stillWanted`).
 */
import { PcmClipPlayer, type PcmClip, type PcmContext } from "./pcm-clip-player";

let player: PcmClipPlayer | null = null;
let sounding: PcmClip | null = null;

function contextCtor(): (new () => unknown) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    AudioContext?: new () => unknown;
    webkitAudioContext?: new () => unknown;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/**
 * Play the samples. `onStart` runs when the first sample is scheduled to sound. Returns false, having played nothing,
 * when the audio context cannot start or `stillWanted` says the moment has passed; resolves true once the line ended
 * (or was stopped with `stopAckClip`).
 */
export async function playAckSamples(
  pcm: Int16Array,
  rate: number,
  options: { volume?: number; onStart?: () => void; stillWanted?: () => boolean } = {},
): Promise<boolean> {
  try {
    if (!player) {
      const Ctor = contextCtor();
      if (!Ctor) return false;
      player = new PcmClipPlayer(new Ctor() as PcmContext);
    }
    await player.ready();
    // After the wait the owner may have spoken, muted or paused: then nothing is played.
    if (options.stillWanted && !options.stillWanted()) return false;
    const playing = player.start(pcm, rate, options.volume ?? 1);
    sounding = playing;
    options.onStart?.();
    await playing.ended;
    if (sounding === playing) sounding = null;
    return true;
  } catch {
    return false;
  }
}

/** Stop the line that is sounding now (barge-in, mute, pause, Stop everything). Safe when nothing plays. */
export function stopAckClip(): void {
  try {
    player?.stop();
  } catch {
    /* nothing is audible */
  }
  sounding = null;
}
