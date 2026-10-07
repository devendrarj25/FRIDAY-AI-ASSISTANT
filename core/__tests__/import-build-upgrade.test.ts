/**
 * Import & Build upgrade: mixed-zip split, document-extract beside PDFs,
 * filename preservation on URL download, chat intents, no fake install,
 * page stays an intake surface (no second Skills market).
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

import {
  describeImportSession,
  handleImportIntent,
  interpretImportPrompt,
} from "../../src/lib/friday/import-chat";
import { imports, parseRepoUrl, type ImportItem } from "../../src/lib/friday/import-engine";
import { upgrades } from "../../src/lib/friday/upgrade-engine";

const require_ = createRequire(import.meta.url);
const importer = require_(path.resolve(process.cwd(), "electron/importer.cjs")) as {
  filenameFromDownload: (
    url: string,
    name?: string,
    response?: { headers?: { get?: (key: string) => string | null } },
  ) => string;
  scanImport: (args: { root: string; source: string }) => Promise<{
    ok: boolean;
    error?: string;
    mode?: string;
    files?: { path: string; dest: string; area: string; extract?: boolean }[];
    contentRoot?: string;
  }>;
  applyImport: (args: { root: string; scan: unknown; keepBackup?: boolean }) => Promise<{
    ok: boolean;
    applied?: number;
    error?: string;
    placed?: { dir: string; files: number }[];
  }>;
  verifyStagedPacks: (args: { root: string; scan: unknown }) => Promise<{
    ok: boolean;
    packs: { kind: string; ok: boolean; skipped?: boolean; detail: string }[];
  }>;
};

const temps: string[] = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-import-build-"));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
  temps.length = 0;
  imports.clear();
  upgrades.clear();
});

function pythonBin(): string | null {
  for (const bin of ["python3", "python"]) {
    try {
      execFileSync(bin, ["-c", "import zipfile"], { stdio: "ignore" });
      return bin;
    } catch {
      /* try the next */
    }
  }
  return null;
}

function zipFolder(folder: string, zipPath: string) {
  const bin = pythonBin();
  expect(bin, "python zipfile is required for the mixed-zip test").toBeTruthy();
  const script = `
import zipfile, os
root = ${JSON.stringify(folder)}
out = ${JSON.stringify(zipPath)}
parent = os.path.dirname(root)
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            full = os.path.join(dirpath, name)
            z.write(full, os.path.relpath(full, parent))
`;
  execFileSync(bin!, ["-c", script]);
}

function samplePdf(text: string) {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  return Buffer.from(
    `%PDF-1.1\n1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>endobj\n4 0 obj<< /Length ${stream.length} >>stream\n${stream}\nendstream\nendobj\n`,
  );
}

describe("filenameFromDownload", () => {
  it("keeps the real extension instead of forcing .zip", () => {
    const headers = { get: (key: string) => (key === "content-disposition" ? null : null) };
    expect(
      importer.filenameFromDownload("https://example.com/voices/piper-en.onnx", "x", { headers }),
    ).toBe("piper-en.onnx");
    expect(
      importer.filenameFromDownload("https://example.com/dl", "x", {
        headers: {
          get: (key: string) =>
            key === "content-disposition" ? 'attachment; filename="notes.pdf"' : null,
        },
      }),
    ).toBe("notes.pdf");
  });
});

describe("mixed zip import", () => {
  it("splits a skill, a tool, and a stray PDF into their real homes and extracts the PDF", async () => {
    const mixed = path.join(temp(), "mixed-drop");
    fs.mkdirSync(path.join(mixed, "hello-skill"), { recursive: true });
    fs.mkdirSync(path.join(mixed, "ping-tool"), { recursive: true });
    fs.writeFileSync(
      path.join(mixed, "hello-skill", "skill.json"),
      JSON.stringify({ id: "hello-skill", name: "Hello Skill", version: "1.0.0" }),
    );
    fs.writeFileSync(
      path.join(mixed, "hello-skill", "skill.mjs"),
      "export async function run(input) { return { ok: true, input: input ?? null }; }\n",
    );
    fs.writeFileSync(
      path.join(mixed, "ping-tool", "tool.json"),
      JSON.stringify({ id: "ping", name: "Ping", version: "1.0.0" }),
    );
    fs.writeFileSync(
      path.join(mixed, "ping-tool", "index.cjs"),
      "module.exports = { async run() { return { ok: true }; } };\n",
    );
    fs.writeFileSync(
      path.join(mixed, "note.pdf"),
      samplePdf("Scope of work: paint the ward office"),
    );

    const zipPath = path.join(temp(), "mixed.zip");
    zipFolder(mixed, zipPath);
    const workspace = temp();
    const scan = await importer.scanImport({ root: workspace, source: zipPath });
    expect(scan.ok, scan.error).toBe(true);
    const destOf = (rel: string) => scan.files?.find((f) => f.path.endsWith(rel) || f.path === rel);
    expect(destOf("skill.json")?.dest).toBe("skills/custom/hello-skill/skill.json");
    expect(destOf("index.cjs")?.dest).toBe("tools/custom/ping/index.cjs");
    expect(destOf("note.pdf")?.dest).toBe("brain-data/knowledge/note.pdf");
    expect(destOf("note.pdf")?.extract).toBe(true);
    expect(destOf("note.pdf")?.area).toBe("brain");

    const verified = await importer.verifyStagedPacks({ root: workspace, scan });
    expect(verified.packs.some((p) => p.kind === "skill")).toBe(true);
    expect(verified.packs.some((p) => p.kind === "tool")).toBe(true);

    const applied = await importer.applyImport({ root: workspace, scan, keepBackup: false });
    expect(applied.ok, applied.error).toBe(true);
    expect(fs.existsSync(path.join(workspace, "skills/custom/hello-skill/skill.json"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "tools/custom/ping/index.cjs"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "brain-data/knowledge/note.pdf"))).toBe(true);
    const extracted = path.join(workspace, "brain-data/knowledge/note.pdf.extracted.txt");
    expect(fs.existsSync(extracted)).toBe(true);
    expect(fs.readFileSync(extracted, "utf8")).toMatch(/paint the ward office/);
    expect(fs.existsSync(path.join(workspace, "config/connectors.json"))).toBe(false);
  });
});

describe("import chat intents", () => {
  it("grounds 'what's in this zip' in the real session dump", async () => {
    expect(interpretImportPrompt("what's in this zip").type).toBe("describe");
    expect(interpretImportPrompt("only install the skills").areas).toEqual(["skills"]);
    expect(interpretImportPrompt("install everything").areas).toBeUndefined();
    expect(interpretImportPrompt("test this tool").type).toBe("verify");
    expect(interpretImportPrompt("analyse this").type).toBe("analyse");
    expect(interpretImportPrompt("build friday exe")).toEqual({
      type: "build",
      identity: "friday",
      kind: "exe",
    });
    expect(interpretImportPrompt("build zip of this project")).toEqual({
      type: "build",
      identity: "other",
      kind: "zip",
    });
    expect(interpretImportPrompt("why is FRIDAY local-first").type).toBe("ask");

    const noSource = await handleImportIntent("build zip of this project", []);
    expect(noSource.action.type).toBe("build");
    expect(noSource.action.identity).toBe("other");
    expect(noSource.text).toMatch(/imported scan or a folder/i);
    expect(imports.getSnapshot().builds.some((b) => b.identity === "other")).toBe(false);

    const item: ImportItem = {
      id: "i1",
      name: "mixed.zip",
      target: "Workspace",
      source: "upload",
      origin: "local upload",
      files: [],
      fileCount: 3,
      bytes: 12,
      stack: [],
      status: "ready",
      at: Date.now(),
      areas: [
        { area: "skills", files: 2 },
        { area: "tools", files: 2 },
        { area: "brain", files: 1 },
      ],
      destinations: [
        { dir: "skills/custom", files: 2 },
        { dir: "tools/custom", files: 2 },
        { dir: "brain-data/knowledge", files: 1 },
      ],
      placements: [
        {
          path: "hello-skill/skill.json",
          dest: "skills/custom/hello-skill/skill.json",
          area: "skills",
          reason: "skill package",
        },
        {
          path: "note.pdf",
          dest: "brain-data/knowledge/note.pdf",
          area: "brain",
          extract: true,
          reason: "document — extract via document-extract",
        },
      ],
    };
    const dump = describeImportSession([item]);
    expect(dump).toContain("skills/custom/hello-skill/skill.json");
    expect(dump).toContain("brain-data/knowledge/note.pdf");
    expect(dump).not.toMatch(/invent/i);

    const reply = await handleImportIntent("what's in this zip", [item]);
    expect(reply.grounded).toBe(true);
    expect(reply.text).toContain("skills/custom/hello-skill/skill.json");
    expect(reply.action.type).toBe("describe");
  });

  it("lets FRIDAY queue analysis and a local build through the same engines", async () => {
    const item: ImportItem = {
      id: "i2",
      name: "hello-skill",
      target: "Workspace",
      source: "upload",
      origin: "local upload",
      files: [{ path: "skill.json", size: 12 }],
      fileCount: 1,
      bytes: 12,
      stack: [],
      status: "ready",
      at: Date.now(),
    };
    const analysed = await handleImportIntent("analyse this", [item]);
    expect(analysed.action.type).toBe("analyse");
    expect(analysed.text).toMatch(/Self-upgrade/);
    expect(analysed.text).toMatch(/GitHub/);

    const built = await handleImportIntent("build friday exe", [item]);
    expect(built.action.type).toBe("build");
    expect(built.action.identity).toBe("friday");
    expect(built.text).toMatch(/desktop app/i);
    const job = imports.getSnapshot().builds[0];
    expect(job?.status).toBe("error");
    expect(job?.step).toMatch(/desktop/i);
  });

  it("applies build progress that arrives before startBuild resolves", async () => {
    const listeners: Array<(event: Record<string, unknown>) => void> = [];
    const previous = (globalThis as { window?: unknown }).window;
    (globalThis as { window: unknown }).window = {
      friday: {
        startBuild: async (_kind: string, options: { clientId?: string }) => {
          const desktopId = "factory-fast";
          for (const fn of listeners) {
            fn({
              id: desktopId,
              clientId: options.clientId,
              progress: 100,
              step: "Build finished",
              status: "done",
              artifact: "/tmp/notes-0.1.0.zip",
            });
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { ok: true, id: desktopId };
        },
        onBuildProgress: (fn: (event: Record<string, unknown>) => void) => {
          listeners.push(fn);
          return () => {
            const index = listeners.indexOf(fn);
            if (index >= 0) listeners.splice(index, 1);
          };
        },
      },
      localStorage: {
        getItem: () => null,
        setItem: () => undefined,
        removeItem: () => undefined,
      },
    };
    try {
      const id = imports.build("zip", "notes zip", {
        identity: "other",
        name: "notes",
        version: "0.1.0",
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const job = imports.getSnapshot().builds.find((b) => b.id === id);
      expect(job?.status).toBe("done");
      expect(job?.artifact).toBe("/tmp/notes-0.1.0.zip");
    } finally {
      if (previous === undefined) delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window: unknown }).window = previous;
    }
  });
});

describe("import engine honesty", () => {
  it("does not fake an installed state without the desktop apply path", async () => {
    const item = await imports.importClipboard(
      JSON.stringify({
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" },
        ],
      }),
      "Workspace",
    );
    expect(item?.status).toBe("ready");
    expect(item?.source).toBe("clipboard");
    const result = await imports.installNow(item!.id);
    expect(result.ok).toBe(false);
    const listed = imports.list().find((i) => i.id === item!.id);
    expect(listed).toBeTruthy();
    expect(listed?.status).not.toBe("installed");
    expect(listed?.message).toMatch(/desktop/i);
  });

  it("treats a GitHub URL as a repo and a file URL as a download", () => {
    expect(parseRepoUrl("https://github.com/devendrarj25/FRIDAY-AI-ASSISTANT")).toEqual({
      owner: "devendrarj25",
      repo: "FRIDAY-AI-ASSISTANT",
      branch: undefined,
    });
    expect(parseRepoUrl("https://example.com/files/pack.zip")).toBeNull();
  });
});

describe("Import & Build page is intake, not a duplicate market", () => {
  it("adds URL, clipboard, drop, and chat without a second Skills market", () => {
    const page = fs.readFileSync(path.resolve(process.cwd(), "src/routes/import.tsx"), "utf8");
    expect(page).toContain("onDrop");
    expect(page).toContain("importClipboard");
    expect(page).toContain("importUrl");
    expect(page).toContain("ImportChat");
    expect(page).toContain("verifyPacks");
    expect(page).not.toMatch(/CapabilityMarket/);
    expect(page).not.toMatch(/marketplace\.ts/);
    const engine = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/friday/import-engine.ts"),
      "utf8",
    );
    expect(engine).toContain("this.remove(id)");
    expect(engine).toContain("governance.submit");
    expect(engine).toContain("verifyImportPacks");
  });

  it("is a local factory: FRIDAY vs other, keep/install, no Hub repo push chrome", () => {
    const page = fs.readFileSync(path.resolve(process.cwd(), "src/routes/import.tsx"), "utf8");
    expect(page).toContain("FRIDAY's own app");
    expect(page).toContain("Other app / project");
    expect(page).toContain("downloads/kept-builds");
    expect(page).toContain("Install EXE");
    expect(page).toContain("Install into FRIDAY");
    expect(page).toContain("What happened here");
    expect(page).not.toMatch(/devQueueChangeSet/);
    expect(page).not.toMatch(/Send change set to Hub/);
    expect(page).not.toMatch(/git push/i);
    expect(page).not.toMatch(/createPullRequest/);
    expect(page).toContain('e.target.value = ""');
    const engine = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/friday/import-engine.ts"),
      "utf8",
    );
    expect(engine).toContain('identity === "other"');
    expect(engine).toContain("factoryKeep");
    expect(engine).toContain("will not fake a finished installer");
    expect(engine).toContain("clientId");
    expect(engine).toMatch(/downloadImport\(\s*[^)]*token/);
    const factory = fs.readFileSync(
      path.resolve(process.cwd(), "electron/import-factory.cjs"),
      "utf8",
    );
    expect(factory).toContain("never git-push");
    expect(factory).not.toMatch(/git push origin/);
    expect(factory).toContain("never use FRIDAY's electron-builder.yml");
  });
});
