/**
 * Shipped tools catalog: every tools/<category>/<...>/tool.json must parse,
 * ids must be unique, and every index.cjs must export run() that executes
 * without throwing on a safe sample input.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(__dirname, "../..");
const TOOLS = path.join(ROOT, "tools");
const require_ = createRequire(import.meta.url);
const capabilities = require_(path.join(ROOT, "electron/capabilities.cjs")) as {
  list: (roots: { appRoot?: string | null; workspaceRoot?: string | null }) => {
    items: { id: string; tree: string; segment: string; entry: string | null; risk: string }[];
  };
};

const REQUIRED_JSON = [
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

function walkToolJson(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "custom") continue;
      walkToolJson(full, out);
    } else if (entry.name === "tool.json") out.push(full);
  }
  return out;
}

const manifests = walkToolJson(TOOLS).map((file) => {
  const dir = path.dirname(file);
  const rel = path.relative(TOOLS, dir).replace(/\\/g, "/");
  const [category, ...rest] = rel.split("/");
  const slug = rest.join("/");
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
  return { file, dir, category, slug, id: `tools/${rel}`, data };
});

function runBounded<T>(label: string, fn: () => Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
    fn().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function sampleFor(slug: string, tmp: string): Record<string, unknown> {
  const samples: Record<string, Record<string, unknown>> = {
    "web-search": { query: "FRIDAY assistant", limit: 2 },
    "web-open": { url: "https://example.com", maxChars: 800 },
    "web-download": { url: "https://example.com", name: "example.html", root: tmp },
    "web-screenshot": { url: "https://example.com" },
    "web-history": { limit: 5 },
    "web-research": { query: "example domain", depth: 1 },
    "web-extract-text": { url: "https://example.com", maxChars: 800 },
    "web-extract-links": { url: "https://example.com" },
    "web-interact": { action: "read", url: "https://example.com" },
    "web-live-open": { url: "https://example.com" },
    "html-strip": { html: "<p>Hello <b>FRIDAY</b></p>" },
    "file-list": { path: ".", root: tmp },
    "file-read": { path: "sample.txt", root: tmp },
    "file-write": { path: "written.txt", content: "hello", root: tmp },
    "file-search": { folder: ".", query: "hello", root: tmp },
    "file-copy": { from: "sample.txt", to: "copied.txt", root: tmp },
    "file-move": { from: "to-move.txt", to: "moved.txt", root: tmp },
    "file-rename": { path: "to-rename.txt", name: "renamed.txt", root: tmp },
    "file-mkdir": { path: "nested/dir", root: tmp },
    "file-stat": { path: "sample.txt", root: tmp },
    "file-hash": { path: "sample.txt", root: tmp },
    "file-tree": { folder: ".", root: tmp },
    "file-delete": { path: "to-delete.txt", root: tmp },
    "archive-extract": { archive: "pack.tar.gz", dest: "extracted", root: tmp },
    "archive-compress": { source: "sample.txt", dest: "pack.tar.gz", root: tmp },
    "archive-list": { archive: "pack.zip", root: tmp },
    "docs-extract": { path: "rows.csv", root: tmp },
    "json-read": { path: "data.json", root: tmp },
    "text-stats": { path: "sample.txt", root: tmp },
    "csv-preview": { path: "rows.csv", root: tmp },
    "find-duplicates": { folder: ".", root: tmp },
    "git-status": { root: ROOT },
    "git-diff": { root: ROOT, statOnly: true },
    "git-log": { root: ROOT, limit: 3 },
    "git-branch": { root: ROOT },
    "git-show": { root: ROOT, rev: "HEAD" },
    "git-stash-list": { root: ROOT },
    "git-remote": { root: ROOT },
    "run-tests": { root: ROOT, probe: true },
    "run-lint": { root: ROOT, probe: true },
    "run-typecheck": { root: ROOT, probe: true },
    "dep-audit": { root: ROOT, probe: true },
    "changelog-draft": { root: ROOT, limit: 5 },
    "sandbox-run": {},
    "project-summarise": { root: tmp },
    "npm-scripts": { root: ROOT },
    "which-tool": { cmd: "node" },
    "workspace-shell": { command: "console.log('workspace-shell-ok')", shell: "node", root: tmp },
    "json-pretty": { text: '{"a":1}' },
    "text-hash": { text: "friday" },
    "replace-in-file": {
      path: "sample.txt",
      find: "hello",
      replace: "hello",
      dryRun: true,
      root: tmp,
    },
    "which-app": { app: "node" },
    "dns-lookup": { host: "localhost" },
    "http-head": { host: "example.com" },
    "tcp-check": { host: "127.0.0.1", port: 1 },
    "tls-info": { host: "example.com" },
    "disk-space": { root: tmp },
    "csv-parse": { text: "name,qty\nalpha,1\n" },
    "csv-to-json": { text: "name,qty\nalpha,1\n" },
    "json-keys": { text: '{"a":1,"b":2}' },
    "json-merge": { base: '{"a":1}', patch: '{"b":2}' },
    "json-get": { text: '{"a":{"b":3}}', path: "a.b" },
    "tsv-preview": { text: "name\tqty\nalpha\t1\n" },
    "pdf-text": { path: "sample.txt", root: tmp },
    "docx-text": { path: "sample.txt", root: tmp },
    "xlsx-sheets": { path: "sample.txt", root: tmp },
    "base64-encode": { text: "friday" },
    "base64-decode": { text: "ZnJpZGF5" },
    "url-encode": { text: "a b" },
    "url-decode": { text: "a%20b" },
    "line-sort": { text: "b\na\n" },
    "unique-lines": { text: "a\na\nb\n" },
    "slugify-text": { text: "Hello FRIDAY" },
    "diff-lines": { left: "a\nb", right: "a\nc" },
    "case-fold": { text: "FrIdAy", mode: "lower" },
    "split-lines": { text: "a\nb" },
    "join-lines": { lines: ["a", "b"], sep: "," },
    "ics-events": { text: "BEGIN:VEVENT\nSUMMARY:Meet\nDTSTART:20260906T090000\nEND:VEVENT\n" },
    "http-get-preview": { url: "https://example.com", maxChars: 200 },
    "github-config": { root: tmp },
    "csv-headers": { text: "name,qty\nalpha,1\n" },
    "csv-row-count": { text: "name,qty\nalpha,1\n" },
    "json-validate": { text: '{"ok":true}' },
    "json-flatten": { text: '{"a":{"b":1}}' },
    "ndjson-preview": { text: '{"a":1}\n{"b":2}\n' },
    "zip-entries": { path: "pack.zip", root: tmp },
    "mime-from-name": { name: "notes.docx" },
    "word-count": { text: "hello friday" },
    "extract-emails": { text: "write to owner@example.com please" },
    "extract-urls": { text: "see https://example.com/docs" },
    "html-entities": { text: "a &amp; b", mode: "decode" },
    "markdown-strip": { text: "# Hello **FRIDAY**" },
    "wrap-text": { text: "hello friday from the tools catalog", width: 12 },
    "hex-encode": { text: "friday" },
    "hex-decode": { text: "667269646179" },
    "query-parse": { text: "q=friday&lang=en" },
    "template-fill": { text: "hi {{name}}", values: { name: "FRIDAY" } },
    "word-frequency": { text: "friday friday tools" },
    "extract-numbers": { text: "pay 12.5 and 3" },
    "prefix-lines": { text: "a\nb", prefix: "- " },
    "json-escape": { text: 'say "hi"' },
    "url-parts": { url: "https://example.com/path?q=1#top" },
    "python-resolve": { root: ROOT },
    "parse-iso": { text: "2026-09-06T09:00:00Z" },
    "format-local": { text: "2026-09-06T09:00:00Z", locale: "en-IN" },
    "duration-ms": { ms: 3661000 },
    "add-days": { text: "2026-09-06T00:00:00Z", days: 2 },
    "weekday-name": { text: "2026-09-06T00:00:00Z", locale: "en-IN" },
    "random-int": { min: 1, max: 3 },
    "sum-list": { text: "1, 2, 3" },
    "average-list": { text: "2, 4, 6" },
    "clamp-number": { value: 12, min: 0, max: 10 },
    "percent-of": { part: 25, whole: 200 },
    "round-number": { value: 3.14159, places: 2 },
    "env-get": { name: "PATH" },
    "app-launch": { app: "friday-missing-app-xyz-probe" },
    "app-focus": {},
    "app-close": {},
    "window-list": {},
    "input-click": {},
    "input-hotkey": {},
    "input-type": {},
    "screen-read-text": {},
    "android-list": {},
    "android-open-app": {},
    "android-input": { action: "tap" },
    "android-transfer": {},
    "android-mirror": {},
    "bluetooth-list": {},
    "bluetooth-scan": { seconds: 0.2 },
    "bluetooth-media": {},
    "bluetooth-send-file": {},
    "network-discover": { kind: "mdns", seconds: 0.2 },
    "network-cast": {},
    "ffmpeg-transcode": { probe: true },
    "credential-vault": { action: "list", root: tmp },
    "port-scan": { host: "127.0.0.1", ports: [1], timeoutMs: 200 },
    "git-commit": { probe: true, root: ROOT },
    "git-push": { probe: true, root: ROOT },
    "git-merge": { probe: true, root: ROOT },
    "reminder-engine": { action: "add", text: "call the accountant in 2 hours", root: tmp },
    "clipboard-history": { action: "capture", text: "hello clipboard", root: tmp },
    "cookie-dump": {},
    "camera-capture": {
      dataUrl:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    },
    "camera-clip": { frames: 2 },
  };
  return samples[slug] || {};
}

describe("FRIDAY tools catalog", () => {
  it("has unique ids, required tool.json fields, and no custom prefill", () => {
    expect(manifests.length).toBeGreaterThanOrEqual(80);
    const ids = manifests.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(fs.readdirSync(path.join(TOOLS, "custom")).every((name) => name === "index.ts")).toBe(
      true,
    );
    for (const item of manifests) {
      for (const key of REQUIRED_JSON) {
        expect(item.data[key], `${item.id} missing ${key}`).toBeDefined();
      }
      expect(["safe", "write", "exec"]).toContain(item.data.risk);
      expect(item.data.enabled).toBe(false);
      expect(String(item.data.approvalPrompt).length).toBeGreaterThan(20);
      if (item.data.risk !== "safe") {
        expect(String(item.data.approvalPrompt)).toMatch(/Allow/i);
      }
    }
  });

  it("is discovered by capabilities.list, including nested device packs", () => {
    const report = capabilities.list({ appRoot: ROOT, workspaceRoot: null });
    const tools = report.items.filter((item) => item.tree === "tools");
    const byId = new Map(tools.map((item) => [item.id, item]));
    expect(tools.length).toBeGreaterThanOrEqual(manifests.length);
    for (const item of manifests) {
      expect(byId.has(item.id), `capabilities.list missing ${item.id}`).toBe(true);
    }
    expect(byId.has("tools/devices/bluetooth/bluetooth-list")).toBe(true);
    expect(byId.has("tools/devices/android/android-list")).toBe(true);
    expect(byId.has("tools/browser/web-search")).toBe(true);
    expect(byId.has("tools/filesystem/file-read")).toBe(true);
    expect(byId.has("tools/developer/git-status")).toBe(true);
    expect(byId.has("tools/data/csv-parse")).toBe(true);
    expect(byId.has("tools/documents/pdf-text")).toBe(true);
    expect(byId.has("tools/text/base64-encode")).toBe(true);
    expect(byId.has("tools/media/screen-sources")).toBe(true);
    expect(byId.has("tools/media/camera-capture")).toBe(true);
    expect(byId.has("tools/media/camera-clip")).toBe(true);
    expect(byId.has("tools/developer/workspace-shell")).toBe(true);
    expect(byId.has("tools/time/unix-now")).toBe(true);
    expect(byId.has("tools/math/uuid-v4")).toBe(true);
    expect(byId.has("tools/health/os-uptime")).toBe(true);
  });

  it("executes every index.cjs run() on a safe sample without throwing", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "friday-tools-"));
    fs.writeFileSync(path.join(tmp, "sample.txt"), "hello friday\n");
    fs.writeFileSync(path.join(tmp, "to-move.txt"), "move me\n");
    fs.writeFileSync(path.join(tmp, "to-rename.txt"), "rename me\n");
    fs.writeFileSync(path.join(tmp, "to-delete.txt"), "delete me\n");
    fs.writeFileSync(path.join(tmp, "data.json"), '{"ok":true}\n');
    fs.writeFileSync(path.join(tmp, "rows.csv"), "name,qty\nalpha,1\n");
    try {
      execFileSync(
        "python3",
        [
          "-c",
          "import zipfile; z=zipfile.ZipFile('pack.zip','w'); z.writestr('a.txt','hi'); z.close()",
        ],
        { cwd: tmp },
      );
    } catch {
      /* archive-list will fail honestly if zipfile is missing */
    }

    const withIndex = manifests.filter((item) => fs.existsSync(path.join(item.dir, "index.cjs")));
    expect(withIndex.length).toBe(manifests.length);

    for (const item of withIndex) {
      const mod = require_(path.join(item.dir, "index.cjs")) as {
        run: (input?: Record<string, unknown>) => Promise<unknown>;
      };
      expect(typeof mod.run, `${item.id} missing run()`).toBe("function");
      const leaf = item.slug.split("/").pop() as string;
      const input = sampleFor(leaf, tmp);
      const result = await runBounded(item.id, () => mod.run(input), 90_000);
      expect(result, `${item.id} returned nothing`).toBeTruthy();
      expect(typeof result).toBe("object");
    }
  }, 420_000);
});
