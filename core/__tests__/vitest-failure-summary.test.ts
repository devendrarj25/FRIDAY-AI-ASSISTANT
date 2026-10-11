/**
 * A failed suite must name the test, the first assertion, and a reproduction
 * command. The summary never prints a token or a signed upload URL.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { removeTemp } from "./helpers/temp-dir";

const require_ = createRequire(import.meta.url);
const summary = require_(path.resolve(__dirname, "../../scripts/vitest-failure-summary.cjs")) as {
  redact: (value: string) => string;
  summarizeVitest: (report: unknown) => { fullName: string; line: string; reproduce: string }[];
  summarizePipeline: (report: unknown) => { name: string; detail: string }[];
  zipStored: (entries: { name: string; data: Buffer | string }[]) => Buffer;
  uploadReports: (
    files: { name: string; data: Buffer }[],
    env: NodeJS.ProcessEnv,
    fetchImpl: (
      url: string,
      init: { body?: unknown; headers?: Record<string, string> },
    ) => Promise<{
      ok: boolean;
      json: () => Promise<Record<string, string>>;
    }>,
  ) => Promise<{ uploaded: boolean; reason: string }>;
  report: (
    argv: string[],
    env: NodeJS.ProcessEnv,
    fetchImpl: undefined,
    io: { log: (line: string) => void; error: (line: string) => void },
  ) => Promise<{ text: string; upload: { reason: string } }>;
};

describe("hosted failure summary", () => {
  it("names the failed test, the assertion, and the reproduction command", async () => {
    const failed = summary.summarizeVitest({
      testResults: [
        {
          name: "core/__tests__/release-resume.test.ts",
          assertionResults: [
            {
              status: "failed",
              title: "publishes a merged unpublished line",
              fullName: "FRIDAY Release resume publishes a merged unpublished line",
              failureMessages: [
                "AssertionError: expected 'prepare' to be 'publish'\n    at release-resume.test.ts:80",
              ],
            },
            { status: "passed", title: "passes", failureMessages: [] },
          ],
        },
      ],
    });
    expect(failed).toHaveLength(1);
    expect(failed[0]?.fullName).toContain("publishes a merged unpublished line");
    expect(failed[0]?.line).toContain("expected 'prepare' to be 'publish'");
    expect(failed[0]?.reproduce).toContain("core/__tests__/release-resume.test.ts");
    expect(failed[0]?.reproduce).toContain("publishes a merged unpublished line");
    const phases = summary.summarizePipeline({
      phases: [
        { name: "verify-artifacts", status: "failed", detail: "python-embed is missing" },
        { name: "package", status: "ok", detail: "packed" },
      ],
    });
    expect(phases.map((phase) => phase.name)).toEqual(["verify-artifacts"]);
    expect(phases[0]?.detail).toContain("python-embed is missing");
  });

  it("redacts secrets and does not print a signed URL", async () => {
    expect(summary.redact("token ghp_abc1234567890 end")).toBe("token [redacted] end");
    expect(summary.redact("CERTIFICATE_PASSWORD=hunter2")).toContain("[redacted]");
    const token = "runtime-token-sentinel";
    const signed = "https://results.example/upload?sig=abcdefghij";
    const calls: { url: string; body: string }[] = [];
    const fetchImpl = async (
      url: string,
      init: { body?: unknown; headers?: Record<string, string> },
    ) => {
      calls.push({ url, body: String(init.body || "") });
      if (url.endsWith("/CreateArtifact")) {
        return { ok: true, json: async () => ({ signedUploadUrl: signed }) };
      }
      return { ok: true, json: async () => ({ ok: "true" }) };
    };
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ scp: "Actions.Results:run1:job1" })).toString(
      "base64url",
    );
    const result = await summary.uploadReports(
      [{ name: "vitest.json", data: Buffer.from('{"ok":true}') }],
      {
        ACTIONS_RUNTIME_TOKEN: `${header}.${payload}.sig`,
        ACTIONS_RESULTS_URL: "https://results.example/v1",
      },
      fetchImpl,
    );
    expect(result.uploaded).toBe(true);
    expect(result.reason).not.toContain(token);
    expect(result.reason).not.toContain("sig=");
    expect(calls[0]?.body).toContain("workflowRunBackendId");
    expect(calls[0]?.body).toContain("run1");
    expect(calls.some((call) => call.url === signed)).toBe(true);
    const missing = await summary.uploadReports([], {}, fetchImpl);
    expect(missing).toEqual({ uploaded: false, reason: "no runtime token" });
  });

  it("writes a job summary from a temporary report and a stored zip", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "friday-summary-"));
    const report = path.join(dir, "vitest.json");
    const step = path.join(dir, "summary.md");
    writeFileSync(
      report,
      JSON.stringify({
        testResults: [
          {
            name: "core/__tests__/sample.test.ts",
            assertionResults: [
              {
                status: "failed",
                title: "keeps the pack",
                fullName: "pack keeps the pack",
                failureMessages: [
                  "AssertionError: expected pack.bin\nGITHUB_TOKEN=ghp_shouldnotprint",
                ],
              },
            ],
          },
        ],
      }),
    );
    const lines: string[] = [];
    const printed = await summary.report(
      [report, "--pipeline", path.join(dir, "missing.json")],
      {
        GITHUB_STEP_SUMMARY: step,
      },
      undefined,
      {
        log: (line) => lines.push(line),
        error: (line) => lines.push(line),
      },
    );
    expect(printed.text).toContain("keeps the pack");
    expect(printed.text).not.toContain("ghp_");
    expect(printed.upload.reason).toBe("no runtime token");
    expect(readFileSync(step, "utf8")).toContain("keeps the pack");
    expect(lines.join("\n")).toContain("::error");
    const zip = summary.zipStored([{ name: "vitest.json", data: '{"a":1}' }]);
    const zipFile = path.join(dir, "report.zip");
    writeFileSync(zipFile, zip);
    const unpacked = spawnSync(
      "python",
      [
        "-c",
        "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print(z.read('vitest.json').decode())",
        zipFile,
      ],
      {
        encoding: "utf8",
      },
    );
    expect(unpacked.status, unpacked.stderr).toBe(0);
    expect(unpacked.stdout).toContain('{"a":1}');
    removeTemp(dir);
  });
});
