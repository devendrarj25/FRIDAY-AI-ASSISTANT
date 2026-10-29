import { voiceForLanguage } from "./speech-normalize";

export type TtsEngine = "sapi" | "supertonic" | "neural" | "formant";

export type TtsChoice = {
  engine: TtsEngine;
  quality: "system" | "neural-local" | "neural-online" | "low-rule";
  voice: string;
};

const FORMANTS: Record<string, [number, number, number]> = {
  a: [800, 1200, 2500],
  e: [400, 2000, 2600],
  i: [300, 2200, 3000],
  o: [500, 900, 2400],
  u: [350, 700, 2200],
  n: [250, 1600, 2500],
  m: [250, 1200, 2200],
  s: [200, 1800, 4500],
  t: [400, 1700, 2800],
  h: [500, 1500, 2500],
};

function lettersFor(text: string): string {
  const known: Record<string, string> = {
    namaste: "namaste",
    haan: "haan",
    nahi: "nahi",
    hello: "helo",
  };
  return text
    .toLowerCase()
    .split(/\s+/)
    .map((word) => known[word] ?? word.replace(/[^a-z]/g, ""))
    .join("");
}

/** Rule-based formant voice. Low quality. Always available. No download. */
export function formantSynth(text: string, rate = 16000): Float32Array {
  const letters = lettersFor(text);
  if (!letters) return new Float32Array();
  const samplesPer = Math.floor(rate * 0.06);
  const out = new Float32Array(letters.length * samplesPer);
  for (let index = 0; index < letters.length; index += 1) {
    const letter = letters[index] ?? "a";
    const formant = FORMANTS[letter] ?? FORMANTS["a"] ?? [500, 1500, 2500];
    for (let i = 0; i < samplesPer; i += 1) {
      const envelope = Math.sin((Math.PI * i) / samplesPer);
      let sample = 0;
      formant.forEach((hz, partial) => {
        sample += Math.sin((2 * Math.PI * hz * i) / rate) * (0.35 / (partial + 1));
      });
      out[index * samplesPer + i] = sample * envelope * 0.2;
    }
  }
  return out;
}

export function chooseTts(input: {
  network: boolean;
  privacy: boolean;
  supertonicReady: boolean;
  windows: boolean;
}): TtsChoice {
  const voice = "hi-IN";
  if (input.privacy || input.windows) {
    if (input.privacy) return { engine: "sapi", quality: "system", voice };
  }
  if (input.supertonicReady && !input.network)
    return { engine: "supertonic", quality: "neural-local", voice };
  if (input.network && !input.privacy) return { engine: "neural", quality: "neural-online", voice };
  if (input.supertonicReady) return { engine: "supertonic", quality: "neural-local", voice };
  if (input.windows) return { engine: "sapi", quality: "system", voice };
  return { engine: "formant", quality: "low-rule", voice };
}

export function switchMidSentence(
  engine: TtsEngine,
  network: boolean,
  supertonicReady: boolean,
  windows: boolean,
): TtsEngine {
  if (engine !== "neural" || network) return engine;
  if (supertonicReady) return "supertonic";
  if (windows) return "sapi";
  return "formant";
}

export function firstAudioLatency(
  startedMs: number,
  heardMs: number,
): { ms: number; withinBudget: boolean } {
  const ms = Math.max(0, heardMs - startedMs);
  return { ms, withinBudget: ms <= 1500 };
}

export function speakVoice(language: string): string {
  return voiceForLanguage(language);
}
