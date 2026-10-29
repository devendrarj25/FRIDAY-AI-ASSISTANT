/**
 * Shipped background-agent library: every agents/core/<slug>/manifest.json
 * parses, ids are unique, and plan()/run() execute on a scratch folder
 * without mutating unless approved:true is passed.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { hasCommand } from "./helpers/environment";

const ROOT = path.resolve(__dirname, "../..");
const CORE = path.join(ROOT, "agents", "core");
const require_ = createRequire(import.meta.url);
const capabilities = require_(path.join(ROOT, "electron/capabilities.cjs")) as {
  list: (roots: { appRoot?: string | null; workspaceRoot?: string | null }) => {
    items: {
      id: string;
      tree: string;
      category: string;
      approvalPrompt?: string;
      enabled: boolean;
      risk: string;
    }[];
  };
};

const REQUIRED = [
  "name",
  "version",
  "description",
  "category",
  "entry",
  "inputs",
  "permissions",
  "risk",
  "enabled",
  "approvalPrompt",
] as const;

const CATEGORIES = new Set([
  "maintenance",
  "monitoring",
  "research",
  "security",
  "backup",
  "reminders",
  "documents",
  "office",
  "developer",
  "home",
]);

function agentDirs(): string[] {
  return fs
    .readdirSync(CORE, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const slugs = agentDirs();

describe("Shipped background-agent library", () => {
  it("keeps agents/custom empty of packs", () => {
    const custom = path.join(ROOT, "agents", "custom");
    const packs = fs
      .readdirSync(custom, { withFileTypes: true })
      .filter((entry) => entry.isDirectory());
    expect(packs).toEqual([]);
  });

  it("has unique ids, valid manifests, and default disabled", () => {
    const ids = new Set<string>();
    expect(slugs.length).toBeGreaterThanOrEqual(90);
    for (const slug of slugs) {
      const file = path.join(CORE, slug, "manifest.json");
      expect(fs.existsSync(file), file).toBe(true);
      const data = JSON.parse(fs.readFileSync(file, "utf8")) as {
        name: string;
        version: string;
        description: string;
        category: string;
        entry: string;
        inputs: string[];
        permissions: string[];
        risk: string;
        enabled: boolean;
        approvalPrompt: string;
      };
      for (const key of REQUIRED) expect(data, `${slug}.${key}`).toHaveProperty(key);
      expect(CATEGORIES.has(data.category), `${slug} category`).toBe(true);
      expect(data.enabled).toBe(false);
      expect(data.approvalPrompt.length).toBeGreaterThan(20);
      expect(fs.existsSync(path.join(CORE, slug, data.entry))).toBe(true);
      const id = `agents/core/${slug}`;
      expect(ids.has(id), `duplicate ${id}`).toBe(false);
      ids.add(id);
    }
    expect(ids.size).toBe(slugs.length);
  });

  it("is visible to the same discovery pass the Agents page uses", () => {
    const { items } = capabilities.list({ appRoot: ROOT, workspaceRoot: null });
    const agents = items.filter(
      (item) => item.tree === "agents" && item.id.startsWith("agents/core/"),
    );
    const ids = agents.map((item) => item.id).sort();
    expect(ids).toEqual(slugs.map((slug) => `agents/core/${slug}`).sort());
    for (const item of agents) {
      expect(item.enabled).toBe(false);
      expect(String(item.approvalPrompt || "").length).toBeGreaterThan(20);
    }
    expect(agents.length).toBe(slugs.length);
  });

  it("plan() and dry-run run() execute on safe sample input without deleting", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "friday-agent-lib-"));
    const past = new Date(Date.now() - 40 * 86400000);
    const keep = path.join(tmp, "keep.txt");
    const stale = path.join(tmp, "stale.tmp");
    const photoA = path.join(tmp, "shot.jpg");
    const photoB = path.join(tmp, "shot-copy.jpg");
    const risky = path.join(tmp, "old-setup.exe");
    const cache = path.join(tmp, "pack.cache");
    const log = path.join(tmp, "rotate.log");
    const bytes = Buffer.from("duplicate-photo-bytes");
    fs.writeFileSync(keep, "keep");
    fs.writeFileSync(stale, "tmp");
    fs.writeFileSync(photoA, bytes);
    fs.writeFileSync(photoB, bytes);
    fs.writeFileSync(risky, "mz");
    fs.writeFileSync(cache, "cache");
    fs.writeFileSync(log, "log");
    for (const file of [stale, photoA, photoB, risky, cache, log]) {
      fs.utimesSync(file, past, past);
    }
    const desk = path.join(tmp, "desk.json");
    fs.writeFileSync(
      desk,
      JSON.stringify({
        tasks: [
          { id: "t1", title: "Pay rent", dueAt: Date.now() - 86400000, done: false },
          { id: "t2", title: "Later", dueAt: Date.now() + 86400000, done: false },
        ],
      }),
    );
    const dest = path.join(tmp, "backup-out");
    fs.mkdirSync(path.join(tmp, "empty-dir"));
    fs.writeFileSync(path.join(tmp, "invoice-GST-2024.pdf"), "pdf");
    fs.writeFileSync(path.join(tmp, "NIT-tender-bridge.pdf"), "pdf");
    fs.writeFileSync(path.join(tmp, "BOQ-site.xlsx"), "sheet");
    fs.writeFileSync(path.join(tmp, "RA-bill-03.pdf"), "pdf");
    fs.writeFileSync(path.join(tmp, "work-order-WO-12.pdf"), "pdf");
    fs.writeFileSync(path.join(tmp, "Copy of drawing FINAL.pdf"), "pdf");
    fs.writeFileSync(path.join(tmp, "2020-01-01-report.pdf"), "pdf");
    fs.writeFileSync(path.join(tmp, "Screenshot 2024.png"), "img");
    fs.writeFileSync(path.join(tmp, "IMG-20240101-WA0001.jpg"), "wa");
    fs.writeFileSync(path.join(tmp, "notes.md"), "TODO harvest https://example.com/tender\n");
    fs.writeFileSync(path.join(tmp, "ledger.csv"), "item,amount\ncement,1500\nsteel,2400\n");
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify({ name: "tmp", scripts: { test: "echo" } }),
    );
    fs.writeFileSync(path.join(tmp, ".env.example"), "API_KEY=\n");
    fs.writeFileSync(path.join(tmp, "bookmarks.html"), '<a href="https://example.com/a">a</a>');
    fs.writeFileSync(
      path.join(tmp, "meet.ics"),
      "BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20990101T090000Z\nSUMMARY:Future\nEND:VEVENT\nEND:VCALENDAR\n",
    );
    fs.mkdirSync(path.join(tmp, "node_modules", "left-pad"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "node_modules", "left-pad", "index.js"), "module.exports=1");

    const samples: Record<string, Record<string, unknown>> = {
      "downloads-cleanup": { folder: tmp, olderThanDays: 1 },
      "temp-file-cleanup": { folder: tmp, olderThanDays: 1 },
      "cache-trim": { folder: tmp, olderThanDays: 1 },
      "log-rotation-cleanup": { folder: tmp, olderThanDays: 1 },
      "duplicate-photo-finder": { folder: tmp, maxDepth: 1 },
      "disk-space-watcher": { folder: tmp, warnPct: 101 },
      "startup-program-auditor": {},
      "process-health-snapshot": {},
      "network-connection-snapshot": {},
      "config-backup-reminder": { folders: [tmp], dest },
      "stale-download-scanner": { folder: tmp, olderThanDays: 1 },
      "browser-extension-inventory": {},
      "recurring-task-nudger": { file: desk },
      "workspace-change-scanner": { folder: tmp, sinceHours: 24 * 400, maxDepth: 1 },
    };

    try {
      // Agents that shell out to an OS tool are only exercised where that tool
      // exists (a minimal Linux image has no `netstat`).
      const NEEDS_TOOL: Record<string, string> = { "network-connection-snapshot": "netstat" };
      for (const slug of slugs) {
        const tool = NEEDS_TOOL[slug];
        if (tool && !hasCommand(tool)) continue;
        const mod = require_(path.join(CORE, slug, "index.cjs")) as {
          plan: (input?: Record<string, unknown>) => { ok?: boolean; error?: string };
          run: (input?: Record<string, unknown>) => Promise<{
            ok?: boolean;
            dryRun?: boolean;
            error?: string;
          }>;
        };
        expect(typeof mod.plan, `${slug}.plan`).toBe("function");
        expect(typeof mod.run, `${slug}.run`).toBe("function");
        const input = samples[slug] ?? { folder: tmp };
        const preview = mod.plan(input);
        expect(preview, slug).toBeTruthy();
        expect(preview.ok, `${slug} plan ok: ${String(preview.error || "")}`).toBe(true);
        const dry = await mod.run(input);
        expect(dry.ok, `${slug} dry run`).toBe(true);
        expect(dry.dryRun, `${slug} dryRun default`).toBe(true);
        const refused = await mod.run({ ...input, dryRun: false, approved: false });
        expect(refused.dryRun, `${slug} refused stays dry`).toBe(true);
      }
      expect(fs.existsSync(keep)).toBe(true);
      expect(fs.existsSync(stale)).toBe(true);
      expect(fs.existsSync(risky)).toBe(true);

      const tender = require_(path.join(CORE, "tender-filename-scanner", "index.cjs")).plan({
        folder: tmp,
      }) as {
        candidates: { name: string }[];
      };
      expect(tender.candidates.some((row) => /tender/i.test(row.name))).toBe(true);
      const csv = require_(path.join(CORE, "csv-expense-total", "index.cjs")).plan({
        folder: tmp,
      }) as {
        totalSum: number;
      };
      expect(csv.totalSum).toBe(3900);
      const empty = require_(path.join(CORE, "empty-folder-cleaner", "index.cjs")).plan({
        folder: tmp,
      }) as {
        candidates: { name: string }[];
      };
      expect(empty.candidates.some((row) => row.name === "empty-dir")).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("every index.cjs exports plan and run, and risky packs never default to executing", () => {
    for (const slug of slugs) {
      const file = path.join(CORE, slug, "index.cjs");
      const src = fs.readFileSync(file, "utf8");
      const manifest = JSON.parse(
        fs.readFileSync(path.join(CORE, slug, "manifest.json"), "utf8"),
      ) as {
        risk: string;
      };
      expect(src, `${slug} plan export`).toMatch(/function\s+plan\s*\(/);
      expect(src, `${slug} run export`).toMatch(/function\s+run\s*\(/);
      expect(src, `${slug} module.exports`).toMatch(/module\.exports\s*=\s*\{[^}]*\bplan\b/);
      expect(src, `${slug} module.exports run`).toMatch(/module\.exports\s*=\s*\{[^}]*\brun\b/);
      expect(src, `${slug} dry-run default`).toMatch(/dryRun\s*!==\s*false/);
      if (manifest.risk !== "safe") {
        expect(src, `${slug} approved gate`).toMatch(/\bapproved\b/);
        expect(src, `${slug} refuses unapproved mutate`).toMatch(/if\s*\(\s*!input\.approved/);
      }
    }
  });
});
