/**
 * Projects & Workspaces Phase 1: persist, switch without leak, handsOffAuto,
 * chat extra, nav, toolchain ids.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { memory } from "../../src/lib/friday/self/memory-engine";
import { setActionMode } from "../../src/lib/friday/brain/action-risk";
import { ALL_NAV_ITEMS } from "../../src/lib/friday/navigation";
import {
  extraLeaksOtherProject,
  fingerprintFromFiles,
  formatProjectWorkspaceExtra,
  skipAutoMutation,
} from "../../src/lib/friday/project-workspace-logic";
import {
  handleProjectWorkspaceChat,
  projectWorkspaces,
} from "../../src/lib/friday/project-workspace-engine";
import { shouldAttachProjectExtra } from "../../src/lib/friday/brain/project-workspace-observe";
import { catalog } from "../../src/lib/friday/catalog";
import {
  reviewEnabledAgents,
  type AgentSchedulerHost,
  type ScheduledAgent,
} from "../../src/lib/friday/self/agent-scheduler";
import type { GovAction, GovItem } from "../../src/lib/friday/self/governance";

const require = createRequire(import.meta.url);
const paths = require("../../electron/friday-paths.cjs");
const disk = require("../../electron/project-workspaces.cjs");
const toolchain = require("../../electron/toolchain.cjs") as { TOOLS: Array<{ id: string }> };

describe("project workspace persist + switch", () => {
  beforeEach(() => {
    memory.resetForTests();
    projectWorkspaces.resetForTests();
    setActionMode("manual");
  });

  it("persists create/save and keeps one active project", () => {
    const labour = projectWorkspaces.create({
      name: "Labour app",
      kind: "mixed",
      rootPath: "/tmp/friday-labour",
    });
    projectWorkspaces.save({
      id: labour.id,
      instructions: "Build the labour register. Do not touch payroll secrets.",
    });
    projectWorkspaces.addKnowledge(labour.id, {
      title: "site",
      text: "North site unique-labour-token-77",
      useInChat: true,
    });
    projectWorkspaces.addSource(labour.id, {
      label: "notes",
      path: "/tmp/friday-labour/notes.md",
      excerpt: "wage sheet lives in notes.md",
      selected: true,
    });
    expect(projectWorkspaces.active()?.name).toBe("Labour app");
    const extra = projectWorkspaces.extraFor(labour.id);
    expect(extra).toMatch(/Build the labour register/);
    expect(extra).toMatch(/unique-labour-token-77/);
    expect(extra).toMatch(/wage sheet lives in notes.md/);
    expect(extra).toMatch(/PROJECT WORKSPACE SESSION/);
  });

  it("does not leak project A knowledge into project B extra or retrieve", () => {
    const a = projectWorkspaces.create({
      name: "Site A",
      kind: "website",
      rootPath: "/tmp/site-a",
    });
    const b = projectWorkspaces.create({
      name: "Site B",
      kind: "website",
      rootPath: "/tmp/site-b",
    });
    projectWorkspaces.addKnowledge(a.id, {
      title: "secret",
      text: "alpha-project-secret-token-AAA",
      useInChat: true,
    });
    projectWorkspaces.addKnowledge(b.id, {
      title: "secret",
      text: "beta-project-secret-token-BBB",
      useInChat: true,
    });
    projectWorkspaces.save({ id: a.id, instructions: "Only work on Site A." });
    projectWorkspaces.save({ id: b.id, instructions: "Only work on Site B." });
    projectWorkspaces.setActive(b.id);
    const extraB = projectWorkspaces.extraFor(b.id);
    expect(extraB).toMatch(/beta-project-secret-token-BBB/);
    expect(extraB).toMatch(/Only work on Site B/);
    expect(extraLeaksOtherProject(extraB, projectWorkspaces.get(a.id)!)).toBe(false);
    const hits = memory.retrieve("beta-project-secret-token-BBB", 8, { projectId: b.id });
    expect(hits.some((hit) => hit.item.text.includes("BBB"))).toBe(true);
    expect(hits.some((hit) => hit.item.text.includes("AAA"))).toBe(false);
    const hitsA = memory.retrieve("alpha-project-secret-token-AAA", 8, { projectId: a.id });
    expect(hitsA.some((hit) => hit.item.text.includes("AAA"))).toBe(true);
    expect(hitsA.some((hit) => hit.item.text.includes("BBB"))).toBe(false);
  });
});

describe("handsOffAuto", () => {
  beforeEach(() => {
    projectWorkspaces.resetForTests();
    setActionMode("auto");
  });

  it("blocks Auto writes into a hands-off project root and still allows owner chat writes", async () => {
    const site = projectWorkspaces.create({
      name: "Notes",
      kind: "documents",
      rootPath: "/tmp/friday-notes-desk",
    });
    projectWorkspaces.setHandsOff(site.id, true);
    projectWorkspaces.setActive(site.id);
    const decision = skipAutoMutation({
      mode: "auto",
      prompt: "write file readme.md",
      paths: ["/tmp/friday-notes-desk/readme.md"],
      items: projectWorkspaces.all(),
      activeId: site.id,
      risk: "write",
    });
    expect(decision.block).toBe(true);
    expect(decision.note).toMatch(/hands-off/i);
    const autoWrite = await projectWorkspaces.writeFile(site.id, "auto.md", "nope");
    expect(autoWrite.ok).toBe(false);
    expect(autoWrite.error).toMatch(/hands-off/i);
    setActionMode("manual");
    expect(handleProjectWorkspaceChat("create other.md with leaked")).toBeNull();
    const owner = handleProjectWorkspaceChat("Project Notes: create readme.md with hello notes");
    expect(owner?.text).toMatch(/Wrote readme.md/);
    const manual = await projectWorkspaces.writeFile(site.id, "owner.md", "yes", {
      actor: "owner",
    });
    expect(manual.ok).toBe(true);
  });

  it("skips background agents that target a hands-off folder", async () => {
    const tmp = "/tmp/friday-hands-off-agent";
    const site = projectWorkspaces.create({ name: "Locked", kind: "other", rootPath: tmp });
    projectWorkspaces.setHandsOff(site.id, true);
    const items = new Map<string, GovItem>();
    const submitted: (GovAction & { id?: string })[] = [];
    const host: AgentSchedulerHost = {
      listEnabledAgents: async () =>
        [
          {
            id: "agents/core/downloads-cleanup",
            name: "Cleanup",
            category: "maintenance",
            risk: "write",
            enabled: true,
          },
        ] satisfies ScheduledAgent[],
      planAgent: async () => ({
        ok: true,
        value: {
          ok: true,
          actionable: true,
          folder: tmp,
          candidates: [{ path: join(tmp, "x.bin") }],
        },
      }),
      runAgent: async () => ({ ok: true, value: { dryRun: false } }),
      getItem: (id) => items.get(id),
      discover: (input) => {
        const item = {
          id: input.id || "gov-x",
          kind: input.kind,
          title: input.title,
          rationale: input.rationale,
          risk: input.risk,
          evidence: input.evidence ?? [],
          stage: "discovered" as const,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          logs: [],
        };
        items.set(item.id, item);
        return item;
      },
      submit: async (action) => {
        submitted.push(action);
        const item = host.discover(action);
        items.set(item.id, { ...item, stage: "waiting-approval" });
        return items.get(item.id) as GovItem;
      },
    };
    const queued = await reviewEnabledAgents(host);
    expect(queued).toBe(0);
    expect(submitted).toHaveLength(0);
  });

  it("does not block Auto terminal in an unrelated folder when a hands-off project is merely active", () => {
    const site = projectWorkspaces.create({
      name: "Locked desk",
      kind: "documents",
      rootPath: "/tmp/friday-locked-desk",
    });
    projectWorkspaces.setHandsOff(site.id, true);
    projectWorkspaces.setActive(site.id);
    const decision = skipAutoMutation({
      mode: "auto",
      prompt: "ls",
      paths: ["/tmp/other-cwd"],
      items: projectWorkspaces.all(),
      activeId: site.id,
      risk: "exec",
    });
    expect(decision.block).toBe(false);
  });
});

describe("project duplicate, kind, isolation, fingerprint", () => {
  beforeEach(() => {
    projectWorkspaces.resetForTests();
  });

  it("duplicates without creating a second id", () => {
    const site = projectWorkspaces.create({ name: "Site", kind: "website" });
    const copy = projectWorkspaces.duplicate(site.id);
    expect(copy).toBeTruthy();
    const ids = projectWorkspaces.list(true).map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(copy!.id);
    expect(copy!.id).not.toBe(site.id);
  });

  it("refreshes runtime when kind changes and can clear isolation", () => {
    const app = projectWorkspaces.create({ name: "App", kind: "node" });
    expect(app.runtime).toContain("Node.js LTS");
    projectWorkspaces.save({ id: app.id, kind: "python" });
    expect(projectWorkspaces.get(app.id)?.runtime).toContain("Python");
    projectWorkspaces.save({
      id: app.id,
      isolation: "docker",
    });
    expect(projectWorkspaces.get(app.id)?.isolation).toBe("docker");
    projectWorkspaces.save({ id: app.id, clearIsolation: true });
    expect(projectWorkspaces.get(app.id)?.isolation).toBeUndefined();
  });

  it("fingerprints package.json from a file listing", () => {
    const hit = fingerprintFromFiles(["src/index.ts", "package.json", "README.md"]);
    expect(hit?.file).toBe("package.json");
    expect(hit?.language).toMatch(/JavaScript/);
  });

  it("attaches the active project extra the way Library pins attach", () => {
    const labour = projectWorkspaces.create({ name: "Labour app", kind: "mixed" });
    projectWorkspaces.setActive(labour.id);
    expect(shouldAttachProjectExtra("what should we do next")).toBe(true);
  });
});

describe("navigation + toolchain", () => {
  it("registers Projects & Workspaces in the one nav SOT", () => {
    const item = ALL_NAV_ITEMS.find((row) => row.to === "/projects");
    expect(item?.label).toBe("Projects & Workspaces");
  });

  it("adds Gradle and Android SDK cmdline-tools to the existing Install Manager catalog", () => {
    const ids = new Set(toolchain.TOOLS.map((t) => t.id));
    expect(ids.has("Gradle")).toBe(true);
    expect(ids.has("Android SDK cmdline-tools")).toBe(true);
    expect(catalog.some((row) => row.pkg === "Gradle")).toBe(true);
    expect(catalog.some((row) => row.pkg === "Android SDK cmdline-tools")).toBe(true);
  });
});

describe("disk manifest", () => {
  it("saves a project under FRIDAY_ROOT/projects without wiping the root", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-projects-"));
    const prev = paths.root();
    paths.setRoot(root);
    try {
      const saved = disk.save({
        name: "Site",
        kind: "website",
        instructions: "Keep the landing page simple.",
        handsOffAuto: true,
      });
      expect(saved.ok).toBe(true);
      expect(saved.item.name).toBe("Site");
      expect(saved.item.handsOffAuto).toBe(true);
      const listed = disk.list();
      expect(listed.items.some((row: { id: string }) => row.id === saved.item.id)).toBe(true);
      const file = join(root, "projects", saved.item.id, "instructions.md");
      expect(readFileSync(file, "utf8")).toMatch(/landing page/);
      const extra = formatProjectWorkspaceExtra(saved.item);
      expect(extra).toMatch(/Keep the landing page simple/);
      expect(extra).toMatch(/handsOffAuto: true/);
    } finally {
      paths.setRoot(prev);
    }
  });

  it("reads a text file inside the project work folder and refuses path escape", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-projects-read-"));
    const prev = paths.root();
    paths.setRoot(root);
    try {
      const saved = disk.save({ name: "Notes", kind: "documents" });
      expect(saved.ok).toBe(true);
      const written = disk.writeFileInProject({
        id: saved.item.id,
        name: "hello.md",
        text: "unique-project-file-token-11",
        actor: "owner",
      });
      expect(written.ok).toBe(true);
      const read = disk.readFileInProject({ id: saved.item.id, name: "hello.md" });
      expect(read.ok).toBe(true);
      expect(read.content).toMatch(/unique-project-file-token-11/);
      const escaped = disk.readFileInProject({ id: saved.item.id, name: "../index.json" });
      expect(escaped.ok).toBe(false);
    } finally {
      paths.setRoot(prev);
    }
  });
});
