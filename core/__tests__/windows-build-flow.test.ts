/**
 * The Windows build flow as one chain with nothing optional:
 *   npm run setup  ->  npm run doctor  ->  npm run build:win  ->  FRIDAY BUILD READY
 * Everything here reads scripts as text or runs them with stand-ins; no network, no installs.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const pipeline = require_(path.join(root, "scripts/build-pipeline.cjs"));
const doctor = require_(path.join(root, "scripts/doctor.cjs"));
const toolkit = require_(path.join(root, "scripts/prefetch-toolkit.cjs"));
const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

describe("npm run setup installs everything and nothing is optional", () => {
  const setup = read("scripts/setup-windows.ps1");

  it("treats FFmpeg, Tesseract and the Visual C++ runtime as required", () => {
    expect(setup).toContain("Ensure-RequiredCommand 'FFmpeg'");
    expect(setup).toContain("Ensure-RequiredCommand 'Tesseract OCR'");
    expect(setup).not.toContain("Ensure-OptionalCommand");
    expect(setup).not.toMatch(/remains optional/);
    expect(setup).toContain("could not be installed by any official method");
    expect(setup).toMatch(
      /vcruntime140\.dll[\s\S]*throw 'The Visual C\+\+ Redistributable could not be installed/,
    );
  });

  it("offers a toolchain-only mode that doctor and the build use, and stops on a toolkit failure", () => {
    expect(setup).toMatch(/param\(\s*#[^\n]*\n[\s\S]*\[switch\]\$ToolchainOnly/);
    expect(setup).toContain("if ($ToolchainOnly)");
    expect(setup).toContain("TOOLCHAIN PASS");
    expect(setup.indexOf("if ($ToolchainOnly)")).toBeLessThan(setup.indexOf("npm.cmd ci"));
    expect(setup).toContain("The agent toolkit is not complete");
  });

  it("keeps the floors as floors and installs the latest stable release when one is missing or older", () => {
    expect(setup).toContain("reused, not modified");
    expect(setup).toContain("installing the latest stable release");
    expect(setup).toContain("never downgrade");
  });
});

describe("npm run doctor checks, repairs and checks again", () => {
  it("runs every step, keeps going after a failure and fails when any step failed", () => {
    expect(pkg.scripts["doctor"]).toBe("node scripts/doctor.cjs");
    const lines: string[] = [];
    const out = doctor.runDoctor(
      [
        { name: "a", run: () => ({ status: 0 }) },
        { name: "b", run: () => ({ status: 1 }) },
        {
          name: "c",
          run: () => {
            throw new Error("boom");
          },
        },
        { name: "d", run: () => ({ status: 0 }) },
      ],
      (line: string) => lines.push(line),
    );
    expect(out.ok).toBe(false);
    expect(out.rows.map((row: { name: string; ok: boolean }) => [row.name, row.ok])).toEqual([
      ["a", true],
      ["b", false],
      ["c", false],
      ["d", true],
    ]);
    const text = lines.join("\n");
    expect(text).toContain("FAIL  b (exit 1)");
    expect(text).toContain("FAIL  c (exit 1: boom)");
    expect(text).toContain("DOCTOR FAIL - 2 step(s) did not finish: b, c");
    expect(doctor.runDoctor([{ name: "ok", run: () => ({ status: 0 }) }], () => {}).ok).toBe(true);
  });

  it("repairs through the same scripts the build uses, in the right order", () => {
    const order = doctor.STEPS.map((step: { name: string }) => step.name);
    expect(order).toEqual([
      "dependencies",
      "environment check and repair",
      "runtime folders and database",
      "main-process dependencies",
      "environment registry",
    ]);
    const source = read("scripts/doctor.cjs");
    expect(source).toContain('node("check-environment.cjs", ["--fix"])');
    expect(source).toContain('node("env-registry.cjs", ["repair"])');
  });
});

describe("the environment check is strict exactly where the setup installs", () => {
  const check = read("scripts/check-environment.cjs");

  it("requires FFmpeg, Tesseract, the Visual C++ runtime, Ollama and the agent tools there", () => {
    expect(check).toContain("const toolsRequired");
    for (const name of [
      "FFmpeg",
      "Tesseract OCR",
      "Visual C++ 2015-2022 Redistributable",
      "Ollama (local models)",
    ]) {
      const at = check.indexOf(`name: "${name}"`);
      expect(at, name).toBeGreaterThan(-1);
      expect(check.slice(at, at + 120), name).toContain("required: toolsRequired");
    }
    expect(check).not.toMatch(/optional — (media|screen|needed)/);
  });

  it("shows hardware and editions that cannot apply as not applicable, never as a warning", () => {
    expect(check).toContain("not applicable: no NVIDIA GPU");
    expect(check).toContain("not applicable: not available on this Windows edition");
    expect(check).toContain("elevatedRequired");
  });

  it("is switched off with the step that installs the tools (hosted CI, offline, FRIDAY_PREFETCH*=0)", () => {
    expect(toolkit.skipReason({ CI: "true" }, "win32")).not.toBe("");
    expect(toolkit.skipReason({ FRIDAY_OFFLINE: "1" }, "win32")).not.toBe("");
    expect(toolkit.skipReason({ FRIDAY_PREFETCH_TOOLKIT: "0" }, "win32")).not.toBe("");
    expect(toolkit.skipReason({}, "win32")).toBe("");
  });
});

describe("the toolkit skips what cannot apply to this PC", () => {
  it("does not try Windows Sandbox on an edition that lacks it", () => {
    const plan = toolkit.toolkitPlan({
      detected: {
        "Sandbox runner (Windows Sandbox)": {
          installed: false,
          unsupported: true,
          manual: "not available on this Windows edition (Windows 11 Home)",
        },
      },
    });
    const row = plan.find((r: { id: string }) => r.id === "Sandbox runner (Windows Sandbox)");
    expect(row).toMatchObject({ action: "skip" });
    expect(row.note).toContain("Windows 11 Home");
    expect(read("electron/toolchain.cjs")).toContain("unsupported: !supported");
  });
});

describe("the build starts with the PC and ends with a verdict", () => {
  it("checks the toolchain first, before npm ci", () => {
    const commands: string[] = pipeline.PHASE_COMMANDS["prepare-environment"];
    expect(commands[0]).toBe("scripts/setup-windows.ps1 -ToolchainOnly");
    expect(commands.indexOf("scripts/check-engines.cjs")).toBe(1);
    const source = read("scripts/build-pipeline.cjs");
    expect(source.indexOf("ensureToolchain(root);")).toBeLessThan(
      source.indexOf('runNode("scripts/check-engines.cjs"'),
    );
  });

  it("installs the toolchain on a local Windows PC only, and stops when it cannot", () => {
    expect(pipeline.ensureToolchain(root, {}, "linux")).toContain("Windows only");
    expect(pipeline.ensureToolchain(root, { CI: "true" }, "win32")).toContain("hosted CI");
    expect(pipeline.ensureToolchain(root, { GITHUB_ACTIONS: "true" }, "win32")).toContain(
      "hosted CI",
    );
    const calls: string[][] = [];
    const env: Record<string, string> = { PATH: "C:\\old" };
    expect(
      pipeline.ensureToolchain(root, env, "win32", {
        run: (_cmd: string, args: string[]) => {
          calls.push(args);
          return { status: 0 };
        },
        readPath: () => "C:\\new",
      }),
    ).toBe("toolchain ready");
    expect(calls[0]).toContain("-ToolchainOnly");
    expect((calls[0] ?? []).join(" ")).toContain("setup-windows.ps1");
    expect(env["PATH"]).toBe("C:\\old;C:\\new");
    expect(() =>
      pipeline.ensureToolchain(root, {}, "win32", {
        run: () => ({ status: 1 }),
        readPath: () => "",
      }),
    ).toThrow(/toolchain is not complete/);
  });

  it("stops the build when the toolkit or the models are not complete", () => {
    const source = read("scripts/build-pipeline.cjs");
    expect(source).not.toContain("a failure never stops the build");
    expect(source).toContain("a tool that cannot be installed stops the build");
    // The scripts exit 1 on a failure; runNode turns that into a failed phase.
    expect(read("scripts/prefetch-toolkit.cjs")).toContain(
      "process.exit(lines.length && strict() ? 1 : 0)",
    );
    expect(read("scripts/prefetch-models.cjs")).toContain(
      "process.exit(lines.length && strict() ? 1 : 0)",
    );
  });

  it("prints READY only when the whole recipe ran and every phase passed", () => {
    const whole = pipeline.parseArgs(["node", "x", "--caller", "cmd"]);
    const ok = {
      ok: true,
      phases: [
        { name: "prepare-environment", status: "ok", detail: "environment ready" },
        { name: "installer-smoke", status: "ok", detail: "installer smoke passed" },
      ],
    };
    const text = pipeline
      .readySummary(whole, ok, root, {
        readdirSync: () => [
          "FRIDAY-Setup-1.1.3.5.exe",
          "FRIDAY-Portable-1.1.3.5.exe",
          "latest.yml",
        ],
        statSync: () => ({ size: 300 * 1048576 }),
        existsSync: () => true,
      })
      .join("\n");
    expect(text).toContain("FRIDAY BUILD READY - every check passed");
    expect(text).toContain("PASS prepare-environment");
    expect(text).toContain("FRIDAY-Setup-1.1.3.5.exe (300 MB)");
    expect(text).toContain("FRIDAY-Portable-1.1.3.5.exe");
    expect(text).toContain("win-unpacked");
    expect(text).toContain("npm run doctor");
    expect(text).not.toContain("latest.yml");

    const partial = pipeline.parseArgs(["node", "x", "--through", "verify-versions"]);
    expect(pipeline.readySummary(partial, ok).join("\n")).toContain("FRIDAY BUILD PARTIAL");

    const failed = { ok: false, phases: [{ name: "package", status: "failed", detail: "boom" }] };
    const bad = pipeline.readySummary(whole, failed).join("\n");
    expect(bad).toContain("FRIDAY BUILD FAILED");
    expect(bad).toContain("FAIL package");
    expect(bad).not.toContain("READY");

    const skipped = {
      ok: true,
      phases: [{ name: "manifest", status: "skipped", detail: "skipped: no manifest" }],
    };
    expect(pipeline.readySummary(whole, skipped).join("\n")).toContain(
      "every check that applies passed",
    );
  });

  it("shows that summary for the CMD pack and npm, not for the release workflows", () => {
    const source = read("scripts/build-pipeline.cjs");
    expect(source).toContain('options.caller === "cmd" || options.caller === "npm"');
  });
});

describe("build-windows.cmd is one clear flow", () => {
  const cmd = read("scripts/build-windows.cmd");

  it("names the chain, prepares a missing toolchain, then runs the one pipeline", () => {
    expect(cmd).toContain("npm run setup");
    expect(cmd).toContain("npm run doctor");
    expect(cmd).toContain("FRIDAY BUILD READY");
    expect(cmd).toContain("Step 1 of 2");
    expect(cmd).toContain("Step 2 of 2");
    expect(cmd).toContain('setup-windows.ps1" -ToolchainOnly');
    expect(cmd).toContain('build-pipeline.cjs" --channel production --caller cmd %*');
  });

  it("stops with the reason and the way forward instead of carrying on", () => {
    expect(cmd).toContain(
      "if errorlevel 1 (echo [FRIDAY] The Windows toolchain could not be prepared",
    );
    expect(cmd).toContain("The build stopped with exit code");
    expect(cmd).toContain("endlocal & exit /b %FRIDAY_BUILD_CODE%");
  });
});
