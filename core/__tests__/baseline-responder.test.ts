import { describe, expect, it } from "vitest";
import {
  baselineRespond,
  capabilitySummary,
  convert,
  evaluateMath,
  handoffMessage,
} from "../../src/lib/friday/brain/baseline-responder";

describe("FRIDAY baseline brain", () => {
  it("answers a greeting instantly, with no model involved and no publisher nickname", () => {
    const reply = baselineRespond("hello");
    expect(reply.handled).toBe(true);
    expect(reply.kind).toBe("greeting");
    expect(reply.text.length).toBeGreaterThan(0);
    expect(reply.text).not.toMatch(/\bDevendra\b|\bMeena\b|\bDev\b/);
  });

  it("knows who she is and answers capability questions from live registries first", () => {
    expect(baselineRespond("who are you").kind).toBe("identity");
    const abilities = baselineRespond("what can you do");
    expect(abilities.handled).toBe(true);
    expect(abilities.text).toMatch(/capability matrix/i);
    expect(abilities.text).toMatch(/model registry/i);
    expect(abilities.text).not.toMatch(/without any AI model/i);
    const smart = baselineRespond("how smart are you right now");
    expect(smart.handled).toBe(true);
    expect(smart.text).toMatch(/capability matrix/i);
  });

  it("keeps capabilitySummary as the honest fallback when live registries cannot answer", () => {
    expect(capabilitySummary()).toMatch(/without any AI model/i);
  });

  it("computes deterministic maths without eval", () => {
    expect(evaluateMath("2+2*3")).toBe(8);
    expect(evaluateMath("(4+6)/5")).toBe(2);
    expect(evaluateMath("2^10")).toBe(1024);
    expect(evaluateMath("hello")).toBeNull();
    expect(baselineRespond("what is 12*12").kind).toBe("math");
  });

  it("converts real units and temperatures", () => {
    expect(convert("10 km to miles")).toMatch(/6\.2137/);
    expect(convert("100 c to f")).toMatch(/212/);
    expect(convert("write me a poem")).toBeNull();
  });

  it("answers date and time from the real clock", () => {
    expect(baselineRespond("what is the time").kind).toBe("datetime");
  });

  it("recognises a direct command as a real tool action", () => {
    const reply = baselineRespond("open Notepad");
    expect(reply.handled).toBe(true);
    expect(reply.action?.tool).toBe("app.launch");
    expect(reply.action?.args).toMatchObject({ target: "Notepad" });
  });

  it("hands open-ended work off instead of faking an answer", () => {
    expect(baselineRespond("write me an essay about the monsoon").handled).toBe(false);
    expect(baselineRespond("explain how closures work").handled).toBe(false);
  });

  it("gives an honest, actionable handoff when no model is reachable", () => {
    const message = handoffMessage("Unavailable: • free model — model not available");
    expect(message).toMatch(/needs a connected AI model/i);
    expect(message).toMatch(/Models|Ollama/);
  });
});
