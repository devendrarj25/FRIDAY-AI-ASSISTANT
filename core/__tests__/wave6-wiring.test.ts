import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { planFor } from "../../src/lib/friday/self/dev-pipeline";

const ROOT = path.resolve(__dirname, "../..");
const OWNED = [
  "src/lib/friday/speech-cache.ts",
  "src/lib/friday/speech-command.ts",
  "src/lib/friday/speech-core.ts",
  "src/lib/friday/speech-dsp.ts",
  "src/lib/friday/speech-eval.ts",
  "src/lib/friday/speech-features.ts",
  "src/lib/friday/speech-normalize.ts",
  "src/lib/friday/speech-playback.ts",
  "src/lib/friday/speech-prosody.ts",
  "src/lib/friday/speech-stt.ts",
  "src/lib/friday/speech-tts.ts",
  "src/lib/friday/speech-vad.ts",
  "src/lib/friday/toolchain-manifest.ts",
  "src/lib/friday/self/own-work.ts",
  "electron/toolchain-pack.cjs",
  "electron/sapi-voice.cjs",
  "electron/whisper-cpp.cjs",
];

function walk(dir: string, out: string[]) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "__tests__" || entry.name === "tests")
      continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(?:ts|tsx|cjs|js|mjs|py)$/.test(entry.name)) out.push(full);
  }
}

function productionExcept(rel: string): string {
  const skip = path.join(ROOT, rel);
  const files: string[] = [];
  for (const top of ["src", "electron", "kernel"]) walk(path.join(ROOT, top), files);
  return files
    .filter((file) => file !== skip)
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");
}

function exportNames(rel: string): string[] {
  const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
  if (rel.endsWith(".cjs")) {
    const block = text.match(/module\.exports\s*=\s*\{([^}]+)\}/);
    return [...(block?.[1] ?? "").matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g)].map(
      (match) => match[1] ?? "",
    );
  }
  return [
    ...text.matchAll(
      /export (?:async )?function ([A-Za-z_][A-Za-z0-9_]*)|export class ([A-Za-z0-9_]+)/g,
    ),
  ].map((match) => match[1] || match[2] || "");
}

describe("wave 6 wiring", () => {
  it("every owned export has a production caller", () => {
    const dead: string[] = [];
    for (const rel of OWNED) {
      const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
      const outside = productionExcept(rel);
      const names = exportNames(rel).filter(Boolean);
      const anchored = names.some((name) => new RegExp(`\\b${name}\\b`).test(outside));
      for (const name of names) {
        const elsewhere = new RegExp(`\\b${name}\\b`).test(outside);
        const calls = text.match(new RegExp(`\\b${name}\\s*\\(`, "g"))?.length ?? 0;
        if (elsewhere || (anchored && calls > 1)) continue;
        dead.push(`${rel} ${name}`);
      }
    }
    expect(dead, dead.join("\n")).toEqual([]);
  });

  it("a self-edit plan stays a review and does not apply", () => {
    const plan = planFor("add a python helper", ["general"], []);
    expect(plan.join(" ")).toMatch(/Nothing is applied/);
    expect(plan.join(" ")).toMatch(/waiting for the owner/);
  });
});
