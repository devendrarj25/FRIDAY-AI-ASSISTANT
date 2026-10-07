/**
 * Multimodal unify + read-only screen observe. No per-modality brain,
 * no pixel capture from Core Brain, no video stub.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { coreBrain } from "../../src/lib/friday/brain/core-brain";
import { classifyModality } from "../../src/lib/friday/brain/modality";
import { observeScreenState, screenLookRequested } from "../../src/lib/friday/brain/screen-observe";

describe("modality classification", () => {
  it("keeps typed chat on text, voice on auto, documents/images/screen as the same pipeline", () => {
    expect(classifyModality({ prompt: "hello", mode: "manual" }).kinds).toEqual(["text"]);
    expect(classifyModality({ prompt: "hello", mode: "auto" }).kinds).toEqual(["text", "voice"]);
    const doc = classifyModality({
      prompt: "summarise this",
      extra: "FILE: bid.pdf (application/pdf, 12 KB)\n--- content ---\nScope of work\n--- end ---",
    });
    expect(doc.kinds).toContain("document");
    expect(doc.needsDeep).toBe(true);
    const img = classifyModality({
      prompt: "what is in this picture",
      extra: "FILE: rain.png (image/png, 20 KB)\n  An image was attached.",
    });
    expect(img.kinds).toContain("image");
    expect(img.videoSupported).toBe(true);
  });

  it("supports camera stills/clips and refuses unbounded live watch", () => {
    const still = classifyModality({ prompt: "take a camera still of the desk" });
    expect(still.kinds).toContain("video");
    expect(still.wantsCamera).toBe(true);
    expect(still.videoSupported).toBe(true);
    expect(still.notBuilt).toEqual([]);
    const classified = classifyModality({ prompt: "watch this live video of the site" });
    expect(classified.notBuilt.join(" ")).toMatch(/unbounded live video/i);
    expect(classified.videoSupported).toBe(true);
  });
});

describe("read-only screen observation", () => {
  it("matches look-at-screen asks and never reports captured pixels", () => {
    expect(screenLookRequested("what is on my screen")).toBe(true);
    expect(screenLookRequested("hello")).toBe(false);
    const observation = observeScreenState();
    expect(observation.readOnly).toBe(true);
    expect(observation.capturedPixels).toBe(false);
    expect(observation.supported).toBe(false);
    expect(observation.summary).toMatch(/no pixels captured/i);
  });

  it("does not import pixel capture from the screen-awareness bridge", () => {
    const source = readFileSync("src/lib/friday/brain/screen-observe.ts", "utf8");
    expect(source).not.toMatch(/\bcaptureScreen\b|\bdescribeScreen\b/);
  });
});

describe("read-only camera observation", () => {
  it("matches camera still asks and never reports captured pixels from Core Brain", async () => {
    const { cameraLookRequested, observeCameraState } =
      await import("../../src/lib/friday/brain/camera-observe");
    expect(cameraLookRequested("take a camera still")).toBe(true);
    expect(cameraLookRequested("hello")).toBe(false);
    const observation = observeCameraState();
    expect(observation.readOnly).toBe(true);
    expect(observation.capturedPixels).toBe(false);
    expect(observation.summary).toMatch(/no camera pixels captured|write-risk/i);
  });
});
describe("core brain stamps modality and read-only screen notes", () => {
  it("notes mixed document+image extra on the same cognize path", async () => {
    const cognition = await coreBrain.cognize("summarise the attached file", {
      mode: "manual",
      allowTools: false,
      extra: "FILE: note.txt (text/plain, 1 KB)\n--- content ---\nhello\n--- end ---",
    });
    const notes = cognition.notes.join(" ");
    expect(notes).toMatch(/modality: text\+document/);
    expect(notes).toMatch(/fabric: deep/);
  });

  it("observes screen state without capturing when asked what is on screen", async () => {
    const cognition = await coreBrain.cognize("what is on my screen right now", {
      mode: "manual",
      allowTools: false,
    });
    const notes = cognition.notes.join(" ");
    expect(notes).toMatch(/screen observe \(read-only\)/);
    expect(notes).toMatch(/no pixels captured/i);
    expect(notes).not.toMatch(/data:image/);
  });
});
