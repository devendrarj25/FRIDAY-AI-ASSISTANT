/**
 * The Hugging Face runner: Transformers' own server for Safetensors and
 * PyTorch models, installed into the FRIDAY folder, serving offline from a
 * hub-cache layout that downloads and imports are linked into. No network, no
 * PyTorch: folders and stand-in processes only.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const runner = require_("../../electron/hf-runner.cjs") as {
  PORT: number;
  CUDA_INDEX: string;
  INSTALL_SCRIPT: string;
  TOOL_ID: string;
  hubDir: (root: string) => string;
  runnerDir: (root: string) => string;
  serveBin: (root: string) => string;
  venvPython: (root: string) => string;
  detect: (root: string) => {
    installed: boolean;
    version?: string;
    status?: string;
    detail?: string;
  };
  serveArgs: () => string[];
  serveEnv: (root: string, base?: Record<string, string>) => Record<string, string>;
  installArgs: (root: string, cuda: boolean) => string[];
  registerSnapshot: (root: string, id: string, dir: string) => { ok: boolean; error?: string };
  listRegistered: (root: string) => string[];
  unregister: (root: string, id: string) => boolean;
  importedRepoId: (slug: string) => string;
};
const importer = require_("../../electron/model-import.cjs") as {
  importForRunner: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
};
const services = require_("../../electron/tool-services.cjs") as {
  createServices: (deps: Record<string, unknown>) => {
    start: (id: string) => Promise<{ ok: boolean; error?: string }>;
  };
};
const toolchain = require_("../../electron/toolchain.cjs") as {
  TOOLS: Array<Record<string, unknown>>;
};

const folders: string[] = [];
const temp = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "friday-hf-"));
  folders.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const modelFolder = (root: string) => {
  const dir = path.join(root, "models", "my-model");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "config.json"), "{}");
  writeFileSync(path.join(dir, "model.safetensors"), "weights");
  writeFileSync(path.join(dir, "tokenizer.json"), "{}");
  return dir;
};

describe("hub-cache registration", () => {
  it("links a model folder under its repo id, without copying the weights", () => {
    const root = temp();
    const dir = modelFolder(root);
    const result = runner.registerSnapshot(root, "Qwen/Qwen2.5-0.5B-Instruct", dir);
    expect(result.ok).toBe(true);
    const cache = path.join(runner.hubDir(root), "models--Qwen--Qwen2.5-0.5B-Instruct");
    const rev = readFileSync(path.join(cache, "refs", "main"), "utf8");
    expect(rev).toMatch(/^[0-9a-f]{40}$/);
    const linked = path.join(cache, "snapshots", rev, "model.safetensors");
    expect(readFileSync(linked, "utf8")).toBe("weights");
    // A hard link shares the file, so there is one copy on disk.
    expect(statSync(linked).ino).toBe(statSync(path.join(dir, "model.safetensors")).ino);
    expect(runner.listRegistered(root)).toEqual(["Qwen/Qwen2.5-0.5B-Instruct"]);
  });

  it("refuses an id that is not owner/name and a folder that is not a model", () => {
    const root = temp();
    const dir = modelFolder(root);
    expect(runner.registerSnapshot(root, "no-owner", dir).ok).toBe(false);
    const empty = path.join(root, "empty");
    mkdirSync(empty);
    expect(runner.registerSnapshot(root, "a/b", empty).error).toMatch(/config\.json/);
  });

  it("removes a registration and leaves the source folder alone", () => {
    const root = temp();
    const dir = modelFolder(root);
    runner.registerSnapshot(root, "a/b", dir);
    expect(runner.unregister(root, "a/b")).toBe(true);
    expect(runner.listRegistered(root)).toEqual([]);
    expect(readFileSync(path.join(dir, "model.safetensors"), "utf8")).toBe("weights");
  });

  it("names an imported folder under friday/<slug>", () => {
    expect(runner.importedRepoId("my model!")).toBe("friday/my-model-");
  });
});

describe("the server it runs", () => {
  it("binds this PC only, on its own port, offline and inside the FRIDAY folder", () => {
    const args = runner.serveArgs();
    expect(args.slice(0, 5)).toEqual(["serve", "--host", "127.0.0.1", "--port", "8083"]);
    expect(args).toContain("--model-timeout");
    const root = temp();
    const env = runner.serveEnv(root, {});
    expect(env["HF_HOME"]).toBe(path.join(root, "models", "huggingface"));
    expect(env["HF_HUB_OFFLINE"]).toBe("1");
    expect(runner.PORT).not.toBe(8000);
  });

  it("is detected from the folder and its marker, and absent from an empty root", () => {
    const root = temp();
    expect(runner.detect(root).installed).toBe(false);
    mkdirSync(path.dirname(runner.serveBin(root)), { recursive: true });
    writeFileSync(runner.serveBin(root), "");
    writeFileSync(runner.venvPython(root), "");
    writeFileSync(
      path.join(runner.runnerDir(root), ".friday-install.json"),
      JSON.stringify({ transformers: "5.9.0", torch: "2.10.0", cuda: true }),
    );
    const found = runner.detect(root);
    expect(found).toMatchObject({ installed: true, version: "5.9.0", status: "Ready" });
    expect(found.detail).toContain("CUDA");
  });

  it("installs Transformers with the serving extra, preferring CUDA PyTorch when asked", () => {
    expect(runner.INSTALL_SCRIPT).toContain("transformers[serving]");
    expect(runner.INSTALL_SCRIPT).toContain(runner.CUDA_INDEX);
    expect(runner.INSTALL_SCRIPT).toContain("using the default build");
    const root = temp();
    expect(runner.installArgs(root, true).slice(-2)).toEqual([runner.runnerDir(root), "1"]);
    expect(runner.installArgs(root, false).slice(-1)).toEqual(["0"]);
  });
});

describe("the Install Manager and the service layer", () => {
  it("lists the runner as an AI runtime with its own detector and installer", () => {
    const tool = toolchain.TOOLS.find((t) => t["id"] === "Hugging Face runner")!;
    expect(tool["category"]).toBe("AI Runtimes");
    expect(typeof tool["detect"]).toBe("function");
    expect(typeof tool["customCommand"]).toBe("function");
  });

  it("does not start a runner that is not installed yet", async () => {
    const layer = services.createServices({
      run: async () => null,
      ping: async () => false,
      tcp: async () => false,
      spawnDetached: async () => ({ pid: 1 }),
      exeFor: () => null,
      installed: () => false,
      killTree: () => {},
      killImages: () => {},
      elevated: async () => ({ ok: false }),
    });
    const result = await layer.start("Hugging Face runner");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not installed yet/);
  });
});

describe("importing a Safetensors folder", () => {
  const base = { ok: true, path: "D:\\FRIDAY\\models\\imported\\x", name: "x" };
  const emit = () => {};

  it("links it and asks for the runner when the runner is missing", async () => {
    const result = await importer.importForRunner({
      base,
      slug: "x",
      name: "x",
      emit,
      deps: {
        serve: {
          repoId: (slug: string) => `friday/${slug}`,
          register: () => ({ ok: true }),
          installed: () => false,
          ensure: async () => false,
        },
      },
    });
    expect(result).toMatchObject({
      state: "stored",
      registered: true,
      registeredAs: "friday/x",
      needsRunner: "Hugging Face runner",
    });
  });

  it("is ready only after the model answers a test prompt", async () => {
    const make = (verify: () => Promise<{ ok: boolean; error?: string }>) => ({
      base,
      slug: "x",
      name: "x",
      emit,
      deps: {
        serve: {
          repoId: (slug: string) => `friday/${slug}`,
          register: () => ({ ok: true }),
          installed: () => true,
          ensure: async () => true,
          verify,
        },
      },
    });
    expect((await importer.importForRunner(make(async () => ({ ok: true }))))["state"]).toBe(
      "ready",
    );
    const silent = await importer.importForRunner(
      make(async () => ({ ok: false, error: "empty answer" })),
    );
    expect(silent["state"]).toBe("not-responding");
  });
});
