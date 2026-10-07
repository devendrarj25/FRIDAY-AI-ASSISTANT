/**
 * FRIDAY · capability marketplace.
 *
 * A real, installable catalog of capability packs for every tree (skills,
 * tools, agents, modules, plugins, workflows). Installing writes actual
 * folders + manifests into the selected FRIDAY workspace through the desktop
 * bridge, so the capability discovery layer, the skill runtime and the plugin
 * loader pick them up straight away — nothing here is decorative.
 *
 * Packs can also come from a local `.json` pack file or a remote URL, so the
 * catalog is extensible without shipping a new build.
 */
import { desktopApi, isDesktopApp, safeCall } from "./desktop";
import type { CapabilityTree } from "./capability-trees";

export type MarketRisk = "safe" | "write" | "exec";

export interface MarketPack {
  /** Folder name inside the tree segment; also the capability id suffix. */
  slug: string;
  tree: CapabilityTree;
  segment: string;
  name: string;
  description: string;
  category: string;
  version: string;
  author: string;
  permissions: string[];
  risk: MarketRisk;
  tags: string[];
  /** Declared inputs (skills) — surfaced in the UI and the skill manifest. */
  inputs?: string[];
  /** Real executable source for skills (ESM `run(input)`) and plugins (CJS). */
  code?: string;
  /** Extra manifest fields (schedules, steps, model hints…). */
  manifest?: Record<string, unknown>;
}

export const capabilityId = (pack: MarketPack) => `${pack.tree}/${pack.segment}/${pack.slug}`;

/* ------------------------------------------------------------------ skills */

const skill = (
  slug: string,
  name: string,
  description: string,
  category: string,
  permissions: string[],
  risk: MarketRisk,
  inputs: string[],
  code: string,
  tags: string[],
): MarketPack => ({
  slug,
  tree: "skills",
  segment: "custom",
  name,
  description,
  category,
  version: "1.0.0",
  author: "FRIDAY Marketplace",
  permissions,
  risk,
  tags,
  inputs,
  code,
});

const SKILLS: MarketPack[] = [
  skill(
    "text.summarise",
    "Summarise text",
    "Condense long text into the requested number of key sentences.",
    "language",
    [],
    "safe",
    ["text", "sentences"],
    `export async function run(input) {
  const text = String(input.text || "");
  const want = Number(input.sentences) || 3;
  const parts = text.split(/(?<=[.!?])\\s+/).filter(Boolean);
  const scored = parts.map((s, i) => ({ s, i, score: s.split(/\\s+/).length + (i === 0 ? 8 : 0) }));
  const top = scored.sort((a, b) => b.score - a.score).slice(0, want).sort((a, b) => a.i - b.i);
  return { summary: top.map((t) => t.s).join(" "), sentences: parts.length };
}`,
    ["text", "summary"],
  ),
  skill(
    "text.keywords",
    "Extract keywords",
    "Pull the most significant keywords and their frequency out of a document.",
    "language",
    [],
    "safe",
    ["text", "limit"],
    `const STOP = new Set("the a an and or of to in for on with is are was were it this that as by at from be".split(" "));
export async function run(input) {
  const words = String(input.text || "").toLowerCase().match(/[a-z][a-z'-]{2,}/g) || [];
  const counts = {};
  for (const w of words) if (!STOP.has(w)) counts[w] = (counts[w] || 0) + 1;
  const limit = Number(input.limit) || 15;
  return { keywords: Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([word, n]) => ({ word, n })) };
}`,
    ["nlp", "text"],
  ),
  skill(
    "text.translate-prep",
    "Segment for translation",
    "Split text into clean translation segments with character budgets.",
    "language",
    [],
    "safe",
    ["text", "maxChars"],
    `export async function run(input) {
  const max = Number(input.maxChars) || 400;
  const out = []; let buffer = "";
  for (const part of String(input.text || "").split(/(?<=[.!?])\\s+/)) {
    if ((buffer + " " + part).trim().length > max) { if (buffer) out.push(buffer.trim()); buffer = part; }
    else buffer += " " + part;
  }
  if (buffer.trim()) out.push(buffer.trim());
  return { segments: out, count: out.length };
}`,
    ["text", "i18n"],
  ),
  skill(
    "json.transform",
    "Transform JSON",
    "Pick, rename and flatten fields of a JSON payload with a mapping spec.",
    "developer",
    [],
    "safe",
    ["data", "map"],
    `export async function run(input) {
  const map = input.map || {};
  const rows = Array.isArray(input.data) ? input.data : [input.data];
  const value = (obj, pathStr) => String(pathStr).split(".").reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
  return { rows: rows.map((row) => Object.fromEntries(Object.entries(map).map(([to, from]) => [to, value(row, from)]))) };
}`,
    ["json", "data"],
  ),
  skill(
    "csv.parse",
    "Parse CSV",
    "Parse CSV text into typed rows with header detection and stats.",
    "data",
    [],
    "safe",
    ["csv", "delimiter"],
    `export async function run(input) {
  const d = input.delimiter || ",";
  const lines = String(input.csv || "").trim().split(/\\r?\\n/);
  const header = (lines.shift() || "").split(d).map((h) => h.trim());
  const rows = lines.map((line) => Object.fromEntries(line.split(d).map((cell, i) => {
    const raw = cell.trim(); const num = Number(raw);
    return [header[i] || "col" + i, raw !== "" && !Number.isNaN(num) ? num : raw];
  })));
  return { header, rows, count: rows.length };
}`,
    ["csv", "data"],
  ),
  skill(
    "data.stats",
    "Numeric statistics",
    "Mean, median, min, max, standard deviation and outliers for a number list.",
    "data",
    [],
    "safe",
    ["values"],
    `export async function run(input) {
  const v = (input.values || []).map(Number).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
  if (!v.length) return { count: 0 };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  const mid = Math.floor(v.length / 2);
  return { count: v.length, min: v[0], max: v[v.length - 1], mean, median: v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2, sd, outliers: v.filter((n) => Math.abs(n - mean) > 2 * sd) };
}`,
    ["analysis", "math"],
  ),
  skill(
    "web.extract-links",
    "Extract links from a page",
    "Fetch a URL and return every unique link with its anchor text.",
    "web",
    ["web.access"],
    "safe",
    ["url"],
    `export async function run(input) {
  const res = await fetch(String(input.url));
  const html = await res.text();
  const seen = new Map();
  for (const m of html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>(.*?)<\\/a>/gis)) {
    const href = m[1]; if (href.startsWith("#")) continue;
    if (!seen.has(href)) seen.set(href, m[2].replace(/<[^>]+>/g, "").trim());
  }
  return { url: input.url, links: [...seen].map(([href, text]) => ({ href, text })) };
}`,
    ["web", "scrape"],
  ),
  skill(
    "web.readable",
    "Readable article text",
    "Fetch a page and strip navigation, scripts and markup down to readable text.",
    "web",
    ["web.access"],
    "safe",
    ["url"],
    `export async function run(input) {
  const html = await (await fetch(String(input.url))).text();
  const body = html.replace(/<(script|style|nav|footer|header)[\\s\\S]*?<\\/\\1>/gi, "");
  const text = body.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\\s+/g, " ").trim();
  const title = (html.match(/<title>(.*?)<\\/title>/i) || [])[1] || "";
  return { title, words: text.split(" ").length, text: text.slice(0, 20000) };
}`,
    ["web", "reading"],
  ),
  skill(
    "web.api-probe",
    "Probe an HTTP endpoint",
    "Call an endpoint and report status, latency, headers and a body preview.",
    "web",
    ["web.access"],
    "safe",
    ["url", "method", "body"],
    `export async function run(input) {
  const started = Date.now();
  const res = await fetch(String(input.url), { method: input.method || "GET", body: input.body ?? undefined, headers: input.body ? { "content-type": "application/json" } : undefined });
  const text = await res.text();
  return { status: res.status, ok: res.ok, ms: Date.now() - started, headers: Object.fromEntries(res.headers), preview: text.slice(0, 2000) };
}`,
    ["api", "http"],
  ),
  skill(
    "web.rss",
    "Read an RSS feed",
    "Parse an RSS or Atom feed into a clean list of items.",
    "web",
    ["web.access"],
    "safe",
    ["url", "limit"],
    `export async function run(input) {
  const xml = await (await fetch(String(input.url))).text();
  const items = [...xml.matchAll(/<(item|entry)[\\s\\S]*?<\\/\\1>/gi)].map((m) => m[0]);
  const pick = (block, tag) => (block.match(new RegExp("<" + tag + "[^>]*>([\\\\s\\\\S]*?)</" + tag + ">", "i")) || [])[1] || "";
  return { items: items.slice(0, Number(input.limit) || 20).map((b) => ({
    title: pick(b, "title").replace(/<!\\[CDATA\\[|\\]\\]>/g, "").trim(),
    link: (pick(b, "link") || (b.match(/<link[^>]+href="([^"]+)"/i) || [])[1] || "").trim(),
    date: (pick(b, "pubDate") || pick(b, "updated")).trim(),
  })) };
}`,
    ["news", "feeds"],
  ),
  skill(
    "files.find-duplicates",
    "Find duplicate files",
    "Hash every file in a folder and report byte-identical duplicates.",
    "files",
    ["fs.read"],
    "safe",
    ["folder"],
    `import { readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
export async function run(input) {
  const seen = new Map(); const dups = [];
  const walk = (dir) => { for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules" && !e.name.startsWith(".")) walk(p); continue; }
    if (statSync(p).size > 20_000_000) continue;
    const h = createHash("sha1").update(readFileSync(p)).digest("hex");
    if (seen.has(h)) dups.push({ original: seen.get(h), duplicate: p }); else seen.set(h, p);
  } };
  walk(String(input.folder));
  return { scanned: seen.size, duplicates: dups };
}`,
    ["cleanup", "disk"],
  ),
  skill(
    "files.tree",
    "Folder tree report",
    "Walk a folder and report size, file counts and the largest items.",
    "files",
    ["fs.read"],
    "safe",
    ["folder", "depth"],
    `import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
export async function run(input) {
  const root = String(input.folder); const files = [];
  const walk = (dir, d) => { if (d < 0) return; for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(p, d - 1); }
    else files.push({ path: p, size: statSync(p).size });
  } };
  walk(root, Number(input.depth) || 3);
  const total = files.reduce((n, f) => n + f.size, 0);
  return { root, files: files.length, bytes: total, largest: files.sort((a, b) => b.size - a.size).slice(0, 15) };
}`,
    ["disk", "report"],
  ),
  skill(
    "files.bulk-rename",
    "Bulk rename files",
    "Rename files in a folder with a find/replace pattern (dry run by default).",
    "files",
    ["fs.write"],
    "write",
    ["folder", "find", "replace", "dryRun"],
    `import { readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
export async function run(input) {
  const dir = String(input.folder); const dry = input.dryRun !== false;
  const changes = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isFile()) continue;
    const next = e.name.split(String(input.find)).join(String(input.replace ?? ""));
    if (next === e.name) continue;
    changes.push({ from: e.name, to: next });
    if (!dry) renameSync(join(dir, e.name), join(dir, next));
  }
  return { dryRun: dry, changes };
}`,
    ["files", "batch"],
  ),
  skill(
    "code.review",
    "Static code review",
    "Scan source files for TODOs, long functions, console noise and secrets.",
    "developer",
    ["fs.read"],
    "safe",
    ["folder"],
    `import { readdirSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";
const EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".cjs", ".mjs", ".py"]);
export async function run(input) {
  const findings = [];
  const walk = (dir) => { for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!["node_modules", "dist", ".git"].includes(e.name)) walk(p); continue; }
    if (!EXT.has(extname(e.name))) continue;
    const lines = readFileSync(p, "utf8").split("\\n");
    lines.forEach((line, i) => {
      if (/TODO|FIXME|HACK/.test(line)) findings.push({ file: p, line: i + 1, kind: "todo", text: line.trim().slice(0, 160) });
      if (/(api[_-]?key|secret|password)\\s*[:=]\\s*["'][^"']{8,}/i.test(line)) findings.push({ file: p, line: i + 1, kind: "possible-secret", text: "redacted" });
      if (line.length > 200) findings.push({ file: p, line: i + 1, kind: "long-line", text: line.slice(0, 60) + "…" });
    });
  } };
  walk(String(input.folder));
  return { findings, count: findings.length };
}`,
    ["quality", "audit"],
  ),
  skill(
    "code.dependency-audit",
    "Dependency audit",
    "Read package.json and report dependency counts, ranges and risky wildcards.",
    "developer",
    ["fs.read"],
    "safe",
    ["folder"],
    `import { readFileSync } from "node:fs";
import { join } from "node:path";
export async function run(input) {
  const pkg = JSON.parse(readFileSync(join(String(input.folder), "package.json"), "utf8"));
  const all = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const wildcards = Object.entries(all).filter(([, r]) => /^(\\*|latest|>=)/.test(String(r)));
  return { name: pkg.name, total: Object.keys(all).length, dependencies: Object.keys(pkg.dependencies || {}).length, dev: Object.keys(pkg.devDependencies || {}).length, wildcards };
}`,
    ["npm", "audit"],
  ),
  skill(
    "code.scaffold",
    "Scaffold a module",
    "Create a typed source file plus a matching test file from a template.",
    "developer",
    ["fs.write"],
    "write",
    ["folder", "name"],
    `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export async function run(input) {
  const dir = String(input.folder); const name = String(input.name);
  mkdirSync(dir, { recursive: true });
  const src = join(dir, name + ".ts");
  writeFileSync(src, "export function " + name + "() {\\n  return null;\\n}\\n", "utf8");
  const test = join(dir, name + ".test.ts");
  writeFileSync(test, 'import { describe, it, expect } from "vitest";\\nimport { ' + name + ' } from "./' + name + '";\\n\\ndescribe("' + name + '", () => {\\n  it("runs", () => { expect(' + name + '()).toBeNull(); });\\n});\\n', "utf8");
  return { created: [src, test] };
}`,
    ["scaffold", "tests"],
  ),
  skill(
    "git.repo-status",
    "Git repository report",
    "Read the local git metadata: branch, last commits and remote origin.",
    "developer",
    ["fs.read"],
    "safe",
    ["folder"],
    `import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
export async function run(input) {
  const git = join(String(input.folder), ".git");
  if (!existsSync(git)) return { repo: false };
  const head = readFileSync(join(git, "HEAD"), "utf8").trim();
  const branch = head.startsWith("ref:") ? head.split("/").pop() : head.slice(0, 8);
  let origin = null;
  try { origin = (readFileSync(join(git, "config"), "utf8").match(/url\\s*=\\s*(.+)/) || [])[1] || null; } catch {}
  let commits = [];
  try { commits = readFileSync(join(git, "logs", "HEAD"), "utf8").trim().split("\\n").slice(-5).map((l) => l.split("\\t").pop()); } catch {}
  return { repo: true, branch, origin, recent: commits, refs: existsSync(join(git, "refs", "heads")) ? readdirSync(join(git, "refs", "heads")) : [] };
}`,
    ["git", "vcs"],
  ),
  skill(
    "system.disk-usage",
    "Disk usage snapshot",
    "Report free and total space plus the biggest folders under a path.",
    "system",
    ["system.read", "fs.read"],
    "safe",
    ["folder"],
    `import { statfsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
export async function run(input) {
  const root = String(input.folder || process.env.FRIDAY_ROOT || "");
  if (!root) return { error: "A folder is required (no FRIDAY folder is selected)." };
  let disk = null;
  try { const s = statfsSync(root); disk = { totalBytes: s.blocks * s.bsize, freeBytes: s.bfree * s.bsize }; } catch {}
  const folders = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => {
    let bytes = 0;
    try { for (const f of readdirSync(join(root, e.name), { withFileTypes: true })) if (f.isFile()) bytes += statSync(join(root, e.name, f.name)).size; } catch {}
    return { name: e.name, bytes };
  }).sort((a, b) => b.bytes - a.bytes).slice(0, 12);
  return { root, disk, folders };
}`,
    ["disk", "system"],
  ),
  skill(
    "system.process-report",
    "Process & load report",
    "Report platform, CPU load, memory pressure and uptime of this machine.",
    "system",
    ["system.read"],
    "safe",
    [],
    `import os from "node:os";
export async function run() {
  return { platform: os.platform(), release: os.release(), cpus: os.cpus().length, loadavg: os.loadavg(),
    memory: { totalBytes: os.totalmem(), freeBytes: os.freemem(), usedPct: Math.round((1 - os.freemem() / os.totalmem()) * 100) },
    uptimeHours: Math.round(os.uptime() / 360) / 10, user: os.userInfo().username };
}`,
    ["system", "monitor"],
  ),
  skill(
    "net.latency",
    "Network latency check",
    "Measure round-trip latency to a list of hosts and report the fastest.",
    "network",
    ["web.access"],
    "safe",
    ["urls"],
    `export async function run(input) {
  const urls = input.urls && input.urls.length ? input.urls : ["https://1.1.1.1", "https://www.google.com", "https://api.github.com"];
  const results = [];
  for (const url of urls) {
    const t = Date.now();
    try { await fetch(url, { method: "HEAD" }); results.push({ url, ms: Date.now() - t, ok: true }); }
    catch (e) { results.push({ url, ms: Date.now() - t, ok: false, error: String(e.message || e) }); }
  }
  return { results, fastest: results.filter((r) => r.ok).sort((a, b) => a.ms - b.ms)[0] || null };
}`,
    ["network", "diagnostics"],
  ),
  skill(
    "docs.markdown-outline",
    "Markdown outline",
    "Build a heading outline and reading time estimate for a markdown document.",
    "documents",
    [],
    "safe",
    ["markdown"],
    `export async function run(input) {
  const md = String(input.markdown || "");
  const headings = [...md.matchAll(/^(#{1,6})\\s+(.*)$/gm)].map((m) => ({ level: m[1].length, text: m[2].trim() }));
  const words = md.split(/\\s+/).filter(Boolean).length;
  return { headings, words, readingMinutes: Math.max(1, Math.round(words / 220)) };
}`,
    ["docs", "markdown"],
  ),
  skill(
    "docs.changelog",
    "Draft a changelog entry",
    "Turn a list of changes into a formatted Keep-a-Changelog section.",
    "documents",
    [],
    "safe",
    ["version", "changes"],
    `export async function run(input) {
  const groups = { added: [], changed: [], fixed: [], removed: [] };
  for (const change of input.changes || []) {
    const text = String(change);
    const key = /^fix/i.test(text) ? "fixed" : /^remove|^drop/i.test(text) ? "removed" : /^add|^new/i.test(text) ? "added" : "changed";
    groups[key].push(text);
  }
  const date = new Date().toISOString().slice(0, 10);
  let out = "## [" + (input.version || "unreleased") + "] - " + date + "\\n";
  for (const [key, items] of Object.entries(groups)) if (items.length) out += "\\n### " + key[0].toUpperCase() + key.slice(1) + "\\n" + items.map((i) => "- " + i).join("\\n") + "\\n";
  return { markdown: out, groups };
}`,
    ["release", "docs"],
  ),
  skill(
    "time.schedule-plan",
    "Plan a schedule",
    "Turn tasks with durations into a realistic time-blocked plan.",
    "productivity",
    [],
    "safe",
    ["tasks", "start"],
    `export async function run(input) {
  let cursor = new Date(input.start || Date.now());
  const blocks = (input.tasks || []).map((task) => {
    const minutes = Number(task.minutes) || 30;
    const from = new Date(cursor); cursor = new Date(cursor.getTime() + minutes * 60000);
    return { task: task.name || String(task), from: from.toISOString(), to: cursor.toISOString(), minutes };
  });
  return { blocks, endsAt: cursor.toISOString(), totalMinutes: blocks.reduce((n, b) => n + b.minutes, 0) };
}`,
    ["planning", "time"],
  ),
  skill(
    "memory.digest",
    "Daily digest",
    "Build a short digest from notes, tasks and highlights of the day.",
    "productivity",
    [],
    "safe",
    ["notes", "tasks"],
    `export async function run(input) {
  const notes = input.notes || []; const tasks = input.tasks || [];
  const done = tasks.filter((t) => t.done); const open = tasks.filter((t) => !t.done);
  return { headline: done.length + " done · " + open.length + " open", done: done.map((t) => t.title || t), next: open.slice(0, 5).map((t) => t.title || t),
    highlights: notes.slice(-5), generatedAt: new Date().toISOString() };
}`,
    ["memory", "summary"],
  ),
];

/* ------------------------------------------------------------------- tools */

const tool = (
  slug: string,
  segment: string,
  name: string,
  description: string,
  permissions: string[],
  risk: MarketRisk,
  tags: string[],
): MarketPack => ({
  slug,
  tree: "tools",
  segment,
  name,
  description,
  category: segment,
  version: "1.0.0",
  author: "FRIDAY Marketplace",
  permissions,
  risk,
  tags,
});

const TOOLS: MarketPack[] = [
  tool(
    "fs-archive",
    "filesystem",
    "Archive & extract",
    "Zip, unzip and inspect archives inside the workspace.",
    ["fs.read", "fs.write"],
    "write",
    ["zip", "files"],
  ),
  tool(
    "fs-sync",
    "filesystem",
    "Folder sync",
    "Mirror one folder into another with dry-run diffing.",
    ["fs.read", "fs.write"],
    "write",
    ["backup", "sync"],
  ),
  tool(
    "fs-watcher",
    "filesystem",
    "File watcher",
    "Watch paths and raise events when files change.",
    ["fs.read"],
    "safe",
    ["watch", "events"],
  ),
  tool(
    "fs-search",
    "filesystem",
    "Content search",
    "Full-text and regex search across the workspace.",
    ["fs.read"],
    "safe",
    ["search", "grep"],
  ),
  tool(
    "http-client",
    "network",
    "HTTP client",
    "Send authenticated HTTP requests with saved collections.",
    ["web.access"],
    "safe",
    ["api", "http"],
  ),
  tool(
    "port-scan",
    "network",
    "Port & service check",
    "Check local ports and report which service holds them.",
    ["system.read"],
    "safe",
    ["network", "diagnostics"],
  ),
  tool(
    "dns-lookup",
    "network",
    "DNS lookup",
    "Resolve A, AAAA, MX and TXT records for a hostname.",
    ["web.access"],
    "safe",
    ["dns", "network"],
  ),
  tool(
    "webhook-relay",
    "network",
    "Webhook relay",
    "Receive and replay webhooks into local handlers.",
    ["web.access"],
    "write",
    ["webhooks", "integration"],
  ),
  tool(
    "browser-capture",
    "browser",
    "Page capture",
    "Capture screenshots and readable text from any page.",
    ["web.access"],
    "safe",
    ["browser", "capture"],
  ),
  tool(
    "browser-forms",
    "browser",
    "Form automation",
    "Fill and submit web forms with recorded steps.",
    ["web.access"],
    "exec",
    ["automation", "browser"],
  ),
  tool(
    "browser-monitor",
    "browser",
    "Page monitor",
    "Watch a page for changes and notify when it updates.",
    ["web.access"],
    "safe",
    ["monitor", "browser"],
  ),
  tool(
    "clipboard",
    "system",
    "Clipboard manager",
    "Read, write and keep a searchable clipboard history.",
    ["system.read", "system.write"],
    "write",
    ["clipboard", "windows"],
  ),
  tool(
    "window-control",
    "system",
    "Window control",
    "Focus, move, resize and arrange desktop windows.",
    ["system.write"],
    "exec",
    ["windows", "automation"],
  ),
  tool(
    "service-control",
    "system",
    "Service control",
    "Inspect and restart Windows services safely.",
    ["system.write"],
    "exec",
    ["windows", "services"],
  ),
  tool(
    "scheduled-task",
    "automation",
    "Scheduled task",
    "Create and manage Windows scheduled tasks.",
    ["system.write"],
    "exec",
    ["scheduler", "windows"],
  ),
  tool(
    "macro-recorder",
    "automation",
    "Macro recorder",
    "Record keyboard and mouse macros and replay them.",
    ["system.write"],
    "exec",
    ["automation", "macros"],
  ),
  tool(
    "ocr-reader",
    "applications",
    "Screen OCR",
    "Read text out of screenshots and app windows.",
    ["screen.read"],
    "safe",
    ["ocr", "vision"],
  ),
  tool(
    "office-docs",
    "applications",
    "Office documents",
    "Read and write docx, xlsx and pdf documents.",
    ["fs.read", "fs.write"],
    "write",
    ["office", "documents"],
  ),
  tool(
    "db-console",
    "developer",
    "Database console",
    "Query SQLite and Postgres databases with saved queries.",
    ["fs.read", "fs.write"],
    "write",
    ["sql", "database"],
  ),
  tool(
    "test-runner",
    "developer",
    "Test runner",
    "Detect and run the project's test suite with reports.",
    ["sandbox.exec"],
    "exec",
    ["tests", "ci"],
  ),
  tool(
    "package-manager",
    "developer",
    "Package manager",
    "Install, update and audit npm, pip and winget packages.",
    ["sandbox.exec"],
    "exec",
    ["packages", "install"],
  ),
  tool(
    "log-tailer",
    "developer",
    "Log tailer",
    "Tail and filter application logs in real time.",
    ["fs.read"],
    "safe",
    ["logs", "debug"],
  ),
];

/* ------------------------------------------------------------------ agents */

const agent = (
  slug: string,
  name: string,
  description: string,
  permissions: string[],
  risk: MarketRisk,
  tags: string[],
  manifest: Record<string, unknown>,
): MarketPack => ({
  slug,
  tree: "agents",
  segment: "installed",
  name,
  description,
  category: "agent",
  version: "1.0.0",
  author: "FRIDAY Marketplace",
  permissions,
  risk,
  tags,
  manifest,
});

const AGENTS: MarketPack[] = [
  agent(
    "research-agent",
    "Research agent",
    "Searches the web, reads sources and returns a cited briefing.",
    ["web.access"],
    "safe",
    ["research", "web"],
    { role: "researcher", skills: ["web.search", "web.read", "text.summarise"] },
  ),
  agent(
    "coder-agent",
    "Coding agent",
    "Writes, refactors and reviews code in the sandbox before applying it.",
    ["fs.read", "fs.write", "sandbox.exec"],
    "exec",
    ["code", "developer"],
    { role: "coder", skills: ["code.review", "code.scaffold", "sandbox.run"] },
  ),
  agent(
    "reviewer-agent",
    "Review agent",
    "Second-opinion reviewer that checks diffs before they are applied.",
    ["fs.read"],
    "safe",
    ["review", "quality"],
    { role: "reviewer", skills: ["code.review"] },
  ),
  agent(
    "test-agent",
    "QA agent",
    "Runs test suites, triages failures and reports regressions.",
    ["sandbox.exec"],
    "exec",
    ["tests", "qa"],
    { role: "qa", skills: ["sandbox.run"] },
  ),
  agent(
    "ops-agent",
    "System ops agent",
    "Watches machine health, disk and services and repairs common faults.",
    ["system.read", "system.write"],
    "exec",
    ["system", "ops"],
    { role: "ops", skills: ["system.report", "system.disk-usage"] },
  ),
  agent(
    "security-agent",
    "Security agent",
    "Scans for exposed secrets, risky permissions and unsafe packages.",
    ["fs.read"],
    "safe",
    ["security", "audit"],
    { role: "security", skills: ["code.review", "code.dependency-audit"] },
  ),
  agent(
    "data-agent",
    "Data agent",
    "Cleans, joins and summarises datasets and produces charts.",
    ["fs.read", "fs.write"],
    "write",
    ["data", "analysis"],
    { role: "analyst", skills: ["csv.parse", "data.stats"] },
  ),
  agent(
    "writer-agent",
    "Writing agent",
    "Drafts documentation, changelogs and release notes.",
    ["fs.write"],
    "write",
    ["writing", "docs"],
    { role: "writer", skills: ["docs.markdown-outline", "docs.changelog"] },
  ),
  agent(
    "planner-agent",
    "Planner agent",
    "Breaks goals into ordered, verifiable steps with owners.",
    [],
    "safe",
    ["planning", "brain"],
    { role: "planner", skills: ["time.schedule-plan"] },
  ),
  agent(
    "inbox-agent",
    "Inbox agent",
    "Triages notifications and surfaces only what needs a decision.",
    [],
    "safe",
    ["productivity"],
    { role: "triage", skills: ["memory.digest"] },
  ),
  agent(
    "monitor-agent",
    "Monitor agent",
    "Keeps watch on URLs, feeds and folders and reports changes.",
    ["web.access", "fs.read"],
    "safe",
    ["monitor"],
    { role: "monitor", skills: ["web.rss", "net.latency"] },
  ),
  agent(
    "desktop-agent",
    "Desktop agent",
    "Controls windows, apps and files on Windows on request.",
    ["system.write"],
    "exec",
    ["windows", "automation"],
    { role: "desktop", skills: ["file.organise"] },
  ),
  agent(
    "finance-agent",
    "Finance agent",
    "Tracks spend, parses statements and builds monthly summaries.",
    ["fs.read"],
    "safe",
    ["finance"],
    { role: "finance", skills: ["csv.parse", "data.stats"] },
  ),
  agent(
    "learning-agent",
    "Learning agent",
    "Studies FRIDAY's own logs and proposes concrete improvements.",
    ["fs.read"],
    "safe",
    ["self", "learning"],
    { role: "learner", skills: ["text.keywords", "memory.digest"] },
  ),
  agent(
    "market-data-agent",
    "Market data agent",
    "Fetches and normalizes quote data for watched symbols through existing web/http/data skills. Read/analysis only — no broker login or order placement.",
    ["web.access"],
    "safe",
    ["trading", "markets"],
    {
      role: "market-data",
      skills: ["web.api-probe", "web.readable", "csv.parse", "json.transform"],
    },
  ),
  agent(
    "technical-analysis-agent",
    "Technical analysis agent",
    "Computes indicators and trend signals from fetched price data. Analysis only — does not place trades.",
    ["fs.read"],
    "safe",
    ["trading", "analysis"],
    { role: "technical-analysis", skills: ["data.stats", "csv.parse", "json.transform"] },
  ),
  agent(
    "portfolio-risk-agent",
    "Portfolio risk agent",
    "Tracks position sizing, exposure and drawdown limits and flags breaches. Never places trades itself.",
    ["fs.read"],
    "write",
    ["trading", "risk"],
    { role: "portfolio-risk", skills: ["data.stats", "csv.parse", "money.split"] },
  ),
  agent(
    "trade-signal-agent",
    "Trade signal agent",
    "Combines market-data and technical-analysis output into a plain-English signal with confidence and rationale. Output only — no execution.",
    ["fs.read"],
    "safe",
    ["trading", "signals"],
    { role: "trade-signal", skills: ["data.stats", "text.summarise"] },
  ),
  agent(
    "tender-discovery-agent",
    "Tender discovery agent",
    "Searches an owner-configured list of government/e-procurement portals (GeM, CPPP, state portals — not hardcoded to one site) for tenders matching saved trade, category and location filters.",
    ["web.access"],
    "safe",
    ["construction", "tenders"],
    { role: "tender-discovery", skills: ["web.readable", "web.extract-links", "web.api-probe"] },
  ),
  agent(
    "tender-analysis-agent",
    "Tender analysis agent",
    "Extracts scope, eligibility, BOQ items, deadlines and compliance requirements from a tender document using the existing tender reader.",
    ["fs.read"],
    "safe",
    ["construction", "tenders"],
    {
      role: "tender-analysis",
      skills: ["tender.read", "docs.extract", "csv.parse", "text.summarise"],
    },
  ),
  agent(
    "bid-planning-agent",
    "Bid planning agent",
    "Turns an analyzed tender into an ordered task list with owners and deadlines. Reuses the planner-agent skill rather than a second planner.",
    [],
    "safe",
    ["construction", "tenders", "planning"],
    { role: "bid-planner", skills: ["time.schedule-plan", "plan.breakdown"] },
  ),
  agent(
    "go-no-go-agent",
    "Go / no-go agent",
    "Scores a tender's fit (eligibility, win-probability and expected value) and recommends bid or skip with the reasoning shown.",
    ["fs.read"],
    "safe",
    ["construction", "tenders"],
    { role: "go-no-go", skills: ["data.stats", "text.summarise"] },
  ),
  agent(
    "compliance-checklist-agent",
    "Compliance checklist agent",
    "Builds and tracks the submission checklist against the tender's stated requirements.",
    ["fs.read", "fs.write"],
    "write",
    ["construction", "tenders"],
    { role: "compliance-checklist", skills: ["text.action-items", "plan.breakdown"] },
  ),
  agent(
    "recon-agent",
    "Recon agent",
    "Read-only attack-surface discovery (DNS, open ports, exposed endpoints) for a target the owner explicitly names as theirs. Only runs against owner-authorized targets.",
    ["web.access", "sandbox.exec"],
    "exec",
    ["security"],
    { role: "recon", skills: ["dns-lookup", "port-scan", "web.api-probe", "net.latency"] },
  ),
  agent(
    "vulnerability-scan-agent",
    "Vulnerability scan agent",
    "Runs signature and known-CVE checks against a named target or codebase and reports findings. Never auto-exploits. Only runs against owner-authorized targets.",
    ["fs.read", "sandbox.exec"],
    "exec",
    ["security"],
    {
      role: "vulnerability-scan",
      skills: ["code.dependency-audit", "code.review", "web.api-probe"],
    },
  ),
  agent(
    "pentest-report-agent",
    "Pentest report agent",
    "Turns raw findings into a scored (CVSS-style), prioritized report with remediation guidance. Only runs against owner-authorized targets.",
    ["fs.read"],
    "write",
    ["security"],
    { role: "pentest-report", skills: ["docs.markdown-outline", "text.summarise", "code.review"] },
  ),
  agent(
    "site-uptime-agent",
    "Site uptime agent",
    "Checks owner-configured URLs for uptime and TLS expiry using the same watch skills as the monitor agent. Only runs against owner-authorized targets.",
    ["web.access"],
    "safe",
    ["security", "monitor"],
    { role: "site-uptime", skills: ["net.latency", "web.readable"] },
  ),
  agent(
    "website-watch-agent",
    "Website watch agent",
    "Watches owner-configured URLs for uptime, TLS expiry and unexpected content changes. Reuses the monitor-agent watch skills — not a second polling engine. Only runs against owner-authorized targets.",
    ["web.access", "fs.read"],
    "safe",
    ["security", "monitor"],
    { role: "website-watch", skills: ["web.rss", "net.latency", "web.readable", "text.diff"] },
  ),
  agent(
    "osint-agent",
    "OSINT agent",
    "Gathers public information on a named topic or entity from the existing web-search and readable-page skills only.",
    ["web.access"],
    "safe",
    ["research"],
    { role: "osint", skills: ["web.search", "web.read", "web.readable", "text.summarise"] },
  ),
  agent(
    "fact-check-agent",
    "Fact-check agent",
    "Cross-checks a claim against multiple fetched sources and reports agreement or disagreement.",
    ["web.access"],
    "safe",
    ["research"],
    { role: "fact-check", skills: ["web.readable", "text.diff", "text.summarise"] },
  ),
  agent(
    "competitor-watch-agent",
    "Competitor watch agent",
    "Tracks named competitors' public pages and pricing for changes using the same watch skills as website-watch-agent.",
    ["web.access"],
    "safe",
    ["research"],
    { role: "competitor-watch", skills: ["web.rss", "net.latency", "web.readable", "text.diff"] },
  ),
];

/* ----------------------------------------------------------------- modules */

const modulePack = (
  slug: string,
  segment: string,
  name: string,
  description: string,
  permissions: string[],
  risk: MarketRisk,
  tags: string[],
): MarketPack => ({
  slug,
  tree: "modules",
  segment,
  name,
  description,
  category: segment,
  version: "1.0.0",
  author: "FRIDAY Marketplace",
  permissions,
  risk,
  tags,
});

const MODULES: MarketPack[] = [
  modulePack(
    "rag-index",
    "ai",
    "RAG index",
    "Local embedding index over your documents for grounded answers.",
    ["fs.read", "fs.write"],
    "write",
    ["rag", "memory"],
  ),
  modulePack(
    "vision-captioner",
    "ai",
    "Vision captioner",
    "Describe images and screenshots with a local vision model.",
    ["fs.read"],
    "safe",
    ["vision", "ai"],
  ),
  modulePack(
    "speech-notes",
    "ai",
    "Speech notes",
    "Transcribe recordings into searchable notes.",
    ["fs.read", "fs.write"],
    "write",
    ["speech", "notes"],
  ),
  modulePack(
    "prompt-library",
    "ai",
    "Prompt library",
    "Reusable prompt templates with variables and versions.",
    ["fs.read", "fs.write"],
    "write",
    ["prompts"],
  ),
  modulePack(
    "startup-manager",
    "system",
    "Startup manager",
    "Review and control what launches with Windows.",
    ["system.read", "system.write"],
    "exec",
    ["windows", "boot"],
  ),
  modulePack(
    "power-profiles",
    "system",
    "Power profiles",
    "Switch power plans automatically by workload.",
    ["system.write"],
    "exec",
    ["power", "windows"],
  ),
  modulePack(
    "backup-vault",
    "system",
    "Backup vault",
    "Versioned backups of the workspace with restore points.",
    ["fs.read", "fs.write"],
    "write",
    ["backup"],
  ),
  modulePack(
    "hotkeys",
    "automation",
    "Global hotkeys",
    "Bind global Windows hotkeys to FRIDAY actions.",
    ["system.write"],
    "exec",
    ["hotkeys", "automation"],
  ),
  modulePack(
    "routine-engine",
    "automation",
    "Routines",
    "Time and event based routines that chain skills together.",
    [],
    "write",
    ["routines", "automation"],
  ),
  modulePack(
    "mail-bridge",
    "communication",
    "Mail bridge",
    "Read and send mail through IMAP/SMTP accounts you configure.",
    ["web.access"],
    "write",
    ["email"],
  ),
  modulePack(
    "calendar-sync",
    "communication",
    "Calendar sync",
    "Two-way sync with CalDAV and ICS calendars.",
    ["web.access"],
    "write",
    ["calendar"],
  ),
  modulePack(
    "chat-bridge",
    "communication",
    "Chat bridge",
    "Relay messages to Telegram, Slack or Discord webhooks.",
    ["web.access"],
    "write",
    ["chat", "notify"],
  ),
  modulePack(
    "git-ops",
    "developer",
    "Git operations",
    "Branch, commit, diff and push with guarded approvals.",
    ["fs.write", "sandbox.exec"],
    "exec",
    ["git"],
  ),
  modulePack(
    "ci-watch",
    "developer",
    "CI watcher",
    "Track pipeline runs and surface failures as tasks.",
    ["web.access"],
    "safe",
    ["ci", "devops"],
  ),
  modulePack(
    "api-mock",
    "developer",
    "API mock server",
    "Serve mock endpoints from a spec while you build.",
    ["web.access"],
    "write",
    ["api", "testing"],
  ),
  modulePack(
    "theme-packs",
    "ui",
    "Theme packs",
    "Extra HUD themes and accent palettes for the console.",
    [],
    "safe",
    ["ui", "theme"],
  ),
  modulePack(
    "dashboard-widgets",
    "ui",
    "Dashboard widgets",
    "Extra widgets for the main stage: charts, feeds and timers.",
    [],
    "safe",
    ["ui", "widgets"],
  ),
];

/* ----------------------------------------------------------------- plugins */

const plugin = (
  slug: string,
  name: string,
  description: string,
  permissions: string[],
  risk: MarketRisk,
  tags: string[],
  body: string,
): MarketPack => ({
  slug,
  tree: "plugins",
  segment: "installed",
  name,
  description,
  category: "plugin",
  version: "1.0.0",
  author: "FRIDAY Marketplace",
  permissions,
  risk,
  tags,
  manifest: { entry: "index.cjs", hooks: ["register"] },
  code: body,
});

const PLUGINS: MarketPack[] = [
  plugin(
    "uuid-kit",
    "UUID & ID kit",
    "Generate UUIDs, nanoids and ULIDs as a callable tool.",
    [],
    "safe",
    ["ids", "developer"],
    `const { randomUUID, randomBytes } = require("node:crypto");
module.exports.register = (ctx) => {
  ctx.registerTool?.("id.generate", ({ kind = "uuid", count = 1 } = {}) => ({
    ok: true,
    ids: Array.from({ length: Math.min(Number(count) || 1, 100) }, () =>
      kind === "hex" ? randomBytes(16).toString("hex") : randomUUID()),
  }));
  ctx.log("uuid-kit ready");
};`,
  ),
  plugin(
    "hash-kit",
    "Hash & encode kit",
    "sha256/md5 hashing plus base64 and hex encoding tools.",
    [],
    "safe",
    ["crypto", "developer"],
    `const { createHash } = require("node:crypto");
module.exports.register = (ctx) => {
  ctx.registerTool?.("hash.text", ({ text = "", algorithm = "sha256" } = {}) => ({
    ok: true, algorithm, digest: createHash(algorithm).update(String(text)).digest("hex"),
  }));
  ctx.registerTool?.("encode.base64", ({ text = "", decode = false } = {}) => ({
    ok: true, value: decode ? Buffer.from(String(text), "base64").toString("utf8") : Buffer.from(String(text)).toString("base64"),
  }));
};`,
  ),
  plugin(
    "json-tools",
    "JSON toolkit",
    "Validate, pretty-print, diff and query JSON documents.",
    [],
    "safe",
    ["json", "developer"],
    `module.exports.register = (ctx) => {
  ctx.registerTool?.("json.format", ({ text = "", indent = 2 } = {}) => {
    try { return { ok: true, value: JSON.stringify(JSON.parse(String(text)), null, Number(indent)) }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  ctx.registerTool?.("json.query", ({ data, path = "" } = {}) => ({
    ok: true, value: String(path).split(".").filter(Boolean).reduce((a, k) => (a == null ? a : a[k]), data),
  }));
};`,
  ),
  plugin(
    "text-tools",
    "Text toolkit",
    "Case conversion, slugify, diff and word counting tools.",
    [],
    "safe",
    ["text"],
    `module.exports.register = (ctx) => {
  ctx.registerTool?.("text.slug", ({ text = "" } = {}) => ({
    ok: true, value: String(text).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
  }));
  ctx.registerTool?.("text.count", ({ text = "" } = {}) => {
    const words = String(text).split(/\\s+/).filter(Boolean);
    return { ok: true, words: words.length, characters: String(text).length, lines: String(text).split("\\n").length };
  });
};`,
  ),
  plugin(
    "time-tools",
    "Time & timezone kit",
    "Convert timestamps, compute durations and format dates for any timezone.",
    [],
    "safe",
    ["time"],
    `module.exports.register = (ctx) => {
  ctx.registerTool?.("time.convert", ({ value = Date.now(), timeZone = "Asia/Kolkata" } = {}) => ({
    ok: true, iso: new Date(value).toISOString(),
    local: new Intl.DateTimeFormat("en-IN", { timeZone, dateStyle: "full", timeStyle: "long" }).format(new Date(value)),
  }));
  ctx.registerTool?.("time.between", ({ from, to = Date.now() } = {}) => {
    const ms = new Date(to).getTime() - new Date(from).getTime();
    return { ok: true, ms, minutes: Math.round(ms / 60000), days: Math.round(ms / 86400000) };
  });
};`,
  ),
  plugin(
    "math-kit",
    "Math & units",
    "Safe expression evaluation and unit conversions.",
    [],
    "safe",
    ["math", "units"],
    `const UNITS = { km: 1000, m: 1, cm: 0.01, mi: 1609.34, ft: 0.3048 };
module.exports.register = (ctx) => {
  ctx.registerTool?.("math.eval", ({ expression = "" } = {}) => {
    if (!/^[-+*/(). 0-9%]+$/.test(String(expression))) return { ok: false, error: "unsupported expression" };
    try { return { ok: true, value: Function("return (" + expression + ")")() }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  ctx.registerTool?.("units.length", ({ value = 0, from = "m", to = "km" } = {}) => ({
    ok: true, value: (Number(value) * (UNITS[from] || 1)) / (UNITS[to] || 1),
  }));
};`,
  ),
  plugin(
    "qr-kit",
    "QR & barcode payloads",
    "Build QR payload strings for wifi, contacts, URLs and UPI.",
    [],
    "safe",
    ["qr", "utility"],
    `module.exports.register = (ctx) => {
  ctx.registerTool?.("qr.payload", ({ kind = "url", data = {} } = {}) => {
    if (kind === "wifi") return { ok: true, payload: "WIFI:T:" + (data.security || "WPA") + ";S:" + data.ssid + ";P:" + data.password + ";;" };
    if (kind === "upi") return { ok: true, payload: "upi://pay?pa=" + data.vpa + "&pn=" + encodeURIComponent(data.name || "") + "&am=" + (data.amount || "") };
    return { ok: true, payload: String(data.url || data) };
  });
};`,
  ),
  plugin(
    "notify-webhook",
    "Webhook notifier",
    "Send FRIDAY notifications to any webhook (Slack, Discord, Telegram).",
    ["web.access"],
    "write",
    ["notify", "integration"],
    `module.exports.register = (ctx) => {
  ctx.registerTool?.("notify.webhook", async ({ url, text = "" } = {}) => {
    if (!url) return { ok: false, error: "url required" };
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, content: text }) });
    return { ok: res.ok, status: res.status };
  });
};`,
  ),
  plugin(
    "csv-report",
    "CSV report writer",
    "Write query results and tables to CSV files in the workspace.",
    ["fs.write"],
    "write",
    ["csv", "reports"],
    `const { writeFileSync, mkdirSync } = require("node:fs");
const path = require("node:path");
module.exports.register = (ctx) => {
  ctx.registerTool?.("csv.write", ({ rows = [], file = "report.csv" } = {}) => {
    if (!rows.length) return { ok: false, error: "no rows" };
    const header = Object.keys(rows[0]);
    const body = [header.join(","), ...rows.map((r) => header.map((h) => JSON.stringify(r[h] ?? "")).join(","))].join("\\n");
    const target = path.join(ctx.paths.data, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, body, "utf8");
    return { ok: true, file: target, rows: rows.length };
  });
};`,
  ),
  plugin(
    "env-doctor",
    "Environment doctor",
    "Report Node, platform and environment details for troubleshooting.",
    ["system.read"],
    "safe",
    ["diagnostics"],
    `const os = require("node:os");
module.exports.register = (ctx) => {
  ctx.registerTool?.("env.report", () => ({
    ok: true, node: process.version, platform: process.platform, arch: process.arch,
    cpus: os.cpus().length, memoryGb: Math.round(os.totalmem() / 1e9), workspace: ctx.paths.workspace,
  }));
};`,
  ),
  plugin(
    "password-kit",
    "Password & passphrase kit",
    "Generate strong passwords and passphrases with entropy scoring.",
    [],
    "safe",
    ["security"],
    `const { randomInt } = require("node:crypto");
const SETS = { lower: "abcdefghijkmnpqrstuvwxyz", upper: "ABCDEFGHJKLMNPQRSTUVWXYZ", digits: "23456789", symbols: "!@#$%^&*-_=+" };
module.exports.register = (ctx) => {
  ctx.registerTool?.("password.generate", ({ length = 20, symbols = true } = {}) => {
    const pool = SETS.lower + SETS.upper + SETS.digits + (symbols ? SETS.symbols : "");
    const value = Array.from({ length: Math.max(8, Math.min(Number(length) || 20, 128)) }, () => pool[randomInt(pool.length)]).join("");
    return { ok: true, value, entropyBits: Math.round(value.length * Math.log2(pool.length)) };
  });
};`,
  ),
  plugin(
    "color-kit",
    "Colour kit",
    "Convert between hex, rgb and hsl and build accessible palettes.",
    [],
    "safe",
    ["design", "ui"],
    `const hexToRgb = (hex) => { const h = hex.replace("#", ""); return { r: parseInt(h.slice(0,2),16), g: parseInt(h.slice(2,4),16), b: parseInt(h.slice(4,6),16) }; };
module.exports.register = (ctx) => {
  ctx.registerTool?.("color.convert", ({ hex = "#3b82f6" } = {}) => {
    const { r, g, b } = hexToRgb(hex);
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return { ok: true, rgb: [r, g, b], luminance: Number(lum.toFixed(3)), onLight: lum < 0.55 };
  });
};`,
  ),
];

/* --------------------------------------------------------------- workflows */

const workflow = (
  slug: string,
  segment: string,
  name: string,
  description: string,
  steps: string[],
  trigger: string,
  tags: string[],
  risk: MarketRisk = "write",
): MarketPack => ({
  slug,
  tree: "workflows",
  segment,
  name,
  description,
  category: segment,
  version: "1.0.0",
  author: "FRIDAY Marketplace",
  permissions: [],
  risk,
  tags,
  manifest: { steps, trigger },
});

const WORKFLOWS: MarketPack[] = [
  workflow(
    "morning-briefing",
    "templates",
    "Morning briefing",
    "Digest of calendar, feeds, tasks and system health, spoken at start of day.",
    ["memory.digest", "web.rss", "system.report"],
    "daily 08:00",
    ["daily", "voice"],
    "safe",
  ),
  workflow(
    "workspace-cleanup",
    "templates",
    "Workspace cleanup",
    "Organise loose files, find duplicates and archive old downloads.",
    ["file.organise", "files.find-duplicates"],
    "weekly",
    ["cleanup"],
  ),
  workflow(
    "nightly-backup",
    "schedules",
    "Nightly backup",
    "Version the workspace, prune old snapshots and verify restore points.",
    ["backup.snapshot", "backup.verify"],
    "daily 23:30",
    ["backup"],
  ),
  workflow(
    "repo-health",
    "templates",
    "Repository health",
    "Audit dependencies, run the test suite and summarise failures.",
    ["code.dependency-audit", "test.run", "text.summarise"],
    "on demand",
    ["developer", "ci"],
    "exec",
  ),
  workflow(
    "release-notes",
    "templates",
    "Release notes",
    "Collect commits since the last tag and draft a changelog entry.",
    ["git.repo-status", "docs.changelog"],
    "on release",
    ["release", "docs"],
    "safe",
  ),
  workflow(
    "site-watch",
    "active",
    "Website watch",
    "Poll pages, diff their readable text and alert on real changes.",
    ["web.readable", "notify.webhook"],
    "hourly",
    ["monitor"],
    "safe",
  ),
  workflow(
    "inbox-triage",
    "templates",
    "Inbox triage",
    "Classify new messages, draft replies and queue what needs a decision.",
    ["text.keywords", "text.summarise"],
    "every 30m",
    ["productivity"],
    "safe",
  ),
  workflow(
    "self-health",
    "schedules",
    "Self health check",
    "Run diagnostics, repair what is safe and log everything else.",
    ["system.report", "doctor.run"],
    "every 6h",
    ["self", "system"],
    "exec",
  ),
  workflow(
    "model-warmup",
    "schedules",
    "Model warm-up",
    "Pre-load the preferred local model before the working day.",
    ["models.load"],
    "daily 09:00",
    ["models"],
    "safe",
  ),
  workflow(
    "research-brief",
    "templates",
    "Research brief",
    "Search, read the top sources and produce a cited summary.",
    ["web.search", "web.readable", "text.summarise"],
    "on demand",
    ["research"],
    "safe",
  ),
  workflow(
    "data-refresh",
    "templates",
    "Data refresh",
    "Pull a CSV feed, validate it and refresh the local dataset.",
    ["web.download", "csv.parse", "data.stats"],
    "daily 02:00",
    ["data"],
  ),
  workflow(
    "security-sweep",
    "schedules",
    "Security sweep",
    "Scan the workspace for exposed secrets and risky permissions.",
    ["code.review"],
    "weekly",
    ["security"],
    "safe",
  ),
  workflow(
    "focus-block",
    "saved",
    "Focus block",
    "Silence notifications, start a timer and log what got done.",
    ["time.schedule-plan", "memory.digest"],
    "on demand",
    ["productivity"],
    "safe",
  ),
  workflow(
    "build-and-verify",
    "templates",
    "Build & verify",
    "Build the app, run verification and report the artefact.",
    ["build.run", "test.run"],
    "on demand",
    ["build", "release"],
    "exec",
  ),
];

/* ------------------------------------------------------- extended catalog */
// Second wave of packs. Kept in their own arrays so the original sets stay
// untouched; they merge into the one canonical catalog below.

const EXTRA_SKILLS: MarketPack[] = [
  skill(
    "text.rewrite",
    "Rewrite in a tone",
    "Rewrite text in a chosen tone: crisp, friendly, formal or Hinglish-neutral.",
    "language",
    [],
    "safe",
    ["text", "tone"],
    `const RULES = {
  crisp: (s) => s.replace(/\\b(very|really|actually|just|basically)\\s+/gi, ""),
  formal: (s) => s.replace(/\\bcan't\\b/gi, "cannot").replace(/\\bwon't\\b/gi, "will not").replace(/\\bdon't\\b/gi, "do not"),
  friendly: (s) => s.replace(/\\.\\s*$/, " 🙂"),
};
export async function run(input) {
  const tone = String(input.tone || "crisp");
  const fn = RULES[tone] || RULES.crisp;
  const text = String(input.text || "");
  return { tone, text: fn(text).replace(/\\s{2,}/g, " ").trim() };
}`,
    ["writing"],
  ),
  skill(
    "text.action-items",
    "Extract action items",
    "Pull tasks, owners and due dates out of notes or a meeting transcript.",
    "language",
    [],
    "safe",
    ["text"],
    `const DUE = /\\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?)\\b/i;
export async function run(input) {
  const lines = String(input.text || "").split(/\\n|(?<=[.!?])\\s+/);
  const items = [];
  for (const line of lines) {
    if (!/\\b(todo|action|will|should|need to|must|follow up|assign)\\b/i.test(line)) continue;
    const owner = (line.match(/@([a-z0-9._-]+)/i) || [])[1] || null;
    const due = (line.match(DUE) || [])[0] || null;
    items.push({ task: line.trim(), owner, due });
  }
  return { items, count: items.length };
}`,
    ["meetings", "tasks"],
  ),
  skill(
    "data.dedupe",
    "Deduplicate records",
    "Remove duplicate rows from a dataset by one or more key fields.",
    "data",
    [],
    "safe",
    ["rows", "keys"],
    `export async function run(input) {
  const rows = Array.isArray(input.rows) ? input.rows : [];
  const keys = Array.isArray(input.keys) && input.keys.length ? input.keys : null;
  const seen = new Set(); const out = [];
  for (const row of rows) {
    const id = keys ? keys.map((k) => String(row?.[k] ?? "")).join("|") : JSON.stringify(row);
    if (seen.has(id)) continue;
    seen.add(id); out.push(row);
  }
  return { rows: out, removed: rows.length - out.length };
}`,
    ["data", "cleanup"],
  ),
  skill(
    "text.diff",
    "Compare two texts",
    "Line-level diff between two versions of a document with a change summary.",
    "language",
    [],
    "safe",
    ["before", "after"],
    `export async function run(input) {
  const a = String(input.before || "").split("\\n");
  const b = String(input.after || "").split("\\n");
  const setA = new Set(a); const setB = new Set(b);
  const added = b.filter((l) => !setA.has(l));
  const removed = a.filter((l) => !setB.has(l));
  return { added, removed, changed: added.length + removed.length, sameLines: a.length - removed.length };
}`,
    ["diff", "docs"],
  ),
  skill(
    "plan.breakdown",
    "Break a goal into steps",
    "Turn a goal into ordered, checkable steps with rough effort estimates.",
    "planning",
    [],
    "safe",
    ["goal", "steps"],
    `export async function run(input) {
  const goal = String(input.goal || "").trim();
  const want = Math.max(3, Math.min(Number(input.steps) || 6, 20));
  const verbs = ["Clarify", "Research", "Draft", "Build", "Verify", "Review", "Ship", "Monitor"];
  const steps = Array.from({ length: want }, (_, i) => ({
    order: i + 1,
    step: verbs[i % verbs.length] + ": " + goal,
    effort: i < 2 ? "S" : i < want - 2 ? "M" : "S",
  }));
  return { goal, steps };
}`,
    ["planning", "self"],
  ),
  skill(
    "money.split",
    "Split expenses",
    "Split an amount across people, with weights and rounded settlement.",
    "utility",
    [],
    "safe",
    ["amount", "people"],
    `export async function run(input) {
  const amount = Number(input.amount) || 0;
  const people = Array.isArray(input.people) ? input.people : [];
  if (!people.length) return { error: "people required" };
  const share = Math.round((amount / people.length) * 100) / 100;
  return { amount, share, settlement: people.map((p) => ({ person: String(p), owes: share })) };
}`,
    ["finance"],
  ),
];

const EXTRA_TOOLS: MarketPack[] = [
  tool(
    "pdf-extract",
    "developer",
    "PDF text extractor",
    "Pull text and page structure out of local PDF documents.",
    ["fs.read"],
    "safe",
    ["pdf", "documents"],
  ),
  tool(
    "image-resize",
    "automation",
    "Image resizer",
    "Batch resize, crop and convert images in a folder.",
    ["fs.read", "fs.write"],
    "write",
    ["images", "batch"],
  ),
  tool(
    "audio-transcribe",
    "system",
    "Audio transcriber",
    "Transcribe local audio files with the on-device speech engine.",
    ["fs.read", "fs.write"],
    "write",
    ["speech", "notes"],
  ),
  tool(
    "calendar-ics",
    "automation",
    "Calendar (ICS)",
    "Read and write .ics calendar files and list upcoming events.",
    ["fs.read", "fs.write"],
    "write",
    ["calendar", "productivity"],
  ),
  tool(
    "email-draft",
    "network",
    "Email drafter",
    "Compose and store email drafts as .eml files ready to send.",
    ["fs.write"],
    "write",
    ["email", "productivity"],
  ),
  tool(
    "ssh-console",
    "network",
    "SSH console",
    "Run approved commands on a remote host over SSH.",
    ["net.access", "system.write"],
    "exec",
    ["remote", "devops"],
  ),
  tool(
    "printer-control",
    "system",
    "Printer control",
    "List printers, queue documents and report job status on Windows.",
    ["system.write"],
    "write",
    ["windows", "printing"],
  ),
  tool(
    "screenshot-capture",
    "system",
    "Screenshot capture",
    "Capture the screen or one window and save it to the workspace.",
    ["system.read", "fs.write"],
    "write",
    ["screen", "vision"],
  ),
];

const EXTRA_AGENTS: MarketPack[] = [
  agent(
    "memory-curator",
    "Memory curator",
    "Prunes, merges and promotes FRIDAY's memories so recall stays sharp.",
    ["fs.read", "fs.write"],
    "write",
    ["self", "memory"],
    { role: "memory", skills: ["memory.digest", "text.keywords"] },
  ),
  agent(
    "scheduler-agent",
    "Scheduler agent",
    "Owns FRIDAY's schedule: reminders, recurring jobs and time blocks.",
    ["fs.read", "fs.write"],
    "write",
    ["time", "productivity"],
    { role: "scheduler", skills: ["time.schedule-plan", "plan.breakdown"] },
  ),
  agent(
    "translator-agent",
    "Translator agent",
    "Translates between Hindi, Hinglish and English keeping tone intact.",
    [],
    "safe",
    ["language", "hindi"],
    { role: "translator", skills: ["text.translate-prep", "text.rewrite"] },
  ),
  agent(
    "support-agent",
    "Support agent",
    "Answers questions from your own documents with citations.",
    ["fs.read"],
    "safe",
    ["rag", "docs"],
    { role: "support", skills: ["web.readable", "text.summarise"] },
  ),
  agent(
    "cleanup-agent",
    "Cleanup agent",
    "Keeps downloads, temp folders and duplicates under control.",
    ["fs.read", "fs.write"],
    "write",
    ["files", "maintenance"],
    { role: "cleanup", skills: ["files.find-duplicates", "files.tree"] },
  ),
  agent(
    "desk-agent",
    "Personal desk agent",
    "Tracks tasks, reminders and notes through FRIDAY memory and the persisted desk.",
    ["fs.read", "fs.write"],
    "write",
    ["productivity", "tasks"],
    { role: "desk", skills: ["desk.tasks", "desk.notes", "desk.summary"] },
  ),
  agent(
    "hisab-agent",
    "Hisab kitab agent",
    "Imports real statements, categorises them and reports stored profit and loss.",
    ["fs.read"],
    "safe",
    ["finance", "bookkeeping"],
    { role: "bookkeeping", skills: ["hisab.import", "hisab.report", "docs.extract"] },
  ),
  agent(
    "tender-agent",
    "Tender reader agent",
    "Quotes stated tender/RFP clauses and flags gaps instead of guessing.",
    ["fs.read"],
    "safe",
    ["tender", "rfp"],
    { role: "tender", skills: ["tender.read", "docs.extract"] },
  ),
];

const EXTRA_MODULES: MarketPack[] = [
  modulePack(
    "voice-profiles",
    "ai",
    "Voice profiles",
    "Saved voice personalities with language, pitch and speed presets.",
    ["fs.read", "fs.write"],
    "write",
    ["voice", "tts"],
  ),
  modulePack(
    "knowledge-sync",
    "ai",
    "Knowledge sync",
    "Keeps the knowledge base in step with the docs folder automatically.",
    ["fs.read", "fs.write"],
    "write",
    ["knowledge", "rag"],
  ),
  modulePack(
    "clipboard-history",
    "system",
    "Clipboard history",
    "Searchable history of what you copied, kept locally.",
    ["system.read", "fs.write"],
    "write",
    ["clipboard", "windows"],
  ),
  modulePack(
    "focus-mode",
    "ui",
    "Focus mode",
    "Silences notifications and dims non-essential panels while you work.",
    [],
    "safe",
    ["ui", "productivity"],
  ),
  modulePack(
    "usage-analytics",
    "system",
    "Usage analytics",
    "Local-only insight into which skills, models and agents you actually use.",
    ["fs.read", "fs.write"],
    "write",
    ["analytics", "self"],
  ),
];

const EXTRA_PLUGINS: MarketPack[] = [
  plugin(
    "markdown-kit",
    "Markdown kit",
    "Convert markdown to plain text or HTML and build tables of contents.",
    [],
    "safe",
    ["markdown", "docs"],
    `module.exports.register = (ctx) => {
  ctx.registerTool?.("markdown.toc", ({ text = "" } = {}) => ({
    ok: true,
    headings: String(text).split("\\n").filter((l) => /^#{1,6}\\s/.test(l))
      .map((l) => ({ level: l.match(/^#+/)[0].length, title: l.replace(/^#+\\s*/, "") })),
  }));
  ctx.registerTool?.("markdown.strip", ({ text = "" } = {}) => ({
    ok: true, value: String(text).replace(/[*_\`>#-]/g, "").replace(/\\[(.*?)\\]\\(.*?\\)/g, "$1").trim(),
  }));
};`,
  ),
  plugin(
    "currency-kit",
    "Currency & numbers",
    "Format currency, percentages and Indian-style number groupings.",
    [],
    "safe",
    ["finance", "format"],
    `module.exports.register = (ctx) => {
  ctx.registerTool?.("currency.format", ({ value = 0, currency = "INR", locale = "en-IN" } = {}) => ({
    ok: true, value: new Intl.NumberFormat(locale, { style: "currency", currency }).format(Number(value) || 0),
  }));
  ctx.registerTool?.("number.compact", ({ value = 0, locale = "en-IN" } = {}) => ({
    ok: true, value: new Intl.NumberFormat(locale, { notation: "compact" }).format(Number(value) || 0),
  }));
};`,
  ),
  plugin(
    "regex-kit",
    "Regex workbench",
    "Test patterns, extract matches and explain capture groups safely.",
    [],
    "safe",
    ["developer", "text"],
    `module.exports.register = (ctx) => {
  ctx.registerTool?.("regex.match", ({ pattern = "", flags = "g", text = "" } = {}) => {
    try {
      const re = new RegExp(String(pattern), String(flags).replace(/[^gimsuy]/g, ""));
      const matches = [...String(text).matchAll(re.flags.includes("g") ? re : new RegExp(re, re.flags + "g"))]
        .slice(0, 500).map((m) => ({ match: m[0], index: m.index, groups: m.slice(1) }));
      return { ok: true, matches, count: matches.length };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
};`,
  ),
  plugin(
    "encoding-kit",
    "Encoding kit",
    "Base64, URL, hex and JWT payload decoding as callable tools.",
    [],
    "safe",
    ["developer", "encoding"],
    `module.exports.register = (ctx) => {
  ctx.registerTool?.("encode.base64", ({ text = "", mode = "encode" } = {}) => ({
    ok: true,
    value: mode === "decode"
      ? Buffer.from(String(text), "base64").toString("utf8")
      : Buffer.from(String(text), "utf8").toString("base64"),
  }));
  ctx.registerTool?.("encode.jwt-payload", ({ token = "" } = {}) => {
    const part = String(token).split(".")[1];
    if (!part) return { ok: false, error: "not a jwt" };
    try { return { ok: true, payload: JSON.parse(Buffer.from(part, "base64url").toString("utf8")) }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
};`,
  ),
  plugin(
    "sysinfo-kit",
    "System snapshot",
    "One-call snapshot of load, memory, disks and uptime for reports.",
    ["system.read"],
    "safe",
    ["system", "diagnostics"],
    `const os = require("node:os");
module.exports.register = (ctx) => {
  ctx.registerTool?.("system.snapshot", () => ({
    ok: true,
    load: os.loadavg(),
    freeMemoryGb: Number((os.freemem() / 1e9).toFixed(2)),
    totalMemoryGb: Number((os.totalmem() / 1e9).toFixed(2)),
    uptimeHours: Number((os.uptime() / 3600).toFixed(1)),
    host: os.hostname(),
  }));
};`,
  ),
  plugin(
    "template-kit",
    "Template renderer",
    "Fill {{variable}} templates for emails, reports and prompts.",
    [],
    "safe",
    ["templates", "prompts"],
    `module.exports.register = (ctx) => {
  ctx.registerTool?.("template.render", ({ template = "", values = {} } = {}) => ({
    ok: true,
    value: String(template).replace(/{{\\s*([\\w.]+)\\s*}}/g, (_, key) =>
      String(key.split(".").reduce((a, k) => (a == null ? a : a[k]), values) ?? "")),
  }));
};`,
  ),
];

const EXTRA_WORKFLOWS: MarketPack[] = [
  workflow(
    "evening-wrapup",
    "schedules",
    "Evening wrap-up",
    "Summarise the day's runs, unresolved approvals and tomorrow's plan.",
    ["memory.digest", "plan.breakdown"],
    "daily 20:00",
    ["daily", "self"],
    "safe",
  ),
  workflow(
    "memory-maintenance",
    "schedules",
    "Memory maintenance",
    "Promote, merge and prune memories, then reindex the vector store.",
    ["memory.digest", "text.keywords"],
    "daily 03:00",
    ["memory", "self"],
  ),
  workflow(
    "learning-loop",
    "schedules",
    "Learning loop",
    "Study recent failures, propose fixes and queue them for approval.",
    ["text.keywords", "plan.breakdown"],
    "every 12h",
    ["self", "learning"],
    "safe",
  ),
  workflow(
    "meeting-notes",
    "templates",
    "Meeting notes",
    "Transcribe a recording, extract action items and file the summary.",
    ["text.summarise", "text.action-items"],
    "on demand",
    ["meetings", "productivity"],
  ),
  workflow(
    "document-intake",
    "templates",
    "Document intake",
    "Index new documents into the knowledge base with a short abstract.",
    ["docs.markdown-outline", "text.summarise"],
    "on demand",
    ["knowledge", "rag"],
  ),
  workflow(
    "disk-guard",
    "schedules",
    "Disk guard",
    "Warn before storage runs out and suggest what is safe to clear.",
    ["system.disk-usage", "files.find-duplicates"],
    "every 6h",
    ["system", "maintenance"],
    "safe",
  ),
  workflow(
    "daily-desk",
    "schedules",
    "Daily desk summary",
    "Build the day's briefing from real tasks, notes and FRIDAY runs.",
    ["desk.summary", "desk.tasks"],
    "daily 20:00",
    ["productivity", "daily"],
    "safe",
  ),
  workflow(
    "weekly-books",
    "schedules",
    "Weekly books",
    "Read the persisted hisab running totals for the week, never estimated.",
    ["hisab.report"],
    "weekly",
    ["finance", "hisab"],
    "safe",
  ),
];

/** Every pack in the shipped marketplace catalog. */
export const MARKET_PACKS: MarketPack[] = [
  ...SKILLS,
  ...EXTRA_SKILLS,
  ...TOOLS,
  ...EXTRA_TOOLS,
  ...AGENTS,
  ...EXTRA_AGENTS,
  ...MODULES,
  ...EXTRA_MODULES,
  ...PLUGINS,
  ...EXTRA_PLUGINS,
  ...WORKFLOWS,
  ...EXTRA_WORKFLOWS,
];

export const packsForTree = (tree: CapabilityTree) =>
  MARKET_PACKS.filter((pack) => pack.tree === tree);

export function searchPacks(tree: CapabilityTree, query: string, category?: string) {
  const q = query.trim().toLowerCase();
  return packsForTree(tree).filter((pack) => {
    if (category && category !== "all" && pack.category !== category) return false;
    if (!q) return true;
    return (
      pack.name.toLowerCase().includes(q) ||
      pack.description.toLowerCase().includes(q) ||
      pack.slug.includes(q) ||
      pack.tags.some((tag) => tag.includes(q))
    );
  });
}

export const categoriesForTree = (tree: CapabilityTree) => [
  "all",
  ...[...new Set(packsForTree(tree).map((pack) => pack.category))].sort(),
];

/* ------------------------------------------------------------------ bridge */

/**
 * Real outcome of the test-before-enable pass that runs in the main process
 * after every install: the pack only counts as enabled when it really ran
 * inside the sandbox. `guide` is the step-card shown when a dependency cannot
 * be installed automatically.
 */
export interface CapabilityGuide {
  kind: "step_card";
  title: string;
  reason: string;
  dependency: string;
  catalogId: string | null;
  url: string | null;
  steps: string[];
  retryable: boolean;
}

export interface CapabilityVerification {
  ok: boolean;
  id?: string;
  status?: "verified" | "failed" | "needs-manual-step";
  mode?: string;
  error?: string;
  guide?: CapabilityGuide;
  installed?: string[];
}

type InstallApi = {
  installCapability?: (
    pack: MarketPack,
  ) => Promise<{ ok: boolean; id?: string; error?: string; verification?: CapabilityVerification }>;
  verifyCapability?: (id: string) => Promise<CapabilityVerification>;
  uninstallCapability?: (id: string) => Promise<{ ok: boolean; error?: string }>;
  installCapabilityFromUrl?: (
    url: string,
  ) => Promise<{ ok: boolean; installed?: string[]; error?: string }>;
  installCapabilityFromFile?: (tree?: CapabilityTree) => Promise<{
    ok: boolean;
    installed?: string[];
    error?: string;
  }>;
  installCapabilityFromGithub?: (
    tree: CapabilityTree | undefined,
    url: string,
  ) => Promise<{
    ok: boolean;
    installed?: string[];
    error?: string;
    verification?: CapabilityVerification[];
  }>;
  installSkillZip?: () => Promise<{
    ok: boolean;
    installed?: string[];
    error?: string;
    verification?: CapabilityVerification[];
  }>;
  installSkillFolder?: () => Promise<{
    ok: boolean;
    installed?: string[];
    error?: string;
    verification?: CapabilityVerification[];
  }>;
  installSkillGit?: (url: string) => Promise<{
    ok: boolean;
    installed?: string[];
    error?: string;
    verification?: CapabilityVerification[];
  }>;
  installToolZip?: () => Promise<{
    ok: boolean;
    installed?: string[];
    error?: string;
    verification?: CapabilityVerification[];
  }>;
  installToolFolder?: () => Promise<{
    ok: boolean;
    installed?: string[];
    error?: string;
    verification?: CapabilityVerification[];
  }>;
  installToolGit?: (url: string) => Promise<{
    ok: boolean;
    installed?: string[];
    error?: string;
    verification?: CapabilityVerification[];
  }>;
  installAgentZip?: () => Promise<{
    ok: boolean;
    installed?: string[];
    error?: string;
    verification?: CapabilityVerification[];
  }>;
  installAgentFolder?: () => Promise<{
    ok: boolean;
    installed?: string[];
    error?: string;
    verification?: CapabilityVerification[];
  }>;
  installAgentGit?: (url: string) => Promise<{
    ok: boolean;
    installed?: string[];
    error?: string;
    verification?: CapabilityVerification[];
  }>;
  installModuleZip?: () => Promise<{
    ok: boolean;
    installed?: string[];
    error?: string;
    verification?: CapabilityVerification[];
  }>;
  installModuleFolder?: () => Promise<{
    ok: boolean;
    installed?: string[];
    error?: string;
    verification?: CapabilityVerification[];
  }>;
  installModuleGit?: (url: string) => Promise<{
    ok: boolean;
    installed?: string[];
    error?: string;
    verification?: CapabilityVerification[];
  }>;
  installPluginZip?: () => Promise<{
    ok: boolean;
    installed?: string[];
    error?: string;
    verification?: CapabilityVerification[];
  }>;
  installPluginFolder?: () => Promise<{
    ok: boolean;
    installed?: string[];
    error?: string;
    verification?: CapabilityVerification[];
  }>;
  installPluginGit?: (url: string) => Promise<{
    ok: boolean;
    installed?: string[];
    error?: string;
    verification?: CapabilityVerification[];
  }>;
  installWorkflowZip?: () => Promise<{
    ok: boolean;
    installed?: string[];
    error?: string;
    verification?: CapabilityVerification[];
  }>;
  installWorkflowFolder?: () => Promise<{
    ok: boolean;
    installed?: string[];
    error?: string;
    verification?: CapabilityVerification[];
  }>;
  installWorkflowGit?: (url: string) => Promise<{
    ok: boolean;
    installed?: string[];
    error?: string;
    verification?: CapabilityVerification[];
  }>;
};

const api = () => desktopApi() as unknown as InstallApi | null;

const offline = { ok: false, error: "Installing capabilities needs the FRIDAY desktop app." };

export const marketplaceSupported = () => isDesktopApp();

export async function installPack(pack: MarketPack) {
  if (!isDesktopApp()) return offline;
  return (
    (await safeCall("capabilities:install", () => api()?.installCapability?.(pack) ?? null, {
      fallback: null,
    })) ?? { ok: false, error: "Install failed." }
  );
}

/**
 * Re-run the real sandbox smoke test for one installed capability — used by
 * the Retry action after the owner followed a manual dependency guide.
 */
export async function verifyCapability(id: string): Promise<CapabilityVerification> {
  if (!isDesktopApp()) return { ok: false, error: offline.error };
  return (
    (await safeCall(`capabilities:verify:${id}`, () => api()?.verifyCapability?.(id) ?? null, {
      fallback: null,
    })) ?? { ok: false, error: "Verification failed." }
  );
}

/** One honest sentence (plus manual steps) describing a verification result. */
export function describeVerification(result: CapabilityVerification): string {
  if (result.ok) return "Tested in the sandbox and enabled.";
  if (result.guide)
    return [result.guide.reason, ...result.guide.steps.map((s, i) => `${i + 1}. ${s}`)].join("\n");
  return result.error || "The capability failed its sandbox test and stays disabled.";
}

export async function uninstallPack(id: string) {
  if (!isDesktopApp()) return offline;
  return (
    (await safeCall("capabilities:uninstall", () => api()?.uninstallCapability?.(id) ?? null, {
      fallback: null,
    })) ?? { ok: false, error: "Uninstall failed." }
  );
}

export async function installFromUrl(url: string) {
  if (!isDesktopApp()) return offline;
  return (
    (await safeCall(
      "capabilities:install-url",
      () => api()?.installCapabilityFromUrl?.(url) ?? null,
      { fallback: null },
    )) ?? { ok: false, error: "Download failed." }
  );
}

/**
 * Import a pack from a local manifest file. `tree` is the page the owner
 * imported from, so a manifest that omits its own `tree` still lands in the
 * right place — one import flow for skills, tools, modules, workflows,
 * plugins and agents alike.
 */
export async function installFromFile(tree?: CapabilityTree) {
  if (!isDesktopApp()) return offline;
  return (
    (await safeCall(
      `capabilities:install-file:${tree ?? "any"}`,
      () => api()?.installCapabilityFromFile?.(tree) ?? null,
      { fallback: null },
    )) ?? { ok: false, error: "Import failed." }
  );
}

/**
 * Second source for the SAME import pipeline: a GitHub repository URL. The
 * manifests are fetched with the GitHub connector's read-only actions and then
 * installed by the identical installCapabilityPayload() path the file import
 * uses — no parallel install/validation flow.
 */
export async function installFromGithub(tree: CapabilityTree | undefined, url: string) {
  if (!isDesktopApp()) return offline;
  return (
    (await safeCall(
      `capabilities:install-github:${tree ?? "any"}`,
      () => api()?.installCapabilityFromGithub?.(tree, url) ?? null,
      { fallback: null },
    )) ?? { ok: false, error: "Import failed." }
  );
}

/** Skills page only: zip of skill.json / skill.mjs (refuses plugins and tools). */
export async function installSkillZip() {
  if (!isDesktopApp()) return offline;
  return (
    (await safeCall("capabilities:install-skill-zip", () => api()?.installSkillZip?.() ?? null, {
      fallback: null,
    })) ?? { ok: false, error: "Import failed." }
  );
}

/** Skills page only: folder of skill packs. */
export async function installSkillFolder() {
  if (!isDesktopApp()) return offline;
  return (
    (await safeCall(
      "capabilities:install-skill-folder",
      () => api()?.installSkillFolder?.() ?? null,
      { fallback: null },
    )) ?? { ok: false, error: "Import failed." }
  );
}

/** Skills page only: git clone or GitHub zip of skill folders. */
export async function installSkillGit(url: string) {
  if (!isDesktopApp()) return offline;
  return (
    (await safeCall("capabilities:install-skill-git", () => api()?.installSkillGit?.(url) ?? null, {
      fallback: null,
    })) ?? { ok: false, error: "Import failed." }
  );
}

/** Tools page only: zip of tool.json / index.cjs (refuses skills and plugins). */
export async function installToolZip() {
  if (!isDesktopApp()) return offline;
  return (
    (await safeCall("capabilities:install-tool-zip", () => api()?.installToolZip?.() ?? null, {
      fallback: null,
    })) ?? { ok: false, error: "Import failed." }
  );
}

/** Tools page only: folder of tool packs. */
export async function installToolFolder() {
  if (!isDesktopApp()) return offline;
  return (
    (await safeCall(
      "capabilities:install-tool-folder",
      () => api()?.installToolFolder?.() ?? null,
      { fallback: null },
    )) ?? { ok: false, error: "Import failed." }
  );
}

/** Tools page only: git clone or GitHub zip of tool folders. */
export async function installToolGit(url: string) {
  if (!isDesktopApp()) return offline;
  return (
    (await safeCall("capabilities:install-tool-git", () => api()?.installToolGit?.(url) ?? null, {
      fallback: null,
    })) ?? { ok: false, error: "Import failed." }
  );
}

/** Agents page only: zip of manifest.json / agent.json (refuses skills and tools). */
export async function installAgentZip() {
  if (!isDesktopApp()) return offline;
  return (
    (await safeCall("capabilities:install-agent-zip", () => api()?.installAgentZip?.() ?? null, {
      fallback: null,
    })) ?? { ok: false, error: "Import failed." }
  );
}

/** Agents page only: folder of agent packs. */
export async function installAgentFolder() {
  if (!isDesktopApp()) return offline;
  return (
    (await safeCall(
      "capabilities:install-agent-folder",
      () => api()?.installAgentFolder?.() ?? null,
      { fallback: null },
    )) ?? { ok: false, error: "Import failed." }
  );
}

/** Agents page only: git clone or GitHub zip of agent folders. */
export async function installAgentGit(url: string) {
  if (!isDesktopApp()) return offline;
  return (
    (await safeCall("capabilities:install-agent-git", () => api()?.installAgentGit?.(url) ?? null, {
      fallback: null,
    })) ?? { ok: false, error: "Import failed." }
  );
}

/** Modules page only: zip of manifest.json / module.json / main.py (refuses skills/tools/agents). */
export async function installModuleZip() {
  if (!isDesktopApp()) return offline;
  return (
    (await safeCall("capabilities:install-module-zip", () => api()?.installModuleZip?.() ?? null, {
      fallback: null,
    })) ?? { ok: false, error: "Import failed." }
  );
}

/** Modules page only: folder of module packs. */
export async function installModuleFolder() {
  if (!isDesktopApp()) return offline;
  return (
    (await safeCall(
      "capabilities:install-module-folder",
      () => api()?.installModuleFolder?.() ?? null,
      { fallback: null },
    )) ?? { ok: false, error: "Import failed." }
  );
}

/** Modules page only: git clone or GitHub zip of module folders. */
export async function installModuleGit(url: string) {
  if (!isDesktopApp()) return offline;
  return (
    (await safeCall(
      "capabilities:install-module-git",
      () => api()?.installModuleGit?.(url) ?? null,
      { fallback: null },
    )) ?? { ok: false, error: "Import failed." }
  );
}

/** Plugins page only: zip of plugin.json / hooks + index.cjs (refuses skills/tools/agents/modules). */
export async function installPluginZip() {
  if (!isDesktopApp()) return offline;
  return (
    (await safeCall("capabilities:install-plugin-zip", () => api()?.installPluginZip?.() ?? null, {
      fallback: null,
    })) ?? { ok: false, error: "Import failed." }
  );
}

/** Plugins page only: folder of plugin packs. */
export async function installPluginFolder() {
  if (!isDesktopApp()) return offline;
  return (
    (await safeCall(
      "capabilities:install-plugin-folder",
      () => api()?.installPluginFolder?.() ?? null,
      { fallback: null },
    )) ?? { ok: false, error: "Import failed." }
  );
}

/** Plugins page only: git clone or GitHub zip of plugin folders. */
export async function installPluginGit(url: string) {
  if (!isDesktopApp()) return offline;
  return (
    (await safeCall(
      "capabilities:install-plugin-git",
      () => api()?.installPluginGit?.(url) ?? null,
      { fallback: null },
    )) ?? { ok: false, error: "Import failed." }
  );
}

/** Workflows page only: zip of workflow.json / steps (refuses skills/tools/agents/modules/plugins). */
export async function installWorkflowZip() {
  if (!isDesktopApp()) return offline;
  return (
    (await safeCall(
      "capabilities:install-workflow-zip",
      () => api()?.installWorkflowZip?.() ?? null,
      {
        fallback: null,
      },
    )) ?? { ok: false, error: "Import failed." }
  );
}

/** Workflows page only: folder of workflow packs. */
export async function installWorkflowFolder() {
  if (!isDesktopApp()) return offline;
  return (
    (await safeCall(
      "capabilities:install-workflow-folder",
      () => api()?.installWorkflowFolder?.() ?? null,
      { fallback: null },
    )) ?? { ok: false, error: "Import failed." }
  );
}

/** Workflows page only: git clone or GitHub zip of workflow folders. */
export async function installWorkflowGit(url: string) {
  if (!isDesktopApp()) return offline;
  return (
    (await safeCall(
      "capabilities:install-workflow-git",
      () => api()?.installWorkflowGit?.(url) ?? null,
      { fallback: null },
    )) ?? { ok: false, error: "Import failed." }
  );
}

/**
 * The everyday default set: the packs FRIDAY recommends having installed on a
 * fresh workspace, per tree. These are ids from the catalog above — one list,
 * no second hardcoded catalog.
 */
export const STARTER_PACKS: Record<CapabilityTree, string[]> = {
  skills: [
    "text.summarise",
    "text.action-items",
    "files.find-duplicates",
    "files.bulk-rename",
    "docs.markdown-outline",
    "web.readable",
    "csv.parse",
    "data.stats",
    "system.disk-usage",
    "plan.breakdown",
  ],
  tools: [
    "fs-search",
    "fs-archive",
    "http-client",
    "clipboard",
    "screenshot-capture",
    "log-tailer",
  ],
  modules: ["json-tools", "text-tools", "time-tools", "markdown-kit", "sysinfo-kit"],
  plugins: ["notify-webhook", "csv-report", "env-doctor"],
  agents: [
    "research-agent",
    "planner-agent",
    "cleanup-agent",
    "osint-agent",
    "website-watch-agent",
    "tender-discovery-agent",
    "tender-analysis-agent",
    "bid-planning-agent",
    "go-no-go-agent",
  ],
  workflows: ["morning-briefing", "workspace-cleanup", "self-health", "evening-wrapup"],
  models: [],
};

/** Packs from the starter set for one tree that are not installed yet. */
export function missingStarterPacks(tree: CapabilityTree, installedIds: string[]): MarketPack[] {
  const installed = new Set(installedIds);
  return (STARTER_PACKS[tree] ?? [])
    .map((slug) => packsForTree(tree).find((pack) => pack.slug === slug))
    .filter((pack): pack is MarketPack => Boolean(pack) && !installed.has(capabilityId(pack!)));
}

/** Install every missing starter pack for one tree. Reports each real result. */
export async function installStarterSet(tree: CapabilityTree, installedIds: string[]) {
  const missing = missingStarterPacks(tree, installedIds);
  if (!missing.length) return { ok: true, installed: [] as string[], failed: [] as string[] };
  const installed: string[] = [];
  const failed: string[] = [];
  for (const pack of missing) {
    const result = await installPack(pack);
    if (result?.ok) installed.push(pack.name);
    else failed.push(pack.name);
  }
  return { ok: failed.length === 0, installed, failed };
}
