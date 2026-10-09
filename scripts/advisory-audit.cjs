#!/usr/bin/env node
/**
 * Dependency advisory policy.
 *
 * High, critical, and unknown severity fail the run unless the advisory id
 * is listed in config/advisory-allow.json and that entry's expiry is still
 * ahead of the clock. Moderate and low severities warn and do not fail.
 * A missing audit tool fails the run. The clock is injectable so a test
 * does not depend on today's date.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const DEFAULT_ALLOW = path.join(root, "config", "advisory-allow.json");

function parseClock(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : null;
}

function loadAllow(file, nowMs) {
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  const active = new Set();
  const ignored = [];
  for (const entry of doc.entries || []) {
    const id = entry && typeof entry.id === "string" ? entry.id.trim() : "";
    const expires = parseClock(entry && entry.expires);
    if (!id || expires == null) {
      ignored.push(entry);
      continue;
    }
    if (expires > nowMs) active.add(id);
  }
  return { active, ignored };
}

function ghsaIds(via) {
  const ids = [];
  if (!Array.isArray(via)) return ids;
  for (const item of via) {
    if (!item || typeof item !== "object") continue;
    for (const field of [item.url, item.source, item.title]) {
      if (typeof field !== "string") continue;
      const match = field.match(/GHSA-[a-z0-9-]+/i);
      if (match) ids.push(match[0]);
    }
  }
  return [...new Set(ids)];
}

function classifyNpm(report) {
  const findings = [];
  const vulns = report && report.vulnerabilities ? report.vulnerabilities : {};
  for (const [name, row] of Object.entries(vulns)) {
    const severity = String((row && row.severity) || "unknown").toLowerCase();
    const ids = ghsaIds(row && row.via);
    const id = ids[0] || `npm:${name}`;
    findings.push({ ecosystem: "npm", id, ids: ids.length ? ids : [id], package: name, severity });
  }
  return findings;
}

function classifyPip(report) {
  const findings = [];
  const deps = report && Array.isArray(report.dependencies) ? report.dependencies : [];
  for (const dep of deps) {
    for (const vuln of dep.vulns || []) {
      const aliases = Array.isArray(vuln.aliases) ? vuln.aliases.map(String) : [];
      const id = String(vuln.id || aliases[0] || `pip:${dep.name}`);
      const severity = String(vuln.severity || "unknown").toLowerCase();
      findings.push({
        ecosystem: "pip",
        id,
        ids: [...new Set([id, ...aliases])],
        package: dep.name,
        severity,
      });
    }
  }
  return findings;
}

function isInformational(severity) {
  return severity === "low" || severity === "moderate" || severity === "info";
}

function decide(findings, allow) {
  const blocking = [];
  const inform = [];
  for (const finding of findings) {
    if (finding.ids.some((id) => allow.has(id))) continue;
    if (isInformational(finding.severity)) inform.push(finding);
    else blocking.push(finding);
  }
  return { blocking, inform };
}

function evaluate({ npm, pip, allow, nowMs }) {
  const findings = [...classifyNpm(npm), ...classifyPip(pip)];
  return decide(findings, allow.active || allow);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function jsonFromOutput(text) {
  const raw = String(text || "");
  const start = raw.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(raw.slice(start));
  } catch {
    return null;
  }
}

function runTool(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  return {
    status: result.status,
    error: result.error ? result.error.message : "",
    parsed: jsonFromOutput(result.stdout),
    stderr: String(result.stderr || ""),
  };
}

function parseCli(argv) {
  const opts = {
    nowMs: Date.now(),
    allow: DEFAULT_ALLOW,
    npmJson: "",
    pipJson: "",
    reportOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === "--now" && next) {
      const ms = parseClock(next);
      if (ms == null) throw new Error(`--now is not a time: ${next}`);
      opts.nowMs = ms;
      i += 1;
    } else if (token === "--allow" && next) {
      opts.allow = path.resolve(next);
      i += 1;
    } else if (token === "--npm-json" && next) {
      opts.npmJson = path.resolve(next);
      i += 1;
    } else if (token === "--pip-json" && next) {
      opts.pipJson = path.resolve(next);
      i += 1;
    } else if (token === "--report-only") {
      opts.reportOnly = true;
    }
  }
  return opts;
}

function report(decision, ignored) {
  for (const entry of ignored) {
    console.log("::warning title=advisory allow-list::Ignored an entry with no id or no expiry.");
  }
  for (const finding of decision.inform) {
    console.log(
      `::warning title=${finding.ecosystem} advisory::${finding.severity} ${finding.package} ${finding.id}`,
    );
  }
  for (const finding of decision.blocking) {
    console.error(
      `::error title=${finding.ecosystem} advisory::${finding.severity} ${finding.package} ${finding.id}`,
    );
  }
  console.log(
    `advisory audit: ${decision.blocking.length} blocking, ${decision.inform.length} informational`,
  );
}

function main(argv) {
  const opts = parseCli(argv);
  const allow = loadAllow(opts.allow, opts.nowMs);
  let npm;
  let pip;
  if (opts.npmJson) {
    npm = readJson(opts.npmJson);
  } else {
    const ran = runTool("npm", ["audit", "--json", "--omit=dev"]);
    if (!ran.parsed) {
      console.error(ran.error || ran.stderr || "npm audit did not return JSON");
      process.exit(1);
    }
    npm = ran.parsed;
  }
  if (opts.pipJson) {
    pip = readJson(opts.pipJson);
  } else {
    const ran = runTool("python", [
      "-m",
      "pip_audit",
      "-r",
      "kernel/requirements.txt",
      "--format",
      "json",
    ]);
    if (!ran.parsed) {
      console.error(ran.error || ran.stderr || "pip-audit did not return JSON");
      process.exit(1);
    }
    pip = ran.parsed;
  }
  const decision = evaluate({ npm, pip, allow, nowMs: opts.nowMs });
  report(decision, allow.ignored);
  process.exit(!opts.reportOnly && decision.blocking.length ? 1 : 0);
}

module.exports = {
  loadAllow,
  classifyNpm,
  classifyPip,
  decide,
  evaluate,
  parseCli,
};

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
