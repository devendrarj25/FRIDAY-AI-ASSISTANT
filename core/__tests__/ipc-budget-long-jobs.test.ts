/**
 * A tool that takes minutes (the tests, a build, a shell command, a media conversion, docker, an install) is a
 * long job: the wait limit of a quick call must not cut it off, and when a limit does end a wait for a tool call, the
 * answer says the tool is still running, never that it failed (the subprocess is not cancelled by the wait).
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const require_ = createRequire(import.meta.url);
const table = require_("../../electron/ipc-budget-table.cjs") as {
  QUICK_MS: number;
  LONG_TOOLS: readonly string[];
  LONG_TOOL_PREFIXES: readonly string[];
  isLongTool: (name: unknown) => boolean;
  budgetFor: (
    channel: string,
    args?: unknown[],
  ) => { class: string; ms: number; method: string; inactivity: boolean };
  stillRunningReply: (
    error: unknown,
    args: unknown[],
  ) => { ok: false; stillRunning: true; error: string } | null;
};
const timeout = require_("../../electron/ipc-timeout.cjs") as {
  budgetError: (budget: unknown) => Error;
};
const gate = require_("../../electron/tool-gate.cjs") as { ASK_TIMEOUT_MS: number };

const read = (rel: string) =>
  readFileSync(resolve(__dirname, "../..", rel), "utf8").replace(/\r\n/g, "\n");
const main = read("electron/main.cjs");
const tools = read("kernel/tools.py");

const call = (name: unknown, extra: Record<string, unknown> = {}) => [
  "tool.exec",
  { name, args: {}, ...extra },
];

describe("long tools are long jobs", () => {
  const LONG = [
    "test.run",
    "dev.check",
    "shell.cmd",
    "shell.powershell",
    "media.convert",
    "docker.pull",
    "docker.run",
    "cpp.build",
    "pip.install",
    "npm.install",
  ];

  it.each(LONG)("%s has no total wait limit", (name) => {
    const budget = table.budgetFor("kernel:rpc", call(name));
    expect(budget).toMatchObject({ class: "long-job", ms: 0, method: "tool.exec" });
    expect(table.isLongTool(name)).toBe(true);
  });

  it("every named long tool is a real kernel tool", () => {
    for (const name of table.LONG_TOOLS) {
      expect(tools, name).toContain(`"${name}"`);
    }
    for (const prefix of table.LONG_TOOL_PREFIXES) {
      expect(tools, prefix).toMatch(new RegExp(`"${prefix.replace(".", "\\.")}[a-z_]+"`));
    }
  });

  it("a quick tool keeps a limit, which also covers the owner's time to answer a permission question", () => {
    for (const name of ["fs.read", "memory.search", "git.status"]) {
      const budget = table.budgetFor("kernel:rpc", call(name));
      expect(budget.class).toBe("quick");
      expect(budget.ms).toBe(table.QUICK_MS + gate.ASK_TIMEOUT_MS);
    }
  });

  it("the plain method budget (no arguments) and every other method are unchanged", () => {
    expect(table.budgetFor("kernel:rpc", ["tool.exec"])).toMatchObject({
      class: "quick",
      ms: table.QUICK_MS,
    });
    expect(table.budgetFor("kernel:rpc", ["chat.stream"]).class).toBe("stream");
    expect(table.budgetFor("kernel:rpc", ["project.run", { name: "test.run" }]).class).toBe(
      "long-job",
    );
    expect(table.budgetFor("kernel:rpc", ["memory.search", { name: "shell.cmd" }]).class).toBe(
      "quick",
    );
    expect(table.isLongTool(undefined)).toBe(false);
    expect(table.isLongTool("")).toBe(false);
    expect(table.isLongTool("fs.write")).toBe(false);
  });

  it("the kernel request reads the same budget with the call's own arguments", () => {
    const start = main.indexOf("async function kernelRequest(");
    const body = main.slice(start, main.indexOf("return new Promise", start));
    expect(body).toContain('ipcTimeout.budgetFor("kernel:rpc", [method, params])');
  });
});

describe("a limit that ends the wait for a tool call says it is still running", () => {
  const expired = (method: string, channel = "kernel:rpc") =>
    timeout.budgetError({ class: "quick", channel, method });

  it("turns the budget error of a tool call into a reply that is not a failure", () => {
    const reply = table.stillRunningReply(expired("tool.exec"), call("test.run"));
    expect(reply).toMatchObject({ ok: false, stillRunning: true });
    expect(reply?.error).toMatch(/test\.run is still running/);
    expect(reply?.error).toMatch(/not cancelled/);
    expect(reply?.error).not.toMatch(/failed|could not|couldn't/i);
  });

  it("leaves every other error, and every other method, alone", () => {
    expect(table.stillRunningReply(expired("memory.search"), ["memory.search", {}])).toBeNull();
    expect(table.stillRunningReply(new Error("disk full"), call("test.run"))).toBeNull();
    expect(
      table.stillRunningReply(expired("tool.exec", "doctor:run"), call("test.run")),
    ).toBeNull();
    expect(table.stillRunningReply(null, call("test.run"))).toBeNull();
  });

  it("names the tool even when the call carried no usable name", () => {
    const reply = table.stillRunningReply(expired("tool.exec"), ["tool.exec", null]);
    expect(reply?.error).toMatch(/^The tool is still running/);
  });

  it("the shared IPC wrapper in the main process applies it to every handler", () => {
    const wrapper = main.slice(
      main.indexOf("ipcMain.handle = (channel, handler) =>"),
      main.indexOf("/** The pack reads this file."),
    );
    expect(wrapper).toContain("stillRunningReply(error, args)");
    expect(wrapper).toContain("if (still) return still;");
  });
});
