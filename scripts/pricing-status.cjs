#!/usr/bin/env node
// FRIDAY - is the official pricing / free-plan knowledge snapshot still fresh?
//
// electron/model-access.cjs classifies provider models from a documentation
// snapshot (Groq free plan, Gemini free tier, Mistral / OpenAI / Anthropic /
// DeepSeek / Perplexity pricing ...). It fails CLOSED once that snapshot is
// older than its TTL, so a stale snapshot silently turns models into "unknown".
// This is the one place that reports it - tests never depend on today's date.
//
//   node scripts/pricing-status.cjs            -> print status, exit 1 if expired
//   node scripts/pricing-status.cjs --warn 4   -> also exit 1 when <= 4 days remain
//   node scripts/pricing-status.cjs --json     -> machine readable
const path = require("node:path");
const access = require(path.resolve(__dirname, "..", "electron", "model-access.cjs"));

const DAY = 24 * 60 * 60 * 1000;
const args = process.argv.slice(2);
const warnIdx = args.indexOf("--warn");
const warnDays = warnIdx >= 0 ? Number(args[warnIdx + 1]) || 0 : 0;

const now = Date.now();
const sources = access.knowledgeCatalogue(now).map((entry) => {
  const expiresAt = Number(entry.checkedAt) + Number(entry.ttlMs);
  const daysLeft = Math.floor((expiresAt - now) / DAY);
  const state = daysLeft < 0 ? "expired" : daysLeft <= warnDays ? "expiring" : "fresh";
  return {
    id: entry.id,
    source: entry.source,
    checkedAt: new Date(entry.checkedAt).toISOString().slice(0, 10),
    expiresAt: new Date(expiresAt).toISOString().slice(0, 10),
    daysLeft,
    state,
  };
});
const oldest = sources.reduce((a, b) => (a.daysLeft < b.daysLeft ? a : b));
const state = oldest.state;
const report = {
  state,
  checkedAt: oldest.checkedAt,
  expiresAt: oldest.expiresAt,
  daysLeft: oldest.daysLeft,
  oldest: oldest.id,
  sources,
  file: "electron/model-access.cjs",
  how: "Re-read each source page, fix any table that changed, then move that source's checkedAt. An empty page must not move a date.",
};

if (args.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`pricing knowledge: ${state.toUpperCase()} (oldest: ${oldest.id})`);
  console.log(
    `  checked ${report.checkedAt}, expires ${report.expiresAt} (${report.daysLeft} day(s) left)`,
  );
  for (const row of sources) {
    console.log(`  ${row.id}: ${row.state} · ${row.checkedAt} · ${row.daysLeft} day(s)`);
  }
  if (state !== "fresh") console.log(`  fix: ${report.how}`);
}
process.exit(state === "fresh" ? 0 : 1);
