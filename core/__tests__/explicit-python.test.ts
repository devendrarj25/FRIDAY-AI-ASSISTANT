/**
 * A FRIDAY_PYTHON left over from an older install must not win over the Python setup creates: the owner's log
 * showed "spawn D:\FRIDAY\.venv\Scripts\python.exe ENOENT" for the English streaming speech model.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const python = require_(path.join(root, "scripts/explicit-python.cjs"));
const prefetch = require_(path.join(root, "scripts/prefetch-models.cjs"));

const there =
  (...files: string[]) =>
  (file: string) =>
    files.includes(file);

describe("an interpreter named in FRIDAY_PYTHON is used only while it exists", () => {
  it("keeps a path that exists, a bare command, and drops one that points nowhere", () => {
    const venv = "D:\\FRIDAY-AI-ASSISTANT\\.venv\\Scripts\\python.exe";
    expect(python.explicitPython(venv, { exists: there(venv) })).toBe(venv);
    expect(python.explicitPython(`"${venv}"`, { exists: there(venv) })).toBe(venv);
    expect(python.explicitPython("python", { exists: () => false })).toBe("python");
    expect(
      python.explicitPython("D:\\FRIDAY\\.venv\\Scripts\\python.exe", { exists: () => false }),
    ).toBe("");
    expect(python.explicitPython("", { exists: () => true })).toBe("");
    expect(python.explicitPython(undefined)).toBe("");
  });

  it("removes a stale variable from the environment and says which one it was", () => {
    const stale = "D:\\FRIDAY\\.venv\\Scripts\\python.exe";
    const env: Record<string, string> = { FRIDAY_PYTHON: stale, OTHER: "x" };
    expect(python.dropStalePython(env, { exists: () => false })).toBe(stale);
    expect(env).toEqual({ OTHER: "x" });
    const kept: Record<string, string> = { FRIDAY_PYTHON: stale };
    expect(python.dropStalePython(kept, { exists: there(stale) })).toBe("");
    expect(kept["FRIDAY_PYTHON"]).toBe(stale);
  });

  it("is what setup, Doctor, the voice smoke test and the model step use", () => {
    for (const file of [
      "scripts/setup-python.cjs",
      "scripts/doctor.cjs",
      "scripts/voice-smoke.cjs",
      "scripts/prefetch-models.cjs",
    ]) {
      expect(readFileSync(path.join(root, file), "utf8"), file).toContain("explicit-python.cjs");
    }
  });

  it("skips the English streaming speech with a note, instead of failing, when the Python is not there", async () => {
    const lines: string[] = [];
    const row = await prefetch.fetchMoonshine("C:/friday", {
      env: { FRIDAY_PYTHON: "D:\\FRIDAY\\.venv\\Scripts\\python.exe" },
      log: (line: string) => lines.push(line),
      run: async () => {
        throw new Error("must not be spawned");
      },
    });
    expect(row).toMatchObject({ id: "moonshine-en", ok: true, skipped: true });
    expect(lines.join("\n")).toContain("no Python runtime yet");
  });
});
