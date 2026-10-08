import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");

const MODULES = [
  "src/lib/friday/voice-recovery.ts",
  "src/lib/friday/think-budget.ts",
  "src/lib/friday/proactive-line.ts",
  "src/lib/friday/conversation-sight.ts",
  "src/lib/friday/eval-corpus.ts",
  "src/lib/friday/asr-bias.ts",
  "src/lib/friday/conversation-arc.ts",
  "src/lib/friday/mic-session.ts",
  "src/lib/friday/tts-ladder.ts",
  "src/lib/friday/speech-understand.ts",
  "src/lib/friday/wake-room.ts",
  "src/lib/friday/voice-flow.ts",
  "src/lib/friday/voice-pack.ts",
  "src/lib/friday/voice-doctor.ts",
  "src/lib/friday/response-policy.ts",
  "src/lib/friday/everyday.ts",
  "electron/python-bootstrap.cjs",
  "electron/voice-weights.cjs",
];

/** State resets that exist so a test can clear a module store. */
const ALLOW = new Set<string>();

function walk(dir: string, out: string[]) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__" || name.endsWith(".test.ts")) continue;
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|cjs|mjs|py)$/.test(name)) out.push(full);
  }
}

function exportsOf(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/export (?:async )?function ([A-Za-z0-9_]+)/g)) {
    if (match[1]) names.add(match[1]);
  }
  for (const match of source.matchAll(/export const ([A-Za-z0-9_]+)/g)) {
    if (match[1]) names.add(match[1]);
  }
  const block = source.match(/module\.exports = \{([\s\S]*?)\};/);
  const body = block?.[1] ?? "";
  for (const name of body.match(/[A-Za-z0-9_]+/g) || []) names.add(name);
  return [...names];
}

function body(source: string, name: string): string {
  return source
    .replace(new RegExp(`export (?:async )?function ${name}\\b`), "function ")
    .replace(new RegExp(`export const ${name}\\b`), "const ")
    .replace(new RegExp(`function ${name}\\b`), "function ")
    .replace(/module\.exports = \{[\s\S]*?\};/, "");
}

describe("voice and mind wiring", () => {
  it("fails when an exported symbol has no production caller", () => {
    const files: string[] = [];
    walk(path.join(ROOT, "src"), files);
    walk(path.join(ROOT, "electron"), files);
    walk(path.join(ROOT, "kernel"), files);
    const texts = new Map(
      files.map((file) => [
        path.relative(ROOT, file).replaceAll("\\", "/"),
        fs.readFileSync(file, "utf8"),
      ]),
    );
    const dead: string[] = [];
    for (const modulePath of MODULES) {
      const source = texts.get(modulePath);
      if (!source) {
        dead.push(`${modulePath} missing`);
        continue;
      }
      for (const name of exportsOf(source)) {
        if (ALLOW.has(name)) continue;
        const hit = [...texts.entries()].some(([file, text]) => {
          const hay = file === modulePath ? body(text, name) : text;
          return new RegExp(`\\b${name}\\b`).test(hay);
        });
        if (!hit) dead.push(`${modulePath} ${name}`);
      }
    }
    expect(dead).toEqual([]);
  });
});
