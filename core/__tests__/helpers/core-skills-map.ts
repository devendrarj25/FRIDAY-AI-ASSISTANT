// Generated once when the 53 first-round skills were merged into 20; do not edit by hand.
export const MERGED: Record<string, string> = {
  "in-gst-calc": "in-tax-invoice",
  "in-invoice-total": "in-tax-invoice",
  "in-inr-words": "in-tax-invoice",
  "in-emi-sip": "in-finance-calc",
  "in-fd-compound": "in-finance-calc",
  "in-split-bill": "in-finance-calc",
  "in-percent-calc": "in-finance-calc",
  "ops-date-calc": "cal-date-time",
  "ops-workdays": "cal-date-time",
  "cal-age-calc": "cal-date-time",
  "ops-timestamp": "cal-date-time",
  "ops-time-zone": "cal-date-time",
  "cal-ics-event": "cal-planner",
  "cal-time-blocks": "cal-planner",
  "ops-cron-explain": "cal-planner",
  "ops-unit-convert": "ops-convert",
  "ops-size-convert": "ops-convert",
  "ops-download-time": "ops-convert",
  "dev-base-convert": "ops-convert",
  "ops-port-lookup": "ops-network-tools",
  "ops-ip-inspect": "ops-network-tools",
  "ops-cidr-calc": "ops-network-tools",
  "web-http-status": "ops-network-tools",
  "ops-file-type": "ops-file-path-check",
  "ops-win-path": "ops-file-path-check",
  "ops-log-triage": "ops-log-doctor",
  "ops-exit-code": "ops-log-doctor",
  "dev-json-repair": "dev-json-tools",
  "dev-json-query": "dev-json-tools",
  "dev-regex-test": "dev-text-tools",
  "dev-text-diff": "dev-text-tools",
  "dev-token-decode": "dev-decode-tools",
  "dev-uuid-inspect": "dev-decode-tools",
  "ops-hash-check": "dev-decode-tools",
  "dev-env-audit": "dev-project-checks",
  "dev-commit-lint": "dev-project-checks",
  "ops-version-compare": "dev-project-checks",
  "saf-secret-scan": "saf-content-scan",
  "saf-pii-redact": "saf-content-scan",
  "saf-injection-scan": "saf-content-scan",
  "saf-url-risk": "saf-link-check",
  "web-url-clean": "saf-link-check",
  "doc-text-clean": "doc-text-tools",
  "doc-word-stats": "doc-text-tools",
  "doc-case-convert": "doc-text-tools",
  "doc-markdown-toc": "doc-text-tools",
  "dat-csv-profile": "dat-table-tools",
  "dat-table-convert": "dat-table-tools",
  "dat-stats": "dat-table-tools",
};

import fs from "node:fs";
import path from "node:path";

/** Every tool (part) of every built-in skill, found by reading the manifests: part id -> skill id. */
export const PART_OF: Record<string, string> = (() => {
  const dir = path.resolve(__dirname, "../../../skills/core");
  const out: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name, "skill.json");
    if (!entry.isDirectory() || !fs.existsSync(file)) continue;
    const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as { parts?: { id: string }[] };
    for (const part of manifest.parts ?? []) out[part.id] = entry.name;
  }
  return out;
})();
