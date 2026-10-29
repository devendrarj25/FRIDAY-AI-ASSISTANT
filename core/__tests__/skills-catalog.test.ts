/**
 * Custom skill catalog: every skills/custom/<slug>/skill.json must parse, have a
 * unique id, and show up in the same discovery pass the Skills page uses
 * (electron/capabilities.cjs list) and the skill runtime (electron/skills.cjs).
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const ROOT = path.resolve(__dirname, "../..");
const CUSTOM = path.join(ROOT, "skills", "custom");
const require = createRequire(import.meta.url);
const capabilities = require("../../electron/capabilities.cjs") as {
  list: (roots: { appRoot?: string | null; workspaceRoot?: string | null }) => {
    items: {
      id: string;
      tree: string;
      segment: string;
      name: string;
      summary?: string;
      description?: string;
      category?: string;
      inputs?: string[];
      enabled: boolean;
    }[];
  };
};
const fridaySkills = require("../../electron/skills.cjs") as {
  list: (root: string) => { ok: boolean; skills: { id: string; name: string; enabled: boolean }[] };
};

const REQUIRED = [
  "id",
  "name",
  "summary",
  "category",
  "capabilities",
  "risk",
  "inputs",
  "version",
  "author",
  "enabled",
  "permissions",
  "description",
] as const;

type SkillManifestFile = {
  id: string;
  name: string;
  summary: string;
  category: string;
  capabilities: unknown[];
  risk: string;
  inputs: string[];
  version: number;
  author: string;
  enabled: boolean;
  permissions: unknown[];
  description: string;
};

function customManifestDirs(): string[] {
  return fs
    .readdirSync(CUSTOM, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && fs.existsSync(path.join(CUSTOM, entry.name, "skill.json")),
    )
    .map((entry) => entry.name);
}

describe("custom skill catalog", () => {
  const slugs = customManifestDirs();
  const manifests = slugs.map((slug) => {
    const raw = fs.readFileSync(path.join(CUSTOM, slug, "skill.json"), "utf8");
    return { slug, data: JSON.parse(raw) as SkillManifestFile };
  });

  it("has at least 200 loadable custom skill manifests with unique ids", () => {
    expect(manifests.length).toBeGreaterThanOrEqual(200);
    const ids = manifests.map((m) => String(m.data.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("meeting-notes");
    expect(ids).toContain("code-review");
    expect(ids).toContain("off-memo-outline");
    expect(ids).toContain("sec-password-hygiene");
  });

  it("every manifest matches the existing skill.json shape and stays disabled by default", () => {
    for (const { slug, data } of manifests) {
      for (const key of REQUIRED) {
        expect(data, `${slug} missing ${key}`).toHaveProperty(key);
      }
      expect(data.id, slug).toBe(slug);
      expect(data.enabled, slug).toBe(false);
      expect(data.risk, slug).toBe("safe");
      expect(String(data.summary).length, `${slug} summary`).toBeGreaterThan(20);
      expect(String(data.description).length, `${slug} description`).toBeGreaterThan(40);
      expect(fs.existsSync(path.join(CUSTOM, slug, "skill.mjs")), `${slug} skill.mjs`).toBe(true);
    }
  });

  it("appears in capabilities.list — the Skills page's real count", () => {
    const report = capabilities.list({ appRoot: ROOT, workspaceRoot: null });
    const skillItems = report.items.filter((item) => item.tree === "skills");
    expect(skillItems.length).toBeGreaterThanOrEqual(200);
    const byId = new Map(skillItems.map((item) => [item.id, item]));
    for (const { slug, data } of manifests) {
      const item = byId.get(`skills/custom/${slug}`);
      expect(item, `capabilities.list missing skills/custom/${slug}`).toBeDefined();
      expect(item?.name).toBe(data.name);
      expect(item?.summary).toBe(data.summary);
      expect(item?.inputs).toEqual(data.inputs);
      expect(item?.enabled).toBe(false);
    }
  });

  it("appears in skills.cjs list — the runtime the router invokes", () => {
    const listed = fridaySkills.list(ROOT);
    expect(listed.ok).toBe(true);
    const custom = listed.skills.filter((skill) => !String(skill.id).includes("."));
    const byId = new Map(listed.skills.map((skill) => [skill.id, skill]));
    expect(custom.length).toBeGreaterThanOrEqual(200);
    for (const { slug, data } of manifests) {
      const skill = byId.get(slug);
      expect(skill, `skills.cjs missing ${slug}`).toBeDefined();
      expect(skill?.name).toBe(data.name);
      expect(skill?.enabled).toBe(false);
    }
  });

  it("covers the shipped category set, including the later office-through-career packs", () => {
    const categories = new Set(manifests.map((m) => m.data.category));
    for (const wanted of [
      "markets",
      "construction",
      "coding",
      "reasoning",
      "productivity",
      "developer",
      "office",
      "data",
      "writing",
      "home",
      "health-education",
      "travel",
      "study",
      "communication",
      "legal-templates",
      "security-hygiene",
      "cooking",
      "career",
    ]) {
      expect(categories.has(wanted), wanted).toBe(true);
    }
  });
});
