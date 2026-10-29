import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  observeSandboxState,
  sandboxLookRequested,
  shouldAttachSandboxExtra,
} from "../../src/lib/friday/brain/sandbox-observe";
import { baselineRespond } from "../../src/lib/friday/brain/baseline-responder";
import { publishSandboxSession, resetSandboxSession } from "../../src/lib/friday/sandbox-awareness";
import { commandNeedsApproval, setActionMode } from "../../src/lib/friday/brain/action-risk";

describe("read-only sandbox observation", () => {
  it("matches look-at-sandbox asks and never claims a second spawn", () => {
    expect(sandboxLookRequested("what is in the sandbox")).toBe(true);
    expect(sandboxLookRequested("find errors in the sandbox")).toBe(true);
    expect(sandboxLookRequested("hello")).toBe(false);
    expect(shouldAttachSandboxExtra("run npm test in the sandbox")).toBe(true);
    expect(shouldAttachSandboxExtra("write me an essay")).toBe(false);
    resetSandboxSession();
    const observation = observeSandboxState();
    expect(observation.readOnly).toBe(true);
    expect(observation.spawned).toBe(false);
    expect(observation.summary).toMatch(/idle|sandbox/i);
  });

  it("does not import a second executor from Core Brain observe", () => {
    const source = readFileSync("src/lib/friday/brain/sandbox-observe.ts", "utf8");
    expect(source).not.toMatch(/runCommand|spawn\(/);
  });
});

describe("baseline sandbox actions", () => {
  it("maps a sandbox check to sandbox.exec as Auto Mode safe, and installs as exec", () => {
    const check = baselineRespond("run npm test in the sandbox");
    expect(check.handled).toBe(true);
    expect(check.action?.tool).toBe("sandbox.exec");
    expect(check.action?.args).toMatchObject({ command: "npm test", op: "run" });
    expect(check.action?.risk).toBe("safe");

    const install = baselineRespond("run npm install in the sandbox");
    expect(install.action?.risk).toBe("exec");
    expect(install.action?.args).toMatchObject({ command: "npm install" });
  });

  it("refuses apply-to-source instead of running it", () => {
    const reply = baselineRespond("apply the sandbox changes");
    expect(reply.handled).toBe(true);
    expect(reply.action).toBeUndefined();
    expect(reply.text).toMatch(/cannot apply/i);
    expect(reply.text).toMatch(/Sandbox page/i);
  });

  it("keeps terminal-only checks on shell.cmd", () => {
    const terminal = baselineRespond("run the tests");
    expect(terminal.action?.tool).toBe("shell.cmd");
    expect(terminal.action?.args).toMatchObject({ command: "npm test" });
  });
});

describe("sandbox Auto Mode approval", () => {
  it("runs sandbox checks without a pause and still asks for installs", () => {
    setActionMode("auto");
    expect(commandNeedsApproval("run npm test in the sandbox", "auto")).toBe(false);
    expect(commandNeedsApproval("run sandbox checks", "auto")).toBe(false);
    expect(commandNeedsApproval("run npm install in the sandbox", "auto")).toBe(true);
    expect(commandNeedsApproval("run docker build . in the sandbox", "auto")).toBe(true);
    expect(commandNeedsApproval("create a python sandbox called demo", "auto")).toBe(true);
    expect(commandNeedsApproval("run npm test in the sandbox", "manual")).toBe(true);
    publishSandboxSession({ projectId: "x", output: "ok" });
    resetSandboxSession();
  });
});
