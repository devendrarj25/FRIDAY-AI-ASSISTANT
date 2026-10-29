/**
 * Plugin hook dispatch must actually call a declared hook at a real lifecycle
 * moment — not merely parse plugin.json. This fixture plugin writes a scratch
 * file from on-turn-complete; a disabled twin must stay silent.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const plugins = require("../../electron/plugins.cjs") as {
  HOOKS: string[];
  canonicalHook: (name: string) => string | null;
  dispatch: (
    roots: { appRoot?: string | null; workspaceRoot?: string | null },
    hook: string,
    payload?: Record<string, unknown>,
    options?: {
      allowDisabled?: boolean;
      authorizeHook?: (info: Record<string, unknown>) => Promise<unknown>;
    },
  ) => Promise<{
    ok: boolean;
    hook?: string;
    fired?: { ok: boolean; id: string; denied?: boolean; error?: string }[];
    error?: string;
  }>;
};

const temps: string[] = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-plugin-hooks-"));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const ENTRY = `module.exports = {
  register() {},
  "on-turn-complete": async function (payload, ctx) {
    ctx.fs.writeFile(
      "turn-complete.log",
      JSON.stringify({ runId: payload.runId, at: Date.now(), source: "on-turn-complete" }) + "\\n",
    );
    return { ok: true, runId: payload.runId };
  },
  "on-error": async function (payload, ctx) {
    ctx.fs.writeFile("last-error.txt", String(payload.error || ""));
    return { ok: true };
  },
};
`;

function writeProbe(root: string, slug: string, enabled: boolean) {
  const dir = path.join(root, "plugins", "installed", slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "plugin.json"),
    JSON.stringify({
      id: slug,
      name: slug,
      version: "1.0.0",
      description: "Hook probe — writes plugin data/ when on-turn-complete fires.",
      category: "installed",
      entry: "index.cjs",
      permissions: [],
      hooks: ["on-turn-complete", "on-error"],
      enabled,
    }),
  );
  fs.writeFileSync(path.join(dir, "index.cjs"), ENTRY);
  return dir;
}

describe("plugin hook registry", () => {
  it("names only lifecycle moments FRIDAY actually has", () => {
    expect(plugins.HOOKS).toEqual([
      "on-app-start",
      "on-app-quit",
      "on-turn-start",
      "on-turn-complete",
      "on-error",
      "on-idle",
      "on-skill-run",
      "on-file-change",
    ]);
    expect(plugins.canonicalHook("onTurnComplete")).toBe("on-turn-complete");
    expect(plugins.canonicalHook("on-commit")).toBeNull();
  });

  it("fires on-turn-complete and writes a real scratch file", async () => {
    const root = temp();
    writeProbe(root, "hook-probe", true);
    const result = await plugins.dispatch({ workspaceRoot: root }, "on-turn-complete", {
      runId: "run-real-1",
    });
    expect(result.ok).toBe(true);
    expect(result.hook).toBe("on-turn-complete");
    expect(result.fired?.some((row) => row.ok && row.id.includes("hook-probe"))).toBe(true);
    const scratch = path.join(root, "plugins", "data", "hook-probe", "turn-complete.log");
    expect(fs.existsSync(scratch), scratch).toBe(true);
    const body = fs.readFileSync(scratch, "utf8");
    expect(body).toMatch(/run-real-1/);
    expect(body).toMatch(/on-turn-complete/);
  }, 60000);

  it("does not fire a disabled plugin", async () => {
    const root = temp();
    writeProbe(root, "hook-probe-off", false);
    const result = await plugins.dispatch({ workspaceRoot: root }, "on-turn-complete", {
      runId: "run-disabled",
    });
    expect(result.fired || []).toEqual([]);
    expect(
      fs.existsSync(path.join(root, "plugins", "data", "hook-probe-off", "turn-complete.log")),
    ).toBe(false);
  }, 60000);

  it("refuses write/exec hooks without authorizeHook", async () => {
    const root = temp();
    const dir = path.join(root, "plugins", "installed", "writey");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "plugin.json"),
      JSON.stringify({
        id: "writey",
        name: "writey",
        version: "1.0.0",
        entry: "index.cjs",
        permissions: ["fs.write"],
        hooks: ["on-error"],
        enabled: true,
      }),
    );
    fs.writeFileSync(
      path.join(dir, "index.cjs"),
      'module.exports={"on-error":async(_p,ctx)=>{ctx.fs.writeFile("x.txt","no");return {ok:true}}}',
    );
    const denied = await plugins.dispatch({ workspaceRoot: root }, "on-error", { error: "boom" });
    expect(denied.fired?.[0]?.denied).toBe(true);
    expect(fs.existsSync(path.join(root, "plugins", "data", "writey", "x.txt"))).toBe(false);

    const allowed = await plugins.dispatch(
      { workspaceRoot: root },
      "on-error",
      { error: "boom" },
      { authorizeHook: async () => ({ ok: true, granted: true }) },
    );
    expect(allowed.fired?.[0]?.ok).toBe(true);
    expect(fs.existsSync(path.join(root, "plugins", "data", "writey", "x.txt"))).toBe(true);
  }, 60000);

  it("is wired at the real brain / idle / boot moments, not a second bus", () => {
    const brain = fs.readFileSync(
      path.join(process.cwd(), "src/lib/friday/brain-engine.ts"),
      "utf8",
    );
    expect(brain).toContain('dispatchPluginHook("on-turn-start"');
    expect(brain).toContain('dispatchPluginHook("on-turn-complete"');
    expect(brain).toContain('dispatchPluginHook("on-error"');
    expect(brain).toContain('dispatchPluginHook("on-skill-run"');
    const core = fs.readFileSync(
      path.join(process.cwd(), "src/lib/friday/brain/core-brain.ts"),
      "utf8",
    );
    expect(core).toContain('dispatchPluginHook("on-skill-run"');
    const idle = fs.readFileSync(
      path.join(process.cwd(), "src/lib/friday/self/autonomous-core.ts"),
      "utf8",
    );
    expect(idle).toContain('dispatchPluginHook("on-idle"');
    const main = fs.readFileSync(path.join(process.cwd(), "electron/main.cjs"), "utf8");
    expect(main).toContain('"on-app-start"');
    expect(main).toContain('"on-app-quit"');
    expect(main).toContain('"on-file-change"');
    expect(main).toContain("plugins:dispatch");
    expect(main).toContain("authorizeHook");
    expect(main).toContain("plugins.list(capabilityRoots())");
    expect(main).toContain("loadEnabled(capabilityRoots()");
    expect(brain).toContain(
      'dispatchPluginHook("on-turn-complete", { runId: run.id, ms: run.ms, ok: false })',
    );
  });

  it("lets fs.read plugins read a workspace file and denies it without the permission", async () => {
    const root = temp();
    fs.writeFileSync(path.join(root, "note.txt"), "hello-workspace");
    const allowedDir = path.join(root, "plugins", "installed", "reader");
    fs.mkdirSync(allowedDir, { recursive: true });
    fs.writeFileSync(
      path.join(allowedDir, "plugin.json"),
      JSON.stringify({
        id: "reader",
        name: "reader",
        version: "1.0.0",
        entry: "index.cjs",
        permissions: ["fs.read"],
        hooks: ["on-app-start"],
        enabled: true,
      }),
    );
    fs.writeFileSync(
      path.join(allowedDir, "index.cjs"),
      `module.exports = {
        "on-app-start": async function (_p, ctx) {
          const file = ctx.workspace.readFile("note.txt");
          ctx.fs.writeFile("got.txt", file.text);
          return { ok: true, bytes: file.bytes };
        },
      };`,
    );
    const ok = await plugins.dispatch({ workspaceRoot: root }, "on-app-start", { at: Date.now() });
    expect(ok.fired?.[0]?.ok).toBe(true);
    expect(
      fs.readFileSync(path.join(root, "plugins", "data", "reader", "got.txt"), "utf8"),
    ).toMatch(/hello-workspace/);

    const deniedDir = path.join(root, "plugins", "installed", "noread");
    fs.mkdirSync(deniedDir, { recursive: true });
    fs.writeFileSync(
      path.join(deniedDir, "plugin.json"),
      JSON.stringify({
        id: "noread",
        name: "noread",
        version: "1.0.0",
        entry: "index.cjs",
        permissions: [],
        hooks: ["on-idle"],
        enabled: true,
      }),
    );
    fs.writeFileSync(
      path.join(deniedDir, "index.cjs"),
      `module.exports = {
        "on-idle": async function (_p, ctx) {
          ctx.workspace.readFile("note.txt");
          return { ok: true };
        },
      };`,
    );
    const denied = await plugins.dispatch({ workspaceRoot: root }, "on-idle", { at: Date.now() });
    expect(denied.fired?.[0]?.ok).toBe(false);
    expect(String(denied.fired?.[0]?.error || "")).toMatch(/fs\.read/);
  }, 60000);
});
