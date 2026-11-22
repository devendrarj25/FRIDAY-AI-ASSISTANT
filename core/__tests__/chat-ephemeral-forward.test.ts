import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

describe("a Brain draft reaches the kernel as an ephemeral, text-only turn", () => {
  it("the bridge request type declares the draft flag", () => {
    const bridge = read("src/lib/friday/bridge.ts");
    const type = bridge.slice(
      bridge.indexOf("sendChat?: (request: {"),
      bridge.indexOf("abortChat?:"),
    );
    expect(type).toMatch(/draft\?: boolean;/);
  });

  it("streamOnce forwards ephemeral as a strict boolean inside the chat.stream params", () => {
    const main = read("electron/main.cjs");
    const params = main.slice(main.indexOf('method: "chat.stream"'));
    const forwarded = params.slice(0, params.indexOf("runId: request.runId"));
    expect(forwarded).toContain("ephemeral: request.draft === true,");
    // Never a truthy coercion: "true", 1 or an object must not make a stored turn ephemeral.
    expect(main).not.toMatch(/ephemeral:\s*(Boolean\(|!!|request\.draft\s*[,}])/);
  });

  it("the kernel honours only a strict true, never on a phone turn, and refuses every tool", () => {
    const kernel = read("kernel/main.py");
    expect(kernel).toMatch(/ephemeral = params\.get\("ephemeral"\) is True and not phone_cognize/);
    expect(kernel).toMatch(/router_no_tools\.set\(True\) if ephemeral/);
    const router = read("kernel/router.py");
    expect(router).toMatch(/NO_TOOLS\.get\(\) or model\.options\.get\("tools"\) is False/);
    expect(router).toContain("no tool may run");
  });

  it("the Brain sends draft: true on a draft request and the companion path never forwards it", () => {
    const brain = read("src/lib/friday/brain-engine.ts");
    expect(brain).toMatch(/routingSurface: "voice" as const,\s*draft: true,/);
    // The phone reaches the kernel only through the read allowlist, never chat.stream with params.
    const kernel = read("kernel/main.py");
    expect(kernel.slice(kernel.indexOf("COMPANION_READS"))).not.toMatch(/^\s*"chat\.stream",/m);
  });
});
