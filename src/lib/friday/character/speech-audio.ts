/**
 * FRIDAY · speech envelope for lip-sync
 *
 * The companion's mouth must follow the REAL voice, so this module taps the
 * audio element that the voice library is already playing and publishes its
 * measured loudness. Nothing here synthesises a fake envelope: when the voice
 * path falls back to the system synthesiser (which exposes no audio stream)
 * the envelope is driven by real word-boundary events instead, and when
 * FRIDAY is silent the value is exactly zero.
 */

type Listener = (amplitude: number) => void;

const listeners = new Set<Listener>();
let context: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let source: MediaElementAudioSourceNode | null = null;
let attached: HTMLAudioElement | null = null;
let raf = 0;
let amplitude = 0;
let fallbackUntil = 0;

function publish(value: number) {
  amplitude = value;
  listeners.forEach((fn) => {
    try {
      fn(value);
    } catch {
      /* one bad listener must not stop the rest */
    }
  });
}

function loop() {
  if (!analyser) return;
  raf = requestAnimationFrame(loop);
  const buffer = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteTimeDomainData(buffer);
  let sum = 0;
  for (let i = 0; i < buffer.length; i += 2) {
    const v = ((buffer[i] ?? 128) - 128) / 128;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / (buffer.length / 2));
  // Perceptual curve: quiet speech should still move the mouth a little.
  publish(Math.min(1, Math.pow(rms * 3.4, 0.72)));
}

/** Called by the voice library for every neural audio clip it plays. */
export function attachSpeechAudio(audio: HTMLAudioElement) {
  if (typeof window === "undefined") return;
  try {
    if (!context) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      context = new Ctor();
    }
    if (context.state === "suspended") void context.resume().catch(() => {});
    if (attached === audio && analyser) return;
    // A media element can only be connected once per context.
    if (source) {
      try {
        source.disconnect();
      } catch {
        /* already detached */
      }
    }
    source = context.createMediaElementSource(audio);
    analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.55;
    source.connect(analyser);
    analyser.connect(context.destination);
    attached = audio;
    audio.addEventListener("ended", () => publish(0), { once: true });
    audio.addEventListener("pause", () => publish(0), { once: true });
    if (!raf) loop();
  } catch {
    // Some builds disallow a second MediaElementSource; the caller still gets
    // the word-boundary fallback below.
    analyser = null;
  }
}

/**
 * Fallback envelope for the system-voice path: a real word boundary produces
 * a real mouth movement, which decays until the next word arrives.
 */
export function pulseSpeechAudio(strength = 0.85) {
  fallbackUntil = Date.now() + 260;
  publish(Math.min(1, strength));
  window.setTimeout(() => {
    if (Date.now() >= fallbackUntil) publish(0);
  }, 240);
}

export function stopSpeechAudio() {
  fallbackUntil = 0;
  publish(0);
}

export function onSpeechAmplitude(fn: Listener) {
  listeners.add(fn);
  fn(amplitude);
  return () => {
    listeners.delete(fn);
  };
}

export const speechAmplitude = () => amplitude;
