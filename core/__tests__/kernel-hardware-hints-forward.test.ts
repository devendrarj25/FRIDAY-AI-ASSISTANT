/**
 * The desktop forwards the router's per-model GPU/CPU placement to the kernel with the chat request.
 * The wiring lives in an Electron entry point that cannot run here, so it is pinned by shape, and the
 * values the router can emit are checked against the ones the kernel accepts.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const require_ = createRequire(import.meta.url);
const read = (rel: string) =>
  readFileSync(resolve(__dirname, "../..", rel), "utf8").replace(/\r\n/g, "\n");

const main = read("electron/main.cjs");
const kernelRouter = read("kernel/router.py");
const kernelMain = read("kernel/main.py");

describe("kernel hardware hints forwarding", () => {
  it("records the planned placement into the request's own map, never a module-wide one", () => {
    expect(main).not.toMatch(/chatHardwareOffload/);
    expect(main).not.toMatch(/^const \w*[Oo]ffload\w* = new Map\(\)/m);
    expect(main).toMatch(
      /for \(const planned of plan\.models\) \{\n\s+const offload = plan\.hardwareHints\?\.\[planned\.id\]\?\.offload;\n\s+if \(typeof offload === "string"\) hardwareOffload\?\.set\(planned\.id, offload\);\n\s+else hardwareOffload\?\.delete\(planned\.id\);/,
    );
    expect(main).toMatch(/const hardwareOffload =\s+extraOptions\.hardwareOffload instanceof Map/);
  });

  it("startChat creates one map per request and hands the same one to the router and the stream", () => {
    const start = main.slice(main.indexOf("async function startChat(request)"));
    const body = start.slice(0, start.indexOf("const checked = candidates.length"));
    expect(body).toMatch(/const hardwareOffload = new Map\(\);/);
    expect(body).toMatch(/routingOptions = \{[\s\S]*?hardwareOffload,/);
    expect(body).toMatch(/await streamOnce\(\{[\s\S]*?hardwareOffload,[\s\S]*?\}\);/);
    // The parallel chat has no plan: it sends no hint instead of reading someone else's.
    const parallel = main.slice(main.indexOf("async function runRole"));
    expect(parallel.slice(0, parallel.indexOf("persistRouterHealth"))).not.toMatch(
      /hardwareOffload/,
    );
  });

  it("sends the hint in the chat.stream params for the one model of that request, and nothing when absent", () => {
    const stream = main.slice(main.indexOf('method: "chat.stream"'));
    const params = stream.slice(0, stream.indexOf("return;"));
    const squash = (text: string) => text.replace(/\s+/g, "").replace(/,([}\])])/g, "$1");
    expect(squash(params)).toContain(
      squash(
        "...(hardwareOffload?.has(model.id) ? { hardwareHints: { [model.id]: { offload: hardwareOffload.get(model.id) } } } : {})",
      ),
    );
    // The request still names exactly one model: a hint cannot add one.
    expect(params).toMatch(/modelIds: \[model\.id\]/);
    expect(params).toMatch(/allowFallback: false/);
    expect(main).toMatch(/async function streamOnceRaw\(\{[^}]*hardwareOffload = null,/);
  });

  it("the kernel reads hardwareHints and applies it through its own validator", () => {
    expect(kernelMain).toContain('hardware_hints=params.get("hardwareHints")');
    expect(kernelRouter).toContain("hints = normalise_hardware_hints(hardware_hints)");
  });

  it("every placement the router emits is one the kernel accepts", () => {
    const accepted = /_OFFLOAD_VALUES = frozenset\(\{([^}]*)\}\)/.exec(kernelRouter)?.[1] ?? "";
    const kernelValues = [...accepted.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    expect(kernelValues).toEqual(["cpu", "gpu", "gpu-if-supported"]);
    const { hardwareFit } = require_("../../electron/model-router.cjs");
    const model = (gb: number) => ({
      id: "ollama:m",
      type: "local",
      meta: { kind: "local", sizeGb: gb },
    });
    const facts = [
      { vramGb: 8, vramFreeGb: 7, ramGb: 16, ramFreeGb: 10, cudaReady: true },
      { vramGb: 8, vramFreeGb: 7, ramGb: 16, ramFreeGb: 10, cudaReady: false },
      { vramGb: 0, ramGb: 16, ramFreeGb: 10 },
      { ramGb: 4, ramFreeGb: 2 },
      // A probed PC with no usable GPU: the one case that says "cpu".
      { gpus: [], ramGb: 16, ramFreeGb: 10 },
      { gpus: [{ vendor: "nvidia" }], vramGb: 6, vramFreeGb: 5, ramGb: 32, ramFreeGb: 24 },
    ];
    const seenValues = new Set<string>();
    expect(typeof hardwareFit).toBe("function");
    let seen = 0;
    for (const f of facts) {
      for (const gb of [1, 5, 9, 30]) {
        const offload = hardwareFit(model(gb), f).offload;
        if (typeof offload === "string") {
          seen += 1;
          seenValues.add(offload);
          expect(kernelValues).toContain(offload);
        }
      }
    }
    expect(seen).toBeGreaterThan(8);
    // All three values are still produced, and null (nothing forced) is produced too.
    expect([...seenValues].sort()).toEqual(["cpu", "gpu", "gpu-if-supported"]);
    expect(hardwareFit(model(9), facts[4]).offload).toBe("cpu");
    expect(hardwareFit(model(9), facts[5]).offload).toBeNull();
  });
});

describe("the first-turn hardware wait", () => {
  const resolve_ = main.slice(main.indexOf("async function resolveChatModels("));
  const head = resolve_.slice(0, resolve_.indexOf("const preferred ="));

  it("is skipped on the voice surface, which has an 800 ms budget", () => {
    expect(head).toMatch(/extraOptions\.surface !== "voice"/);
  });

  it("happens at most once per app run, and the timer is always cleared", () => {
    expect(main).toMatch(/let hardwareBootWaited = false;/);
    expect(head).toMatch(/!hardwareBootWaited/);
    expect(head).toMatch(/hardwareBootWaited = true;/);
    expect(head).toMatch(/clearTimeout\(/);
    expect(head).toMatch(/finally \{/);
    // The flag is raised before the first await so two concurrent first turns do not both wait.
    expect(head.indexOf("hardwareBootWaited = true;")).toBeLessThan(
      head.indexOf("await Promise.race"),
    );
  });

  it("the comment about missing facts is true: no probe means null memory and CPU fields", () => {
    expect(main).not.toMatch(/Before the first probe finishes every field is null and routing\n/);
    expect(main).toMatch(/no live number stands in for a probe/);
  });
});
