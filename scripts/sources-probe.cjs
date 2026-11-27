#!/usr/bin/env node
// FRIDAY - does every row of config/tool-sources/*.json get an answer from the real source chain?
//
// Each row is resolved through the same chain the Install Manager uses (the data file's sources, then the vendor feed,
// then the pin; electron/installer-catalog.cjs chainOfTool). One line per row: which kind of source answered, the
// version, how it came (primary, fallback, cache, pinned) and how long it took. Exit 1 when any row has no answer.
// It writes nothing except the normal vendor cache under FRIDAY_ROOT (when that folder is set).
//
//   node scripts/sources-probe.cjs                 -> every row
//   node scripts/sources-probe.cjs --row Python    -> one row (repeat --row for more)
//   node scripts/sources-probe.cjs --offline       -> the cache and the pins only, no network
//   node scripts/sources-probe.cjs --timeout 4000  -> per-source deadline in ms (default 6000)
"use strict";
if (require.main === module) require("./live-console.cjs").installColorConsole();

const path = require("node:path");

function parseArgs(argv) {
  const out = { rows: [], offline: false, timeoutMs: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--offline") out.offline = true;
    else if (arg === "--row" && argv[i + 1]) out.rows.push(argv[(i += 1)]);
    else if (arg === "--timeout" && Number(argv[i + 1]) > 0) out.timeoutMs = Number(argv[(i += 1)]);
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`unknown option "${arg}" (try --help)`);
  }
  return out;
}

/** A catalogue row for an id: the real tool when the catalogue has it, else a bare row (the chain is the file's). */
function toolOf(id, toolchain) {
  return toolchain.toolById(id) || { id };
}

/** Resolve one row; never throws. `ms` is the wall time of the whole chain. */
async function probeRow(id, deps) {
  const { vendor, catalog, toolchain, store, offline, timeoutMs, fetchImpl, now } = deps;
  const started = now();
  try {
    const chain = catalog.chainOfTool(toolOf(id, toolchain));
    if (!chain?.sources?.length)
      return { id, ok: false, error: "no source chain", ms: now() - started };
    const got = await vendor.resolveLatest(id, chain.sources, {
      store,
      offline,
      ...(timeoutMs ? { timeoutMs } : {}),
      ...(fetchImpl ? { fetchImpl } : {}),
    });
    return {
      id,
      ok: Boolean(got.ok),
      source: got.source || "",
      version: got.version || "",
      via: got.via || "",
      error: got.ok ? "" : got.error || "no answer",
      ms: now() - started,
    };
  } catch (error) {
    return {
      id,
      ok: false,
      error: String(error?.message || error).slice(0, 160),
      ms: now() - started,
    };
  }
}

function formatTable(results) {
  const head = ["row", "source", "version", "via", "ms"];
  const lines = results.map((r) => [
    r.id,
    r.ok ? r.source : "NO ANSWER",
    r.ok ? r.version : r.error,
    r.ok ? r.via : "-",
    String(r.ms),
  ]);
  const widths = head.map((h, c) => Math.max(h.length, ...lines.map((l) => l[c].length)));
  const pad = (cols) => cols.map((v, c) => v.padEnd(widths[c])).join("  ");
  return [pad(head), pad(widths.map((w) => "-".repeat(w))), ...lines.map(pad)].join("\n");
}

async function main(argv = process.argv.slice(2), overrides = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(
      "usage: node scripts/sources-probe.cjs [--row <id>]... [--offline] [--timeout <ms>]",
    );
    return 0;
  }
  const electron = path.resolve(__dirname, "..", "electron");
  const vendor = overrides.vendor || require(path.join(electron, "vendor-sources.cjs"));
  const catalog = overrides.catalog || require(path.join(electron, "installer-catalog.cjs"));
  const toolchain = overrides.toolchain || require(path.join(electron, "toolchain.cjs"));
  const loaded = vendor.loadToolSources(overrides.dir ? { dir: overrides.dir } : {});
  for (const message of loaded.errors) console.log(`data file problem: ${message}`);
  const known = Object.keys(loaded.rows);
  const wanted = args.rows.length ? args.rows : known;
  const unknown = wanted.filter((id) => !known.includes(id));
  for (const id of unknown) console.log(`no data-file row named "${id}"`);
  const root = overrides.root ?? process.env.FRIDAY_ROOT;
  const deps = {
    vendor,
    catalog,
    toolchain,
    store: root ? vendor.storeFor(root) : null,
    offline: args.offline,
    timeoutMs: args.timeoutMs,
    fetchImpl: overrides.fetchImpl || null,
    now: overrides.now || Date.now,
  };
  const results = [];
  for (const id of wanted.filter((w) => known.includes(w))) results.push(await probeRow(id, deps));
  if (results.length) console.log(formatTable(results));
  const failed = results.filter((r) => !r.ok);
  console.log(
    `${results.length - failed.length}/${results.length} rows answered${args.offline ? " (offline: cache and pins only)" : ""}` +
      (failed.length ? `; no answer: ${failed.map((r) => r.id).join(", ")}` : ""),
  );
  return failed.length || unknown.length || loaded.errors.length || !results.length ? 1 : 0;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(String(error?.message || error));
      process.exit(2);
    },
  );
}

module.exports = { parseArgs, probeRow, formatTable, main };
