import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  observeTerminalState,
  shouldAttachTerminalExtra,
  terminalLookRequested,
} from "../../src/lib/friday/brain/terminal-observe";
import { baselineRespond } from "../../src/lib/friday/brain/baseline-responder";
import {
  publishTerminalSession,
  resetTerminalSession,
} from "../../src/lib/friday/terminal-awareness";

describe("read-only terminal observation", () => {
  it("matches look-at-terminal asks and never claims a second spawn", () => {
    expect(terminalLookRequested("what did the last command print")).toBe(true);
    expect(terminalLookRequested("why did that fail")).toBe(true);
    expect(terminalLookRequested("hello")).toBe(false);
    expect(shouldAttachTerminalExtra("run git status in the terminal")).toBe(true);
    expect(shouldAttachTerminalExtra("write me an essay")).toBe(false);
    resetTerminalSession();
    const observation = observeTerminalState();
    expect(observation.readOnly).toBe(true);
    expect(observation.spawned).toBe(false);
    expect(observation.summary).toMatch(/idle|FRIDAY root/i);
  });

  it("does not import a second executor from Core Brain observe", () => {
    const source = readFileSync("src/lib/friday/brain/terminal-observe.ts", "utf8");
    expect(source).not.toMatch(/runCommand|spawn\(/);
  });
});

describe("baseline terminal actions", () => {
  it("maps a workspace check to shell.cmd as Auto Mode safe, and installs as exec", () => {
    const check = baselineRespond("run git status in the terminal");
    expect(check.handled).toBe(true);
    expect(check.action?.tool).toBe("shell.cmd");
    expect(check.action?.args).toMatchObject({ command: "git status" });
    expect(check.action?.risk).toBe("safe");
    const install = baselineRespond("run npm install in the terminal");
    expect(install.action?.args).toMatchObject({ command: "npm install" });
    expect(install.action?.risk).toBe("exec");
  });

  it("answers from the live buffer without inventing output", async () => {
    publishTerminalSession({
      cwd: "/friday/workspace",
      shell: "cmd",
      lines: [
        { kind: "cmd", text: "> node -v" },
        { kind: "out", text: "v22.19.0" },
      ],
      lastCommand: "node -v",
      lastExitOk: true,
      lastExitCode: 0,
    });
    const reply = baselineRespond("what did the last command print");
    expect(reply.handled).toBe(true);
    expect(reply.resolve).toBeTypeOf("function");
    const text = await reply.resolve!();
    expect(text).toMatch(/v22\.19\.0/);
    expect(text).toMatch(/TERMINAL SESSION/);
    resetTerminalSession();
  });
});
