/**
 * Phone companion parity with the desktop.
 *
 * The phone is not a read-only viewer and not a frozen snapshot:
 *  - a turn typed on the PC is pushed to the phone live,
 *  - the section/capability registry is re-read when the desktop republishes,
 *  - a capability the phone taps runs FRIDAY's real planner, so the owner's
 *    approval gate on the PC still decides on risky steps.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const kernel = fs.readFileSync(path.join(root, "kernel/main.py"), "utf8");
const companion = fs.readFileSync(path.join(root, "kernel/companion.py"), "utf8");
const { TREES } = createRequire(import.meta.url)(
  path.join(root, "electron/friday-contract.cjs"),
) as { TREES: Record<string, unknown> };

describe("phone live parity", () => {
  it("tracks live phone sockets in one place", () => {
    expect(companion).toContain("PHONE_SOCKETS: set = set()");
    expect(companion).toContain("PHONE_SOCKETS.add(ws)");
    expect(companion).toContain("PHONE_SOCKETS.discard(ws)");
    expect(companion).toContain("async def phone_broadcast");
  });

  it("mirrors desktop chat turns to the phone", () => {
    const handler = kernel.slice(
      kernel.indexOf('if method == "chat.stream"'),
      kernel.indexOf('if method == "task.run"'),
    );
    expect(handler).toMatch(/phone_broadcast\(\{"type": "peer", "role": "user"/);
    expect(handler).toMatch(/phone_broadcast\(\{"type": "peer", "role": "assistant"/);
    expect(handler).toContain("_PHONE_COGNIZE");
    expect(companion).toContain("if(m.type==='peer')");
    expect(companion).toContain("_PHONE_SENDER");
    expect(companion).toContain("m.origin!=='phone'");
  });

  it("refreshes the phone menu when the desktop republishes its registry", () => {
    expect(kernel).toContain("_watch_companion_registry");
    expect(kernel).toContain('phone_broadcast({"type": "refresh"})');
    expect(kernel).toContain('phone_broadcast({"type": "live"');
    expect(companion).toContain("if(m.type==='refresh')");
    expect(companion).toContain("if(m.type==='live')");
    expect(companion).toContain("live.work");
    expect(kernel).toContain("privacy.ask");
    expect(kernel).toContain('incoming == "privacy.decide"');
    expect(kernel).not.toContain('method == "privacy.decide"');
  });

  it("replays the shared conversation when a phone reconnects", () => {
    expect(kernel).toContain("def companion_history");
    expect(kernel).toContain("history_provider=companion_history");
    expect(companion).toContain("if(m.type==='history')");
    expect(companion).toContain("el('log').innerHTML=''");
  });

  it("publishes every installable capability type through the one companion publish call", () => {
    const shell = fs.readFileSync(path.join(root, "src/components/friday/AppShell.tsx"), "utf8");
    const runtime = fs.readFileSync(path.join(root, "src/lib/friday/runtime.ts"), "utf8");
    const publish = shell.slice(
      shell.indexOf("const publish = () => {"),
      shell.indexOf("publish();"),
    );
    expect(publish).toContain("capabilityRegistry.getSnapshot()");
    expect(publish).toContain("publishCompanionFeatures");
    expect(publish).toContain("capabilities: snapshot.resources.map");
    expect(publish).toContain("buildCompanionLive");
    expect(publish).toContain("resourceRunnable");
    expect(publish).toContain("runnable: resourceRunnable");
    expect(publish).toContain("mode: voice.mode");
    expect(publish).toContain("observeBrain");
    expect(publish).toContain("workGoal");
    expect(shell).toContain("brain.subscribe");
    expect(publish).toContain("knownConnectors()");
    expect(publish).toContain("doctor.getSnapshot()");
    expect(publish).toContain("assistantMode.getSnapshot()");
    expect(kernel).toContain("capabilities_provider=companion_capability_list");
    expect(companion).toContain("data.capabilities||[]");
    const workspaceMap = runtime.slice(
      runtime.indexOf("const WORKSPACE_TYPE"),
      runtime.indexOf("const HUB_TYPE"),
    );
    for (const kind of Object.keys(TREES)) {
      expect(workspaceMap).toContain(`${kind}:`);
    }
    expect(runtime).toContain('modules: "module"');
    expect(runtime).toContain("installedCapabilities");
    expect(runtime).toContain('item.tree !== "models"');
  });

  it("runs phone-triggered capabilities through the real planner, not a second path", () => {
    const task = kernel.slice(
      kernel.indexOf("async def companion_task"),
      kernel.indexOf("def companion_payload"),
    );
    expect(task).toContain('dispatch("task.run"');
    expect(task).toContain("approval-required");
    expect(companion).toContain("task_handler=");
    expect(companion).toContain("function isRunnable");
    expect(companion).toContain("if(isRunnable(c))");
    expect(companion).not.toContain("const RUNNABLE=");
    expect(companion).toContain("typeof live.line==='string'");
  });

  it("keeps direct phone commands read-only", () => {
    const reads = kernel.slice(
      kernel.indexOf("COMPANION_READS = {"),
      kernel.indexOf("async def companion_command"),
    );
    for (const forbidden of ["tool.exec", "task.approve", "code.run", "settings.set"]) {
      expect(reads).not.toContain(`"${forbidden}"`);
    }
    expect(kernel).toContain("if method not in COMPANION_READS");
  });

  it("does not invent a second kernel-method phone menu when the registry is unpublished", () => {
    expect(kernel).not.toContain('"group": "Kernel"');
    expect(kernel).toContain("instead of inventing a second kernel-method menu");
  });

  it("publishes the existing Tailscale probe on the same live snapshot", () => {
    const shell = fs.readFileSync(path.join(root, "src/components/friday/AppShell.tsx"), "utf8");
    expect(shell).toContain("companionRemote");
    expect(shell).toContain("remote: remoteCache");
    expect(companion).toContain("live.remote");
    expect(companion).not.toContain("ngrok");
    expect(companion).not.toMatch(/cloudflare/i);
  });

  it("acks a busy desktop instead of leaving the kernel to invent a second brain", () => {
    const engine = fs.readFileSync(path.join(root, "src/lib/friday/brain-engine.ts"), "utf8");
    expect(engine).toContain("companionCognizeAck");
    expect(engine).toContain("I'm still working on the last request");
    expect(engine).toContain('turnAwarenessExtra(prompt, { kind: "phone" })');
    expect(engine).toContain("composer.directive()");
    expect(engine).not.toMatch(/If we\s+are busy we do not ack/);
    expect(kernel).toContain("chat.replace");
    expect(kernel).toContain('phone_broadcast({"type": "history"');
    expect(companion).toContain("if(m.type==='history')");
    expect(kernel).toContain("kernel_stream");
  });

  it("clears kernel history and Auto captions when the desktop conversation is cleared", () => {
    const engine = fs.readFileSync(path.join(root, "src/lib/friday/brain-engine.ts"), "utf8");
    expect(engine).toContain("syncSharedSurfaces");
    expect(engine).toContain("kernelApi.chat");
    expect(engine).toContain(".replace(");
    expect(engine).toContain("assistantMode.clearCaptions()");
    expect(engine).toContain("assistantMode.adoptTranscript()");
    expect(fs.readFileSync(path.join(root, "src/lib/friday/assistant-mode.ts"), "utf8")).toContain(
      "adoptTranscript()",
    );
  });
});
