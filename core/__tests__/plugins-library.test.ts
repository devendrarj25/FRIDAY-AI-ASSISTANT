/**
 * The plugins that ship with FRIDAY and write an insight: each one fires on its hooks with realistic payloads,
 * leaves a valid insight.json in its own data folder, never stores a secret value, and the Plugins page API
 * (plugins.insights) lists them. Zero-permission ones ship on, the ones that read the workspace ship off.
 */
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, "../..");
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const plugins = require("../../electron/plugins.cjs") as Any;

const temps: string[] = [];
afterAll(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const SECRET = `gh${"p_"}${"Zq7".repeat(13)}`;
const PAYLOAD: Record<string, unknown> = {
  "on-app-start": {},
  "on-app-quit": {},
  "on-turn-start": { runId: "r1", intent: "chat" },
  "on-turn-complete": { runId: "r1", ms: 1200, ok: true },
  "on-error": { runId: "r1", error: `token ${SECRET} failed at C:\\x\\y 123`, ms: 40 },
  "on-idle": { at: 1, discovered: 2, researched: 1, note: "studied the repo" },
  "on-skill-run": { skillId: "health-calc", name: "health", ok: false, detail: "x" },
  "on-file-change": { component: "skills", file: "a.json", relative: "skills/a.json", at: 1 },
};

function manifests() {
  const dir = path.join(ROOT, "plugins", "installed");
  return fs
    .readdirSync(dir)
    .map((id) => path.join(dir, id, "plugin.json"))
    .filter((f) => fs.existsSync(f))
    .map((f) => JSON.parse(fs.readFileSync(f, "utf8")))
    .filter((m) => m.insight === true);
}

describe("insight plugins", () => {
  const all = manifests();

  it("ship 29 of them: permission-free on, workspace readers off", () => {
    expect(all.length).toBe(29);
    for (const m of all) {
      const reads = m.permissions.includes("fs.read");
      expect(m.enabled, m.id).toBe(!reads);
      expect(
        m.permissions.every((p: string) => p === "fs.read"),
        m.id,
      ).toBe(true);
      expect(m.description.length, m.id).toBeGreaterThan(40);
    }
    expect(all.filter((m) => m.enabled).length).toBe(20);
  });

  it("each fires on its hooks, writes a valid insight, and never stores a secret", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "friday-pl-lib-"));
    temps.push(ws);
    fs.writeFileSync(path.join(ws, ".env"), "A=1\nB=2\n");
    fs.writeFileSync(path.join(ws, ".env.example"), "A=\n");
    fs.writeFileSync(path.join(ws, "README.md"), "# demo\n");
    fs.writeFileSync(
      path.join(ws, "package.json"),
      JSON.stringify({ name: "demo", scripts: { test: "x" } }),
    );
    fs.writeFileSync(path.join(ws, "a.js"), `// TODO fix\nconst k = "${SECRET}";\r\n`);
    const roots = { appRoot: ROOT, workspaceRoot: ws };
    for (const m of all) {
      for (const hook of m.hooks as string[]) {
        for (let i = 0; i < 2; i++) {
          const r = await plugins.dispatch(roots, hook, PAYLOAD[hook], {
            allowDisabled: true,
            pluginId: m.id,
          });
          const f = (r.fired ?? []) as { ok: boolean; error?: string }[];
          expect(f.length, `${m.id} ${hook}`).toBe(1);
          expect(f[0]!.ok, `${m.id} ${hook}: ${f[0]!.error}`).toBe(true);
        }
      }
      const dataDir = path.join(ws, "plugins", "data", m.id);
      const file = path.join(dataDir, "insight.json");
      if (m.id !== "idle-note-log" || fs.existsSync(file)) {
        expect(fs.existsSync(file), m.id).toBe(true);
        const insight = JSON.parse(fs.readFileSync(file, "utf8"));
        expect(["info", "good", "warn"]).toContain(insight.level);
        expect(String(insight.title).length, m.id).toBeGreaterThan(0);
      }
      for (const f of fs.readdirSync(dataDir)) {
        expect(fs.readFileSync(path.join(dataDir, f), "utf8"), `${m.id}/${f}`).not.toContain(
          SECRET,
        );
      }
    }
  }, 600000);

  it("plugins.insights lists them for the page, warnings first", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "friday-pl-ins-"));
    temps.push(ws);
    const roots = { appRoot: ROOT, workspaceRoot: ws };
    await plugins.dispatch(roots, "on-error", PAYLOAD["on-error"], {});
    await plugins.dispatch(roots, "on-turn-complete", PAYLOAD["on-turn-complete"], {});
    const rows = plugins.insights(roots) as Any[];
    expect(rows.length).toBeGreaterThan(2);
    expect(rows.some((r) => r.id.endsWith("error-secret-sniff") && r.level === "warn")).toBe(true);
    const order = { warn: 0, info: 1, good: 2 } as Record<string, number>;
    const levels = rows.map((r) => order[r.level]!);
    expect(levels).toEqual([...levels].sort((a, b) => a - b));
  }, 120000);

  it("hooks run in parallel yet results keep the plugin order", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "friday-pl-par-"));
    temps.push(ws);
    const r = await plugins.dispatch(
      { appRoot: ROOT, workspaceRoot: ws },
      "on-turn-complete",
      PAYLOAD["on-turn-complete"],
      {},
    );
    const ids = (r.fired as { id: string }[]).map((f) => f.id);
    expect(ids.length).toBe(new Set(ids).size);
    const expected = (plugins.list({ appRoot: ROOT, workspaceRoot: ws }) as Any[])
      .filter((p) => p.enabled && p.hooks.includes("on-turn-complete"))
      .map((p) => p.id);
    expect(ids).toEqual(expected);
  }, 120000);

  it("Test runs keep their files apart, report the note, and never change the real counters", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "friday-pl-test-"));
    temps.push(ws);
    const roots = { appRoot: ROOT, workspaceRoot: ws };
    const id = "plugins/installed/daily-turn-log";
    const r = await plugins.dispatch(roots, "on-turn-complete", PAYLOAD["on-turn-complete"], {
      allowDisabled: true,
      pluginId: id,
      test: true,
    });
    expect(r.fired[0].ok).toBe(true);
    expect(r.fired[0].insight.title).toBe("Today");
    const dir = path.join(ws, "plugins", "data", "daily-turn-log");
    expect(fs.existsSync(path.join(dir, "days.json"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "insight.json"))).toBe(false);
    expect(plugins.insights(roots).some((row: Any) => row.id === id)).toBe(false);
  }, 60000);

  it("a warning nobody refreshed for a day is shown as info", () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "friday-pl-ttl-"));
    temps.push(ws);
    const dir = path.join(ws, "plugins", "data", "break-reminder");
    fs.mkdirSync(dir, { recursive: true });
    const note = {
      level: "warn",
      title: "Take a break",
      text: "x",
      at: Date.now() - 30 * 3600_000,
    };
    fs.writeFileSync(path.join(dir, "insight.json"), JSON.stringify(note));
    const row = (plugins.insights({ appRoot: ROOT, workspaceRoot: ws }) as Any[]).find((r) =>
      r.id.endsWith("break-reminder"),
    );
    expect(row.level).toBe("info");
    fs.writeFileSync(path.join(dir, "insight.json"), JSON.stringify({ ...note, at: Date.now() }));
    const fresh = (plugins.insights({ appRoot: ROOT, workspaceRoot: ws }) as Any[]).find((r) =>
      r.id.endsWith("break-reminder"),
    );
    expect(fresh.level).toBe("warn");
  });
});
