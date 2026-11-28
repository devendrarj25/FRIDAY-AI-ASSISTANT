/**
 * terminal:exec is gated by default. A call is the owner's own only when it carries the explicit owner mark that the
 * Terminal page's own runner sets; a call with no origin, an unknown origin or the agent origin is FRIDAY's own, so a
 * halted FRIDAY refuses it and a command that is not a plain read asks first. The wait for the owner's answer has the
 * same allowance as every other permission question, and a late Allow after that wait ended does not run. The real
 * handler is cut out of electron/main.cjs and run here with its collaborators replaced; the clock is faked.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require_ = createRequire(import.meta.url);
const table = require_("../../electron/ipc-budget-table.cjs") as {
  QUICK_MS: number;
  budgetFor: (channel: string, args: unknown[]) => { class: string; ms: number };
  waitExpired: (channel: string, args: unknown[], startedAt: number, now?: () => number) => boolean;
  stillRunningReply: (error: unknown, args: unknown) => { error: string } | null;
};
const gate = require_("../../electron/tool-gate.cjs") as { ASK_TIMEOUT_MS: number };
const main = readFileSync(resolve(__dirname, "../../electron/main.cjs"), "utf8").replace(
  /\r\n/g,
  "\n",
);

type Result = { ok: boolean; error?: string; ran?: boolean };
type Handler = (event: unknown, options: unknown) => Promise<Result>;

function handlerSource(): string {
  const start = main.indexOf('ipcMain.handle("terminal:exec"');
  expect(start).toBeGreaterThan(-1);
  return main.slice(start, main.indexOf('ipcMain.handle("terminal:cancel"', start));
}

function rig(options: { halted?: boolean; kind?: "exec" | "write"; verdict?: () => unknown } = {}) {
  let captured: Handler | null = null;
  const ran: unknown[] = [];
  const asked: unknown[] = [];
  const deps = {
    ipcMain: { handle: (_channel: string, handler: Handler) => void (captured = handler) },
    ownerAutonomyState: () => ({ dial: "balanced", halted: options.halted === true }),
    getWorkspaceRoot: () => "root",
    terminal: {
      classifyCommand: () => options.kind ?? "exec",
      isUntrustedFolder: () => false,
      runCommand: async (_root: string, request: unknown) => {
        ran.push(request);
        return { ok: true, ran: true };
      },
    },
    authorizeToolCall: async (name: string, args: unknown) => {
      asked.push([name, args]);
      return (options.verdict ? options.verdict() : { allowed: true }) as {
        allowed: boolean;
        reason?: string;
      };
    },
    terminalPython: async () => null,
    send: () => undefined,
    ipcBudgetTable: table,
  };
  const names = Object.keys(deps);
  new Function(...names, handlerSource())(...names.map((key) => (deps as never)[key]));
  return { call: captured as unknown as Handler, ran, asked };
}

describe("terminal:exec is gated unless the owner mark is present", () => {
  it.each([
    ["no origin at all", {}],
    ["the agent origin", { origin: "agent" }],
    ["an unknown origin", { origin: "Owner" }],
    ["a non-string origin", { origin: true }],
    ["an object origin", { origin: { is: "owner" } }],
  ])("%s: a command that is not a plain read asks first", async (_name, extra) => {
    const { call, ran, asked } = rig();
    await call({}, { command: "make install", ...extra });
    expect(asked).toHaveLength(1);
    expect(ran).toHaveLength(1);
  });

  it("a refusal from the gate stops the run", async () => {
    const { call, ran } = rig({ verdict: () => ({ allowed: false, reason: "no" }) });
    expect(await call({}, { command: "make install" })).toMatchObject({ ok: false, error: "no" });
    expect(ran).toHaveLength(0);
  });

  it("a halted FRIDAY refuses a call with no origin, and never asks", async () => {
    const { call, ran, asked } = rig({ halted: true });
    const result = await call({}, { command: "dir" });
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toMatch(/Stop everything/);
    expect(ran).toHaveLength(0);
    expect(asked).toHaveLength(0);
  });

  it("a plain read from an unmarked call runs without a question", async () => {
    const { call, ran, asked } = rig({ kind: "write" });
    await call({}, { command: "dir" });
    expect(asked).toHaveLength(0);
    expect(ran).toHaveLength(1);
  });

  it("the owner mark runs what the owner typed without the gate, and the mark never reaches the run", async () => {
    const { call, ran, asked } = rig();
    await call({}, { command: "make install", origin: "owner" });
    expect(asked).toHaveLength(0);
    expect(ran).toHaveLength(1);
    expect(ran[0]).not.toHaveProperty("origin");
  });

  it("an empty call is gated too", async () => {
    const { call, asked } = rig();
    await call({}, undefined);
    expect(asked).toHaveLength(1);
  });
});

describe("the wait for the owner's answer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it("an unmarked call has the permission-question allowance on top of the quick budget; the owner's own call does not", () => {
    expect(table.budgetFor("terminal:exec", [{ command: "x" }]).ms).toBe(
      table.QUICK_MS + gate.ASK_TIMEOUT_MS,
    );
    expect(table.budgetFor("terminal:exec", [{ command: "x", origin: "agent" }]).ms).toBe(
      table.QUICK_MS + gate.ASK_TIMEOUT_MS,
    );
    expect(table.budgetFor("terminal:exec", [{ command: "x", origin: "owner" }]).ms).toBe(
      table.QUICK_MS,
    );
    expect(table.budgetFor("terminal:exec", []).ms).toBe(table.QUICK_MS + gate.ASK_TIMEOUT_MS);
  });

  it("waitExpired is true only past the budget of that call", () => {
    const args = [{ command: "x" }];
    const ms = table.budgetFor("terminal:exec", args).ms;
    expect(table.waitExpired("terminal:exec", args, 0, () => ms)).toBe(false);
    expect(table.waitExpired("terminal:exec", args, 0, () => ms + 1)).toBe(true);
    // A channel with no total limit never expires.
    expect(table.waitExpired("build:start", [], 0, () => 10 ** 12)).toBe(false);
  });

  it("a late Allow, after the budget of the call ended, does not run the command", async () => {
    const { call, ran } = rig({
      verdict: () => {
        vi.setSystemTime(1_000_000 + table.QUICK_MS + gate.ASK_TIMEOUT_MS + 1);
        return { allowed: true };
      },
    });
    const result = await call({}, { command: "make install" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not run/);
    expect(ran).toHaveLength(0);
  });

  it("an Allow inside the budget still runs", async () => {
    const { call, ran } = rig({
      verdict: () => {
        vi.setSystemTime(1_000_000 + gate.ASK_TIMEOUT_MS);
        return { allowed: true };
      },
    });
    await call({}, { command: "make install" });
    expect(ran).toHaveLength(1);
  });
});

describe("the reply for a tool call whose wait ended", () => {
  it("never tells the caller to ask again, because asking again would run the tool a second time", () => {
    const error = Object.assign(new Error("x"), {
      code: "IPC_BUDGET",
      channel: "kernel:rpc",
      method: "tool.exec",
    });
    const reply = table.stillRunningReply(error, ["tool.exec", { name: "test.run" }]);
    expect(reply?.error).toMatch(/still running/);
    expect(reply?.error).toMatch(/not cancelled/);
    expect(reply?.error).not.toMatch(/ask again/i);
    expect(reply?.error).toMatch(/do not run it again/i);
  });
});

describe("the Terminal page marks its own commands", () => {
  const ops = readFileSync(resolve(__dirname, "../../src/lib/friday/ops-engine.ts"), "utf8");
  const terminalTs = readFileSync(resolve(__dirname, "../../src/lib/friday/terminal.ts"), "utf8");

  it("only the typed-command runner sets the owner mark, and FRIDAY's own shell runs say agent", () => {
    expect(ops).toMatch(/executeReal[\s\S]{0,400}this\.spawn\(command, \{ origin: "owner" \}\)/);
    expect(ops).toContain('{ ...options, origin: "agent" }');
    expect(terminalTs).toMatch(/origin\?: "agent" \| "owner"/);
    expect(ops.match(/origin: "owner"/g)).toHaveLength(1);
  });
});
