/**
 * A rerun of FRIDAY Release must reuse an existing release pull request,
 * publish an already-merged unpublished line once, and refuse to move a
 * tag that is already a GitHub release.
 */
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, "../..");
const orchestrator = require_(path.join(ROOT, "scripts/orchestrator-engine.cjs")) as {
  orchestrationPlan: (input: Record<string, unknown>) => {
    step: string;
    version?: string;
    prNumber?: number | null;
  };
};
const engine = require_(path.join(ROOT, "scripts/release-engine.cjs")) as {
  publishHandoff: (input: Record<string, unknown>) => { action: string; reason?: string };
  diagnosePublishBlockers: (input: Record<string, unknown>) => { ok: boolean; kind: string };
};

describe("FRIDAY Release resume", () => {
  it("reuses an open release pull request instead of preparing another", () => {
    const plan = orchestrator.orchestrationPlan({
      mode: "auto",
      mainVersion: "1.1.1.2",
      prepared: [{ number: 31, version: "1.1.1.2", state: "open" }],
      released: [],
    });
    expect(plan.step).toBe("merge");
    expect(plan.prNumber).toBe(31);
    expect(plan.version).toBe("1.1.1.2");
  });

  it("publishes a merged unpublished line and does not invent the next number", () => {
    const plan = orchestrator.orchestrationPlan({
      mode: "auto",
      mainVersion: "1.1.1.2",
      prepared: [{ number: 31, version: "1.1.1.2", state: "merged" }],
      released: [],
    });
    expect(plan.step).toBe("publish");
    expect(plan.version).toBe("1.1.1.2");
  });

  it("rebuilds an existing release in place", () => {
    const plan = orchestrator.orchestrationPlan({
      mode: "rebuild",
      mainVersion: "1.1.1.2",
      prepared: [{ number: 31, version: "1.1.1.2", state: "merged" }],
      released: ["v1.1.1.2"],
    });
    expect(plan.step).toBe("rebuild");
    expect(plan.version).toBe("1.1.1.2");
    const handoff = engine.publishHandoff({
      mode: "update",
      current: "1.1.1.2",
      prepared: [{ number: 31, version: "1.1.1.2", state: "merged" }],
      released: ["v1.1.1.2"],
    });
    expect(handoff.action).toBe("error");
    expect(handoff.reason || "").toMatch(/already exists/);
  });

  it("blocks confirm when the tag is already published or the pull request is still open", () => {
    const published = engine.diagnosePublishBlockers({
      version: "1.1.1.2",
      published: true,
      mergedPr: { number: 31 },
      ancestor: true,
      changelogOk: true,
    });
    expect(published.ok).toBe(false);
    expect(published.kind).toBe("already_published");
    const open = engine.diagnosePublishBlockers({
      version: "1.1.1.2",
      published: false,
      openPr: { number: 31, url: "https://example.invalid/31" },
    });
    expect(open.ok).toBe(false);
    expect(open.kind).toBe("pr_open_unmerged");
    const ready = engine.diagnosePublishBlockers({
      version: "1.1.1.2",
      published: false,
      mergedPr: { number: 31 },
      ancestor: true,
      changelogOk: true,
    });
    expect(ready.ok).toBe(true);
    expect(ready.kind).toBe("ready");
  });

  it("plans from temporary files without reading this checkout's tags", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "friday-resume-"));
    const prepared = path.join(dir, "prepared.json");
    const released = path.join(dir, "released.txt");
    const tags = path.join(dir, "tags.txt");
    writeFileSync(prepared, JSON.stringify([{ number: 31, version: "1.1.1.2", state: "merged" }]));
    writeFileSync(released, "");
    writeFileSync(tags, "");
    const gh = path.join(dir, "gh");
    const ghLog = path.join(dir, "gh.log");
    writeFileSync(gh, '#!/bin/sh\nprintf \'%s\\n\' "$@" >> "$GH_LOG"\nexit 0\n');
    chmodSync(gh, 0o755);
    const viewed = spawnSync("gh", ["release", "view", "v1.1.1.2"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env["PATH"] || ""}`, GH_LOG: ghLog },
    });
    expect(viewed.status).toBe(0);
    expect(readFileSync(ghLog, "utf8")).toContain("release\nview\nv1.1.1.2");
    const result = spawnSync(
      process.execPath,
      [
        "scripts/orchestrator-engine.cjs",
        "plan",
        "--mode",
        "auto",
        "--current",
        "1.1.1.2",
        "--prepared",
        prepared,
        "--released",
        released,
        "--tags",
        tags,
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, PATH: `${dir}:${process.env["PATH"] || ""}`, GH_LOG: ghLog },
      },
    );
    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout) as { step: string; version: string };
    expect(body.step).toBe("publish");
    expect(body.version).toBe("1.1.1.2");
    const release = readFileSync(path.join(ROOT, ".github/workflows/release.yml"), "utf8");
    expect(release).toContain("tag $tag already exists");
    expect(release).toContain("gh release upload");
    expect(release).toContain("--clobber");
    expect(release).not.toContain("git push --force");
    expect(release).not.toContain("git tag -f");
  });
});
