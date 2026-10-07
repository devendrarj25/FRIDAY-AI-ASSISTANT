/**
 * Tools-page import: only tool-shaped packs, incomplete packs are healed
 * into tool.json + index.cjs, and install still goes through installPack().
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const toolPack = require("../../electron/tool-pack.cjs") as {
  looksLikeTool: (pack: unknown) => boolean;
  healToolPack: (pack: unknown) => {
    ok: boolean;
    pack?: {
      tree?: string;
      id?: string;
      enabled?: boolean;
      code?: string;
      healed?: boolean;
      entry?: string;
      approvalPrompt?: string;
    };
    error?: string;
  };
  prepareToolsOnly: (
    payload: unknown,
    extra?: { nonToolKinds?: string[] },
  ) => { ok: boolean; packs?: unknown[]; error?: string; skipped?: number };
  collectToolPacksFromDir: (dir: string) => {
    packs: { id?: string; code?: string }[];
    nonToolKinds: string[];
  };
};
const capabilities = require("../../electron/capabilities.cjs") as {
  installPack: (
    roots: { workspaceRoot: string },
    pack: unknown,
    hint?: string,
  ) => { ok: boolean; id?: string; tree?: string; path?: string; error?: string };
};

const temps: string[] = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-tool-pack-"));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
  temps.length = 0;
});

describe("tool pack healer", () => {
  it("heals an incomplete tool into tool.json fields plus a loadable run()", () => {
    const healed = toolPack.healToolPack({ name: "Line tally", category: "text" });
    expect(healed.ok).toBe(true);
    expect(healed.pack?.tree).toBe("tools");
    expect(healed.pack?.id).toBe("line-tally");
    expect(healed.pack?.enabled).toBe(false);
    expect(healed.pack?.entry).toBe("index.cjs");
    expect(String(healed.pack?.code)).toMatch(/module\.exports/);
    expect(String(healed.pack?.approvalPrompt)).toMatch(/Allow/);
    expect(healed.pack?.healed).toBe(true);
  });

  it("keeps an existing run() instead of replacing it with the stub", () => {
    const code = "async function run(input) { return { n: 1 }; }\nmodule.exports = { run };\n";
    const healed = toolPack.healToolPack({
      id: "keep-run",
      name: "Keep run",
      code,
      inputs: ["text"],
    });
    expect(healed.ok).toBe(true);
    expect(String(healed.pack?.code)).toContain("return { n: 1 }");
    expect(String(healed.pack?.code)).not.toMatch(/Healed stub/);
  });

  it("does not treat a skill pack as a tool", () => {
    expect(toolPack.looksLikeTool({ tree: "skills", name: "Word tally", inputs: [] })).toBe(false);
    const prepared = toolPack.prepareToolsOnly({
      tree: "skills",
      name: "Word tally",
      code: "export async function run() { return 1; }",
    });
    expect(prepared.ok).toBe(false);
    expect(String(prepared.error)).toMatch(/Tools page only accepts tool packs/i);
  });
});

describe("tool pack collect and install", () => {
  it("collects tool.json + index.cjs folders and refuses skill.json", () => {
    const dir = temp();
    const pack = path.join(dir, "echo-tool");
    fs.mkdirSync(pack);
    fs.writeFileSync(
      path.join(pack, "tool.json"),
      JSON.stringify({ name: "Echo tool", inputs: ["text"], risk: "safe" }),
    );
    fs.writeFileSync(
      path.join(pack, "index.cjs"),
      "async function run(input) { return { ok: true, echo: input }; }\nmodule.exports = { run };\n",
    );
    fs.mkdirSync(path.join(dir, "a-skill"));
    fs.writeFileSync(
      path.join(dir, "a-skill", "skill.json"),
      JSON.stringify({ name: "Not a tool" }),
    );
    const collected = toolPack.collectToolPacksFromDir(dir);
    expect(collected.nonToolKinds).toContain("skills");
    expect(collected.packs.some((p) => /echo/i.test(String(p.id || "")))).toBe(true);
  });

  it("installPack writes tool.json and index.cjs, never enables", () => {
    const workspace = temp();
    const healed = toolPack.healToolPack({
      name: "Echo tool",
      category: "custom",
      code: "async function run(input) { return { ok: true }; }\nmodule.exports = { run };\n",
    });
    expect(healed.ok).toBe(true);
    const installed = capabilities.installPack({ workspaceRoot: workspace }, healed.pack, "tools");
    expect(installed.ok).toBe(true);
    expect(installed.id).toBe("tools/custom/echo-tool");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(workspace, "tools", "custom", "echo-tool", "tool.json"), "utf8"),
    );
    expect(manifest.enabled).toBe(false);
    expect(manifest.entry).toBe("index.cjs");
    expect(fs.existsSync(path.join(workspace, "tools", "custom", "echo-tool", "index.cjs"))).toBe(
      true,
    );
  });
});
