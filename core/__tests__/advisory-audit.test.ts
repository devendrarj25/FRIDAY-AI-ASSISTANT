import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const audit = require_("../../scripts/advisory-audit.cjs") as {
  evaluate: (input: {
    npm: unknown;
    pip: unknown;
    allow: { active: Set<string> };
    nowMs: number;
  }) => { blocking: Array<{ id: string }>; inform: Array<{ id: string }> };
  loadAllow: (file: string, nowMs: number) => { active: Set<string>; ignored: unknown[] };
};

const NOW = Date.parse("2026-06-01T00:00:00.000Z");

function npmReport(severity: string, id: string) {
  return {
    vulnerabilities: {
      widget: {
        severity,
        via: [{ url: `https://github.com/advisories/${id}`, source: id }],
      },
    },
  };
}

describe("advisory audit policy", () => {
  it("blocks high, critical, and unknown severity, and only warns on moderate and low", () => {
    const allow = { active: new Set<string>() };
    const high = audit.evaluate({
      npm: npmReport("high", "GHSA-high"),
      pip: { dependencies: [] },
      allow,
      nowMs: NOW,
    });
    expect(high.blocking.map((row) => row.id)).toEqual(["GHSA-high"]);
    expect(high.inform).toEqual([]);

    const critical = audit.evaluate({
      npm: npmReport("critical", "GHSA-crit"),
      pip: { dependencies: [] },
      allow,
      nowMs: NOW,
    });
    expect(critical.blocking).toHaveLength(1);

    const unknown = audit.evaluate({
      npm: { vulnerabilities: {} },
      pip: { dependencies: [{ name: "demo", vulns: [{ id: "PYSEC-1" }] }] },
      allow,
      nowMs: NOW,
    });
    expect(unknown.blocking.map((row) => row.id)).toEqual(["PYSEC-1"]);

    const moderate = audit.evaluate({
      npm: npmReport("moderate", "GHSA-mod"),
      pip: { dependencies: [] },
      allow,
      nowMs: NOW,
    });
    expect(moderate.blocking).toEqual([]);
    expect(moderate.inform.map((row) => row.id)).toEqual(["GHSA-mod"]);
  });

  it("honours an allow-list entry only while its expiry is ahead of the injected clock", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-advisory-"));
    const file = path.join(dir, "allow.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        entries: [
          {
            id: "GHSA-waived",
            expires: "2026-07-01T00:00:00.000Z",
            reason: "upstream fix pending",
          },
          { id: "GHSA-bad" },
        ],
      }),
    );
    const open = audit.loadAllow(file, Date.parse("2026-06-15T00:00:00.000Z"));
    expect([...open.active]).toEqual(["GHSA-waived"]);
    expect(open.ignored).toHaveLength(1);
    const closed = audit.loadAllow(file, Date.parse("2026-07-01T00:00:00.000Z"));
    expect([...closed.active]).toEqual([]);

    const waived = audit.evaluate({
      npm: npmReport("high", "GHSA-waived"),
      pip: { dependencies: [] },
      allow: open,
      nowMs: Date.parse("2026-06-15T00:00:00.000Z"),
    });
    expect(waived.blocking).toEqual([]);
    const expired = audit.evaluate({
      npm: npmReport("high", "GHSA-waived"),
      pip: { dependencies: [] },
      allow: closed,
      nowMs: Date.parse("2026-07-01T00:00:00.000Z"),
    });
    expect(expired.blocking.map((row) => row.id)).toEqual(["GHSA-waived"]);
  });

  it("exits 0 for a fixture with only a moderate advisory and 1 when that advisory is high", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-advisory-cli-"));
    const allow = path.join(dir, "allow.json");
    const npmFile = path.join(dir, "npm.json");
    const pipFile = path.join(dir, "pip.json");
    fs.writeFileSync(allow, JSON.stringify({ entries: [] }));
    fs.writeFileSync(pipFile, JSON.stringify({ dependencies: [] }));
    fs.writeFileSync(npmFile, JSON.stringify(npmReport("moderate", "GHSA-mod")));
    const warn = spawnSync(
      process.execPath,
      [
        "scripts/advisory-audit.cjs",
        "--allow",
        allow,
        "--npm-json",
        npmFile,
        "--pip-json",
        pipFile,
        "--now",
        "2026-06-01T00:00:00.000Z",
      ],
      { cwd: path.resolve(__dirname, "../.."), encoding: "utf8" },
    );
    expect(warn.status).toBe(0);
    expect(warn.stdout).toContain("::warning");
    expect(warn.stdout).toContain("0 blocking, 1 informational");

    fs.writeFileSync(npmFile, JSON.stringify(npmReport("high", "GHSA-high")));
    const block = spawnSync(
      process.execPath,
      [
        "scripts/advisory-audit.cjs",
        "--allow",
        allow,
        "--npm-json",
        npmFile,
        "--pip-json",
        pipFile,
        "--now",
        "2026-06-01T00:00:00.000Z",
      ],
      { cwd: path.resolve(__dirname, "../.."), encoding: "utf8" },
    );
    expect(block.status).toBe(1);
    expect(block.stderr).toContain("::error");
    expect(block.stdout).toContain("1 blocking, 0 informational");

    const reportOnly = spawnSync(
      process.execPath,
      [
        "scripts/advisory-audit.cjs",
        "--report-only",
        "--allow",
        allow,
        "--npm-json",
        npmFile,
        "--pip-json",
        pipFile,
        "--now",
        "2026-06-01T00:00:00.000Z",
      ],
      { cwd: path.resolve(__dirname, "../.."), encoding: "utf8" },
    );
    expect(reportOnly.status).toBe(0);
    expect(reportOnly.stdout).toContain("1 blocking, 0 informational");
  });
});
