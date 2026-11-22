import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { askFriday } from "../../src/lib/friday/ask";

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

describe("I1: the quick lane is an ephemeral, text-only turn too", () => {
  const g = globalThis as unknown as { window?: unknown };
  const saved = g.window;
  afterEach(() => {
    g.window = saved;
  });

  /** A desktop bridge that records the request and answers it at once. */
  function bridge() {
    const sent: Array<Record<string, unknown>> = [];
    const done = new Set<(e: { requestId: string; cancelled?: boolean }) => void>();
    const deltas = new Set<(e: { requestId: string; text: string }) => void>();
    g.window = {
      friday: {
        sendChat: (request: Record<string, unknown>) => {
          sent.push(request);
          queueMicrotask(() => {
            deltas.forEach((fn) => fn({ requestId: String(request["requestId"]), text: "Paris." }));
            done.forEach((fn) => fn({ requestId: String(request["requestId"]) }));
          });
        },
        onChatDelta: (fn: never) => (deltas.add(fn), () => deltas.delete(fn)),
        onChatDone: (fn: never) => (done.add(fn), () => done.delete(fn)),
        onChatError: () => () => undefined,
        abortChat: vi.fn(),
      },
    };
    return sent;
  }

  it("askFriday sends draft: true only when asked to be ephemeral, so the kernel stores nothing and offers no tool", async () => {
    const sent = bridge();
    await askFriday("capital of France?", { ephemeral: true });
    await askFriday("capital of France?");
    expect(sent[0]?.["draft"]).toBe(true);
    expect("draft" in (sent[1] ?? {})).toBe(false);
  });

  it("the quick lane asks ephemerally; the full turn and the other callers do not change", () => {
    const brain = read("src/lib/friday/brain-engine.ts");
    expect(brain).toMatch(
      /askFriday\(text, \{\s*system: QUICK_SYSTEM,\s*timeoutMs: 45_000,\s*ephemeral: true,?\s*\}\)/,
    );
    const ask = read("src/lib/friday/ask.ts");
    expect(ask).toMatch(/\.\.\.\(options\.ephemeral === true \? \{ draft: true \} : \{\}\)/);
    // The kernel half is pinned above: only a strict true counts, and every tool is refused.
  });
});
