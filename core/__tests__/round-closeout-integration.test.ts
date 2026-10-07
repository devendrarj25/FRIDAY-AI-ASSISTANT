/**
 * Part B closeout — one continuous session against the real modules from
 * this round (route/cost modes, Part-0 gates, companion live, boot honesty).
 *
 * Does not launch the packaged Windows EXE. Every assertion drives the same
 * functions the desktop, voice path, phone, and kernel use.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { createRequire } from "node:module";
import { pinKnowledgeClock } from "./helpers/knowledge-clock";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildCompanionLive, companionLiveLine } from "../../src/lib/friday/companion-live";
import {
  actionNeedsApproval,
  commandNeedsApproval,
  setActionMode,
} from "../../src/lib/friday/brain/action-risk";
import { considerMemory } from "../../src/lib/friday/brain/memory-policy";
import { governance, ALWAYS_ASK_KINDS } from "../../src/lib/friday/self/governance";
import { autonomy } from "../../src/lib/friday/self/autonomy";
import { inspectCrossModeSync } from "../../src/lib/friday/cross-mode-sync";

const require_ = createRequire(import.meta.url);

pinKnowledgeClock();
const router = require_("../../electron/model-router.cjs");
const billing = require_("../../electron/billing-policy.cjs");
const firewall = require_("../../electron/billing-firewall.cjs");
const privacy = require_("../../electron/privacy-firewall.cjs");
const authority = require_("../../electron/tool-authority.cjs");
const autoRestart = require_("../../electron/kernel-auto-restart.cjs");
const health = require_("../../electron/service-health.cjs");
const access = require_("../../electron/model-access.cjs");

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

const model = (id: string, kind: "local" | "cloud", provider: string) => {
  const base = {
    id,
    label: id,
    provider,
    role: "brain",
    contextK: 32,
    meta: { providerId: provider, kind, modelName: id.split(":")[1] || id },
  };
  return kind === "cloud" && (provider === "gemini" || provider === "groq")
    ? access.stampVerified(base)
    : base;
};

const POOL = [
  model("ollama:llama3.1", "local", "ollama"),
  model("ollama:qwen2.5", "local", "ollama"),
  model("gemini:gemini-2.0-flash", "cloud", "gemini"),
  model("groq:llama-3.3-70b", "cloud", "groq"),
  model("openai:gpt-4o", "cloud", "openai"),
];

const ids = (list: Array<{ id: string }>) => list.map((m) => m.id);

describe("Part B closeout — one continuous routing + safety session", () => {
  beforeEach(() => setActionMode("auto"));

  it("walks cost mode, route mode, gates, companion live, and boot honesty in order", () => {
    // --- 1. Auto / Manual share one action-mode switch (chat + voice) ------
    setActionMode("auto");
    expect(commandNeedsApproval("what is 2 + 2", "auto")).toBe(false);
    expect(actionNeedsApproval("safe", "auto")).toBe(false);
    setActionMode("manual");
    expect(commandNeedsApproval("what is 2 + 2", "manual")).toBe(true);
    expect(actionNeedsApproval("safe", "manual")).toBe(true);
    setActionMode("auto");

    const sync = inspectCrossModeSync();
    expect(sync.chatModelIds[0]).toBe(sync.voiceModelIds[0]);
    expect(sync.ok).toBe(true);
    expect(read("src/lib/friday/assistant-mode.ts")).toContain('from "./brain-engine"');
    expect(read("src/lib/friday/assistant-mode.ts")).toContain("brain.send(");

    // --- 2. Cost mode: free-only → auto (free-preferred) → paid-only -------
    const freeOnly = ids(router.selectEligible(POOL, { policy: "free-only", mode: "auto" }));
    expect(freeOnly).toContain("ollama:llama3.1");
    expect(freeOnly).toContain("gemini:gemini-2.0-flash");
    expect(freeOnly).not.toContain("openai:gpt-4o");

    const autoCost = ids(router.selectEligible(POOL, { policy: "free-preferred", mode: "auto" }));
    expect(autoCost).toContain("ollama:llama3.1");
    expect(autoCost).toContain("groq:llama-3.3-70b");
    expect(autoCost).not.toContain("openai:gpt-4o");
    expect(router.policyForCostMode("free-first")).toBe("free-preferred");

    const paidOnly = ids(router.selectEligible(POOL, { policy: "paid-only", mode: "auto" }));
    expect(paidOnly).toEqual(["openai:gpt-4o"]);
    expect(
      firewall.guardProviderRequest({
        model: { type: "cloud", access: "paid" },
        billing: billing.normaliseBilling({ paidAccess: true, autoPaidUsage: true }),
        policy: "paid-only",
      }).allowed,
    ).toBe(true);

    const localPaid = router.selectEligible(POOL, {
      mode: "local-only",
      policy: "paid-only",
    });
    expect(localPaid).toEqual([]);
    expect(router.explainUnavailable({ mode: "local-only", policy: "paid-only" })).toMatch(
      /no paid local models exist/i,
    );

    // --- 3. Route mode: local-only / cloud-only / auto, with multi-select --
    const localMulti = ids(
      router.selectEligible(POOL, {
        mode: "local-only",
        preferred: ["ollama:llama3.1", "ollama:qwen2.5"],
      }),
    );
    expect(localMulti.sort()).toEqual(["ollama:llama3.1", "ollama:qwen2.5"].sort());
    expect(localMulti.every((id) => id.startsWith("ollama:"))).toBe(true);

    const cloudMulti = ids(
      router.selectEligible(POOL, {
        mode: "cloud-only",
        preferred: ["gemini:gemini-2.0-flash", "groq:llama-3.3-70b"],
      }),
    );
    expect(cloudMulti.sort()).toEqual(["gemini:gemini-2.0-flash", "groq:llama-3.3-70b"].sort());
    expect(cloudMulti.some((id) => id.startsWith("ollama:"))).toBe(false);

    const autoRoute = ids(router.selectEligible(POOL, { mode: "auto", policy: "free-preferred" }));
    expect(autoRoute.some((id) => id.startsWith("ollama:"))).toBe(true);
    expect(autoRoute.some((id) => id.startsWith("gemini:"))).toBe(true);

    // --- 4. Ask-before-download / install (no silent auto-apply) -----------
    expect(commandNeedsApproval("download llama3.2-3b", "auto")).toBe(true);
    expect(commandNeedsApproval("install faster-whisper", "auto")).toBe(true);
    expect(ALWAYS_ASK_KINDS.has("download")).toBe(true);
    expect(ALWAYS_ASK_KINDS.has("install")).toBe(true);
    autonomy.update({ approvalLevel: "trusted" });
    expect(governance.autoApproves("safe", "download")).toBe(false);
    expect(governance.autoApproves("safe", "install")).toBe(false);

    // --- 5. Ask-before-delete; stored allow cannot skip write/exec ---------
    expect(commandNeedsApproval("delete the logs folder", "auto")).toBe(true);
    expect(authority.decide("fs.write", "write", { "fs.write": "allow" })).toBe("ask");
    expect(authority.decide("shell.cmd", "exec", { "shell.cmd": "allow" })).toBe("ask");

    // --- 6. Credentials typed in chat are never kept as memory -------------
    const keyText = "my api key is sk-abcdefghijklmnopqrstuvwxyz";
    expect(considerMemory({ text: keyText }).keep).toBe(false);
    expect(privacy.classify(keyText).level).toBe("sensitive");
    expect(
      privacy.guardEgress({
        model: { type: "cloud", id: "openai:gpt-4o", label: "gpt-4o" },
        content: keyText,
        connected: true,
      }).autoAllowed,
    ).toBe(false);
    expect(read("src/lib/friday/brain-engine.ts")).not.toContain("connectProvider");
    expect(read("src/lib/friday/assistant-mode.ts")).not.toContain("connectProvider");
    expect(read("src/lib/friday/brain/core-brain.ts")).toContain("considerMemory");

    // --- 7. Companion live carries the same route/cost/picks, no refresh ---
    const live = buildCompanionLive({
      voice: "LISTENING",
      listening: true,
      error: false,
      doctorProblems: 0,
      doctorWarnings: 0,
      doctorScanning: false,
      connectors: [],
      cloud: ["openai"],
      routeMode: "cloud-only",
      policy: "paid-only",
      selected: ["openai:gpt-4o"],
    });
    expect(live.routeMode).toBe("cloud-only");
    expect(live.policy).toBe("paid-only");
    expect(live.selected).toEqual(["openai:gpt-4o"]);
    expect(companionLiveLine(live)).toContain("route: cloud-only");
    expect(companionLiveLine(live)).toContain("cost: paid-only");
    const shell = read("src/components/friday/AppShell.tsx");
    expect(shell).toContain("usageRegistry.subscribe(publish)");
    expect(shell).toContain("assistantMode.subscribe(publish)");
    expect(read("electron/main.cjs")).toContain("void pushBillingToKernel()");

    // --- 8. Boot / crash honesty from Part A still holds -------------------
    const main = read("electron/main.cjs");
    expect(main).toContain("if (!kernel && !kernelReady) return false");
    expect(main).toContain("serviceHealth.invalidate()");
    expect(autoRestart.DELAYS_MS).toEqual([0, 2000, 8000]);
    expect(autoRestart.MAX_ATTEMPTS).toBe(3);
    expect(typeof health.invalidate).toBe("function");
    expect(read("electron/service-health.cjs")).toContain("sampleGeneration");

    autonomy.update({ approvalLevel: "balanced" });
    setActionMode("auto");
  });
});
