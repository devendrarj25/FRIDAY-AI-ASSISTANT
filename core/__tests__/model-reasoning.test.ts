/** Which thinking control a model takes is data with a stated source, and unknown means no field at all. */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const caps = createRequire(import.meta.url)("../../electron/model-capabilities.cjs") as {
  REASONING_CONTROLS: string[];
  resolveReasoning: (model: unknown) => {
    control: string;
    keepAcrossToolTurns: boolean;
    source: string;
  };
  resolveCapabilities: (model: unknown) => { reasoningControl: { control: string } };
};

const of = (id: string) => caps.resolveReasoning({ id });

describe("resolveReasoning", () => {
  it("gives the newest Claude models adaptive effort and the older ones a budget", () => {
    for (const id of [
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
      "claude-fable-5-1",
      "claude-mythos-preview",
      "claude-sonnet-4-6",
      "claude-opus-4-7",
    ]) {
      expect(of(id), id).toMatchObject({ control: "effort", keepAcrossToolTurns: true });
    }
    for (const id of [
      "claude-sonnet-4-5-20250929",
      "claude-opus-4-5-20251101",
      "claude-haiku-4-5-20251001",
      "claude-3-7-sonnet-latest",
    ]) {
      expect(of(id), id).toMatchObject({ control: "budget", keepAcrossToolTurns: true });
    }
    expect(of("claude-3-5-sonnet-20241022").control).toBe("none");
  });

  it("separates Qwen3 thinking models from the instruct-only release", () => {
    expect(of("qwen3:8b")).toMatchObject({ control: "enable_thinking", keepAcrossToolTurns: true });
    expect(of("qwen3-30b-a3b-instruct-2507").control).toBe("none");
    expect(of("qwen2.5-coder:7b").control).toBe("none");
  });

  it("marks reasoning models that think by themselves", () => {
    expect(of("deepseek-r1:14b").control).toBe("always");
    expect(of("deepseek-r1-distill-qwen-7b").control).toBe("always");
    expect(of("deepseek-chat").control).toBe("none");
  });

  it("flags the effort field for OpenAI models as unverified", () => {
    expect(of("gpt-5")).toMatchObject({ control: "effort", source: "curated-unverified" });
    expect(of("o3-mini").control).toBe("effort");
    expect(of("gpt-4o").control).toBe("none");
  });

  it("lets the source override the table, and ignores a control it does not know", () => {
    expect(
      caps.resolveReasoning({
        id: "claude-3-5-haiku",
        meta: { reasoningControl: { control: "budget", keepAcrossToolTurns: true } },
      }),
    ).toMatchObject({ control: "budget", source: "declared" });
    expect(
      caps.resolveReasoning({ id: "x", meta: { reasoningControl: { control: "turbo" } } }).control,
    ).toBe("none");
  });

  it("travels with the capability record, and an unknown or empty model sends nothing", () => {
    expect(caps.resolveCapabilities({ id: "claude-opus-5-5" }).reasoningControl.control).toBe(
      "effort",
    );
    expect(caps.resolveReasoning({}).control).toBe("none");
    expect(caps.REASONING_CONTROLS).toContain("enable_thinking");
  });
});
