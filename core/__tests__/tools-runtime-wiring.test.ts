/**
 * Tools page discovery and the tool runtime must see the same packs,
 * and chat-shaped `{ prompt }` must reach the keys shipped run() actually reads.
 *
 * Catalog tools ship in the app folder. Enable is a capabilities.json override
 * (no workspace copy required — shipped packs run in-process via require).
 * Every shipped pack now has index.cjs; kernelTool packs delegate through
 * electron/kernel-tool-run.cjs and are runnable.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { chooseTools } from "../../src/lib/friday/brain/tool-router";
import { observeBrain, noteObserve } from "../../src/lib/friday/brain/observe";
import type { ToolPackManifest } from "../../src/lib/friday/brain/tool-forge";

const require = createRequire(import.meta.url);
const tools = require("../../electron/tools.cjs") as {
  list: (root: unknown) => {
    ok: boolean;
    tools: {
      id: string;
      enabled: boolean;
      name: string;
      runnable?: boolean;
      inputs?: string[];
      risk?: string;
      origin?: string;
    }[];
  };
  invoke: (
    root: unknown,
    id: string,
    input?: unknown,
    ctx?: { allowDisabled?: boolean },
  ) => Promise<{ ok: boolean; value?: unknown; error?: string }>;
  enrichInput: (
    item: { inputs?: string[] } | null,
    raw: unknown,
    workspaceRoot?: string | null,
  ) => Record<string, unknown>;
};
const capabilities = require("../../electron/capabilities.cjs") as {
  list: (roots: { appRoot?: string | null; workspaceRoot?: string | null }) => {
    items: { id: string; tree: string; enabled: boolean }[];
  };
  setEnabled: (roots: { workspaceRoot: string }, id: string, enabled: boolean) => { ok: boolean };
};

const temps: string[] = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-tool-wire-"));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
  temps.length = 0;
});

const APP = process.cwd();

function writeWorkspaceTool(workspaceRoot: string, slug: string) {
  const dir = path.join(workspaceRoot, "tools", "custom", slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "tool.json"),
    JSON.stringify({
      id: slug,
      name: "Wire Probe",
      summary: "Deterministic CJS probe used to prove chat-shaped tool input wiring.",
      category: "custom",
      permissions: [],
      risk: "safe",
      inputs: ["text"],
      version: "1.0.0",
      author: "friday-core",
      enabled: false,
      entry: "index.cjs",
      description: "Returns the input text so invoke can be checked without a model.",
      approvalPrompt: "FRIDAY wants to run Wire Probe. Allow this?",
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(dir, "index.cjs"),
    "async function run(input = {}) { return { ok: true, text: String(input.text || '') }; }\nmodule.exports = { run };\n",
    "utf8",
  );
  return dir;
}

describe("chat-shaped input mapping", () => {
  it("maps prompt onto declared text and injects the workspace root", () => {
    const mapped = tools.enrichInput(
      { inputs: ["text", "path", "root"] },
      { prompt: "hello desk" },
      "/tmp/friday-folder",
    );
    expect(mapped["text"]).toBe("hello desk");
    expect(mapped["prompt"]).toBe("hello desk");
    expect(mapped["root"]).toBe("/tmp/friday-folder");
  });

  it("prefers the previous successful output over the original prompt", () => {
    const mapped = tools.enrichInput(
      { inputs: ["text"] },
      {
        prompt: "please encode then decode",
        previous: [
          { id: "tools/text/base64-encode", ok: true, value: { ok: true, text: "aGVsbG8=" } },
        ],
      },
      null,
    );
    expect(mapped["text"]).toBe("aGVsbG8=");
  });

  it("maps a URL-shaped prompt onto url and a host-shaped prompt onto host", () => {
    expect(
      tools.enrichInput({ inputs: ["url"] }, { prompt: "parse https://example.com/path" }, null)[
        "url"
      ],
    ).toBe("https://example.com/path");
    expect(
      tools.enrichInput({ inputs: ["host"] }, { prompt: "lookup example.com" }, null)["host"],
    ).toBe("example.com");
  });
});

describe("app catalog vs workspace runtime", () => {
  it("lists shipped catalog tools from appRoot even with an empty workspace", () => {
    const workspaceRoot = temp();
    const listed = tools.list({ appRoot: APP, workspaceRoot }).tools;
    expect(listed.some((item) => item.id === "tools/text/base64-encode")).toBe(true);
    expect(listed.find((item) => item.id === "tools/text/base64-encode")?.enabled).toBe(false);
    const kernelNowRunnable = listed.find(
      (item) => item.id === "tools/devices/bluetooth/bluetooth-scan",
    );
    expect(kernelNowRunnable?.runnable).toBe(true);
    const page = capabilities
      .list({ appRoot: APP, workspaceRoot })
      .items.filter((item) => item.tree === "tools");
    expect(page.map((item) => item.id)).toContain("tools/text/base64-encode");
  });

  it("applies capabilities.json Enable so the router can pick a shipped tool", async () => {
    const workspaceRoot = temp();
    const roots = { appRoot: APP, workspaceRoot };
    capabilities.setEnabled({ workspaceRoot }, "tools/text/base64-encode", true);
    const listed = tools.list(roots).tools.find((item) => item.id === "tools/text/base64-encode");
    expect(listed?.enabled).toBe(true);
    expect(listed?.runnable).toBe(true);

    const asManifest: ToolPackManifest = {
      id: listed!.id,
      name: listed!.name,
      description: "Encode UTF-8 text as base64",
      category: "text",
      permissions: [],
      risk: "safe",
      inputs: listed!.inputs ?? ["text"],
      enabled: true,
      ...(typeof listed?.runnable === "boolean" ? { runnable: listed.runnable } : {}),
    };
    expect(chooseTools("please Base64 encode this", [asManifest]).map((item) => item.id)).toEqual([
      "tools/text/base64-encode",
    ]);

    const ran = await tools.invoke(roots, "tools/text/base64-encode", { prompt: "hello desk" });
    expect(ran.ok).toBe(true);
    expect((ran.value as { text?: string })?.text).toBe(
      Buffer.from("hello desk", "utf8").toString("base64"),
    );
  });

  it("lets Test selected run a still-disabled shipped tool without enabling it", async () => {
    const workspaceRoot = temp();
    const roots = { appRoot: APP, workspaceRoot };
    const blocked = await tools.invoke(roots, "tools/text/base64-encode", { prompt: "nope" });
    expect(blocked.ok).toBe(false);
    expect(String(blocked.error)).toMatch(/disabled/i);
    const tested = await tools.invoke(
      roots,
      "tools/text/base64-encode",
      { prompt: "probe" },
      { allowDisabled: true },
    );
    expect(tested.ok).toBe(true);
    expect((tested.value as { text?: string })?.text).toBe(
      Buffer.from("probe", "utf8").toString("base64"),
    );
    expect(
      tools.list(roots).tools.find((item) => item.id === "tools/text/base64-encode")?.enabled,
    ).toBe(false);
  });

  it("injects the workspace root so a file tool can read without the chat sending root", async () => {
    const workspaceRoot = temp();
    fs.writeFileSync(path.join(workspaceRoot, "note.txt"), "desk note", "utf8");
    const ran = await tools.invoke(
      { appRoot: APP, workspaceRoot },
      "tools/filesystem/file-read",
      { path: "note.txt" },
      { allowDisabled: true },
    );
    expect(ran.ok).toBe(true);
    expect((ran.value as { text?: string })?.text).toBe("desk note");
  });

  it("runs a workspace-forged CJS tool from chat-shaped prompt input", async () => {
    const workspaceRoot = temp();
    writeWorkspaceTool(workspaceRoot, "wire-probe");
    capabilities.setEnabled({ workspaceRoot }, "tools/custom/wire-probe", true);
    const listed = tools
      .list({ appRoot: APP, workspaceRoot })
      .tools.find((item) => item.id === "tools/custom/wire-probe");
    expect(listed?.enabled).toBe(true);
    expect(listed?.origin).toBe("workspace");
    const ran = await tools.invoke({ appRoot: APP, workspaceRoot }, "tools/custom/wire-probe", {
      prompt: "from chat",
    });
    expect(ran.ok).toBe(true);
    expect((ran.value as { text?: string })?.text).toBe("from chat");
  });
});

describe("kernel tool child deadline", () => {
  const kernel = require("../../electron/kernel-tool-run.cjs") as {
    spawnJson: (
      executable: string,
      args: string[],
      input: Record<string, unknown>,
      timeoutMs: number,
    ) => Promise<{ ok?: boolean; error?: string }>;
  };

  it("returns when the child ignores the deadline", async () => {
    const result = await kernel.spawnJson(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {},
      400,
    );
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/timed out after 400ms/);
  });
});

describe("observability", () => {
  it("records the last catalog tool id the same way baseline skills do", () => {
    noteObserve({ tool: "tools/text/base64-encode" });
    expect(observeBrain().tool).toBe("tools/text/base64-encode");
  });
});

describe("desktop IPC wiring", () => {
  const main = fs.readFileSync(path.join(process.cwd(), "electron/main.cjs"), "utf8");
  const preload = fs.readFileSync(path.join(process.cwd(), "electron/preload.cjs"), "utf8");
  const core = fs.readFileSync(
    path.join(process.cwd(), "src/lib/friday/brain/core-brain.ts"),
    "utf8",
  );

  it("lists and invokes through capabilityRoots() so app packs are visible", () => {
    expect(main).toContain("fridayTools.list(capabilityRoots())");
    expect(main).toContain("fridayTools.invoke(capabilityRoots()");
    expect(main).toContain("allowDisabled: Boolean(options && options.allowDisabled)");
    expect(preload).toContain("toolpacks:invoke");
    expect(preload).toContain("options || {}");
    expect(core).toContain('stage?.("agents.tools"');
    expect(core).toContain("noteObserve({ tool:");
  });
});
