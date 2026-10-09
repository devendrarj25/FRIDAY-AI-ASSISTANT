#!/usr/bin/env node
/**
 * FRIDAY - documentation engine.
 *
 * ONE registry, ONE index, ZERO hand-maintained document maps.
 *
 * Every Markdown document FRIDAY ships is declared exactly once, below, with
 * its canonical path, its title, who it is for and the single question it
 * answers. From that registry this script:
 *
 *   * regenerates the full documentation index (`docs/README.md`);
 *   * regenerates the short documentation map in `README.md` (topic -> file),
 *     so the two can never disagree or drift into two different write-ups;
 *   * fails when a Markdown file exists on disk but is not registered, or a
 *     registered document is missing, thin, or carries the wrong title;
 *   * fails when the same paragraph is copy-pasted into two documents;
 *   * fails when the skill / tool / agent / plugin / workflow / module counts
 *     stated in FRIDAY_STATE.md or docs/FRIDAY_FEATURES.md differ from the disk
 *     (`--fix` rewrites them, so adding a skill never leaves a stale number).
 *
 * It never rewrites a document body: only the generated index blocks. Version
 * declarations stay owned by `scripts/release-engine.cjs` (`syncDocs`), which
 * calls this engine on every release so documentation is future-proof - a new
 * release, upgrade or new document keeps the whole set synchronised without
 * anyone editing an index by hand.
 *
 *   node scripts/docs-engine.cjs            report only (exit 1 on drift)
 *   node scripts/docs-engine.cjs --fix      regenerate the generated blocks
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

/* ------------------------------------------------------------- registry --- */

/**
 * Document sections, in reading order. `id` is referenced by each document.
 */
const SECTIONS = [
  { id: "start", title: "1. Start here" },
  { id: "architecture", title: "2. Architecture and data" },
  { id: "release", title: "3. Build, version, release and update" },
  { id: "governance", title: "4. Repository governance" },
  { id: "sessions", title: "5. Working sessions (humans and AI tools)" },
];

/**
 * The canonical document registry.
 *
 * file      - canonical path, relative to the repository root.
 * title     - the exact H1 the document must carry (a trailing "(vX.Y.Z)" is
 *             allowed and kept in step by the release engine).
 * section   - which index section it belongs to.
 * audience  - who reads it.
 * answers   - the single question it answers (used verbatim in the index).
 * topic     - short label for the README documentation map.
 * inMap     - include in the short README map (false = index only).
 * role      - document class (default `canonical`):
 *             canonical | history | developer | session | legal
 */
const DOC_ROLES = ["canonical", "history", "developer", "session", "legal"];
const DOCUMENTS = [
  {
    file: "README.md",
    title: "FRIDAY — Personal AI Assistant",
    section: "start",
    audience: "everyone",
    answers: "What FRIDAY is, who owns it, how to get it, and which document to open next",
    topic: "Project overview and entry point",
    inMap: false,
  },
  {
    file: "INSTALL.md",
    title: "FRIDAY — Windows Install and Build Guide",
    section: "start",
    audience: "owner",
    answers:
      "Published Setup and Portable, every owner-facing CMD/npm command, toolchain download fallbacks, isolated runtime layout, first-launch so Chat Manual/Auto/voice/local engines work, then upgrade and uninstall",
    topic: "Install, local CMD pack, first-launch, upgrade, uninstall",
  },
  {
    file: "docs/FRIDAY_USER_GUIDE.md",
    title: "FRIDAY — User Guide",
    section: "start",
    audience: "owner",
    answers: "How to use the running desktop app, section by section, plus troubleshooting",
    topic: "Using Chat, Voice, Models, and every sidebar section",
  },
  {
    file: "docs/FRIDAY_FEATURES.md",
    title: "FRIDAY — Feature & Capability Catalog",
    section: "start",
    audience: "owner, AI tools",
    answers: "Every shipped capability, the file that implements it, and the test that covers it",
    topic: "Feature catalog with implementation and test map",
  },
  {
    file: "docs/FRIDAY_IMPORT_FORMAT.md",
    title: "FRIDAY — Capability Import Format",
    section: "start",
    audience: "owner, AI tools",
    answers:
      "JSON manifests for importing a skill, tool, module, plugin, workflow or agent, and what Import & Build does next",
    topic: "Capability import JSON format",
  },
  {
    file: "ARCHITECTURE.md",
    title: "FRIDAY — Architecture Overview",
    section: "architecture",
    audience: "developers, AI tools",
    answers: "Process layers, the allowlisted IPC surface, and how renderer, main, and kernel meet",
    topic: "Architecture layers and IPC",
  },
  {
    file: "docs/FRIDAY_ARCHITECTURE_BASELINE.md",
    title: "FRIDAY — Architecture Baseline",
    section: "architecture",
    audience: "developers, AI tools",
    answers: "The locked folder and subsystem baseline the architecture audit enforces",
    topic: "Architecture baseline and drift detectors",
  },
  {
    file: "docs/FRIDAY_MASTER_FLOW.md",
    title: "FRIDAY — Master Operating Flow",
    section: "architecture",
    audience: "developers, AI tools",
    answers: "The owner operating loop and which live module owns each stage",
    topic: "Master operating flow",
  },
  {
    file: "docs/FRIDAY_STORAGE_CONTRACT.md",
    title: "FRIDAY — Storage, Installation, Update & Uninstall Contract",
    section: "architecture",
    audience: "developers, AI tools",
    answers: "The single FRIDAY root, what Setup may replace, and what uninstall may delete",
    topic: "Storage root, install, update, uninstall",
  },
  {
    file: "docs/FRIDAY_PROVIDERS_AND_SECRETS.md",
    title: "FRIDAY — Providers, Models & Secrets",
    section: "architecture",
    audience: "owner, developers",
    answers:
      "Local model engines, cloud providers, encrypted keys, billing firewall, and privacy egress",
    topic: "Providers, credentials, billing and privacy firewalls",
  },
  {
    file: "docs/FRIDAY_BUILD_AND_RELEASE.md",
    title: "FRIDAY — Build, Release, Version & Update Guide",
    section: "release",
    audience: "owner",
    answers:
      "CMD, TEST, and Official packs, the TEST Windows identity, and how an installed copy chooses Stable or Test",
    topic: "Build paths, TEST identity, and Stable versus Test updates",
  },
  {
    file: "VERSIONING.md",
    title: "FRIDAY — Versioning Policy",
    section: "release",
    audience: "owner, AI tools",
    answers:
      "The one public version, the npm encoding, counters that keep counting, and when a failed or auto run keeps its number",
    topic: "Version scheme and bump rules",
  },
  {
    file: "RELEASE.md",
    title: "FRIDAY — Release Runbook",
    section: "release",
    audience: "owner",
    answers: "Click-by-click Official, TEST, and local CMD release steps with pre-flight checks",
    topic: "Release runbook",
  },
  {
    file: "docs/FRIDAY_GITHUB_ACTIONS.md",
    title: "FRIDAY — GitHub Actions Catalog (Repository Automation)",
    section: "release",
    audience: "owner, AI tools",
    answers: "Every repository workflow: filename, trigger, inputs, permissions, how to run it",
    topic: "GitHub Actions catalog",
  },
  {
    file: "docs/FRIDAY_MERGE_FLOW.md",
    title: "FRIDAY — Repository Workflow",
    section: "governance",
    audience: "owner, AI tools",
    answers:
      "How a change reaches main, how Safe Merge, cleanup, and Repository Control behave, and why an official release stays a separate step",
    topic: "Repository workflow: branch, merge, cleanup, and revert",
    role: "developer",
  },
  {
    file: "docs/FRIDAY_CHANGE_CONTROL.md",
    title: "FRIDAY — Change Control",
    section: "governance",
    audience: "owner, AI tools",
    answers:
      "How a change is classified, bounded, tested, and recorded, and which product module owns each development contract",
    topic: "Change control, task packet, and development contracts",
    role: "developer",
  },
  {
    file: "CONTRIBUTING.md",
    title: "Contributing to FRIDAY",
    section: "governance",
    audience: "developers, AI tools",
    answers: "How a human contributor branches, verifies, and updates documents in the same PR",
    topic: "Contributor workflow and documentation contract",
    role: "developer",
  },
  {
    file: "SECURITY.md",
    title: "FRIDAY — Security Policy",
    section: "governance",
    audience: "owner, developers",
    answers: "Threat model, GitHub Secrets, workflow least privilege, and how to report a flaw",
    topic: "Security policy and reporting",
  },
  {
    file: "LICENSE",
    title: null,
    section: "governance",
    audience: "everyone",
    answers:
      "Ownership, personal-use rights, contribution, no-redistribution and attribution terms",
    topic: "Licence and ownership terms",
    role: "legal",
  },
  {
    file: "CHANGELOG.md",
    title: "FRIDAY — Changelog",
    section: "governance",
    audience: "everyone",
    answers: "Published What's New for each version, in plain language, on the current public line",
    topic: "Changelog of published versions",
    role: "history",
  },
  {
    file: "AUDIT.md",
    title: "FRIDAY — Project Audit",
    section: "governance",
    audience: "owner, AI tools",
    answers: "What is verified versus not, with the command or release that is the evidence",
    topic: "Verification evidence and open limitations",
    role: "developer",
  },
  {
    file: "FRIDAY_STATE.md",
    title: "FRIDAY — Project State",
    section: "sessions",
    audience: "AI tools (current facts, after the session rules)",
    answers:
      "Live briefing for a new session: architecture snapshot, counts, decisions, next priorities",
    topic: "Cross-session project state briefing",
    role: "session",
  },
  {
    file: "AGENTS.md",
    title: "AGENTS.md — instructions for AI tools working on FRIDAY",
    section: "sessions",
    audience: "AI tools",
    answers:
      "The upgrade flow for AI tools: one pull request, keep what works, fix a locked-area bug without breaking it, same-change tests and docs, owner merges",
    topic: "AI session protocol and landing bar",
    role: "session",
  },
];

/** Markdown outside the registry that is generated or historical, not indexed. */
const UNREGISTERED_OK = [
  /^docs\/README\.md$/, // the index itself, generated from this registry
  /^releases\/notes\/v[\d.]+(-test\.\d+)?\.md$/, // per-release notes, generated
  /^release-notes\.md$/, // transient What's New staged by the release workflow (copied into releases/notes/), never committed
  /^\.github\//, // issue/PR templates
  /^node_modules\//,
  /^\.friday-dev\//,
  /^\.workspace\//,
  /^\.lovable\//,
  /^dist/,
  /^\.pytest_cache\//,
  /^CLAUDE\.md$/, // one-line `@AGENTS.md` import, never a second copy of AGENTS.md
  /^recovery\/[^/]+\.md$/, // Main Safety Recovery preservation records, not product documentation
];

/* -------------------------------------------------------------- helpers --- */

const byFile = new Map(DOCUMENTS.map((d) => [d.file, d]));

/** Every Markdown file that physically exists in the checkout. */
function markdownFiles(dir = ROOT, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(ROOT, full).split(path.sep).join("/");
    if (entry.isDirectory()) {
      if (
        [
          "node_modules",
          ".git",
          "dist",
          "dist-desktop",
          "release",
          ".output",
          ".wrangler",
          ".cache",
          ".workspace",
          ".lovable",
          ".tanstack",
          ".venv",
          ".friday-dev",
          "venv",
          "python-runtime",
          ".pytest_cache",
          "__pycache__",
          ".cursor",
        ].includes(entry.name)
      )
        continue;
      markdownFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(rel);
    }
  }
  return out;
}

const heading = (rel) => /^#\s+(.+)$/m.exec(read(rel))?.[1]?.trim() ?? "";

/** A document title matches when it is the declared one, optionally version-stamped. */
function titleMatches(actual, declared) {
  if (!declared) return true;
  return actual === declared || new RegExp(`^${escape(declared)}\\s*\\(v[\\d.]+\\)$`).test(actual);
}

const escape = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* ------------------------------------------------- generated index block --- */

const INDEX_START =
  "<!-- docs-engine: generated index. Edit scripts/docs-engine.cjs, not this. -->";
const INDEX_END = "<!-- docs-engine: end generated index -->";
const MAP_START = "<!-- docs-engine: generated map. Edit scripts/docs-engine.cjs, not this. -->";
const MAP_END = "<!-- docs-engine: end generated map -->";
const ROUTE_START =
  "<!-- docs-engine: generated kernel routes. Edit scripts/docs-engine.cjs, not this. -->";
const ROUTE_END = "<!-- docs-engine: end generated kernel routes -->";

const linkFrom = (fromDir, rel) => {
  const target = path.relative(fromDir, path.join(ROOT, rel)).split(path.sep).join("/");
  return target.startsWith(".") ? target : target;
};

/** The full index body used inside docs/README.md. */
function indexBlock() {
  const dir = path.join(ROOT, "docs");
  const lines = [INDEX_START, ""];
  for (const section of SECTIONS) {
    const docs = DOCUMENTS.filter((d) => d.section === section.id);
    if (!docs.length) continue;
    lines.push(`## ${section.title}`, "");
    lines.push("| Document | Answers | For |", "| --- | --- | --- |");
    for (const doc of docs) {
      lines.push(
        `| [${doc.file}](${linkFrom(dir, doc.file)}) | ${doc.answers} | ${doc.audience} |`,
      );
    }
    lines.push("");
  }
  lines.push(
    `## ${SECTIONS.length + 1}. Document roles`,
    "",
    "Every registered document is the **canonical** write-up for its topic unless",
    "the table below says otherwise. Generated files are not registered. Per-release",
    "notes keep the version they were published with.",
    "",
    "| Role | Meaning | Documents |",
    "| --- | --- | --- |",
  );
  for (const role of DOC_ROLES.filter((role) => role !== "canonical")) {
    const files = DOCUMENTS.filter((d) => (d.role || "canonical") === role).map((d) => d.file);
    if (!files.length) continue;
    const meaning =
      role === "history"
        ? "Published What's New, in plain language, on the current public line; once published, a section is not rewritten"
        : role === "developer"
          ? "Contributor, audit, and repository-governance procedure"
          : role === "session"
            ? "Live working briefing for humans and AI tools"
            : "Licence and ownership terms";
    lines.push(`| ${role} | ${meaning} | ${files.map((file) => `\`${file}\``).join(", ")} |`);
  }
  lines.push(
    "",
    "Generated (not registered): `docs/README.md` (this index) and",
    "`releases/notes/vX.Y.Z.md` (per-release What's New). Transient:",
    "`release-notes.md` at the repo root during publish — never a committed document.",
    "",
    `## ${SECTIONS.length + 2}. Release notes`,
    "",
    "`releases/notes/vX.Y.Z.md` holds the published What's New for each release; the",
    "same body is prepended to [../CHANGELOG.md](../CHANGELOG.md) by the release",
    "workflow. These files are generated per release and are deliberately not part",
    "of the registry.",
    "",
    `## ${SECTIONS.length + 3}. How this index stays true`,
    "",
    "This section and the documentation map in [../README.md](../README.md) are both",
    "generated from the single registry in `scripts/docs-engine.cjs`. Adding, renaming",
    "or removing a document means editing that registry and running `npm run docs:sync`;",
    "`npm run docs:check` (and `core/__tests__/docs-registry.test.ts`) fail when a",
    "Markdown file is unregistered, missing, thin, wrongly titled, or duplicated across",
    "two documents. Version declarations are kept in step separately by",
    "`scripts/release-engine.cjs`, which runs this engine on every release.",
    "",
    INDEX_END,
  );
  return lines.join("\n");
}

/** The short topic -> document map used inside README.md. */
function mapBlock() {
  const lines = [MAP_START, "", "| Topic | Document |", "| --- | --- |"];
  lines.push(
    "| Full documentation index (every document, what it answers) | [docs/README.md](docs/README.md) |",
  );
  for (const doc of DOCUMENTS) {
    if (doc.inMap === false) continue;
    lines.push(`| ${doc.topic} | [${doc.file}](${doc.file}) |`);
  }
  lines.push("", MAP_END);
  return lines.join("\n");
}

/** Route index from kernel/openapi.snapshot.json. The HTTP test owns that file. */
function kernelRouteBlock() {
  const raw = JSON.parse(read("kernel/openapi.snapshot.json"));
  const paths = raw.openapi && raw.openapi.paths ? raw.openapi.paths : {};
  const lines = [ROUTE_START, "", "| Method | Path |", "| --- | --- |"];
  for (const route of Object.keys(paths).sort()) {
    const item = paths[route] || {};
    const methods = Object.keys(item)
      .filter((method) => method !== "parameters" && !method.startsWith("x-"))
      .sort();
    for (const method of methods) lines.push(`| ${method.toUpperCase()} | \`${route}\` |`);
  }
  for (const socket of raw.websockets || []) lines.push(`| WEBSOCKET | \`${socket}\` |`);
  lines.push("", ROUTE_END);
  return lines.join("\n");
}

/** Replace a generated block, or append it when the markers are absent. */
function writeBlock(rel, start, end, body, { anchor } = {}) {
  const file = path.join(ROOT, rel);
  const before = fs.readFileSync(file, "utf8");
  const rx = new RegExp(`${escape(start)}[\\s\\S]*?${escape(end)}`);
  let after;
  if (rx.test(before)) {
    after = before.replace(rx, body);
  } else if (anchor && anchor.test(before)) {
    after = before.replace(anchor, (match) => `${match}\n${body}\n`);
  } else {
    after = `${before.trimEnd()}\n\n${body}\n`;
  }
  if (after === before) return false;
  fs.writeFileSync(file, after);
  return true;
}

/* ---------------------------------------------------- capability counts --- */

/**
 * Capability counts are stated in two documents. They are facts about the disk,
 * so they are counted here and checked (`docs:check`) or rewritten (`docs:sync`,
 * and every release) rather than trusted to whoever last added a skill.
 */
const COUNT_KINDS = [
  { label: "Skills", dir: "skills", file: "skill.json" },
  { label: "Tools", dir: "tools", file: "tool.json" },
  { label: "Agents", dir: "agents", file: "manifest.json" },
  { label: "Plugins", dir: "plugins", file: "plugin.json" },
  { label: "Workflows", dir: "workflows", file: "workflow.json" },
  { label: "Modules", dir: "modules", file: "manifest.json" },
];

/** Where each count is written: [document, pattern builder]. Group 2 is the number. */
const COUNT_SITES = [
  {
    file: "FRIDAY_STATE.md",
    pattern: (k) => new RegExp(`(\\|\\s*${k.label}\\s*\\|\\s*)(\\d+)(\\s*\`${k.file}\`)`),
  },
  {
    file: "docs/FRIDAY_FEATURES.md",
    pattern: (k) => new RegExp(`(${k.label} \\*\\*)(\\d+)(\\*\\* \`${k.file}\`)`),
  },
];

function countNamed(dir, name) {
  const top = path.join(ROOT, dir);
  if (!fs.existsSync(top)) return 0;
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === name) n += 1;
    }
  };
  walk(top);
  return n;
}

/** Counted from disk: { Skills: 214, ... }. */
function capabilityCounts() {
  return Object.fromEntries(COUNT_KINDS.map((k) => [k.label, countNamed(k.dir, k.file)]));
}

/** Every stated count that disagrees with the disk (or whose sentence is gone). */
function countDrift() {
  const actual = capabilityCounts();
  const drift = [];
  for (const site of COUNT_SITES) {
    if (!exists(site.file)) continue;
    const text = read(site.file);
    for (const k of COUNT_KINDS) {
      const m = text.match(site.pattern(k));
      if (!m) drift.push({ file: site.file, kind: k.label, stated: null, actual: actual[k.label] });
      else if (Number(m[2]) !== actual[k.label])
        drift.push({
          file: site.file,
          kind: k.label,
          stated: Number(m[2]),
          actual: actual[k.label],
        });
    }
  }
  return drift;
}

/** Rewrite stale numbers in place. Returns touched files. */
function syncCounts() {
  const actual = capabilityCounts();
  const touched = [];
  for (const site of COUNT_SITES) {
    if (!exists(site.file)) continue;
    const before = read(site.file);
    let text = before;
    for (const k of COUNT_KINDS)
      text = text.replace(site.pattern(k), (_, a, _n, c) => `${a}${actual[k.label]}${c}`);
    if (text !== before) {
      fs.writeFileSync(path.join(ROOT, site.file), text);
      touched.push(site.file);
    }
  }
  return touched;
}

/* ----------------------------------------------------------- duplication --- */

/** Normalised paragraph blocks of a document, long enough to matter. */
function paragraphs(text) {
  return text
    .split(/\n\s*\n/)
    .map((block) =>
      block
        .split("\n")
        .map((l) => l.trim())
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((block) => block.length >= 200 && !block.startsWith("|") && !block.startsWith("```"));
}

/** The same paragraph living in two registered documents is duplication. */
function duplicates() {
  const seen = new Map();
  for (const doc of DOCUMENTS) {
    if (!doc.file.endsWith(".md") || !exists(doc.file)) continue;
    for (const block of new Set(paragraphs(read(doc.file)))) {
      const list = seen.get(block) ?? [];
      list.push(doc.file);
      seen.set(block, list);
    }
  }
  return [...seen.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([block, files]) => ({ files, excerpt: `${block.slice(0, 90)}...` }));
}

/* --------------------------------------------------------------- report --- */

function inspect() {
  const registered = DOCUMENTS.map((d) => d.file);
  const onDisk = markdownFiles();

  const missing = registered.filter((rel) => !exists(rel));
  const unregistered = onDisk.filter(
    (rel) => !registered.includes(rel) && !UNREGISTERED_OK.some((rx) => rx.test(rel)),
  );
  const thin = registered
    .filter((rel) => exists(rel) && read(rel).trim().length < 400)
    .map((rel) => rel);
  const mistitled = DOCUMENTS.filter(
    (d) => d.file.endsWith(".md") && exists(d.file) && !titleMatches(heading(d.file), d.title),
  ).map((d) => ({ file: d.file, found: heading(d.file), expected: d.title }));

  const indexStale = !read("docs/README.md").includes(indexBlock());
  const mapStale = !read("README.md").includes(mapBlock());
  const kernelRoutesStale = !read("ARCHITECTURE.md").includes(kernelRouteBlock());
  let flowStale = false;
  try {
    flowStale = require("./flow-registry.cjs").registryStale();
  } catch {
    flowStale = true;
  }

  return {
    missing,
    unregistered,
    thin,
    mistitled,
    duplicates: duplicates(),
    indexStale,
    mapStale,
    kernelRoutesStale,
    flowStale,
    countDrift: countDrift(),
    get ok() {
      return (
        !this.missing.length &&
        !this.unregistered.length &&
        !this.thin.length &&
        !this.mistitled.length &&
        !this.duplicates.length &&
        !this.indexStale &&
        !this.mapStale &&
        !this.kernelRoutesStale &&
        !this.flowStale &&
        !this.countDrift.length
      );
    },
  };
}

/** Regenerate every generated documentation block. Returns touched files. */
function sync({ root = ROOT } = {}) {
  void root;
  const touched = [];
  const flow = require("./flow-registry.cjs");
  if (flow.registryStale()) {
    flow.writeRegistry();
    touched.push(flow.OUT);
  }
  if (
    writeBlock("docs/README.md", INDEX_START, INDEX_END, indexBlock(), {
      anchor: /^---$/m,
    })
  )
    touched.push("docs/README.md");
  if (
    writeBlock("README.md", MAP_START, MAP_END, mapBlock(), {
      anchor: /^### Documentation map \(one canonical document per topic\)$/m,
    })
  )
    touched.push("README.md");
  if (
    writeBlock("ARCHITECTURE.md", ROUTE_START, ROUTE_END, kernelRouteBlock(), {
      anchor: /^`kernel\/main\.py` mounts .+$/m,
    })
  )
    touched.push("ARCHITECTURE.md");
  for (const rel of syncCounts()) if (!touched.includes(rel)) touched.push(rel);
  return touched;
}

function main() {
  const fix = process.argv.slice(2).includes("--fix");
  if (fix) {
    const touched = sync();
    console.log(
      touched.length ? `regenerated: ${touched.join(", ")}` : "generated blocks: in sync",
    );
  }
  const report = inspect();
  console.log(`documents registered : ${DOCUMENTS.length}`);
  console.log(`missing              : ${report.missing.length}`);
  console.log(`unregistered         : ${report.unregistered.length}`);
  console.log(`thin                 : ${report.thin.length}`);
  console.log(`wrong title          : ${report.mistitled.length}`);
  console.log(`duplicated blocks    : ${report.duplicates.length}`);
  console.log(`index/map stale      : ${report.indexStale || report.mapStale}`);
  console.log(`kernel routes stale  : ${report.kernelRoutesStale}`);
  console.log(`flow registry stale  : ${report.flowStale}`);
  console.log(`capability counts off: ${report.countDrift.length}`);
  for (const rel of report.missing) console.log(`  missing        ${rel}`);
  for (const rel of report.unregistered)
    console.log(`  unregistered   ${rel} -> add it to scripts/docs-engine.cjs`);
  for (const rel of report.thin) console.log(`  thin           ${rel}`);
  for (const m of report.mistitled)
    console.log(`  wrong title    ${m.file}: "${m.found}" != "${m.expected}"`);
  for (const c of report.countDrift)
    console.log(
      `  count drift    ${c.file}: ${c.kind} states ${c.stated ?? "(sentence missing)"}, disk has ${c.actual}`,
    );
  for (const d of report.duplicates)
    console.log(`  duplicated     ${d.files.join(" == ")} :: ${d.excerpt}`);
  console.log(
    report.ok ? "documentation: arranged and synced" : "documentation: run `npm run docs:sync`",
  );
  if (!report.ok) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  ROOT,
  SECTIONS,
  DOCUMENTS,
  DOC_ROLES,
  UNREGISTERED_OK,
  byFile,
  markdownFiles,
  indexBlock,
  mapBlock,
  kernelRouteBlock,
  duplicates,
  capabilityCounts,
  countDrift,
  syncCounts,
  inspect,
  sync,
};
