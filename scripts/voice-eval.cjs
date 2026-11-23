#!/usr/bin/env node
/**
 * Held-out speech evaluation, from the command line. No audio, no model, no network: it checks a manifest of
 * recordings (listed by SHA-256, kept outside the repository), freezes the test set, and scores transcripts
 * against it with the same pure rules the tests pin (src/lib/friday/voice-engine/voice-eval-set.ts). It
 * refuses to print a number for anything the manifest does not list.
 *
 *   node scripts/voice-eval.cjs validate [--manifest FILE]
 *   node scripts/voice-eval.cjs summary  [--manifest FILE]
 *   node scripts/voice-eval.cjs freeze   [--manifest FILE] [--write]    lock the test set (never overwrites a lock)
 *   node scripts/voice-eval.cjs hash-references --references REFS.json   print the referenceSha256 of each sentence
 *   node scripts/voice-eval.cjs score --references REFS.json --hypotheses HYPS.json
 *                                     [--manifest FILE] [--split test|dev] [--engine NAME] [--out FILE]
 *
 * Exit: 0 done, 1 manifest invalid or bad usage, 2 refused (no number is printed). The default manifest is
 * config/voice/eval-manifest.json, a catalogue with no items; the owner's real manifest, references and
 * hypotheses stay on his PC and are passed by path.
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { fileURLToPath, pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_MANIFEST = path.join(ROOT, "config", "voice", "eval-manifest.json");

const sha256 = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

let hooked = false;
/** Load a TypeScript module of this repository (types stripped, extensionless imports resolved). */
async function loadTs(relative) {
  if (
    typeof Module.registerHooks !== "function" ||
    typeof Module.stripTypeScriptTypes !== "function"
  ) {
    throw new Error(
      "this script needs Node 22.19 or newer (module.registerHooks, stripTypeScriptTypes)",
    );
  }
  if (!hooked) {
    hooked = true;
    Module.registerHooks({
      resolve(specifier, context, next) {
        if (/^\.{1,2}\//.test(specifier) && !path.extname(specifier) && context.parentURL) {
          const base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
          for (const tail of [".ts", "/index.ts"]) {
            if (fs.existsSync(base + tail)) return next(pathToFileURL(base + tail).href, context);
          }
        }
        return next(specifier, context);
      },
      load(url, context, next) {
        if (url.startsWith("file:") && url.endsWith(".ts")) {
          const source = fs.readFileSync(fileURLToPath(url), "utf8");
          const quiet = process.emitWarning;
          process.emitWarning = () => {};
          try {
            return {
              format: "module",
              shortCircuit: true,
              source: Module.stripTypeScriptTypes(source, { mode: "transform" }),
            };
          } finally {
            process.emitWarning = quiet;
          }
        }
        return next(url, context);
      },
    });
  }
  return import(pathToFileURL(path.join(ROOT, relative)).href);
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--write") flags.write = true;
    else if (arg.startsWith("--")) flags[arg.slice(2)] = argv[(i += 1)];
    else positional.push(arg);
  }
  return { flags, positional };
}

const readJson = (file) => {
  const text = fs.readFileSync(file, "utf8");
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
};

async function main(argv, out = console.log) {
  const { flags, positional } = parseArgs(argv);
  const command = positional[0] || "validate";
  const lib = await loadTs("src/lib/friday/voice-engine/voice-eval-set.ts");
  const manifestFile = flags.manifest ? path.resolve(flags.manifest) : DEFAULT_MANIFEST;

  if (command === "hash-references") {
    if (!flags.references) return fail("--references FILE is required", 1, out);
    const refs = readJson(flags.references);
    out(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(refs).map(([id, t]) => [id, sha256(String(t).normalize("NFC"))]),
        ),
        null,
        2,
      ),
    );
    return 0;
  }
  if (!["validate", "summary", "freeze", "score"].includes(command)) {
    return fail(
      `unknown command "${command}" (validate, summary, freeze, hash-references, score)`,
      1,
      out,
    );
  }
  if (!fs.existsSync(manifestFile)) return fail(`manifest not found: ${manifestFile}`, 1, out);
  const raw = readJson(manifestFile);

  if (command === "score") {
    if (!flags.references || !flags.hypotheses)
      return fail("--references and --hypotheses are required", 1, out);
    const result = lib.scoreHeldOut({
      manifest: raw,
      references: readJson(flags.references),
      hypotheses: readJson(flags.hypotheses),
      sha256,
      ...(flags.split ? { split: flags.split } : {}),
      ...(flags.engine ? { engine: flags.engine } : {}),
    });
    if (result.status === "refused") {
      out("REFUSED: no number is reported");
      for (const reason of result.reasons) out(`  - ${reason}`);
      return 2;
    }
    const json = `${JSON.stringify(result.report, null, 2)}\n`;
    if (flags.out) fs.writeFileSync(flags.out, json);
    out(json.trimEnd());
    return 0;
  }

  const checked = lib.validateManifest(raw, sha256);
  if (!checked.manifest) {
    out(`INVALID: ${checked.problems.length} problem(s)`);
    for (const problem of checked.problems) out(`  - ${problem}`);
    return 1;
  }
  if (command === "validate") {
    const n = checked.manifest.items.length;
    out(
      n
        ? `VALID: ${n} item(s), test set ${checked.manifest.testLock ? "frozen" : "not frozen"}`
        : "VALID, but it lists no items: nothing can be scored (UNVERIFIED)",
    );
    return 0;
  }
  if (command === "summary") {
    out(JSON.stringify(lib.manifestSummary(checked.manifest), null, 2));
    return 0;
  }
  // freeze
  if (checked.manifest.testLock)
    return fail(
      `the test set is already frozen (${checked.manifest.testLock.frozenOn}); a lock is never overwritten`,
      1,
      out,
    );
  const tests = checked.manifest.items.filter((i) => i.split === "test").length;
  if (!tests) return fail("there are no test items to freeze", 1, out);
  const lock = {
    sha256: lib.testSetLock(checked.manifest, sha256),
    items: tests,
    frozenOn: new Date().toISOString().slice(0, 10),
  };
  if (flags.write) {
    raw.testLock = lock;
    fs.writeFileSync(manifestFile, `${JSON.stringify(raw, null, 2)}\n`);
    out(`froze ${tests} test item(s) in ${manifestFile}`);
  } else {
    out(JSON.stringify(lock, null, 2));
    out("(not written: add --write to store it in the manifest)");
  }
  return 0;
}

function fail(message, code, out) {
  out(message);
  return code;
}

module.exports = { loadTs, sha256, main };

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error.message);
      process.exit(1);
    },
  );
}
