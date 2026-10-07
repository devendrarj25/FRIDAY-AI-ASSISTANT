/**
 * Brain section closeout: Personality toggles actually change Core Brain,
 * Updates reads live scanners (never invented versions), workspace tiles and
 * schedule last-run stay honest, and the Updates HudPanel actions prop is
 * wired. No page restyle.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { coreBrain } from "../../src/lib/friday/brain/core-brain";
import { brainKnowledge } from "../../src/lib/friday/brain/knowledge-base";
import {
  collectLiveUpdateRows,
  honestLastRun,
  workspaceTilesFromScan,
} from "../../src/lib/friday/brain/section-sync";
import { brainActionNeedsApproval, setActionMode } from "../../src/lib/friday/brain/action-risk";
import { spokenSummary } from "../../src/lib/friday/voice-library";
import { workspaceTree } from "../../src/lib/friday/brain-catalog";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

const BASE_ROWS = [
  {
    id: "app",
    label: "FRIDAY application",
    channel: "github releases",
    installed: "—",
    latest: "—",
    state: "up-to-date" as const,
    notes: "not checked yet",
  },
  {
    id: "plugins",
    label: "Plugins",
    channel: "plugin registry",
    installed: "—",
    latest: "—",
    state: "up-to-date" as const,
    notes: "not checked yet",
  },
  {
    id: "modules",
    label: "Modules",
    channel: "manifest index",
    installed: "—",
    latest: "—",
    state: "up-to-date" as const,
    notes: "not checked yet",
  },
  {
    id: "agents",
    label: "Agents",
    channel: "bundled definitions",
    installed: "—",
    latest: "—",
    state: "up-to-date" as const,
    notes: "not checked yet",
  },
  {
    id: "providers",
    label: "AI providers",
    channel: "official provider APIs",
    installed: "—",
    latest: "—",
    state: "up-to-date" as const,
    notes: "not checked yet",
  },
  {
    id: "tools",
    label: "Developer tools",
    channel: "winget / vendor",
    installed: "—",
    latest: "—",
    state: "up-to-date" as const,
    notes: "not checked yet",
  },
  {
    id: "workflows",
    label: "Workflows",
    channel: "workspace",
    installed: "—",
    latest: "—",
    state: "up-to-date" as const,
    notes: "not checked yet",
  },
];

describe("Brain page wiring stays honest", () => {
  const page = read("src/routes/brain.tsx");
  const engine = read("src/lib/friday/brain-engine.ts");

  it("puts Updates actions on HudPanel instead of as a child string", () => {
    expect(page).toMatch(/title="Startup update flow"/);
    expect(page).toContain("actions={");
    expect(page).not.toMatch(/>\s*\n\s*actions=/);
  });

  it("does not invent Notion Sync / 1.4.3 versions in the Brain updater", () => {
    expect(engine).not.toContain("1.4.3");
    expect(engine).not.toContain("Notion Sync");
    expect(engine).not.toContain("Voice Bridge");
    expect(engine).toContain("collectLiveUpdateRows");
    expect(engine).toContain("applyDesktopUpdate");
  });

  it("passes Personality flags into cognize and does not speak from the chat path", () => {
    expect(engine).toContain("useKnowledge: this.state.settings.useKnowledge");
    expect(engine).toContain("useProjectMemory: this.state.settings.useProjectMemory");
    expect(engine).toContain("autoLearn: this.state.settings.autoLearn");
    expect(engine).toContain("learn: this.state.settings.autoLearn");
    expect(engine).toContain("speakReply");
    expect(engine).toContain("Manual and chat stay silent");
    expect(engine).not.toContain("speakText");
    expect(engine).toContain("settings.set");
    expect(engine).toContain("write_lessons");
    expect(engine).not.toContain("planner.options");
    expect(engine).toContain("refreshUpdatesIfStale");
    expect(engine).toContain("syncLearningSurfaces");
    expect(engine).toContain("brainActionNeedsApproval");
  });

  it("maps schedule jobs onto existing settings / workflow enable", () => {
    expect(engine).toContain("honorScheduleJob");
    expect(engine).toContain("morning-briefing");
    expect(engine).toContain('preferences.setToggle("memOpt"');
    expect(engine).toContain("honestLastRun");
  });

  it("refreshes the Updates tab from live scanners when the last check is stale", () => {
    expect(page).toContain("refreshUpdatesIfStale");
  });

  it("kernel overlays Brain autoLearn through settings.set, not a new IPC", () => {
    const kernel = read("kernel/main.py");
    expect(kernel).not.toMatch(/method == ["']planner.options["']/);
    expect(kernel).toContain("apply_live_setting");
    expect(kernel).toContain('if "write_lessons" in _stored');
  });
});

describe("live update rows", () => {
  it("never fills versions that the scanners did not return", async () => {
    const { rows } = await collectLiveUpdateRows(BASE_ROWS, {
      version: "v1.0.0.2",
      github: async () => ({ ok: false, error: "desktop only" }),
      electronUpdates: async () => [],
      plugins: async () => ({ ok: false, plugins: [], updates: [], error: "no feed" }),
      capabilities: async () => null,
      providerCount: 4,
    });
    const app = rows.find((row) => row.id === "app")!;
    expect(app.installed).toBe("v1.0.0.2");
    expect(app.latest).toBe("v1.0.0.2");
    expect(app.state).toBe("up-to-date");
    expect(app.notes).toMatch(/desktop only/i);
    expect(rows.every((row) => !row.notes.includes("Notion"))).toBe(true);
    expect(rows.find((row) => row.id === "providers")?.installed).toBe("4 catalogued");
  });

  it("marks the app available only when GitHub or electron-updater says so", async () => {
    const { rows } = await collectLiveUpdateRows(BASE_ROWS, {
      version: "v1.0.0.2",
      github: async () => ({
        ok: true,
        currentVersion: "v1.0.0.2",
        version: "v1.0.0.3",
        updateAvailable: true,
        notes: "real GitHub notes",
      }),
      electronUpdates: async () => [],
      plugins: async () => ({ ok: true, plugins: [], updates: [] }),
      capabilities: async () => ({
        items: [],
        counts: { plugins: { total: 78, enabled: 2 } },
        scannedAt: 1,
        appRoot: null,
        workspaceRoot: null,
      }),
      providerCount: 4,
    });
    const app = rows.find((row) => row.id === "app")!;
    expect(app.state).toBe("available");
    expect(app.latest).toBe("v1.0.0.3");
    expect(app.notes).toMatch(/real GitHub notes/);
    expect(rows.find((row) => row.id === "plugins")?.installed).toBe("2 enabled / 78 packed");
  });
});

describe("workspace tiles and schedule honesty", () => {
  it("falls back to the catalog when no scan exists", () => {
    const tiles = workspaceTilesFromScan(null);
    expect(tiles.map((t) => t.name)).toEqual(workspaceTree.map((t) => t.name));
  });

  it("uses live folder counts when a scan is present", () => {
    const tiles = workspaceTilesFromScan({
      root: "C:\\\\FRIDAY",
      exists: true,
      valid: true,
      present: ["Memory"],
      missing: [],
      scannedAt: Date.now(),
      folders: [
        {
          name: "Memory",
          path: "C:\\\\FRIDAY\\\\Memory",
          kind: "data",
          files: 12,
          subfolders: 3,
          indexed: true,
        },
      ],
    });
    expect(tiles).toEqual([{ name: "Memory", note: "12 files · 3 sub-folders" }]);
  });

  it("strips leftover demo last-run stamps", () => {
    expect(honestLastRun("today 09:00")).toBe("—");
    expect(honestLastRun("08:41")).toBe("08:41");
  });
});

describe("Personality flags reach Core Brain", () => {
  it("skips knowledge recall when useKnowledge is off", async () => {
    brainKnowledge.remember({
      kind: "knowledge",
      title: "BrainCloseoutUniqueFact",
      body: "BrainCloseoutUniqueFact is a marker used only by this test.",
      source: "test",
      provenance: "user",
      confidence: 0.9,
    });
    const on = await coreBrain.cognize("what is BrainCloseoutUniqueFact", {
      mode: "manual",
      allowTools: false,
      useKnowledge: true,
    });
    const off = await coreBrain.cognize("what is BrainCloseoutUniqueFact", {
      mode: "manual",
      allowTools: false,
      useKnowledge: false,
    });
    expect(on.useKnowledge).toBe(true);
    expect(off.useKnowledge).toBe(false);
    expect(off.notes.join(" ")).toMatch(/knowledge: skipped/);
    expect(off.notes.join(" ")).not.toMatch(/recalled \d+ stored knowledge/);
  });

  it("skips project-scoped memory when useProjectMemory is off", async () => {
    const cognition = await coreBrain.cognize("write a haiku about rain", {
      mode: "manual",
      allowTools: false,
      useProjectMemory: false,
    });
    expect(cognition.useProjectMemory).toBe(false);
    expect(cognition.notes.join(" ")).toMatch(/project memory: skipped/);
  });

  it("records autoLearn on the cognition so reflect can skip writes", async () => {
    const cognition = await coreBrain.cognize("write a haiku about rain", {
      mode: "manual",
      allowTools: false,
      autoLearn: false,
    });
    expect(cognition.autoLearn).toBe(false);
    const verification = coreBrain.reflect({
      cognition,
      answer: "Rain on tin roofs.",
      ok: true,
      learn: false,
    });
    expect(verification.ok).toBe(true);
  });
});

describe("confirm-important cannot skip write/exec", () => {
  it("still asks for write in auto even when confirmImportant is off", () => {
    setActionMode("auto");
    expect(brainActionNeedsApproval("write", "auto", { confirmImportant: false })).toBe(true);
    expect(brainActionNeedsApproval("exec", "auto", { confirmImportant: false })).toBe(true);
    expect(brainActionNeedsApproval("safe", "auto", { confirmImportant: false })).toBe(false);
  });

  it("asks for a consequential phrasing of a safe tool when the toggle is on", () => {
    setActionMode("auto");
    expect(
      brainActionNeedsApproval("safe", "auto", {
        confirmImportant: true,
        prompt: "delete the logs folder",
      }),
    ).toBe(true);
    expect(
      brainActionNeedsApproval("safe", "auto", {
        confirmImportant: true,
        prompt: "what is the weather",
      }),
    ).toBe(false);
  });
});

describe("spokenSummary lives on the one TTS helper", () => {
  it("strips markdown for speech", () => {
    expect(spokenSummary("**Hello** `code` https://example.com Done.")).toMatch(/Hello/);
    expect(spokenSummary("**Hello** world.")).not.toContain("**");
  });
});
