import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";

type Verdict = {
  area: string;
  hot: boolean;
  dest: string;
  reason: string;
  extract?: boolean;
  needsApproval?: boolean;
};
type PackageInfo = { mode: string; packageName: string; label: string };

const require = createRequire(import.meta.url);
const { classify, inspectPackage } = require(
  path.resolve(process.cwd(), "electron/import-classify.cjs"),
) as {
  classify: (relative: string, ctx?: Record<string, unknown>) => Verdict;
  inspectPackage: (root: string, fallback?: string) => PackageInfo;
};

const roots: string[] = [];
const tmp = (files: Record<string, string>) => {
  const dir = mkdtempSync(path.join(tmpdir(), "friday-import-"));
  roots.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
};

afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("import recogniser", () => {
  it("recognises a FRIDAY package and keeps its layout", () => {
    const root = tmp({ "electron/main.cjs": "//", "kernel/main.py": "#" });
    const info = inspectPackage(root, "friday");
    expect(info.mode).toBe("friday");
    expect(classify("electron/main.cjs", info).dest).toBe("electron/main.cjs");
  });

  it("routes a manifest package into its registry folder", () => {
    const root = tmp({
      "manifest.json": JSON.stringify({ name: "Repo Import", kind: "plugin", version: "1.0.0" }),
      "index.js": "//",
    });
    const info = inspectPackage(root, "pack");
    expect(info.mode).toBe("manifest");
    expect(classify("index.js", info).dest).toBe("plugins/installed/repo-import/index.js");
  });

  it("keeps a foreign project intact under workspace/projects", () => {
    const root = tmp({ "package.json": JSON.stringify({ name: "some-app" }), "src/a.ts": "" });
    const info = inspectPackage(root, "some-app");
    expect(info.mode).toBe("project");
    expect(classify("src/a.ts", info).dest.startsWith("workspace/projects/")).toBe(true);
  });

  it("routes loose content by type", () => {
    const root = tmp({
      "notes.md": "# hello",
      "flow.json": JSON.stringify({ nodes: [], connections: {} }),
      "brain.gguf": "x",
      "skill.py": "def run(tools):\n    return 1\n",
    });
    const info = inspectPackage(root, "drop");
    expect(info.mode).toBe("loose");
    const dest = (rel: string) => classify(rel, { ...info, full: path.join(root, rel) }).dest;
    expect(dest("notes.md")).toBe("brain-data/knowledge/notes.md");
    expect(dest("flow.json")).toBe("workflows/saved/flow.json");
    expect(dest("brain.gguf")).toBe("models/local/brain.gguf");
    expect(dest("skill.py")).toBe("skills/custom/skill.py");
  });

  it("parks unrecognised content instead of scattering it", () => {
    const root = tmp({ "mystery.xyz": "?" });
    const info = inspectPackage(root, "mystery-drop");
    const verdict = classify("mystery.xyz", { ...info, full: path.join(root, "mystery.xyz") });
    expect(verdict.dest.startsWith("updates/unsorted/")).toBe(true);
    expect(verdict.reason).toMatch(/not recognised/i);
  });
});

describe("packages inside a drop", () => {
  it("installs a skill folder whole, using its skill.json manifest", () => {
    const root = tmp({
      "demo-skill/skill.json": JSON.stringify({ id: "demo-skill", name: "Demo", version: "1.0.0" }),
      "demo-skill/skill.mjs": "export default { run() { return 1; } };",
    });
    const info = inspectPackage(root, "drop");
    expect(info.mode).toBe("loose");
    const dest = (rel: string) => classify(rel, { ...info, full: path.join(root, rel) }).dest;
    expect(dest("demo-skill/skill.json")).toBe("skills/custom/demo/skill.json");
    expect(dest("demo-skill/skill.mjs")).toBe("skills/custom/demo/skill.mjs");
  });

  it("routes several packages of different kinds into their registries", () => {
    const root = tmp({
      "a/tool.json": JSON.stringify({ id: "ping", name: "Ping" }),
      "a/index.cjs": "//",
      "b/manifest.json": JSON.stringify({ name: "Notes", kind: "plugin" }),
      "b/index.js": "//",
      "readme.md": "# drop",
    });
    const info = inspectPackage(root, "drop");
    const dest = (rel: string) => classify(rel, { ...info, full: path.join(root, rel) }).dest;
    expect(dest("a/index.cjs")).toBe("tools/custom/ping/index.cjs");
    expect(dest("b/index.js")).toBe("plugins/installed/notes/index.js");
    expect(dest("readme.md")).toBe("brain-data/knowledge/readme.md");
  });
});

describe("import type coverage", () => {
  it("routes a piper/voice model into the real voices folder", () => {
    const root = tmp({ "piper-en.onnx": "onnx" });
    const info = inspectPackage(root, "drop");
    const verdict = classify("piper-en.onnx", { ...info, full: path.join(root, "piper-en.onnx") });
    expect(verdict.dest).toBe("voices/piper-en.onnx");
    expect(verdict.area).toBe("voices");
  });

  it("parks a chat transcript for approval and does not treat it as a skill", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
    });
    const root = tmp({ "transcript.json": body });
    const info = inspectPackage(root, "drop");
    const verdict = classify("transcript.json", {
      ...info,
      full: path.join(root, "transcript.json"),
    });
    expect(verdict.dest).toBe("memory/imports/chats/transcript.json");
    expect(verdict.area).toBe("memory");
    expect(verdict.needsApproval).toBe(true);
  });

  it("parks a connector bundle beside config, not live connectors.json", () => {
    const body = JSON.stringify({
      id: "github",
      authType: "oauth",
      credentials: { token: "not-a-live-write" },
    });
    const root = tmp({ "github-connector.json": body });
    const info = inspectPackage(root, "drop");
    const verdict = classify("github-connector.json", {
      ...info,
      full: path.join(root, "github-connector.json"),
    });
    expect(verdict.dest).toBe("config/connector-imports/github-connector.json");
    expect(verdict.area).toBe("connectors");
    expect(verdict.needsApproval).toBe(true);
    expect(verdict.dest).not.toMatch(/connectors\.json/);
  });

  it("marks PDFs for document-extract rather than a blind copy", () => {
    const root = tmp({ "brief.pdf": "%PDF" });
    const info = inspectPackage(root, "drop");
    const verdict = classify("brief.pdf", { ...info, full: path.join(root, "brief.pdf") });
    expect(verdict.dest).toBe("brain-data/knowledge/brief.pdf");
    expect(verdict.extract).toBe(true);
    expect(verdict.reason).toMatch(/document-extract/i);
  });
});
