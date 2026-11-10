#!/usr/bin/env node
/**
 * Voice hardware validation, from the command line. Nothing here touches a microphone or a speaker: it prepares
 * the checklist, scores the speech transcripts a person collected, and judges the report. See
 * config/voice-hardware-validation.json for the scenarios and testing/voice-hardware/phrases.json for the phrases.
 *
 *   node scripts/voice-hardware-validate.cjs plan                      print the scenarios, steps and criteria
 *   node scripts/voice-hardware-validate.cjs init REPORT.json          write a blank report to fill in
 *   node scripts/voice-hardware-validate.cjs score-stt --transcripts T.json [--report REPORT.json]
 *   node scripts/voice-hardware-validate.cjs soak --record SOAK.json [--report REPORT.json]
 *   node scripts/voice-hardware-validate.cjs check REPORT.json         exit 0 only for a verified report
 */
"use strict";

const fs = require("node:fs");
const lib = require("./voice-validation.cjs");

const args = process.argv.slice(2);
const command = args[0] || "plan";
const flag = (name) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

function mergeMeasured(reportFile, id, measured) {
  const report = fs.existsSync(reportFile) ? read(reportFile) : lib.blankReport();
  const entry = (report.scenarios[id] ??= { status: "not-run", measured: {}, evidence: "" });
  entry.measured = { ...entry.measured, ...measured };
  write(reportFile, report);
}

if (command === "plan") {
  for (const scenario of lib.catalog().scenarios) {
    console.log(`\n${scenario.id} - ${scenario.title}   (needs: ${scenario.needs.join(", ")})`);
    scenario.steps.forEach((step, index) => console.log(`  ${index + 1}. ${step}`));
    for (const c of scenario.criteria)
      console.log(`  pass when ${c.metric} ${c.max !== undefined ? `<= ${c.max}` : `>= ${c.min}`}`);
  }
  console.log(`\n${lib.catalog().evidenceRule}`);
} else if (command === "init") {
  const file = args[1];
  if (!file) throw new Error("usage: init REPORT.json");
  if (fs.existsSync(file)) throw new Error(`${file} exists; it is not overwritten`);
  write(file, lib.blankReport());
  console.log(`wrote ${file}: fill machine and each scenario's measured numbers and evidence`);
} else if (command === "score-stt") {
  const transcripts = read(
    flag("transcripts") ||
      (() => {
        throw new Error("--transcripts FILE is required");
      })(),
  );
  const score = lib.scoreTranscripts(lib.phrases().phrases, transcripts);
  console.log(JSON.stringify(score, null, 2));
  if (flag("report"))
    mergeMeasured(flag("report"), "stt-hindi-hinglish", {
      phrases: score.phrases,
      hindiWer: score.hindiWer,
      hinglishWer: score.hinglishWer,
      englishWer: score.englishWer,
    });
} else if (command === "soak") {
  const result = lib.analyseSoak(
    read(
      flag("record") ||
        (() => {
          throw new Error("--record FILE is required");
        })(),
    ),
  );
  console.log(JSON.stringify(result, null, 2));
  if (flag("report")) mergeMeasured(flag("report"), "session-30-minutes", result);
} else if (command === "check") {
  const verdict = lib.checkReport(read(args[1]));
  for (const r of verdict.results) {
    console.log(
      `${r.pass ? "PASS" : "FAIL"}  ${r.id}  ${r.title}${r.evidenced ? "" : "  (no evidence noted)"}`,
    );
    for (const row of r.rows.filter((x) => !x.pass))
      console.log(
        `        ${row.metric}: ${row.value === null ? "not measured" : row.value} (needs ${row.limit})`,
      );
  }
  for (const problem of verdict.machineProblems) console.log(`MACHINE  ${problem}`);
  console.log(verdict.summary);
  console.log(
    verdict.verified
      ? "VERIFIED on the installed Windows app"
      : "UNVERIFIED - not a hardware verification",
  );
  process.exitCode = verdict.verified ? 0 : 1;
} else {
  throw new Error(`unknown command ${command}`);
}
