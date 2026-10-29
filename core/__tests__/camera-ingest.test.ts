/**
 * Webcam stills: ingest a real image data URL, refuse invented pixels, and
 * fail honestly without the desktop capture window.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const camera = require("../../electron/camera.cjs") as {
  setRoot: (root: string) => string | null;
  ingest: (payload: { dataUrl?: string }) => {
    ok: boolean;
    file?: string;
    kind?: string;
    error?: string;
  };
  capture: (options?: { dataUrl?: string }) => Promise<{
    ok: boolean;
    file?: string;
    error?: string;
  }>;
  getState: () => { captures: number; lastFile: string | null };
};

const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
  temps.length = 0;
});

describe("camera ingest", () => {
  it("stores a real PNG data URL under FRIDAY_ROOT/cache/camera", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-camera-"));
    temps.push(root);
    camera.setRoot(root);
    const result = camera.ingest({ dataUrl: PIXEL });
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("still");
    expect(result.file && fs.existsSync(result.file)).toBe(true);
    expect(camera.getState().captures).toBe(1);
    expect(String(result.file)).toContain(`${path.sep}cache${path.sep}camera${path.sep}`);
  });

  it("refuses a non-image payload instead of inventing pixels", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-camera-"));
    temps.push(root);
    camera.setRoot(root);
    const result = camera.ingest({ dataUrl: "data:text/plain;base64,aGVsbG8=" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/PNG\/JPEG\/WebP data URL/i);
    expect(camera.getState().captures).toBe(0);
  });

  it("fails honestly when capture needs Electron and no data URL was given", async () => {
    const result = await camera.capture({});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/camera needs the FRIDAY desktop app/i);
  });
});
