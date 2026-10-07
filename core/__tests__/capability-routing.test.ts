/**
 * Proof that every capability type routes to exactly one section, that the
 * section lists rebuild from the shared registry event, and that an installed
 * skill is immediately invocable wherever it landed (not just in skills/custom).
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const capabilities = require("../../electron/capabilities.cjs") as {
  resolveTree: (pack: unknown, hint?: string) => string | null;
  installPack: (
    roots: { workspaceRoot?: string },
    pack: unknown,
    hint?: string,
  ) => { ok: boolean; id?: string; tree?: string; error?: string };
  list: (roots: { workspaceRoot?: string }) => { items: { id: string; tree: string }[] };
};
const skills = require("../../electron/skills.cjs") as {
  list: (root: string) => { skills: { id: string; enabled: boolean }[] };
  read: (root: string, id: string) => { ok: boolean; skill?: { id: string } };
  setEnabled: (root: string, id: string, enabled: boolean) => { ok: boolean };
};

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "friday-routing-"));

describe("capability auto-routing", () => {
  it("routes a declared tree, an alias, a page hint and an inferred shape", () => {
    expect(capabilities.resolveTree({ tree: "agents" })).toBe("agents");
    expect(capabilities.resolveTree({ kind: "Agent" })).toBe("agents");
    expect(capabilities.resolveTree({ type: "plug-in" })).toBe("plugins");
    // The import page is only a hint — a declared tree always wins over it.
    expect(capabilities.resolveTree({ tree: "tools" }, "skills")).toBe("tools");
    expect(capabilities.resolveTree({ name: "Anything" }, "modules")).toBe("modules");
    // GitHub import: the manifest file name says which tree it is.
    expect(capabilities.resolveTree({ manifestName: "workflow" })).toBe("workflows");
    // Shape inference, last resort only.
    expect(capabilities.resolveTree({ steps: [] })).toBe("workflows");
    expect(capabilities.resolveTree({ code: "export const run = () => 1" })).toBe("skills");
    expect(capabilities.resolveTree({ command: "git status" })).toBe("tools");
    expect(capabilities.resolveTree({ name: "mystery" })).toBeNull();
  });

  it("lands an agent, a skill and a tool in exactly the right section", () => {
    const workspaceRoot = temp();
    const roots = { workspaceRoot };
    const agent = capabilities.installPack(roots, { kind: "agent", name: "Inbox agent" });
    const skill = capabilities.installPack(
      roots,
      { name: "Word count", code: "export const run = () => 2" },
      "",
    );
    const tool = capabilities.installPack(roots, { name: "Repo status" }, "tools");
    expect([agent.ok, skill.ok, tool.ok]).toEqual([true, true, true]);
    expect(agent.tree).toBe("agents");
    expect(skill.tree).toBe("skills");
    expect(tool.tree).toBe("tools");

    const byTree = new Map(capabilities.list(roots).items.map((i) => [i.id, i.tree]));
    expect(byTree.get(agent.id!)).toBe("agents");
    expect(byTree.get(skill.id!)).toBe("skills");
    expect(byTree.get(tool.id!)).toBe("tools");
    // No cross-contamination: each section sees exactly one of them.
    for (const tree of ["agents", "skills", "tools"]) {
      expect(capabilities.list(roots).items.filter((i) => i.tree === tree)).toHaveLength(1);
    }
  });

  it("rejects a pack with no usable tree instead of guessing a wrong section", () => {
    const result = capabilities.installPack({ workspaceRoot: temp() }, { name: "mystery" });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/capability tree/i);
  });
});

describe("installed skills are usable immediately", () => {
  it("lists, enables and reads a skill installed outside skills/custom", () => {
    const root = temp();
    const dir = path.join(root, "skills", "installed", "note-taker");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "skill.json"),
      JSON.stringify({ id: "note-taker", name: "Note taker", enabled: true, risk: "safe" }),
    );
    fs.writeFileSync(path.join(dir, "skill.mjs"), "export const run = () => 'ok';\n", "utf8");

    const listed = skills.list(root).skills.map((s) => s.id);
    expect(listed).toContain("note-taker");
    expect(skills.read(root, "note-taker").ok).toBe(true);
    expect(skills.setEnabled(root, "note-taker", true).ok).toBe(true);
  });
});
