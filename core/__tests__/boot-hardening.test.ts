import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const root = resolve(__dirname, "../..");
const require_ = createRequire(import.meta.url);
const startup = require_(join(root, "electron/startup.cjs"));
const main = readFileSync(join(root, "electron/main.cjs"), "utf8");

/**
 * Boot must be silent, deterministic and idempotent: no OS window may appear
 * for FRIDAY's own child processes, the canonical config is validated before
 * the kernel reads it, and a freshly started engine gets time to list models.
 */
describe("silent, deterministic EXE boot", () => {
  it("never lets a FRIDAY-owned child process open a console window", () => {
    const spawnAt = main.indexOf("kernel = spawn(");
    const kernelSpawn = main.slice(spawnAt, spawnAt + 2600);
    expect(kernelSpawn).toContain("windowsHide: true");
    const regCalls = main.match(/execFile\(\s*"reg"[\s\S]{0,400}?\)/g) || [];
    expect(regCalls.length).toBeGreaterThan(0);
    for (const call of regCalls) expect(call).toContain("windowsHide: true");
  });

  it("validates the one canonical config before the kernel starts", () => {
    expect(main).toContain("function ensureCanonicalConfig");
    const configAt = main.indexOf("ensureCanonicalConfig(root)");
    const kernelAt = main.indexOf("await startKernel(root)");
    expect(configAt).toBeGreaterThan(0);
    expect(kernelAt).toBeGreaterThan(configAt);
  });

  it("repairs unreadable config instead of silently discarding it", () => {
    expect(main).toContain(".corrupt-");
    expect(main).toContain("readJsonFile(bootstrapSettingsFile(), { repair: true })");
  });

  it("does not pin an empty model catalogue for a whole cache window", () => {
    expect(main).toContain("EMPTY_ROUTABLE_TTL_MS");
    expect(main).toContain("routableCache.models.length ? ROUTABLE_TTL_MS : EMPTY_ROUTABLE_TTL_MS");
  });

  it("does not stamp Starting services ok when the kernel child was not spawned", () => {
    const after = main.slice(main.indexOf("await startKernel(root)"));
    const bootOk = after.indexOf('boot("Starting services", "ok"');
    expect(bootOk).toBeGreaterThan(0);
    expect(after.slice(0, bootOk)).toContain("if (kernel)");
  });

  it("stops the health wait when the kernel child is already gone", () => {
    const wait = main.slice(
      main.indexOf("async function waitForKernel"),
      main.indexOf("function portBusy"),
    );
    expect(wait).toContain("AbortSignal.timeout(800)");
    expect(wait).toContain("if (!kernel && !kernelReady) return false");
    expect(wait).toContain("serviceHealth.invalidate()");
  });

  it("invalidates service-health when the kernel child exits or fails to spawn", () => {
    expect(main).toContain("serviceHealth.invalidate()");
    const exitAt = main.indexOf('kernel.on("exit"');
    const exit = main.slice(exitAt, main.indexOf("kernelStartPromise = waitForKernel", exitAt));
    expect(exit).toContain("serviceHealth.invalidate()");
    expect(exit.indexOf("serviceHealth.invalidate()")).toBeLessThan(
      exit.indexOf("kernelAuto?.onProcessExit"),
    );
  });
});

describe("startup flow model settling", () => {
  const base = {
    workspaceRoot: root,
    boot: () => {},
    log: () => {},
    listCapabilities: async () => ({ items: [], counts: {} }),
    kernelAlive: async () => true,
  };

  it("re-probes models after it has just started a local engine", async () => {
    let probes = 0;
    const report = await startup.runStartupFlow({
      ...base,
      engineStatus: async () => [{ id: "ollama", name: "Ollama", running: false, canStart: true }],
      startEngine: async () => ({ ok: true, detail: "endpoint verified" }),
      routableModels: async () => {
        probes += 1;
        return probes >= 2 ? 3 : 0; // the engine answers on the second probe
      },
    });
    expect(probes).toBeGreaterThan(1);
    expect(report.modelsAvailable).toBe(3);
  }, 30_000);

  it("probes once when no engine had to be started", async () => {
    let probes = 0;
    await startup.runStartupFlow({
      ...base,
      engineStatus: async () => [],
      startEngine: async () => ({ ok: false, error: "not installed" }),
      routableModels: async () => {
        probes += 1;
        return 0;
      },
    });
    expect(probes).toBe(1);
  });
});
