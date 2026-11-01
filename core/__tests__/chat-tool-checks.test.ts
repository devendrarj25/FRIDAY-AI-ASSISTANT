import { describe, expect, it } from "vitest";
import { checkWithTools } from "../../src/lib/friday/brain/tool-checks";
import { sandboxToolPort } from "../../src/lib/friday/sandbox-agent";

describe("tool checks in the chat turn", () => {
  it("are available only where the owner's dial lets the sandbox run", () => {
    expect(sandboxToolPort("strict", false)).toBeUndefined();
    expect(sandboxToolPort("balanced", false)).toBeUndefined();
    expect(sandboxToolPort("full", true)).toBeUndefined();
  });

  it("turn a program that did not run and a missing file into named failures", async () => {
    const out = await checkWithTools(
      "write a python script that prints hello",
      "Here it is:\n```python\nprint(hello\n```\nI also saved it to workspace/hello.py",
      {
        runCode: async () => ({ ok: false, detail: "SyntaxError: '(' was never closed" }),
        fileInfo: async () => ({ exists: false, size: 0 }),
      },
    );
    expect(out.checked).toEqual(["runnable-code", "made-file"]);
    expect(out.failures.map((row) => row.id)).toEqual(["runnable-code", "made-file"]);
    expect(out.failures[0]?.message).toMatch(/SyntaxError/);
  });

  it("pass quietly when the code runs and the file is there", async () => {
    const out = await checkWithTools(
      "write a python script that prints hello",
      "```python\nprint('hello')\n```\nSaved to workspace/hello.py",
      {
        runCode: async () => ({ ok: true, detail: "hello" }),
        fileInfo: async () => ({ exists: true, size: 12 }),
      },
    );
    expect(out.failures).toEqual([]);
  });
});
