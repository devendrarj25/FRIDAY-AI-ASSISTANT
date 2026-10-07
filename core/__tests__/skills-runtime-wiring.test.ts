/**
 * Skills page discovery and the skill runtime must see the same packs.
 *
 * Catalog skills ship in the app folder. The selected workspace is a different
 * directory. capabilities.list already scans both; skills.cjs used to scan only
 * the workspace, so Enable on the page could not reach chat/voice invoke.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { chooseSkill } from "../../src/lib/friday/brain/skill-router";
import type { SkillManifest } from "../../src/lib/friday/brain/skill-forge";

const require = createRequire(import.meta.url);
const skills = require("../../electron/skills.cjs") as {
  list: (root: unknown) => {
    ok: boolean;
    skills: { id: string; enabled: boolean; name: string }[];
  };
  read: (
    root: unknown,
    id: string,
  ) => { ok: boolean; skill?: { enabled: boolean }; code?: string; error?: string };
  setEnabled: (
    root: unknown,
    id: string,
    enabled: boolean,
  ) => { ok: boolean; skill?: { enabled: boolean; dir?: string }; error?: string };
  invoke: (
    root: unknown,
    id: string,
    input?: unknown,
    ctx?: { allowDisabled?: boolean },
  ) => Promise<{ ok: boolean; value?: unknown; error?: string }>;
  ensureWorkspaceCopy: (root: unknown, id: string) => { dir: string } | null;
};
const capabilities = require("../../electron/capabilities.cjs") as {
  list: (roots: { appRoot?: string | null; workspaceRoot?: string | null }) => {
    items: { id: string; tree: string; enabled: boolean }[];
  };
  setEnabled: (roots: { workspaceRoot: string }, id: string, enabled: boolean) => { ok: boolean };
};

const temps: string[] = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-skill-wire-"));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
  temps.length = 0;
});

function writeCatalogSkill(appRoot: string, slug: string, extra: Record<string, unknown> = {}) {
  const dir = path.join(appRoot, "skills", "custom", slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "skill.json"),
    JSON.stringify({
      id: slug,
      name: "Wire Probe",
      summary: "Deterministic sandbox probe used to prove app-to-workspace skill wiring.",
      category: "coding",
      capabilities: [],
      permissions: [],
      risk: "safe",
      inputs: ["text"],
      version: 1,
      author: "friday-core",
      enabled: false,
      description: "Returns the input text so invoke can be checked without a model.",
      ...extra,
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(dir, "skill.mjs"),
    "export async function run(input = {}) { return { ok: true, text: String(input.text || input.prompt || '') }; }\nexport default run;\n",
    "utf8",
  );
  return dir;
}

describe("app catalog vs workspace runtime", () => {
  it("does not list a shipped skill from an empty workspace string root", () => {
    const appRoot = temp();
    const workspaceRoot = temp();
    writeCatalogSkill(appRoot, "wire-probe");
    const workspaceOnly = skills.list(workspaceRoot).skills.map((s) => s.id);
    expect(workspaceOnly).not.toContain("wire-probe");
  });

  it("lists the shipped skill when both roots are passed — same view as the Skills page", () => {
    const appRoot = temp();
    const workspaceRoot = temp();
    writeCatalogSkill(appRoot, "wire-probe");
    const roots = { appRoot, workspaceRoot };
    expect(skills.list(roots).skills.map((s) => s.id)).toContain("wire-probe");
    expect(skills.list(roots).skills.find((s) => s.id === "wire-probe")?.enabled).toBe(false);
    const page = capabilities.list(roots).items.filter((item) => item.tree === "skills");
    expect(page.map((item) => item.id)).toContain("skills/custom/wire-probe");
  });

  it("copies the shipped skill into the workspace on Enable so chat can invoke it", async () => {
    const appRoot = temp();
    const workspaceRoot = temp();
    writeCatalogSkill(appRoot, "wire-probe");
    const roots = { appRoot, workspaceRoot };
    const enabled = skills.setEnabled(roots, "wire-probe", true);
    expect(enabled.ok).toBe(true);
    expect(enabled.skill?.enabled).toBe(true);
    expect(
      fs.existsSync(path.join(workspaceRoot, "skills", "custom", "wire-probe", "skill.json")),
    ).toBe(true);
    const listed = skills.list(roots).skills.find((s) => s.id === "wire-probe");
    expect(listed?.enabled).toBe(true);

    const asManifest = listed as SkillManifest;
    expect(chooseSkill("run Wire Probe please", [asManifest])?.id).toBe("wire-probe");

    const ran = await skills.invoke(roots, "wire-probe", { text: "hello desk" });
    expect(ran.ok).toBe(true);
    expect((ran.value as { text?: string })?.text).toBe("hello desk");
  });

  it("applies capabilities.json Enable to the runtime list before a copy exists", () => {
    const appRoot = temp();
    const workspaceRoot = temp();
    writeCatalogSkill(appRoot, "wire-probe");
    capabilities.setEnabled({ workspaceRoot }, "skills/custom/wire-probe", true);
    const listed = skills
      .list({ appRoot, workspaceRoot })
      .skills.find((s) => s.id === "wire-probe");
    expect(listed?.enabled).toBe(true);
  });

  it("lets Test selected run a still-disabled shipped skill without enabling it", async () => {
    const appRoot = temp();
    const workspaceRoot = temp();
    writeCatalogSkill(appRoot, "wire-probe");
    const roots = { appRoot, workspaceRoot };
    const blocked = await skills.invoke(roots, "wire-probe", { text: "nope" });
    expect(blocked.ok).toBe(false);
    expect(String(blocked.error)).toMatch(/disabled/i);
    const tested = await skills.invoke(
      roots,
      "wire-probe",
      { text: "probe" },
      { allowDisabled: true },
    );
    expect(tested.ok).toBe(true);
    expect((tested.value as { text?: string })?.text).toBe("probe");
    expect(skills.list(roots).skills.find((s) => s.id === "wire-probe")?.enabled).toBe(false);
    expect(fs.existsSync(path.join(workspaceRoot, "skills", "custom", "wire-probe"))).toBe(false);
  });
});

describe("desktop IPC wiring", () => {
  const main = fs.readFileSync(path.join(process.cwd(), "electron/main.cjs"), "utf8");
  const preload = fs.readFileSync(path.join(process.cwd(), "electron/preload.cjs"), "utf8");

  it("lists, reads, enables and invokes through capabilityRoots() so app packs are visible", () => {
    expect(main).toContain("fridaySkills.list(capabilityRoots())");
    expect(main).toContain("fridaySkills.read(capabilityRoots()");
    expect(main).toContain("fridaySkills.setEnabled(capabilityRoots()");
    expect(main).toContain("fridaySkills.invoke(capabilityRoots()");
    expect(main).toContain("allowDisabled: Boolean(options && options.allowDisabled)");
    expect(preload).toContain("options || {}");
  });
});
