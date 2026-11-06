#!/usr/bin/env node
/**
 * FRIDAY - when does setup look for a newer release?
 *
 * Setup, Doctor and the build keep what is installed when it is supported, and take the newest
 * official release when the source has one: winget for the PC toolchain, PyPI for the Python
 * packages, ollama.com for the local chat engine. Asking each source costs time, so each question is
 * asked at most once a day per topic (a stamp in .cache/setup-update.json), and:
 *
 *   FRIDAY_SETUP_UPDATE=0      never look for a newer release (floors only, as before)
 *   FRIDAY_SETUP_UPDATE=1      look now, whatever the stamp says
 *   hosted CI, FRIDAY_OFFLINE=1  never look: a hosted build stays reproducible, an offline one cannot
 *
 * A newer release that cannot be installed never fails a step: the installed, supported one stays.
 * `scripts/setup-windows.ps1` applies the same rule with its own stamp for the PC toolchain.
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const DAY_MS = 24 * 60 * 60 * 1000;

function stampFile(root = ROOT) {
  return path.join(root, ".cache", "setup-update.json");
}

/** "off" (never), "force" (now) or "daily" (once a day per topic). */
function mode(env = process.env) {
  if (env.CI || env.GITHUB_ACTIONS) return "off";
  if (String(env.FRIDAY_OFFLINE || "") === "1") return "off";
  const asked = String(env.FRIDAY_SETUP_UPDATE ?? "")
    .trim()
    .toLowerCase();
  if (asked === "0" || asked === "false" || asked === "off") return "off";
  if (asked === "1" || asked === "true" || asked === "force") return "force";
  return "daily";
}

function readStamps(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(stampFile(root), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Is it time to look for a newer release of `topic`? */
function due(topic, { env = process.env, root = ROOT, now = Date.now() } = {}) {
  const how = mode(env);
  if (how === "off") return false;
  if (how === "force") return true;
  const last = Date.parse(String(readStamps(root)[topic] || ""));
  return !Number.isFinite(last) || now - last >= DAY_MS || now < last;
}

/** Record that `topic` was looked at, so the next ask within a day is skipped. */
function markChecked(topic, { root = ROOT, now = Date.now() } = {}) {
  try {
    const stamps = readStamps(root);
    stamps[topic] = new Date(now).toISOString();
    fs.mkdirSync(path.dirname(stampFile(root)), { recursive: true });
    fs.writeFileSync(stampFile(root), `${JSON.stringify(stamps, null, 2)}\n`);
  } catch {
    /* without a stamp the next run simply asks again */
  }
}

module.exports = { DAY_MS, mode, due, markChecked, stampFile };
