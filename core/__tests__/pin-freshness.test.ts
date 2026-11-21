import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "../..");

type Pin = { name: string; files: string[]; pattern: RegExp; source: Record<string, string> };
type Verdict = {
  name: string;
  status: string;
  pinned?: string;
  latest?: string;
  note?: string;
};
const mod = require_("../../scripts/pin-freshness.cjs") as {
  PINS: Pin[];
  GRACE_DAYS: number;
  compareVersions: (a: string, b: string) => number;
  readPin: (pin: Pin, root: string) => { versions: Set<string>; where: string[] };
  fetchLatest: (
    source: Record<string, string>,
    fetchJson: (url: string) => Promise<unknown>,
  ) => Promise<{ version: string; publishedAt?: string } | null>;
  judge: (
    pin: Pin,
    found: { versions: Set<string>; where: string[] },
    latest: { version: string; publishedAt?: string } | null,
    now: number,
  ) => Verdict;
  check: (o: Record<string, unknown>) => Promise<Verdict[]>;
  summarize: (r: Verdict[]) => { needs: Verdict[]; line: string };
};

// A fixed clock: nothing here depends on today's date or on the network.
const NOW = Date.parse("2026-12-01T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const tool = (name: string) => mod.PINS.find((p) => p.name === name) as Pin;
const found = (...versions: string[]) => ({ versions: new Set(versions), where: [] });

describe("compareVersions", () => {
  it("orders dotted numbers numerically, not as text", () => {
    expect(mod.compareVersions("1.9.0", "1.10.0")).toBe(-1);
    expect(mod.compareVersions("8.30.1", "8.30.1")).toBe(0);
    expect(mod.compareVersions("2.0", "1.99.9")).toBe(1);
  });
});

describe("judging a pin against the newest release", () => {
  const zizmor = tool("zizmor");

  it("is current when the pin is the newest release", () => {
    const v = mod.judge(
      zizmor,
      found("1.32.0"),
      { version: "1.32.0", publishedAt: daysAgo(40) },
      NOW,
    );
    expect(v.status).toBe("current");
  });

  it("waits while a newer release is younger than the grace period", () => {
    const v = mod.judge(
      zizmor,
      found("1.31.1"),
      { version: "1.32.0", publishedAt: daysAgo(3) },
      NOW,
    );
    expect(v.status).toBe("fresh");
    expect(v.note).toContain(`waiting ${mod.GRACE_DAYS}`);
  });

  it("reports behind once a newer release has been out for the grace period", () => {
    const v = mod.judge(
      zizmor,
      found("1.31.1"),
      { version: "1.32.0", publishedAt: daysAgo(mod.GRACE_DAYS) },
      NOW,
    );
    expect(v.status).toBe("behind");
    expect(v).toMatchObject({ pinned: "1.31.1", latest: "1.32.0" });
  });

  it("calls an unreadable release unknown, never a fault, and a missing pin missing", () => {
    expect(mod.judge(zizmor, found("1.31.1"), null, NOW).status).toBe("unknown");
    expect(mod.judge(zizmor, found(), null, NOW).status).toBe("missing");
  });

  it("flags files that pin the same tool to different versions", () => {
    const v = mod.judge(tool("pip-audit"), found("2.10.1", "2.9.0"), null, NOW);
    expect(v.status).toBe("mismatch");
    expect(v.note).toContain("2.10.1");
  });
});

describe("reading the newest release from the official source", () => {
  it("reads a GitHub release tag and its date", async () => {
    const latest = await mod.fetchLatest({ github: "rhysd/actionlint" }, async (url) => {
      expect(url).toBe("https://api.github.com/repos/rhysd/actionlint/releases/latest");
      return { tag_name: "v1.7.13", published_at: "2026-11-01T00:00:00Z" };
    });
    expect(latest).toEqual({ version: "1.7.13", publishedAt: "2026-11-01T00:00:00Z" });
  });

  it("reads a PyPI release and the upload time of its first file", async () => {
    const latest = await mod.fetchLatest({ pypi: "zizmor" }, async (url) => {
      expect(url).toBe("https://pypi.org/pypi/zizmor/json");
      return {
        info: { version: "1.32.0" },
        releases: { "1.32.0": [{ upload_time_iso_8601: "2026-11-02T10:00:00Z" }] },
      };
    });
    expect(latest).toEqual({ version: "1.32.0", publishedAt: "2026-11-02T10:00:00Z" });
  });

  it("returns null for a network error, a refusal or a version it cannot read", async () => {
    const down = async () => {
      throw new Error("offline");
    };
    expect(await mod.fetchLatest({ pypi: "zizmor" }, down)).toBeNull();
    expect(
      await mod.fetchLatest({ github: "a/b" }, async () => ({ tag_name: "nightly" })),
    ).toBeNull();
  });
});

describe("the pins in this repository", () => {
  it("are all found where the script looks for them, as plain x.y.z versions", () => {
    for (const pin of mod.PINS) {
      const read = mod.readPin(pin, root);
      expect(read.versions.size, `${pin.name} pins exactly one version`).toBe(1);
      expect([...read.versions][0]).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it("pin the tools to the same version in every file that names them", () => {
    // The secret scanner image in PR Validation and Security Scan, and the audit tool in three workflows.
    expect(mod.readPin(tool("gitleaks"), root).where.length).toBeGreaterThanOrEqual(3);
    expect(mod.readPin(tool("pip-audit"), root).where.length).toBeGreaterThanOrEqual(3);
  });
});

describe("check and summary", () => {
  it("reads every pin from a throwaway tree and judges it with the injected source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-pins-"));
    try {
      const write = (file: string, text: string) => {
        mkdirSync(dirname(join(dir, file)), { recursive: true });
        writeFileSync(join(dir, file), text);
      };
      write(
        ".github/workflows/pr-validation.yml",
        [
          "image='zricethezav/gitleaks:v8.30.1@sha256:abc'",
          'python -m pip install "zizmor==1.31.1"',
          'python -m pip install "pip-audit==2.10.1"',
        ].join("\n"),
      );
      write(
        ".github/workflows/security.yml",
        'zricethezav/gitleaks:v8.30.1@sha256:abc "pip-audit==2.10.1"',
      );
      write(".github/workflows/health-weekly.yml", '"pip-audit==2.10.1"');
      write(
        "scripts/run-actionlint.cjs",
        "https://github.com/rhysd/actionlint/releases/download/v1.7.12/x.tar.gz",
      );
      const fetchJson = async (url: string) => {
        if (url.includes("gitleaks")) return { tag_name: "v8.30.1", published_at: daysAgo(90) };
        if (url.includes("actionlint")) return { tag_name: "v1.7.13", published_at: daysAgo(30) };
        if (url.includes("zizmor"))
          return {
            info: { version: "1.32.0" },
            releases: { "1.32.0": [{ upload_time_iso_8601: daysAgo(20) }] },
          };
        throw new Error("offline");
      };
      const results = await mod.check({ root: dir, fetchJson, now: NOW });
      const by = Object.fromEntries(results.map((r) => [r.name, r.status]));
      expect(by).toEqual({
        gitleaks: "current",
        actionlint: "behind",
        zizmor: "behind",
        "pip-audit": "unknown",
      });
      const summary = mod.summarize(results);
      expect(summary.needs.map((r) => r.name)).toEqual(["actionlint", "zizmor"]);
      expect(summary.line).toBe("pinned tools: 2 need attention, 1 could not be read, 4 checked");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the weekly health report", () => {
  it("runs the check as an information step that can warn but never fail the run", () => {
    const resume = readFileSync(join(root, "scripts/resume.cjs"), "utf8");
    const at = resume.indexOf('step("pinned tool versions (info)"');
    expect(at).toBeGreaterThan(-1);
    const block = resume.slice(at, resume.indexOf("\n}\n", at));
    expect(block).toContain("scripts/pin-freshness.cjs");
    expect(block).toContain('status: "WARN"');
    expect(block).not.toContain('status: "FAIL"');
    // Only the CI run (Health Weekly) asks; a local `npm run resume` stays offline.
    expect(resume.indexOf("if (CI) {")).toBeLessThan(at);
  });
});
