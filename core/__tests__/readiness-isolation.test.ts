/**
 * Readiness must not open the owner's FRIDAY folder or the default kernel port.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const harness = require_(path.join(root, "scripts/readiness-test.cjs"));
const bind = require_(path.join(root, "electron/kernel-bind.cjs"));
const paths = require_(path.join(root, "electron/friday-paths.cjs"));
const fridayRoot = require_(path.join(root, "scripts/friday-root.cjs"));

describe("readiness isolation", () => {
  it("uses a fresh root and refuses the recorded folder unless opted in", () => {
    const owner = mkdtempSync(path.join(tmpdir(), "friday-owner-"));
    writeFileSync(path.join(owner, "secret.txt"), "owner-data");
    const fresh = harness.chooseReadinessRoot({ recorded: owner, alive: true });
    expect(fresh.optedIn).toBe(false);
    expect(fresh.root).not.toBe(path.resolve(owner));
    expect(fresh.root).not.toContain("secret.txt");
    expect(() =>
      harness.chooseReadinessRoot({
        argv: ["--use-recorded-root"],
        recorded: owner,
        alive: true,
      }),
    ).toThrow(/in use/);
    const opted = harness.chooseReadinessRoot({
      argv: ["--use-recorded-root"],
      recorded: owner,
      alive: false,
    });
    expect(opted.root).toBe(path.resolve(owner));
    expect(() =>
      harness.chooseReadinessRoot({ argv: ["--root", owner], recorded: owner, alive: false }),
    ).toThrow(/recorded FRIDAY folder/);
  });

  it("picks a free port and classifies a kernel exit", async () => {
    expect(bind.initialPort({})).toBe(8765);
    expect(bind.initialPort({ FRIDAY_KERNEL_PORT: "9001" })).toBe(9001);
    const port = await bind.pickFreePort();
    expect(port).toBeGreaterThan(1024);
    expect(port).toBeLessThan(65536);
    const held = bind.classifyKernelExit({
      code: 1,
      text: "INFO noise\n".repeat(50) + "Error: listen EADDRINUSE 127.0.0.1:8765",
    });
    expect(held.class).toBe("port in use");
    expect(held.lines.length).toBeLessThanOrEqual(40);
    expect(
      bind.classifyKernelExit({ code: 1, text: "sqlite3.OperationalError: database is locked" })
        .class,
    ).toBe("database locked");
    expect(
      bind.classifyKernelExit({ code: 1, text: "ModuleNotFoundError: No module named 'fastapi'" })
        .class,
    ).toBe("python import error");
    expect(
      bind.classifyKernelExit({ code: 1, text: "Permission denied: 'D:\\\\FRIDAY'" }).class,
    ).toBe("permission");
    const line = harness.restartReportLine(
      {
        exitCode: 1,
        output: "listen EADDRINUSE 127.0.0.1:8765",
        stages: [
          { name: "DATABASE", ok: false, detail: "settings.set could not reach the kernel" },
        ],
        kernel: { pid: null, port: 8765 },
      },
      { kernel: { pid: null, port: 8765 } },
    );
    expect(line).toContain("port in use");
    expect(line).toContain("launch 1 pid none port 8765");
    expect(line).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
  });

  it("warns when the folder is this checkout and ignores runtime data", () => {
    const checkout = paths.checkoutGuard(root);
    expect(checkout.checkout).toBe(true);
    expect(checkout.message).toContain("not deleted");
    const other = mkdtempSync(path.join(tmpdir(), "friday-plain-"));
    expect(paths.checkoutGuard(other).checkout).toBe(false);
    for (const name of fridayRoot.RUNTIME_FOLDERS) {
      const probe =
        name === "database"
          ? "database/friday.sqlite3"
          : name === "logs"
            ? "logs/friday.log"
            : name === "runtime"
              ? "runtime/probe.bin"
              : `${name}/probe.bin`;
      const ignored = execFileSync("git", ["check-ignore", "-q", probe], {
        cwd: root,
        stdio: "ignore",
      });
      expect(ignored).toBeDefined();
    }
    execFileSync("git", ["check-ignore", "-q", "models/local/weights.gguf"], {
      cwd: root,
      stdio: "ignore",
    });
    expect(() =>
      execFileSync("git", ["check-ignore", "-q", "models/index.ts"], {
        cwd: root,
        stdio: "ignore",
      }),
    ).toThrow();
  });

  it("copies runtime data and leaves the source in place", async () => {
    const from = mkdtempSync(path.join(tmpdir(), "friday-from-"));
    const to = mkdtempSync(path.join(tmpdir(), "friday-to-"));
    mkdirSync(path.join(from, "data"), { recursive: true });
    writeFileSync(path.join(from, "data", "note.txt"), "keep");
    const copied = await paths.copyVerified(path.join(from, "data"), path.join(to, "data"));
    expect(copied.ok).toBe(true);
    expect(copied.sourceCount).toBe(1);
    expect(copied.targetCount).toBe(1);
    expect(readFileSync(path.join(from, "data", "note.txt"), "utf8")).toBe("keep");
  });
});
