/**
 * Every shipped skill, through the real sandbox harness: none may crash on empty, long, multi-line, non-English or
 * odd input (a skill may answer "not for this request", but the harness must not fail), and all of them can be
 * switched off and on again in one go, which the runtime and the capability index must agree on.
 */
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, "../..");
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const skills = require("../../electron/skills.cjs") as Any;
const caps = require("../../electron/capabilities.cjs") as Any;

const temps: string[] = [];
const workspace = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "friday-ws-all-"));
  temps.push(d);
  return d;
};
afterAll(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const INPUTS: Record<string, unknown>[] = [
  {},
  { prompt: "x".repeat(4000) },
  {
    text: "line one\nline two\n\n(a, b) throw error 12 and 3.5 and 1,50,000 https://example.com a@b.co",
  },
  { prompt: 'नमस्ते दुनिया kal subah 8 baje 2026-11-07 null undefined NaN {"a":[1,2]}' },
];

describe("every shipped skill", () => {
  it("lists 243 skills quickly and runs without crashing on odd input", async () => {
    const roots = { appRoot: ROOT, workspaceRoot: workspace() };
    const started = Date.now();
    const listed = skills.list(roots);
    expect(Date.now() - started).toBeLessThan(2000);
    const own = listed.skills.filter((s: Any) => !s.builtin && !s.id.includes("."));
    expect(own.length).toBe(239);
    const crashed: string[] = [];
    for (const skill of own) {
      for (const input of INPUTS) {
        const result = await skills.invoke(roots, skill.id, input, {});
        if (!result.ok)
          crashed.push(`${skill.id}: ${String(result.error).split("\n").slice(-1)[0]}`);
      }
    }
    expect(crashed).toEqual([]);
  }, 600_000);

  it("can all be switched off and on again, and the index and the runtime agree", async () => {
    const roots = { appRoot: ROOT, workspaceRoot: workspace() };
    const ids = caps
      .list(roots)
      .items.filter((i: Any) => i.tree === "skills")
      .map((i: Any) => i.id as string);
    expect(ids.length).toBe(243);
    for (const id of ids) {
      caps.setEnabled(roots, id, false);
      skills.setEnabled(roots, id.split("/").pop(), false);
    }
    expect(caps.list(roots).items.filter((i: Any) => i.tree === "skills" && i.enabled)).toEqual([]);
    expect(skills.list(roots).skills.filter((s: Any) => s.enabled && !s.builtin)).toEqual([]);
    expect(await skills.invoke(roots, "math-tools", { prompt: "1+1" }, {})).toMatchObject({
      ok: false,
      error: "Skill is disabled.",
    });
    for (const id of ids) {
      caps.setEnabled(roots, id, true);
      skills.setEnabled(roots, id.split("/").pop(), true);
    }
    expect(caps.list(roots).items.filter((i: Any) => i.tree === "skills" && !i.enabled)).toEqual(
      [],
    );
    expect(await skills.invoke(roots, "math-tools", { prompt: "1+1" }, {})).toMatchObject({
      ok: true,
    });
  }, 120_000);
});
