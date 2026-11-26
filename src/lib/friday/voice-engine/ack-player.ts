/**
 * FRIDAY · plays one short line that was made in advance (the instant acknowledgement), from raw samples in memory.
 *
 * Local samples only: nothing here calls a voice engine, a cloud service or the network. It plays on the page's one sample
 * player (`voice-library.ts`), so the echo reference hears the line like the reply; the conductor decides whether the line may sound
 * (`instant-ack.ts`) and asks again after the wait for the audio context (`stillWanted`).
 */
import { sharedPcmPlayer } from "../voice-library";
import type { PcmClip } from "./pcm-clip-player";

let sounding: PcmClip | null = null;

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
    const player = sharedPcmPlayer();
    if (!player) return false;
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
    sounding?.stop();
  } catch {
    /* nothing is audible */
  }
  sounding = null;
}
