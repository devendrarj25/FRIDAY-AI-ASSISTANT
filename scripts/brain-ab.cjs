#!/usr/bin/env node
/**
 * FRIDAY · offline A/B of the Brain benchmark bank across two git refs.
 *
 *   node scripts/brain-ab.cjs <refA> <refB> [--out <folder>]
 *
 * Each ref is checked out as a throwaway worktree OUTSIDE the repository, the bank is run there
 * (`core/__tests__/benchmark-report.test.ts`), and the two runs are compared task by task in this checkout
 * (`core/__tests__/benchmark-compare.test.ts`). Nothing in the repository is changed, no workflow is
 * touched, no model or network is used. A ref that does not contain the bank cannot be compared, and the
 * script says so instead of inventing a result. Results go to a temporary folder (or --out), never to the
 * repository or to user data.
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const BANK = "src/lib/friday/self/benchmark-bank.ts";

function git(args, cwd = ROOT) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function parseArgs(argv) {
  const refs = [];
  let out = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") out = argv[(i += 1)] || null;
    else refs.push(argv[i]);
  }
  return { refs, out };
}

function runIn(dir, ref, outFile) {
  const result = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "node_modules", "vitest", "vitest.mjs"),
      "run",
      "core/__tests__/benchmark-report.test.ts",
    ],
    {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, FRIDAY_BENCH_OUT: outFile, FRIDAY_BENCH_COMMIT: ref },
    },
  );
  return result.status === 0 && fs.existsSync(outFile);
}

function main() {
  const { refs, out } = parseArgs(process.argv.slice(2));
  if (refs.length !== 2) {
    console.error("usage: node scripts/brain-ab.cjs <refA> <refB> [--out <folder>]");
    return 2;
  }
  const work = fs.mkdtempSync(path.join(out ? path.resolve(out) : os.tmpdir(), "friday-brain-ab-"));
  const trees = [];
  const files = [];
  try {
    for (const [index, ref] of refs.entries()) {
      const label = index === 0 ? "A" : "B";
      const tree = path.join(work, label);
      const added = git(["worktree", "add", "--detach", tree, ref]);
      if (added.status !== 0) {
        console.error(`${label} (${ref}): could not check out: ${added.stderr.trim()}`);
        return 1;
      }
      trees.push(tree);
      if (!fs.existsSync(path.join(tree, BANK))) {
        console.error(
          `${label} (${ref}): this ref has no benchmark bank (${BANK}), so it cannot be compared.`,
        );
        return 1;
      }
      fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(tree, "node_modules"), "dir");
      const file = path.join(work, `${label}.json`);
      if (!runIn(tree, ref, file)) {
        console.error(`${label} (${ref}): the bank did not run to the end.`);
        return 1;
      }
      files.push(file);
    }
    const report = path.join(work, "report.json");
    const compare = spawnSync(
      process.execPath,
      [
        path.join(ROOT, "node_modules", "vitest", "vitest.mjs"),
        "run",
        "core/__tests__/benchmark-compare.test.ts",
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          FRIDAY_BENCH_A: files[0],
          FRIDAY_BENCH_B: files[1],
          FRIDAY_BENCH_REPORT: report,
        },
      },
    );
    if (compare.status !== 0 || !fs.existsSync(report)) {
      console.error("the comparison did not run to the end.");
      return 1;
    }
    const rows = JSON.parse(fs.readFileSync(report, "utf8"));
    const changed = rows.filter((row) => row.verdict !== "no measurable difference");
    console.log(`A = ${refs[0]}   B = ${refs[1]}   categories compared: ${rows.length}`);
    for (const row of rows) {
      console.log(
        `${row.verdict.padEnd(26)} ${row.id.padEnd(28)} A ${row.passA}/${row.tasks}  B ${row.passB}/${row.tasks}  p=${row.p.toFixed(3)}`,
      );
    }
    console.log(
      changed.length
        ? `${changed.length} category(ies) differ; the rest show no measurable difference at this sample size.`
        : "No category shows a measurable difference at this sample size.",
    );
    console.log(`Raw runs and report: ${work}`);
    return 0;
  } finally {
    for (const tree of trees) git(["worktree", "remove", "--force", tree]);
    git(["worktree", "prune"]);
  }
}

process.exitCode = main();
