import { describe, expect, it } from "vitest";
import * as routerModule from "../../src/lib/friday/voice-engine/utterance-router";
import {
  routeCommandLane,
  type CommandRouteInput,
} from "../../src/lib/friday/voice-engine/utterance-router";
import {
  COMMAND_VOCABULARY,
  SAFETY_COMMANDS,
  type VocabularyCommand,
  type CommandRegistryEntry,
} from "../../src/lib/friday/voice-engine/command-lane";

const REGISTRY: CommandRegistryEntry[] = [
  { id: "chrome", names: ["Chrome"] },
  { id: "spotify", names: ["Spotify"] },
];
const route = (text: string, over: Partial<CommandRouteInput> = {}) =>
  routeCommandLane({
    text,
    partial: false,
    ctx: { registry: REGISTRY },
    speakingNow: false,
    handsFree: false,
    wakeHeard: false,
    ...over,
  });

describe("empty and non-command text", () => {
  it.each(["", "   ", "\n"])("%j -> ignore", (t) => {
    expect(route(t).route).toBe("ignore");
    expect(route(t, { speakingNow: true, wakeHeard: true }).reason).toBe("empty");
  });
  it.each([
    "what is the weather tomorrow",
    "ruko aur mujhe batao ki kal kya hai",
    "kal ka mausam kaisa rahega",
    "open firefox",
  ])("%s -> brain, whatever the flags", (t) => {
    for (const over of [
      {},
      { speakingNow: true },
      { wakeHeard: true },
      { handsFree: true, speakingNow: true },
      { partial: true },
    ]) {
      const r = route(t, over);
      expect(r.route).toBe("brain");
      expect(r.command).toBeUndefined();
    }
  });
});

describe("safety verbs while she is speaking need no wake word", () => {
  it.each([
    ["stop", "stop"],
    ["ruko", "stop"],
    ["रुको", "stop"],
    ["stop everything", "stop-all"],
    ["mute", "mute"],
    ["chup ho ja", "mute"],
    ["म्यूट", "mute"],
    ["pause", "pause"],
    ["pause karo", "pause"],
    ["volume down", "volume-down"],
    ["volume kam karo", "volume-down"],
    ["quieter", "quieter"],
    ["dheere bolo", "quieter"],
  ])("%s -> command %s", (t, c) => {
    const r = route(t, { speakingNow: true });
    expect(r.route).toBe("command");
    expect(r.command?.command).toBe(c);
    expect(r.command?.folded.length).toBeGreaterThan(0);
  });
  it("the same words when she is silent and nobody woke her go to the brain gate", () => {
    const r = route("stop");
    expect(r.route).toBe("brain");
    expect(r.reason).toBe("wake-required");
    expect(r.command).toBeUndefined();
  });
});

describe("other verbs never bypass the wake requirement", () => {
  it.each([
    "volume up",
    "louder",
    "unmute",
    "resume",
    "repeat that",
    "open chrome",
    "chrome kholo",
    "dobara bolo",
    "आवाज़ बढ़ाओ",
  ])("%s while she speaks, no wake -> brain", (t) => {
    const r = route(t, { speakingNow: true });
    expect(r.route).toBe("brain");
    expect(r.reason).toBe("wake-required");
    expect(r.command).toBeUndefined();
  });
  it("with the wake word heard they take the lane", () => {
    expect(route("volume up", { wakeHeard: true }).route).toBe("command");
    expect(route("open chrome", { wakeHeard: true }).command?.args?.id).toBe("chrome");
  });
  it("in Auto mode's hands-free gate they take the lane", () => {
    expect(route("resume", { handsFree: true }).route).toBe("command");
    expect(route("unmute", { handsFree: true, speakingNow: true }).route).toBe("command");
  });
  it("exhaustive: a command route needs a safety verb while speaking, or a wake or hands-free gate", () => {
    const flags = [false, true];
    for (const c of Object.keys(COMMAND_VOCABULARY) as VocabularyCommand[]) {
      const v = COMMAND_VOCABULARY[c];
      for (const p of [...v.en, ...v.hinglish, ...v.hi]) {
        for (const speakingNow of flags)
          for (const handsFree of flags)
            for (const wakeHeard of flags)
              for (const partial of flags) {
                const r = route(p, { speakingNow, handsFree, wakeHeard, partial });
                if (r.route !== "command") continue;
                const gated = handsFree || wakeHeard;
                const safetyWhileSpeaking = speakingNow && SAFETY_COMMANDS.has(c);
                expect(
                  gated || safetyWhileSpeaking,
                  `${p} ${JSON.stringify({ speakingNow, handsFree, wakeHeard, partial })}`,
                ).toBe(true);
                if (partial) expect(SAFETY_COMMANDS.has(c), p).toBe(true);
              }
      }
    }
  });
});

describe("partial transcripts", () => {
  it("route a safety verb only", () => {
    expect(route("stop", { partial: true, speakingNow: true }).route).toBe("command");
    expect(route("mute", { partial: true, wakeHeard: true }).route).toBe("command");
    expect(route("ruko", { partial: true, handsFree: true }).route).toBe("command");
  });
  it("never route another verb, even with the wake word", () => {
    for (const t of ["volume up", "unmute", "resume", "open chrome", "repeat", "louder"]) {
      const r = route(t, { partial: true, wakeHeard: true, handsFree: true, speakingNow: true });
      expect(r.route, t).toBe("brain");
      expect(r.reason, t).toBe("partial-needs-final");
      expect(r.command, t).toBeUndefined();
    }
  });
  it("a partial that is not a command goes to the brain", () => {
    expect(route("ruko aur", { partial: true, speakingNow: true }).route).toBe("brain");
  });
  it("the final of the same words takes the lane", () => {
    expect(route("volume up", { partial: false, wakeHeard: true }).route).toBe("command");
  });
});

describe("the lane carries the arguments", () => {
  it("open keeps the target and registry id", () => {
    const r = route("spotifi kholo", { wakeHeard: true });
    expect(r.route).toBe("command");
    expect(r.command?.command).toBe("open");
    expect(r.command?.args?.id).toBe("spotify");
    expect(r.command?.confidence).toBeLessThan(1);
  });
  it("consequential words never route as a command", () => {
    for (const t of ["delete it", "send the email", "install chrome", "shutdown", "pay now"]) {
      const r = route(t, { speakingNow: true, wakeHeard: true, handsFree: true });
      expect(r.route, t).toBe("brain");
    }
  });
});

describe("safety, determinism, immutability, speed", () => {
  it("nothing exported here can approve, confirm or say yes, and the route carries no approval", () => {
    expect(typeof routeCommandLane).toBe("function");
    for (const name of Object.keys(routerModule)) {
      if (name === "routeUtterance") continue;
      expect(name).not.toMatch(/approv|confirm|\byes\b|^yes|grant/i);
    }
    for (const t of ["stop", "yes", "haan kar do", "approve it", "confirm"]) {
      const r = route(t, { speakingNow: true, wakeHeard: true });
      expect(Object.keys(r).join(",")).not.toMatch(/approv|confirm|yes/i);
      expect(r.command?.command ?? "").not.toMatch(/approv|confirm|yes/);
    }
  });
  it("a spoken yes or no is not a lane command", () => {
    for (const t of ["yes", "haan", "ok do it", "हाँ कर दो", "nahi"]) {
      expect(route(t, { speakingNow: true, wakeHeard: true, handsFree: true }).route).toBe("brain");
    }
  });
  it("is deterministic and leaves the input untouched", () => {
    const input = Object.freeze({
      text: "chrome kholo",
      partial: false,
      ctx: Object.freeze({
        registry: Object.freeze([
          Object.freeze({ id: "chrome", names: Object.freeze(["Chrome"]) }),
        ]),
        lang: "hinglish" as const,
      }),
      speakingNow: false,
      handsFree: true,
      wakeHeard: false,
    });
    const before = JSON.stringify(input);
    const a = JSON.stringify(routeCommandLane(input as unknown as CommandRouteInput));
    const b = JSON.stringify(routeCommandLane(input as unknown as CommandRouteInput));
    expect(a).toBe(b);
    expect(JSON.stringify(input)).toBe(before);
  });
  it("500 calls with a 200-entry registry take under 50 ms in total", () => {
    const big: CommandRegistryEntry[] = Array.from({ length: 200 }, (_, i) => ({
      id: `app-${i}`,
      names: [`Application${i}`],
    }));
    const texts = [
      "stop",
      "open application7",
      "open nosuchthing",
      "kal ka mausam kaisa hai",
      "volume kam karo",
    ];
    const run = (n: number) => {
      for (let i = 0; i < n; i++)
        route(texts[i % texts.length] as string, {
          ctx: { registry: big },
          speakingNow: true,
          wakeHeard: true,
        });
    };
    run(texts.length);
    const t0 = performance.now();
    run(500);
    expect(performance.now() - t0).toBeLessThan(50);
  });
});
