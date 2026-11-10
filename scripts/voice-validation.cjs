/**
 * Voice hardware validation: scoring and the report check, with no hardware in them.
 *
 * The scenarios and their numeric criteria are config/voice-hardware-validation.json. A person runs them on the
 * installed Windows app with real devices and writes the measured numbers into a report file; this module scores
 * speech transcripts (word error rate), and judges a report against the criteria. It never invents a number and
 * never calls a run verified unless the report itself says the installed, packaged app ran on Windows.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const CATALOG_FILE = path.join(ROOT, "config", "voice-hardware-validation.json");
const PHRASES_FILE = path.join(ROOT, "testing", "voice-hardware", "phrases.json");

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const catalog = () => readJson(CATALOG_FILE);
const phrases = () => readJson(PHRASES_FILE);

/** Words of a sentence for scoring: NFC, lower case, punctuation removed, split on spaces. */
function words(text) {
  return String(text || "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Word-level edit distance (substitutions, insertions, deletions). */
function editDistance(reference, hypothesis) {
  const a = reference;
  const b = hypothesis;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(
        previous[j] + 1,
        row[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = row;
  }
  return previous[b.length];
}

/**
 * Word error rate per group and overall: edits divided by the words that were said. A phrase with no transcript
 * counts every word as missed, so skipping a hard phrase cannot lower the rate.
 */
function scoreTranscripts(phraseList, transcripts) {
  const groups = {};
  const missing = [];
  for (const phrase of phraseList) {
    const reference = words(phrase.text);
    const hypothesis = Object.hasOwn(transcripts, phrase.id) ? words(transcripts[phrase.id]) : [];
    if (!Object.hasOwn(transcripts, phrase.id)) missing.push(phrase.id);
    const g = (groups[phrase.group] ??= { words: 0, edits: 0, phrases: 0 });
    g.words += reference.length;
    g.edits += editDistance(reference, hypothesis);
    g.phrases += 1;
  }
  const rate = (g) => (g && g.words ? Number((g.edits / g.words).toFixed(4)) : null);
  const total = Object.values(groups).reduce(
    (sum, g) => ({ words: sum.words + g.words, edits: sum.edits + g.edits }),
    { words: 0, edits: 0 },
  );
  return {
    phrases: phraseList.length - missing.length,
    hindiWer: rate(groups.hindi),
    hinglishWer: rate(groups.hinglish),
    englishWer: rate(groups.english),
    overallWer: total.words ? Number((total.edits / total.words).toFixed(4)) : null,
    missing,
  };
}

/** Judge measured numbers against a scenario's criteria. A metric that was not measured fails. */
function judgeScenario(scenario, measured) {
  const rows = scenario.criteria.map((criterion) => {
    const value = measured ? measured[criterion.metric] : undefined;
    const known = typeof value === "number" && Number.isFinite(value);
    let pass = known;
    if (known && criterion.max !== undefined) pass = value <= criterion.max;
    if (known && criterion.min !== undefined) pass = pass && value >= criterion.min;
    return {
      metric: criterion.metric,
      value: known ? value : null,
      limit: criterion.max !== undefined ? `<= ${criterion.max}` : `>= ${criterion.min}`,
      pass,
    };
  });
  return { id: scenario.id, pass: rows.every((r) => r.pass), rows };
}

/** Is this machine block proof that the installed Windows app ran? Each missing piece is named. */
function machineProblems(machine) {
  const problems = [];
  const m = machine || {};
  if (m.os !== "win32")
    problems.push("machine.os must be win32 (this report was not made on Windows)");
  if (m.appPackaged !== true)
    problems.push(
      "machine.appPackaged must be true (the installed or portable build, not a dev run)",
    );
  if (!String(m.appVersion || "").trim()) problems.push("machine.appVersion is empty");
  if (!String(m.inputDevice || "").trim())
    problems.push("machine.inputDevice is empty (name the real microphone)");
  if (!String(m.outputDevice || "").trim())
    problems.push("machine.outputDevice is empty (name the real speaker or headphones)");
  if (!String(m.testedBy || "").trim()) problems.push("machine.testedBy is empty");
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(m.date || "")))
    problems.push("machine.date must be an ISO date");
  return problems;
}

/** A blank report with every scenario waiting for its numbers. */
function blankReport() {
  const scenarios = {};
  for (const scenario of catalog().scenarios) {
    scenarios[scenario.id] = {
      status: "not-run",
      measured: Object.fromEntries(scenario.criteria.map((c) => [c.metric, null])),
      evidence: "",
    };
  }
  return {
    version: 1,
    machine: {
      os: "",
      osVersion: "",
      appPackaged: false,
      appVersion: "",
      cpu: "",
      ramGb: null,
      gpu: "",
      inputDevice: "",
      outputDevice: "",
      testedBy: "",
      date: "",
    },
    scenarios,
  };
}

/**
 * Judge a whole report. `verified` is true only when the machine block proves an installed Windows run AND every
 * scenario's measured numbers meet every criterion. Anything else says exactly what is missing.
 */
function checkReport(report) {
  const cat = catalog();
  const problems = machineProblems(report && report.machine);
  const results = cat.scenarios.map((scenario) => {
    const entry = (report && report.scenarios && report.scenarios[scenario.id]) || {};
    const judged = judgeScenario(scenario, entry.measured);
    const evidenced = String(entry.evidence || "").trim().length > 0;
    return {
      ...judged,
      title: scenario.title,
      evidenced,
      ran: entry.status !== "not-run" && entry.status !== undefined,
      pass: judged.pass && evidenced,
    };
  });
  const failed = results.filter((r) => !r.pass);
  return {
    verified: problems.length === 0 && failed.length === 0,
    machineProblems: problems,
    results,
    summary: `${results.length - failed.length} of ${results.length} scenarios meet their criteria`,
  };
}

/**
 * A long session from the app's soak record (Voice diagnostics > copy diagnostics, "soak"): the numbers the
 * session-30-minutes scenario asks for. `samples` are one per minute; `turns` carry the first-sound time.
 */
function analyseSoak(record) {
  const samples = (record && record.samples) || [];
  const turns = (record && record.turns) || [];
  const startedAt = record && record.startedAt;
  const endedAt = record && record.endedAt;
  const heap = samples.map((s) => s.heapMb).filter((v) => typeof v === "number");
  const times = turns.map((t) => t.firstSoundMs).filter((v) => typeof v === "number" && v >= 0);
  const median = (list) => {
    if (!list.length) return null;
    const sorted = [...list].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  const fifth = Math.max(1, Math.floor(times.length / 5));
  const early = median(times.slice(0, fifth));
  const late = median(times.slice(-fifth));
  return {
    durationMinutes:
      typeof startedAt === "number" && typeof endedAt === "number"
        ? Number(((endedAt - startedAt) / 60000).toFixed(1))
        : null,
    turns: turns.length,
    stuckInterventions: Number((record && record.interventions) || 0),
    unrecoveredFaults: Number((record && record.unrecoveredFaults) || 0),
    heapGrowthMb: heap.length >= 2 ? Number((heap[heap.length - 1] - heap[0]).toFixed(1)) : null,
    firstSoundLateVsEarlyRatio: early && late ? Number((late / early).toFixed(2)) : null,
  };
}

module.exports = {
  catalog,
  phrases,
  words,
  editDistance,
  scoreTranscripts,
  judgeScenario,
  machineProblems,
  blankReport,
  checkReport,
  analyseSoak,
};
