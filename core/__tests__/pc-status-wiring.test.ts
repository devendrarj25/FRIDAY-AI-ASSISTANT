/**
 * The live PC detection is wired end to end: the main process passes the model cache folder, the network switch and
 * the power source to the probes; the Hardware and Status pages read the facts and the governor through the shared
 * channels with loading, offline, error (with Retry) and ready states; the heavy loads ask the governor first and
 * degrade instead of hanging. Source pins only where the code cannot run here (the Electron main process).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { GovernorStatus, HardwareFacts } from "../../src/lib/friday/desktop";
import { PcStatusPanel, type PcStatusState } from "../../src/components/friday/PcStatusPanel";

const read = (file: string) =>
  readFileSync(path.join(__dirname, "..", "..", file), "utf8").replace(/\r\n/g, "\n");
const main = read("electron/main.cjs");
const stt = read("electron/stt.cjs");

describe("main process: what the probes are given", () => {
  it("passes the data folder, the model cache folder and the network switch to both hardware probes", () => {
    const fn = /function hardwareProbeOptions\(\) \{[\s\S]*?\n\}\n/.exec(main)?.[0] ?? "";
    expect(fn).toContain("const root = getWorkspaceRoot();");
    expect(fn).toContain('modelCacheRoot: root ? path.join(root, "models") : null');
    // The network round trip is measured only when neither privacy mode nor a local-only route is on and the PC is online.
    expect(fn).toContain("allowNetwork = !egressLocalOnly() && !netStatus.isOffline();");
    expect(fn).toMatch(/catch \{\s*allowNetwork = false;/);
    expect(main).toContain(
      'function egressLocalOnly() {\n  return voicePrivacyOn() || modelRouteMode() === "local-only";',
    );
    expect(main).toContain(
      'require("./net-fetch.cjs").setEgressPolicy(() => ({ localOnly: egressLocalOnly() }));',
    );
    expect(main.match(/detectHardware\(hardwareProbeOptions\(\)\)/g)?.length).toBe(2);
  });

  it("gives the facts the power source from powerMonitor, with no thermal state off macOS", () => {
    const fn = /function livePowerState\(\) \{[\s\S]*?\n\}\n/.exec(main)?.[0] ?? "";
    expect(fn).toContain("onBatteryPower: monitor.isOnBatteryPower() === true");
    expect(fn).toContain('process.platform === "darwin"');
    expect(fn).toContain(": null,");
    expect(main).toMatch(/gpuInfo: electronGpuInfo,\s*power: livePowerState\(\),/);
  });

  it("asks the probes again a few seconds later while the wider probes are still measuring", () => {
    expect(main).toContain("const HARDWARE_PENDING_RETRY_MS = 3000;");
    expect(main).toContain(
      "const freshMs = lastHardware?.capabilities ? HARDWARE_FRESH_MS : HARDWARE_PENDING_RETRY_MS;",
    );
    // First paint never waits for them: the boot probe is still the only thing the kernel start may wait on, and it is bounded.
    expect(main).toMatch(/await Promise\.race\(\[hardwareBoot, new Promise/);
  });
});

describe("main process: leases at the heavy load sites", () => {
  it("builds one load-lease helper over the governor and gives it to the speech worker", () => {
    expect(main).toMatch(
      /const loadLeases = require\("\.\/load-lease\.cjs"\)\.createLoadLeases\(\{\s*governor,/,
    );
    expect(main).toContain("stt.setLoadLeases(loadLeases);");
    expect(main.match(/require\("\.\/load-lease\.cjs"\)/g)?.length).toBe(1);
  });

  it("asks before a local chat model loads, as voice for Auto mode and chat otherwise", () => {
    const fn = /async function leaseLocalModel\([\s\S]*?\n\}\n/.exec(main)?.[0] ?? "";
    expect(fn).toContain('request?.routingSurface === "voice" ? "voice" : "chat"');
    expect(fn).toContain("modelRouter.hardwareFit(model, routingHardwareFacts())");
    expect(fn).toContain('fit.fit === "unknown" || fit.fit === "resident"');
    expect(fn).toContain('{ ramGb: fit.needGb, hint: "cpu" }');
    expect(fn).toContain('if (taken.hint === "cpu") hardwareOffload?.set(model.id, "cpu");');
    expect(fn).toContain("loadLeases.runLoad(priority, () => modelsApi.ollamaWarm(tag");
    expect(fn).toContain('if (!governor || model?.type !== "local") return nothing;');
    const once = /async function streamOnce\(args\) \{[\s\S]*?\n\}\n/.exec(main)?.[0] ?? "";
    expect(once).toContain("const held = await leaseLocalModel(args);");
    expect(once).toContain("resourceRefused: true");
    expect(once).toMatch(/finally \{\s*held\.lease\?\.release\(\);/);
  });

  it("moves to the next model on a refusal without marking the model unhealthy", () => {
    const at = main.indexOf("if (result.resourceRefused) {");
    const health = main.indexOf("providerHealth.noteFailure(model.id, {", at);
    expect(at).toBeGreaterThan(0);
    expect(health).toBeGreaterThan(at);
    expect(main.slice(at, health)).toContain("index += 1;\n        continue;");
    expect(main).toContain("else if (!result.cancelled && !result.resourceRefused) {");
  });

  it("warms the fast chat model only through the prefetch slot", () => {
    expect(main).toContain(
      'loadLeases.runLoad("prefetch", () => modelsApi.ollamaWarm(tag)).catch(() => {});',
    );
    expect(main).not.toMatch(/void modelsApi\.ollamaWarm\(tag\)/);
  });

  it("speech: leases before the worker loads and runs the load itself in the model-load slot", () => {
    expect(stt).toContain('loadLeases.runLoad("voice", run)');
    expect(stt).toContain("return slot.ran ? slot.value : run();");
    expect(stt).toContain('priority: "voice"');
    expect(stt.match(/guardedLoad\(\(\) =>/g)?.length).toBe(2);
    expect(stt).toMatch(/const held = await leaseSpeechLoad\(wanted\);/);
    // The lease follows the worker: it is dropped when the worker is gone, never stacked.
    expect(stt).toContain("alive: () => holder.loading || Boolean(worker?.alive),");
    expect(stt).toContain("speechHeld?.fail();");
  });

  it("the embedding model loads in the kernel, not here: no lease call for it in the main process", () => {
    expect(main).not.toMatch(/embed[a-z]*\(.*loadLeases|loadLeases.*embed/i);
  });
});

const facts = (over: Partial<HardwareFacts> = {}): HardwareFacts => ({
  vramGb: 6,
  vramFreeGb: 5,
  ramGb: 16,
  ramFreeGb: 9,
  diskFreeGb: 300,
  gpuVendor: "nvidia",
  gpuName: "NVIDIA GeForce RTX 2060",
  gpus: [
    {
      vendor: "nvidia",
      name: "NVIDIA GeForce RTX 2060",
      vramGb: 6,
      vramCapped: false,
      driver: "556.12",
    },
  ],
  cudaReady: true,
  driverVersion: "556.12",
  npu: false,
  cpuClass: "mid",
  sources: ["nvidia-smi", "capability-probe"],
  health: { level: "tight", reasons: ["ram-small"] },
  ...over,
});
const governor: GovernorStatus = {
  ok: true,
  level: "high",
  notice: null,
  memory: { freeMb: 3000, totalMb: 16384, level: "high" },
  vram: null,
  lag: { p99Ms: 5, maxMs: 9, paused: false },
  power: { stress: "none", preferSmall: false },
  holds: [],
  leases: [],
  queued: [],
  jobs: {},
  actions: [],
};
const state = (view: PcStatusState["view"], extra: Partial<PcStatusState> = {}): PcStatusState => ({
  view,
  busy: false,
  refresh: vi.fn(),
  ...extra,
});
const html = (s: PcStatusState, compact = false) =>
  renderToStaticMarkup(createElement(PcStatusPanel, { state: s, compact }));

describe("the PC status panel states", () => {
  it("loading: a measuring line and no numbers", () => {
    const out = html(state({ phase: "loading" }));
    expect(out).toContain("Measuring this PC…");
    expect(out).toContain("Refresh PC details");
    expect(out).not.toContain("GB");
  });

  it("offline: says where the details appear instead of showing empty rows", () => {
    const out = html(state({ phase: "offline" }));
    expect(out).toContain("PC details appear in the installed FRIDAY app");
    expect(out).not.toContain("Processor");
  });

  it("error: the message and a Retry control", () => {
    const out = html(state({ phase: "error", message: "probe failed" }));
    expect(out).toContain("This PC could not be read");
    expect(out).toContain("probe failed");
    expect(out).toContain("Retry");
  });

  it("ready: health with its reasons, every section, and the governor", () => {
    const out = html(state({ phase: "ready", facts: facts(), governor }));
    expect(out).toContain("This PC is running tight");
    expect(out).toContain("This PC has under 6 GB of memory");
    for (const id of [
      "system",
      "processor",
      "memory",
      "graphics",
      "storage",
      "network",
      "power",
      "governor",
    ]) {
      expect(out).toContain(`data-pc-section="${id}"`);
    }
    expect(out).toContain("high: idle models are being unloaded");
  });

  it("ready, still measuring: says measuring, not healthy", () => {
    const out = html(
      state({
        phase: "ready",
        facts: facts({ sources: ["nvidia-smi"], health: { level: "ok", reasons: [] } }),
        governor: null,
      }),
    );
    expect(out).toContain("Still measuring this PC");
    expect(out).toContain("measuring…");
    expect(out).not.toContain("This PC is healthy");
    expect(out).toContain("not running");
  });

  it("compact (Status page): health, memory and the governor only", () => {
    const out = html(state({ phase: "ready", facts: facts(), governor }), true);
    expect(out).toContain('data-pc-section="memory"');
    expect(out).toContain('data-pc-section="governor"');
    expect(out).not.toContain('data-pc-section="processor"');
  });

  it("disables the refresh button while it is reading", () => {
    const out = html(state({ phase: "ready", facts: facts(), governor }, { busy: true } as never));
    expect(out).toMatch(/<button[^>]*disabled[^>]*>[\s\S]*Refresh PC details/);
  });
});

describe("the pages read through the shared channels, with no timer of their own", () => {
  const hook = read("src/lib/friday/use-pc-status.ts");
  it("the hook reads hardware:facts and governor:status, refreshes on mount, on request and on a change signal", () => {
    expect(hook).toContain("api.hardwareFacts(force)");
    expect(hook).toContain(".governorStatus?.()");
    expect(hook).toContain("subscribeSystemPressure(onChange)");
    expect(hook).toContain("desktopApi()?.onGovernorNotice?.(onChange)");
    expect(hook).not.toContain("setInterval");
    // The only timers are one-shot: a bounded retry while probes measure, and a debounce.
    expect(hook).toContain("const PENDING_RETRY_MAX = 3;");
  });

  it("Hardware and Status render the panel from one hook call each, and keep their old panels", () => {
    const system = read("src/routes/system.tsx");
    const status = read("src/routes/status.tsx");
    expect(system).toContain("const pc = usePcStatus();");
    expect(system).toContain("<PcStatusPanel state={pc} />");
    expect(system).toContain('title="Hardware Overview"');
    expect(system).toContain('title="Acceleration"');
    expect(status).toContain("<PcStatusPanel state={pc} compact />");
    expect(status).toContain("Open Hardware →");
  });

  it("the channels exist end to end: preload, main handler and budget class", () => {
    const preload = read("electron/preload.cjs");
    const table = read("electron/ipc-budget-table.cjs");
    expect(preload).toContain('ipcRenderer.invoke("hardware:facts", force === true)');
    expect(preload).toContain('"governor:status"');
    expect(main.match(/ipcMain\.handle\("hardware:facts"/g)?.length).toBe(1);
    expect(main.match(/ipcMain\.handle\("governor:status"/g)?.length).toBe(1);
    expect(table).toContain('"hardware:facts": "quick"');
    expect(table).toContain('"governor:status"');
  });
});
