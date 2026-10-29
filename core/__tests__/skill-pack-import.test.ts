/**
 * Skills-page import: only skill-shaped packs, incomplete packs are healed
 * into the custom-skill runtime, and install still goes through installPack().
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const skillPack = require("../../electron/skill-pack.cjs") as {
  looksLikeSkill: (pack: unknown) => boolean;
  healSkillPack: (pack: unknown) => {
    ok: boolean;
    pack?: { tree?: string; id?: string; enabled?: boolean; code?: string; healed?: boolean };
    error?: string;
  };
  prepareSkillsOnly: (
    payload: unknown,
    extra?: { nonSkillKinds?: string[] },
  ) => { ok: boolean; packs?: unknown[]; error?: string; skipped?: number };
  collectSkillPacksFromDir: (dir: string) => {
    packs: { id?: string; code?: string }[];
    nonSkillKinds: string[];
  };
  parseGitUrl: (url: string) => { url: string; repo?: string; owner?: string } | null;
  attachSiblingSkillCode: (
    packs: Record<string, unknown>[],
    files: { path?: string; code?: string }[],
  ) => Record<string, unknown>[];
};
const capabilities = require("../../electron/capabilities.cjs") as {
  installPack: (
    roots: { workspaceRoot: string },
    pack: unknown,
    hint?: string,
  ) => { ok: boolean; id?: string; tree?: string; path?: string; error?: string };
};

const temps: string[] = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-skill-pack-"));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
  temps.length = 0;
});

describe("skill pack healer", () => {
  it("heals a incomplete skill into skill.json fields plus a loadable run()", () => {
    const healed = skillPack.healSkillPack({ name: "Word tally", category: "writing" });
    expect(healed.ok).toBe(true);
    expect(healed.pack?.tree).toBe("skills");
    expect(healed.pack?.id).toBe("word-tally");
    expect(healed.pack?.enabled).toBe(false);
    expect(String(healed.pack?.code)).toMatch(/export async function run/);
    expect(healed.pack?.healed).toBe(true);
  });

  it("keeps an existing run() instead of replacing it with the stub", () => {
    const code = "export async function run(input) { return { n: 1 }; }\n";
    const healed = skillPack.healSkillPack({
      id: "keep-run",
      name: "Keep run",
      code,
      inputs: ["text"],
    });
    expect(healed.ok).toBe(true);
    expect(String(healed.pack?.code)).toContain("return { n: 1 }");
    expect(String(healed.pack?.code)).not.toMatch(/Healed stub/);
  });

  it("does not treat a plugin pack as a skill", () => {
    expect(skillPack.looksLikeSkill({ tree: "plugins", name: "Desk notifier", hooks: [] })).toBe(
      false,
    );
    const prepared = skillPack.prepareSkillsOnly({
      tree: "plugins",
      slug: "desk-notifier",
      name: "Desk notifier",
      code: "module.exports.run = async () => ({}) ",
    });
    expect(prepared.ok).toBe(false);
    expect(prepared.error).toMatch(/Skills page only accepts skill packs/i);
  });
});

describe("skills-only folder collect", () => {
  it("collects skill.json folders and skips plugin.json", () => {
    const dir = temp();
    fs.mkdirSync(path.join(dir, "good-skill"));
    fs.writeFileSync(
      path.join(dir, "good-skill", "skill.json"),
      JSON.stringify({
        id: "good-skill",
        name: "Good skill",
        summary: "Counts words in pasted text for a local draft.",
      }),
    );
    fs.writeFileSync(
      path.join(dir, "good-skill", "skill.mjs"),
      "export async function run(input = {}) { return { ok: true, words: String(input.text || '').split(/\\s+/).filter(Boolean).length }; }\n",
    );
    fs.mkdirSync(path.join(dir, "sneaky-plugin"));
    fs.writeFileSync(
      path.join(dir, "sneaky-plugin", "plugin.json"),
      JSON.stringify({ name: "Sneaky", kind: "plugin" }),
    );
    const collected = skillPack.collectSkillPacksFromDir(dir);
    expect(collected.nonSkillKinds).toContain("plugins");
    expect(collected.packs).toHaveLength(1);
    expect(collected.packs[0]?.id).toBe("good-skill");
    expect(String(collected.packs[0]?.code)).toMatch(/function run/);
    const prepared = skillPack.prepareSkillsOnly(collected.packs, {
      nonSkillKinds: collected.nonSkillKinds,
    });
    expect(prepared.ok).toBe(true);
    expect(prepared.packs).toHaveLength(1);
  });

  it("refuses a folder that only contains a plugin", () => {
    const dir = temp();
    fs.writeFileSync(
      path.join(dir, "plugin.json"),
      JSON.stringify({ name: "Only plugin", kind: "plugin" }),
    );
    const collected = skillPack.collectSkillPacksFromDir(dir);
    const prepared = skillPack.prepareSkillsOnly(collected.packs, {
      nonSkillKinds: collected.nonSkillKinds,
    });
    expect(prepared.ok).toBe(false);
    expect(prepared.error).toMatch(/plugin/i);
  });

  it("installs a healed skill through installPack into skills/custom", () => {
    const workspaceRoot = temp();
    const healed = skillPack.healSkillPack({
      name: "Healed install",
      summary: "A healed pack used to prove installPack still writes the skill runtime.",
    });
    expect(healed.ok).toBe(true);
    const result = capabilities.installPack({ workspaceRoot }, healed.pack, "skills");
    expect(result.ok).toBe(true);
    expect(result.tree).toBe("skills");
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(workspaceRoot, "skills", "custom", "healed-install", "skill.json"),
        "utf8",
      ),
    );
    expect(manifest.enabled).toBe(false);
    expect(manifest.summary).toMatch(/healed pack used to prove/i);
    expect(manifest.description).toMatch(/healed pack used to prove/i);
    expect(
      fs.existsSync(path.join(workspaceRoot, "skills", "custom", "healed-install", "skill.mjs")),
    ).toBe(true);
    const code = fs.readFileSync(
      path.join(workspaceRoot, "skills", "custom", "healed-install", "skill.mjs"),
      "utf8",
    );
    expect(code).toMatch(/export async function run/);
  });
});

describe("git URL parse", () => {
  it("accepts a GitHub https URL and rejects junk", () => {
    const parsed = skillPack.parseGitUrl("https://github.com/devendrarj25/FRIDAY-AI-ASSISTANT");
    expect(parsed?.owner).toBe("devendrarj25");
    expect(parsed?.repo).toBe("FRIDAY-AI-ASSISTANT");
    expect(skillPack.parseGitUrl("not a url")).toBeNull();
    expect(skillPack.parseGitUrl("https://example.com/foo; rm -rf /")).toBeNull();
  });
});

describe("GitHub sibling skill.mjs attach", () => {
  it("maps each skill.mjs onto the pack whose folder slug matches, not every pack", () => {
    const packs: { id: string; name: string; code?: string }[] = [
      { id: "notes", name: "Notes" },
      { id: "meeting-notes", name: "Meeting notes" },
    ];
    skillPack.attachSiblingSkillCode(packs, [
      {
        path: "skills/custom/meeting-notes/skill.json",
        code: "export async function run(){ return 'meeting'; }",
      },
    ]);
    expect(packs[0]?.code).toBeUndefined();
    expect(String(packs[1]?.code)).toContain("meeting");
  });

  it("lets a single-pack payload take the only sibling file", () => {
    const packs: { name: string; code?: string }[] = [{ name: "Solo skill" }];
    skillPack.attachSiblingSkillCode(packs, [
      { path: "skill.json", code: "export async function run(){ return 1; }" },
    ]);
    expect(String(packs[0]?.code)).toContain("return 1");
  });
});

describe("installPack keeps skill summary when description is empty", () => {
  it("writes summary from pack.summary so the Skills details panel is not blank", () => {
    const workspaceRoot = temp();
    const result = capabilities.installPack(
      { workspaceRoot },
      {
        id: "sum-only",
        name: "Summary only",
        summary: "Only the summary field is present on this imported skill pack.",
        code: "export async function run(){ return { ok: true }; }\n",
      },
      "skills",
    );
    expect(result.ok).toBe(true);
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(workspaceRoot, "skills", "custom", "sum-only", "skill.json"),
        "utf8",
      ),
    );
    expect(manifest.summary).toBe("Only the summary field is present on this imported skill pack.");
    expect(manifest.description).toBe(
      "Only the summary field is present on this imported skill pack.",
    );
  });
});
