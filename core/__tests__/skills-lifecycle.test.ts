/**
 * The whole skill life cycle against the real modules, in a throwaway workspace: scan a folder, prepare the pack,
 * install it, verify it, run it, switch it off and on (the way the Skills page does, through the capability index and
 * the runtime), remove it, and switch a shipped built-in skill off and on again.
 */
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, "../..");
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const importer = require("../../electron/importer.cjs") as Any;
const skillPack = require("../../electron/skill-pack.cjs") as Any;
const caps = require("../../electron/capabilities.cjs") as Any;
const verify = require("../../electron/capability-verify.cjs") as Any;
const skills = require("../../electron/skills.cjs") as Any;

const temps: string[] = [];
const tmp = (p: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
  temps.push(d);
  return d;
};
afterAll(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function sourceFolder() {
  const src = tmp("friday-skill-src-");
  const dir = path.join(src, "word-count");
  fs.mkdirSync(dir);
  fs.writeFileSync(
    path.join(dir, "skill.json"),
    JSON.stringify({
      id: "word-count",
      name: "Word count",
      summary: "Count the words in text",
      category: "writing",
      capabilities: [],
      risk: "safe",
      inputs: ["text"],
      version: 1,
      author: "me",
      enabled: true,
      permissions: [],
      description: "Counts the words in the text you give it, offline.",
    }),
  );
  fs.writeFileSync(
    path.join(dir, "skill.mjs"),
    "export async function run(input={}){const t=String(input.text??input.prompt??'');return {ok:true,words:t.trim()?t.trim().split(/\\s+/).length:0};}\n",
  );
  return src;
}

describe("skill life cycle on the real modules", () => {
  it("folder install: scan, install (off), verify (on), run, off, on, remove", async () => {
    const ws = tmp("friday-ws-");
    const roots = { appRoot: ROOT, workspaceRoot: ws };
    const scan = await importer.scanImport({ root: ws, source: sourceFolder() });
    expect(scan.ok).toBe(true);
    const found = skillPack.collectSkillPacksFromDir(scan.contentRoot);
    const prepared = skillPack.prepareSkillsOnly(found.packs, {
      nonSkillKinds: found.nonSkillKinds,
    });
    expect(prepared.ok).toBe(true);

    const installed = caps.installPack(roots, prepared.packs[0]);
    expect(installed).toMatchObject({ ok: true, id: "skills/custom/word-count" });
    const row = () => caps.list(roots).items.find((i: Any) => i.id === installed.id);
    expect(row().enabled).toBe(false); // never on before it passes verification

    const verdict = await verify.verifyCapability(
      { root: ws },
      { id: installed.id, tree: "skills", dir: caps.packPath(ws, installed.id) },
      { emit() {} },
    );
    expect(verdict.ok).toBe(true);
    caps.markVerified(roots, installed.id, verdict);
    expect(row()).toMatchObject({ enabled: true, origin: "workspace", segment: "custom" });

    const ran = await skills.invoke(roots, "word-count", { text: "one two three" }, {});
    expect(ran).toMatchObject({ ok: true, value: { words: 3 } });

    // The page flips both the index and the runtime; a switched-off skill must not run.
    caps.setEnabled(roots, installed.id, false);
    skills.setEnabled(roots, "word-count", false);
    expect(row().enabled).toBe(false);
    expect(await skills.invoke(roots, "word-count", { text: "x" }, {})).toMatchObject({
      ok: false,
      error: "Skill is disabled.",
    });
    caps.setEnabled(roots, installed.id, true);
    skills.setEnabled(roots, "word-count", true);
    expect((await skills.invoke(roots, "word-count", { text: "a b" }, {})).ok).toBe(true);

    expect(caps.uninstallPack(roots, installed.id).ok).toBe(true);
    expect(row()).toBeUndefined();
    expect(fs.existsSync(caps.packPath(ws, installed.id))).toBe(false);
  }, 60000);

  it("zip install: the same pipeline reads a .zip and the skill runs", async () => {
    const { zipSync, strToU8 } = require("fflate") as Any;
    const src = sourceFolder();
    const zipPath = path.join(tmp("friday-zip-"), "word-count.zip");
    const dir = path.join(src, "word-count");
    fs.writeFileSync(
      zipPath,
      zipSync({
        "word-count/skill.json": strToU8(fs.readFileSync(path.join(dir, "skill.json"), "utf8")),
        "word-count/skill.mjs": strToU8(fs.readFileSync(path.join(dir, "skill.mjs"), "utf8")),
      }),
    );
    const ws = tmp("friday-ws-");
    const roots = { appRoot: ROOT, workspaceRoot: ws };
    const scan = await importer.scanImport({ root: ws, source: zipPath });
    expect(scan.ok, scan.error).toBe(true);
    const found = skillPack.collectSkillPacksFromDir(scan.contentRoot);
    const prepared = skillPack.prepareSkillsOnly(found.packs, {
      nonSkillKinds: found.nonSkillKinds,
    });
    const installed = caps.installPack(roots, prepared.packs[0]);
    expect(installed.ok).toBe(true);
    const verdict = await verify.verifyCapability(
      { root: ws },
      { id: installed.id, tree: "skills", dir: caps.packPath(ws, installed.id) },
      { emit() {} },
    );
    caps.markVerified(roots, installed.id, verdict);
    expect(await skills.invoke(roots, "word-count", { text: "a b c d" }, {})).toMatchObject({
      ok: true,
      value: { words: 4 },
    });
  }, 60000);

  it("a shipped built-in skill can be switched off and on, and stays in the app", async () => {
    const ws = tmp("friday-ws-");
    const roots = { appRoot: ROOT, workspaceRoot: ws };
    const id = "skills/core/ops-log-doctor";
    const row = () => caps.list(roots).items.find((i: Any) => i.id === id);
    expect(row().enabled).toBe(true);
    caps.setEnabled(roots, id, false);
    skills.setEnabled(roots, "ops-log-doctor", false);
    expect(row().enabled).toBe(false);
    expect((await skills.invoke(roots, "ops-log-doctor", { code: 3010 }, {})).ok).toBe(false);
    caps.setEnabled(roots, id, true);
    skills.setEnabled(roots, "ops-log-doctor", true);
    expect(row().enabled).toBe(true);
    expect((await skills.invoke(roots, "ops-log-doctor", { code: 3010 }, {})).ok).toBe(true);
    caps.uninstallPack(roots, id);
    expect(row()).toBeDefined(); // the app copy cannot be removed
    expect(fs.existsSync(path.join(ROOT, "skills", "core", "ops-log-doctor", "skill.mjs"))).toBe(
      true,
    );
  }, 60000);
});
