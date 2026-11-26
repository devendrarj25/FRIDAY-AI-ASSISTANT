/**
 * The wake-word package installs through the Install Manager row (electron/toolchain.cjs commandFor), into the
 * interpreter FRIDAY itself runs, never as a blind unpinned `pip install --upgrade` of whatever Python was found.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const toolchain = require_("../../electron/toolchain.cjs");
const wake = readFileSync("electron/wake-engine.cjs", "utf8");

describe("wake word install", () => {
  it("the Install Manager row installs openwakeword into the interpreter it is given, without --upgrade", async () => {
    const tool = toolchain.toolById("openWakeWord");
    expect(tool?.pip).toBe("openwakeword");
    const [exe, args] = await toolchain.commandFor(tool, "install", {
      python: { exe: "/friday/runtime/.venv/bin/python", prefix: [] },
    });
    expect(exe).toBe("/friday/runtime/.venv/bin/python");
    expect(args).toEqual(["-m", "pip", "install", "--prefer-binary", "openwakeword"]);
  });

  it("wake-engine install goes through that row with its own interpreter", () => {
    const body = wake.slice(wake.indexOf("async function install()"));
    const install = body.slice(0, body.indexOf("function tmpFile"));
    expect(install).toContain('require("./toolchain.cjs")');
    expect(install).toContain('toolById("openWakeWord")');
    expect(install).toContain('commandFor(tool, "install", { python:');
    expect(install).not.toContain("--upgrade");
    expect(install).not.toMatch(/"pip",\s*"install"/);
  });
});
