/**
 * What the boot screen waits for, and in which words.
 *
 * The main process reports one `boot()` step for every real piece of start-up work (the kernel, the workspace scan,
 * plugins, runtimes, providers, acceleration, the startup flow). This module names those pieces once: the stages
 * the boot screen lists, how much each one weighs in the progress bar, which reported label belongs to which stage,
 * and why this launch is a launch (the first one, a restart the owner asked for, a start at sign-in, or a normal
 * start, which also covers the first open after the PC was shut down). It is pure so a test can read it.
 *
 * "FRIDAY ready" is the last step the startup flow reports (electron/startup.cjs): the boot screen leaves when it
 * arrives, not after a fixed number of seconds.
 */
"use strict";

/** Stage ids, in the order they usually finish. `weight` shares the progress bar; `needsWorkspace` stages are
 *  skipped when the owner has not chosen a FRIDAY folder yet. */
const STAGES = [
  { id: "install", label: "Detecting installation", weight: 1, match: /^Detecting installation/ },
  {
    id: "services",
    label: "Starting the local AI service",
    weight: 4,
    match: /^Starting services/,
  },
  {
    id: "workspace",
    label: "Opening your FRIDAY folder",
    weight: 2,
    match: /^(Detecting workspace|Reading workspace\.json)/,
  },
  {
    id: "scan",
    label: "Scanning folders",
    weight: 2,
    needsWorkspace: true,
    match: /^(Scanning folders|Rebuilding registry)/,
  },
  {
    id: "capabilities",
    label: "Loading capabilities",
    weight: 3,
    needsWorkspace: true,
    match: /^Loading workflows/,
  },
  { id: "runtimes", label: "Detecting runtimes", weight: 2, match: /^Detecting runtimes/ },
  { id: "providers", label: "Detecting AI providers", weight: 2, match: /^Detecting AI providers/ },
  {
    id: "acceleration",
    label: "Checking acceleration",
    weight: 2,
    match: /^Checking acceleration/,
  },
  { id: "state", label: "Restoring your state", weight: 2, match: /^Loading persistent state/ },
  { id: "verify", label: "Verifying the AI service", weight: 2, match: /^Verifying kernel/ },
  { id: "models", label: "Restoring models", weight: 2, match: /^Restoring models/ },
  { id: "ready", label: "Getting FRIDAY ready", weight: 3, match: /^FRIDAY ready/ },
];

/** The stage a reported boot label belongs to, or null (a detail line such as "Loading agents"). */
function stageFor(label) {
  const text = String(label || "");
  const hit = STAGES.find((stage) => stage.match.test(text));
  return hit ? hit.id : null;
}

/** Why this launch is a launch. `firstRun` is "no window state saved yet"; `loginArg` is the sign-in marker. */
function bootModeFor({ argv = [], firstRun = false, loginArg = "--friday-login" } = {}) {
  const list = Array.isArray(argv) ? argv : [];
  if (firstRun) return "first-run";
  if (list.includes("--friday-restart=1")) return "restart";
  if (list.includes(loginArg)) return "sign-in";
  return "start";
}

const MODE_TEXT = {
  "first-run": {
    title: "Setting FRIDAY up for the first time",
    detail:
      "This first start prepares your folders, models and voice. Next starts are much faster.",
  },
  restart: { title: "Restarting FRIDAY", detail: "Bringing every part back up." },
  "sign-in": { title: "Starting FRIDAY with Windows", detail: "Getting ready in the background." },
  start: { title: "Starting FRIDAY", detail: "Loading everything she needs." },
};

/** The plan the boot screen shows: stages (without the matcher, which is a main-process detail) and the words. */
function planFor(mode) {
  const text = MODE_TEXT[mode] || MODE_TEXT.start;
  return {
    mode: MODE_TEXT[mode] ? mode : "start",
    title: text.title,
    detail: text.detail,
    stages: STAGES.map(({ id, label, weight, needsWorkspace }) => ({
      id,
      label,
      weight,
      ...(needsWorkspace ? { needsWorkspace: true } : {}),
    })),
  };
}

module.exports = { STAGES, MODE_TEXT, stageFor, bootModeFor, planFor };
