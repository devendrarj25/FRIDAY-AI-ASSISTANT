/**
 * The older entry points (`chooseTts`, `switchMidSentence` in speech-tts.ts) hold no ranking of their own: they agree
 * with `chooseTtsEngine` in tts-ladder.ts over a table of inputs, and FRIDAY Voice ranks first whenever it can speak.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { chooseTts, switchMidSentence as speechSwitch } from "../../src/lib/friday/speech-tts";
import {
  chooseTtsEngine,
  switchMidSentence,
  type TtsEngine,
} from "../../src/lib/friday/tts-ladder";

const bools = [true, false];
const prefers = [undefined, "auto", "neural", "supertonic", "sapi"] as const;
const root = resolve(import.meta.dirname, "../..");

describe("speech-tts.ts delegates to the one ladder", () => {
  it("chooseTts agrees with chooseTtsEngine over the whole table (formant only without a system voice)", () => {
    let cases = 0;
    for (const network of bools)
      for (const privacy of bools)
        for (const supertonicReady of bools)
          for (const windows of bools) {
            const ladder = chooseTtsEngine({ network, privacy, supertonicReady });
            const want = ladder === "sapi" && !windows ? "formant" : ladder;
            expect(chooseTts({ network, privacy, supertonicReady, windows }).engine).toBe(want);
            cases += 1;
          }
    expect(cases).toBe(16);
  });

  it("FRIDAY Voice ranks first whenever it is ready and its breaker is closed", () => {
    for (const network of bools)
      for (const privacy of bools)
        for (const windows of bools) {
          const input = { network, privacy, supertonicReady: true, windows };
          expect(chooseTts(input).engine, JSON.stringify(input)).toBe("supertonic");
          expect(chooseTts(input).quality).toBe("neural-local");
          for (const prefer of [undefined, "auto", "supertonic"] as const)
            expect(
              chooseTtsEngine({
                network,
                privacy,
                supertonicReady: true,
                ...(prefer ? { prefer } : {}),
              }),
            ).toBe("supertonic");
        }
  });

  it("an open breaker counts as not ready, and privacy mode never selects a cloud voice", () => {
    for (const network of bools)
      for (const prefer of prefers) {
        const open = chooseTtsEngine({
          network,
          privacy: false,
          supertonicReady: true,
          supertonicBreakerOpen: true,
          ...(prefer ? { prefer } : {}),
        });
        expect(open).toBe(
          network && prefer !== "sapi" && prefer !== "supertonic" ? "neural" : "sapi",
        );
        for (const supertonicReady of bools) {
          const priv = chooseTtsEngine({
            network,
            privacy: true,
            supertonicReady,
            ...(prefer ? { prefer } : {}),
          });
          expect(priv, `${network} ${supertonicReady} ${prefer}`).not.toBe("neural");
        }
      }
    for (const windows of bools)
      for (const supertonicReady of bools)
        expect(
          chooseTts({ network: true, privacy: true, supertonicReady, windows }).engine,
        ).not.toBe("neural");
  });

  it("the online voice wins only when FRIDAY Voice cannot speak, or the owner picked it", () => {
    expect(chooseTtsEngine({ network: true, privacy: false, supertonicReady: false })).toBe(
      "neural",
    );
    expect(
      chooseTtsEngine({ network: true, privacy: false, supertonicReady: true, prefer: "neural" }),
    ).toBe("neural");
    expect(chooseTtsEngine({ network: true, privacy: false, supertonicReady: true })).toBe(
      "supertonic",
    );
  });

  it("switchMidSentence in speech-tts agrees with the ladder's", () => {
    for (const supertonicReady of bools)
      for (const windows of bools) {
        const ladder: TtsEngine = switchMidSentence({
          networkDropped: true,
          current: "neural",
          supertonicReady,
        });
        const want = ladder === "sapi" && !windows ? "formant" : ladder;
        expect(speechSwitch("neural", false, supertonicReady, windows)).toBe(want);
      }
    expect(speechSwitch("neural", true, true, true)).toBe("neural");
    expect(speechSwitch("sapi", false, true, true)).toBe("sapi");
  });

  it("speech-tts.ts holds no ranking call of its own", () => {
    const source = readFileSync(resolve(root, "src/lib/friday/speech-tts.ts"), "utf8");
    expect(source).not.toContain("legacyEngineChoice");
    expect(source).toContain('from "./tts-ladder"');
  });
});
