/**
 * The tool permission gate in the main process reads the owner's autonomy dial. At Full (and not stopped) a write or
 * exec call runs without a prompt but still carries the signed, argument-bound authorization the kernel checks
 * (its argument policy and its secret and credential refusals stay); at Ask every time and Balanced it asks; when
 * everything is stopped it refuses. The app's own shutdown and restart always ask. A question nobody answers ends as
 * "no" and is routed to a notification. The real functions are cut out of electron/main.cjs and run here with their
 * collaborators replaced, because the entry point itself cannot be loaded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const require_ = createRequire(import.meta.url);
const gate = require_("../../electron/tool-gate.cjs") as {
  ASK_TIMEOUT_MS: number;
  gateDecision: (input: {
    risk: string;
    decision: string;
    dial?: string;
    halted?: boolean;
    stored?: string;
  }) => { decision: string; reason: string | null };
  askWithTimeout: (
    ask: (signal: AbortSignal) => Promise<unknown>,
    options?: { ms?: number },
  ) => Promise<{ granted: boolean; remember: boolean; timedOut?: boolean }>;
};
const toolAuthority = require_("../../electron/tool-authority.cjs") as {
  decide: (name: string, risk: string, policy: Record<string, string>) => string;
  hashArgs: (args: unknown) => string;
};

const main = readFileSync(resolve(__dirname, "../../electron/main.cjs"), "utf8").replace(
  /\r\n/g,
  "\n",
);

/** One top-level function of main.cjs, found by its first line and closed by brace counting. */
function extract(signature: string): string {
  const start = main.indexOf(signature);
  expect(start, `${signature} is in main.cjs`).toBeGreaterThan(-1);
  const open = main.indexOf("{", main.indexOf(")", start));
  let depth = 0;
  for (let at = open; at < main.length; at += 1) {
    if (main[at] === "{") depth += 1;
    else if (main[at] === "}") {
      depth -= 1;
      if (depth === 0) return main.slice(start, at + 1);
    }
  }
  throw new Error(`${signature} is not closed`);
}

type Deps = Record<string, unknown>;
function build<T>(source: string, name: string, deps: Deps): T {
  const names = Object.keys(deps);
  const factory = new Function(...names, `${source}\nreturn ${name};`);
  return factory(...names.map((key) => deps[key])) as T;
}

type Verdict = {
  allowed: boolean;
  risk?: string;
  reason?: string;
  authorization?: string | null;
  desktop?: boolean;
};
const SECRET = "test-secret-built-at-run-time-" + "x".repeat(8);

function authorizer(options: {
  risk: string;
  dial?: string;
  halted?: boolean;
  policy?: Record<string, string>;
  alwaysAsk?: string[];
  answer?: { granted: boolean; remember: boolean };
}) {
  const asked: string[] = [];
  const remembered: unknown[] = [];
  const deps: Deps = {
    appLifecycle: { alwaysAsk: (name: string) => (options.alwaysAsk ?? []).includes(name) },
    askOwnerForTool: async (name: string) => {
      asked.push(name);
      return options.answer ?? { granted: true, remember: false };
    },
    toolRisk: async () => options.risk,
    applyOwnerPermissionOverlay: (_name: string, _risk: string, decision: string) => decision,
    toolAuthority,
    toolPolicy: () => options.policy ?? {},
    persistToolDecision: (...args: unknown[]) => remembered.push(args),
    ownerAutonomyState: () => ({
      dial: options.dial ?? "balanced",
      halted: options.halted === true,
    }),
    toolGate: gate,
    TOOL_AUTHORITY_SECRET: SECRET,
    log: () => undefined,
  };
  const fn = build<(name: string, args: unknown) => Promise<Verdict>>(
    extract("async function authorizeToolCall(name, args) {"),
    "authorizeToolCall",
    deps,
  );
  return { call: fn, asked, remembered };
}

describe("the pure dial rules", () => {
  const cases: [string, Parameters<typeof gate.gateDecision>[0], string, string | null][] = [
    [
      "write at Full asks nothing",
      { risk: "write", decision: "ask", dial: "full" },
      "allow",
      "full-autonomy",
    ],
    [
      "exec at Full asks nothing",
      { risk: "exec", decision: "ask", dial: "full" },
      "allow",
      "full-autonomy",
    ],
    ["write at Balanced asks", { risk: "write", decision: "ask", dial: "balanced" }, "ask", null],
    ["exec at Ask every time asks", { risk: "exec", decision: "ask", dial: "ask" }, "ask", null],
    [
      "a stopped FRIDAY refuses write at Full",
      { risk: "write", decision: "ask", dial: "full", halted: true },
      "deny",
      "halted",
    ],
    [
      "a stopped FRIDAY refuses exec at Balanced",
      { risk: "exec", decision: "ask", dial: "balanced", halted: true },
      "deny",
      "halted",
    ],
    [
      "a read still runs when stopped",
      { risk: "safe", decision: "allow", dial: "full", halted: true },
      "allow",
      null,
    ],
    [
      "a tool the owner set to ask by name still asks at Full",
      { risk: "exec", decision: "ask", dial: "full", stored: "ask" },
      "ask",
      null,
    ],
    [
      "a stored deny wins over Full",
      { risk: "exec", decision: "deny", dial: "full", stored: "deny" },
      "deny",
      "policy",
    ],
    ["an unknown risk with no dial asks", { risk: "mystery", decision: "ask" }, "ask", null],
    ["a read is not touched by Full", { risk: "safe", decision: "ask", dial: "full" }, "ask", null],
  ];
  it.each(cases)("%s", (_label, input, decision, reason) => {
    expect(gate.gateDecision(input)).toEqual({ decision, reason });
  });
});

describe("authorizeToolCall in electron/main.cjs", () => {
  it("Full and not stopped: write and exec run without a prompt and carry a signed authorization bound to the args", async () => {
    for (const risk of ["write", "exec"]) {
      const { call, asked } = authorizer({ risk, dial: "full" });
      const args = { path: "notes.txt", text: "hello" };
      const verdict = await call("fs.write", args);
      expect(asked).toEqual([]);
      expect(verdict.allowed).toBe(true);
      expect(verdict.risk).toBe(risk);
      expect(String(verdict.authorization)).toMatch(/^v1\./);
      const body = JSON.parse(
        Buffer.from(String(verdict.authorization).split(".")[1] ?? "", "base64url").toString(
          "utf8",
        ),
      ) as { tool: string; argsHash: string; risk: string };
      expect(body).toMatchObject({
        tool: "fs.write",
        risk,
        argsHash: toolAuthority.hashArgs(args),
      });
    }
  });

  it("Balanced and Ask every time still ask, and a refusal is final", async () => {
    for (const dial of ["balanced", "ask"]) {
      const yes = authorizer({ risk: "exec", dial });
      expect((await yes.call("shell.cmd", {})).allowed).toBe(true);
      expect(yes.asked).toEqual(["shell.cmd"]);
      const no = authorizer({ risk: "exec", dial, answer: { granted: false, remember: false } });
      const verdict = await no.call("shell.cmd", {});
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toMatch(/denied/);
    }
  });

  it("a stopped FRIDAY refuses a write or exec call at every dial and never asks", async () => {
    for (const dial of ["full", "balanced", "ask"]) {
      const { call, asked } = authorizer({ risk: "write", dial, halted: true });
      const verdict = await call("fs.write", { path: "a" });
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toMatch(/Stop everything/);
      expect(verdict.authorization ?? null).toBeNull();
      expect(asked).toEqual([]);
    }
  });

  it("a read-only tool runs at any dial, stopped or not", async () => {
    for (const halted of [false, true]) {
      const { call, asked } = authorizer({ risk: "safe", dial: "ask", halted });
      const verdict = await call("fs.read", { path: "a" });
      expect(verdict).toMatchObject({ allowed: true, authorization: null });
      expect(asked).toEqual([]);
    }
  });

  it("the app's own shutdown and restart ask at Full too", async () => {
    const { call, asked } = authorizer({ risk: "exec", dial: "full", alwaysAsk: ["app.shutdown"] });
    const verdict = await call("app.shutdown", {});
    expect(asked).toEqual(["app.shutdown"]);
    expect(verdict).toMatchObject({ allowed: true, desktop: true });
    const refused = authorizer({
      risk: "exec",
      dial: "full",
      alwaysAsk: ["app.shutdown"],
      answer: { granted: false, remember: false },
    });
    expect((await refused.call("app.shutdown", {})).allowed).toBe(false);
  });

  it("a tool the owner set to ask by name asks at Full, and one set to deny stays blocked", async () => {
    const ask = authorizer({ risk: "exec", dial: "full", policy: { "shell.cmd": "ask" } });
    await ask.call("shell.cmd", {});
    expect(ask.asked).toEqual(["shell.cmd"]);
    const deny = authorizer({ risk: "exec", dial: "full", policy: { "shell.cmd": "deny" } });
    const verdict = await deny.call("shell.cmd", {});
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/blocked by your permission settings/);
    expect(deny.asked).toEqual([]);
  });

  it("still routes every allowed call through the signature, never around it", () => {
    const body = extract("async function authorizeToolCall(name, args) {");
    expect(body).toContain("toolGate.gateDecision(");
    expect(body).toContain("ownerAutonomyState()");
    expect(body.match(/allowed: true/g)?.length).toBe(3);
    expect(body.match(/toolAuthority\.issue\(/g)?.length).toBe(1);
  });
});

describe("the owner's dial and the stop flag, as the main process reads them", () => {
  const source = extract("function ownerAutonomyState() {");
  const dial = extract("function ownerAutonomyDial() {");
  const make = (read: () => unknown) => {
    const deps: Deps = {
      stateStore: { readState: read },
      stateFile: (name: string) => name,
    };
    return {
      state: build<() => { dial: string; halted: boolean }>(source, "ownerAutonomyState", deps),
      dial: build<() => string>(`${source}\n${dial}`, "ownerAutonomyDial", deps),
    };
  };

  it("reports the dial and the stop flag from the stored state", () => {
    const stopped = make(() => ({ approvalLevel: "full", halted: true }));
    expect(stopped.state()).toEqual({ dial: "full", halted: true });
    expect(make(() => ({ approvalLevel: "full" })).state()).toEqual({
      dial: "full",
      halted: false,
    });
    expect(make(() => null).state()).toEqual({ dial: "balanced", halted: false });
  });

  it("an unreadable state asks, and the installer gate still sees a stopped FRIDAY as Ask every time", () => {
    const broken = make(() => {
      throw new Error("disk");
    });
    expect(broken.state()).toEqual({ dial: "ask", halted: false });
    expect(broken.dial()).toBe("ask");
    expect(make(() => ({ approvalLevel: "full", halted: true })).dial()).toBe("ask");
    expect(make(() => ({ approvalLevel: "full" })).dial()).toBe("full");
    expect(make(() => ({ approvalLevel: "balanced" })).dial()).toBe("balanced");
  });
});

describe("a permission question that nobody answers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function asker(options: { visible?: boolean; focused?: boolean } = {}) {
    const calls: Record<string, unknown>[] = [];
    const notices: string[] = [];
    const target = { id: "win" };
    const dialog = {
      showMessageBox: (_target: unknown, box: Record<string, unknown>) => {
        calls.push(box);
        const signal = box["signal"] as AbortSignal | undefined;
        return new Promise((resolve) => {
          signal?.addEventListener("abort", () => resolve({ response: 1, checkboxChecked: false }));
        });
      },
    };
    const fn = build<
      (name: string, risk: string, args: unknown) => Promise<Record<string, unknown>>
    >(extract("async function askOwnerForTool(name, risk, args) {"), "askOwnerForTool", {
      liveWin: () => (options.visible === false ? null : target),
      dialog,
      toolAuthority,
      toolGate: gate,
      routeToolAskNotice: (_target: unknown, name: string) => notices.push(name),
    });
    return { fn, calls, notices };
  }

  it("ends as a refusal after the deadline, closes the question, and says so through the notification route", async () => {
    const { fn, calls, notices } = asker();
    const pending = fn("shell.cmd", "exec", { cmd: "dir" });
    expect(notices).toEqual(["shell.cmd"]);
    await vi.advanceTimersByTimeAsync(gate.ASK_TIMEOUT_MS + 1);
    const answer = await pending;
    expect(answer).toMatchObject({ granted: false, remember: false, timedOut: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.["signal"]).toBeInstanceOf(AbortSignal);
    expect((calls[0]?.["signal"] as AbortSignal).aborted).toBe(true);
  });

  it("an answer inside the deadline is returned as it is", async () => {
    const calls: unknown[] = [];
    const fn = build<
      (name: string, risk: string, args: unknown) => Promise<Record<string, unknown>>
    >(extract("async function askOwnerForTool(name, risk, args) {"), "askOwnerForTool", {
      liveWin: () => ({}),
      dialog: {
        showMessageBox: async (_t: unknown, box: unknown) => {
          calls.push(box);
          return { response: 0, checkboxChecked: true };
        },
      },
      toolAuthority,
      toolGate: gate,
      routeToolAskNotice: () => undefined,
    });
    expect(await fn("fs.write", "write", {})).toEqual({ granted: true, remember: true });
  });

  it("with no window there is nothing to answer, so the answer is no", async () => {
    const { fn, calls } = asker({ visible: false });
    expect(await fn("shell.cmd", "exec", {})).toEqual({ granted: false, remember: false });
    expect(calls).toEqual([]);
  });

  it("the notification route is a real function that shows the window and notifies when it is not focused", () => {
    expect(main).toMatch(/function routeToolAskNotice\(target, name\) \{/);
    const route = extract("function routeToolAskNotice(target, name) {");
    expect(route).toContain("showInactive()");
    expect(route).toContain("flashFrame(true)");
    expect(route).toContain("new Notification(");
    expect(route).toContain("isFocused()");
  });

  it("every other caller of the question gets the same deadline, because it lives in the one function", () => {
    expect(main.match(/async function askOwnerForTool\(/g)?.length).toBe(1);
    expect(extract("async function askOwnerForTool(name, risk, args) {")).toContain(
      "toolGate.askWithTimeout(",
    );
  });
});
