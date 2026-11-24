/**
 * Which engine folder is active, and which are pruned: ordered by the marker's `installedAt` (name only breaks a tie),
 * a folder with a healthy marker before one with none or a broken one, and the folder just installed or in use is never
 * pruned. A fallback build that was installed later wins over an older broken build with a newer-looking name.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const llama = require_(path.join(root, "electron/llama-runtime.cjs"));
const engines = require_(path.join(root, "electron/engine-install.cjs"));

const SERVER = process.platform === "win32" ? "llama-server.exe" : "llama-server";
const spec = () => engines.ENGINES["llama.cpp"];
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "friday-select-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const base = () => engines.engineBase(dir, spec());
const names = () => (existsSync(base()) ? readdirSync(base()).sort() : []);

/** One engine folder holding a server binary; `marker` is written as given (an object, or raw text for a broken one). */
function folder(name: string, marker?: Record<string, unknown> | string | null) {
  const where = path.join(base(), name);
  mkdirSync(where, { recursive: true });
  writeFileSync(path.join(where, SERVER), name);
  if (typeof marker === "string") writeFileSync(path.join(where, engines.MARKER), marker);
  else if (marker)
    writeFileSync(
      path.join(where, engines.MARKER),
      JSON.stringify({ id: "llama.cpp", tag: name.split("-")[0], ...marker }),
    );
  return where;
}

describe("the active engine folder is the one installed last, not the one with the newest-looking name", () => {
  it("a CPU fallback installed after a broken CUDA build of the same tag is the active engine", () => {
    folder("b8000-cuda12", { backend: "cuda", variant: "cuda-12.8", installedAt: 1_000 });
    const cpu = folder("b8000-cpu", { backend: "cpu", variant: "avx2", installedAt: 2_000 });
    expect(engines.detectEngine(dir, spec())).toMatchObject({
      installed: true,
      backend: "cpu",
      path: path.join(cpu, SERVER),
    });
    // the same function the app starts the server with
    expect(llama.findServer(dir)).toBe(path.join(cpu, SERVER));
    expect(llama.readBackend(dir)).toMatchObject({ backend: "cpu" });
  });

  it("the order of the names does not matter when the markers disagree with it", () => {
    folder("b9000-cpu", { backend: "cpu", installedAt: 1 });
    folder("b7000-cpu", { backend: "cpu", installedAt: 3 }); // an older pinned tag, installed last
    folder("b8000-cpu", { backend: "cpu", installedAt: 2 });
    expect(engines.detectEngine(dir, spec())).toMatchObject({ tag: "b7000" });
    expect(llama.findServer(dir)).toContain("b7000-cpu");
  });

  it("the name only breaks a tie, numerically (b10000 after b9000)", () => {
    folder("b9000-cpu", { backend: "cpu", installedAt: 5 });
    folder("b10000-cpu", { backend: "cpu", installedAt: 5 });
    expect(engines.detectEngine(dir, spec())).toMatchObject({ tag: "b10000" });
  });

  it("a folder with no marker (an install from before markers) ranks below any folder with one", () => {
    folder("b9999-cpu"); // no marker: newest name, unknown origin
    folder("b8000-cpu", { backend: "cpu", installedAt: 1 });
    expect(engines.detectEngine(dir, spec())).toMatchObject({ tag: "b8000" });
    expect(llama.findServer(dir)).toContain("b8000-cpu");
  });

  it("a folder with no marker is still found when it is the only one, with the version from its name", () => {
    folder("b8123-cpu");
    expect(engines.detectEngine(dir, spec())).toMatchObject({
      installed: true,
      version: "8123",
      backend: null,
    });
    expect(llama.findServer(dir)).toContain("b8123-cpu");
  });

  it("a corrupted or non-object marker counts as no marker and never throws", () => {
    folder("b9500-cuda12", "{ this is not json");
    folder("b9400-cuda12", "null");
    folder("b9300-cuda12", "[1,2]");
    folder("b9200-cuda12", '"text"');
    folder("b8000-cpu", { backend: "cpu", installedAt: 1 });
    expect(engines.detectEngine(dir, spec())).toMatchObject({ tag: "b8000", backend: "cpu" });
    expect(llama.findServer(dir)).toContain("b8000-cpu");
  });

  it("only corrupted markers: the newest name is used, as before markers existed", () => {
    folder("b9000-cpu", "{");
    folder("b9500-cpu", "{");
    expect(engines.detectEngine(dir, spec())).toMatchObject({ installed: true, version: "9500" });
  });

  it("a marker that says the build is not healthy ranks below a healthy one even when it is newer", () => {
    folder("b8000-cuda12", { backend: "cuda", installedAt: 9_000, healthy: false });
    folder("b8000-cpu", { backend: "cpu", installedAt: 1_000 });
    expect(engines.detectEngine(dir, spec())).toMatchObject({ backend: "cpu" });
  });

  it("an installedAt that is not a number is treated as the oldest, never as NaN ordering", () => {
    folder("b8000-cpu", { backend: "cpu", installedAt: "yesterday" });
    folder("b7000-cpu", { backend: "cpu", installedAt: 4 });
    folder("b6000-cpu", { backend: "cpu", installedAt: null });
    expect(engines.detectEngine(dir, spec())).toMatchObject({ tag: "b7000" });
  });

  it("staging and previous folders are never active", () => {
    folder("b9000-cpu.staging", { backend: "cpu", installedAt: 99 });
    folder("b9000-cpu.prev", { backend: "cpu", installedAt: 99 });
    folder("b8000-cpu", { backend: "cpu", installedAt: 1 });
    expect(engines.detectEngine(dir, spec())).toMatchObject({ tag: "b8000" });
    expect(llama.findServer(dir)).toContain("b8000-cpu");
  });

  it("a folder with a marker but no binary is skipped for the next one", () => {
    const broken = path.join(base(), "b9000-cpu");
    mkdirSync(broken, { recursive: true });
    writeFileSync(path.join(broken, engines.MARKER), JSON.stringify({ installedAt: 99 }));
    folder("b8000-cpu", { backend: "cpu", installedAt: 1 });
    expect(engines.detectEngine(dir, spec())).toMatchObject({ tag: "b8000" });
  });
});

describe("pruneOld keeps the newest two by install time, and never the active or just-installed folder", () => {
  it("three folders: the oldest install goes, whatever its name", () => {
    folder("b9000-cpu", { installedAt: 1 }); // the biggest name, installed first
    folder("b8000-cuda12", { installedAt: 2 });
    folder("b8000-cpu", { installedAt: 3 });
    expect(engines.pruneOld(dir, spec())).toEqual(["b9000-cpu"]);
    expect(names()).toEqual(["b8000-cpu", "b8000-cuda12"]);
  });

  it("an older pinned tag installed just now survives among 3+ newer-named folders", () => {
    folder("b9000-cpu", { installedAt: 10 });
    folder("b8500-cpu", { installedAt: 20 });
    folder("b8000-cuda12", { installedAt: 30 });
    folder("b7000-cpu", { installedAt: 40 }); // the pinned fallback, just installed
    const gone = engines.pruneOld(dir, spec(), 2, undefined, ["b7000-cpu"]);
    expect(gone.sort()).toEqual(["b8500-cpu", "b9000-cpu"]);
    expect(names()).toEqual(["b7000-cpu", "b8000-cuda12"]);
    expect(engines.detectEngine(dir, spec())).toMatchObject({ tag: "b7000" });
  });

  it("a protected folder is kept even when it is the oldest and keep is 1", () => {
    folder("b9000-cpu", { installedAt: 10 });
    folder("b8000-cpu", { installedAt: 20 });
    folder("b7000-cpu", { installedAt: 5 });
    const gone = engines.pruneOld(dir, spec(), 1, undefined, ["b7000-cpu"]);
    expect(gone.sort()).toEqual(["b9000-cpu"]);
    expect(names()).toEqual(["b7000-cpu", "b8000-cpu"]);
  });

  it("the folder detectEngine reports is never pruned, even with no protect list and a missing marker", () => {
    folder("b9999-cpu"); // no marker: ranks last, so it is not the active one
    folder("b8000-cpu", { installedAt: 1 });
    folder("b7000-cpu", { installedAt: 2 });
    folder("b6000-cpu", { installedAt: 3 });
    const active = engines.detectEngine(dir, spec());
    engines.pruneOld(dir, spec(), 1);
    expect(names()).toContain(path.basename(path.dirname(active.path)));
    expect(engines.detectEngine(dir, spec())).toMatchObject({ tag: "b6000" });
  });

  it("corrupted and missing markers are pruned first, before any healthy install", () => {
    folder("b9000-cpu", "{");
    folder("b9001-cpu");
    folder("b8000-cpu", { installedAt: 1 });
    folder("b7000-cpu", { installedAt: 2 });
    engines.pruneOld(dir, spec());
    expect(names()).toEqual(["b7000-cpu", "b8000-cpu"]);
  });

  it("two or fewer folders are all kept, and a missing base is not an error", () => {
    folder("b8000-cpu", { installedAt: 1 });
    folder("b7000-cpu", { installedAt: 2 });
    expect(engines.pruneOld(dir, spec())).toEqual([]);
    expect(engines.pruneOld(path.join(dir, "nowhere"), spec())).toEqual([]);
  });
});

describe("installEngine keeps the folder it just installed", () => {
  const zipName = "llama-b7000-bin-win-cpu-x64.zip";
  const assets = [
    {
      name: zipName,
      url: `https://github.com/ggml-org/llama.cpp/releases/download/b7000/${zipName}`,
      bytes: 1000,
      sha256: sha(zipName),
    },
  ];
  const deps = (now: number) => ({
    download: async (_url: string, dest: string) => {
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, zipName);
    },
    extract: async (_zip: string, out: string) => {
      mkdirSync(out, { recursive: true });
      writeFileSync(path.join(out, SERVER), zipName);
      return { ok: true };
    },
    health: async () => ({ ok: true }),
    diskFree: () => 50 * 1024 ** 3,
    now: () => now,
  });
  const facts = { ramGb: 16, gpus: [], cpu: { avx2: false, avx512: false } };

  it("an older pinned tag installed over three newer folders stays and is the active engine", async () => {
    folder("b9000-cpu", { backend: "cpu", installedAt: 100 });
    folder("b8500-cpu", { backend: "cpu", installedAt: 200 });
    folder("b8000-cuda12", { backend: "cuda", installedAt: 300 });
    const out = await engines.installEngine(
      dir,
      spec(),
      {
        release: {
          ok: true,
          version: "7000",
          tag: "b7000",
          assets,
          source: "pinned",
          usedPin: true,
        },
        facts,
      },
      deps(400),
    );
    expect(out).toMatchObject({ ok: true, tag: "b7000" });
    const installed = names().filter((n) => n.startsWith("b7000"));
    expect(installed).toHaveLength(1);
    expect(names()).toHaveLength(2);
    expect(names()).toContain("b8000-cuda12"); // the second newest install is the kept rollback
    expect(engines.detectEngine(dir, spec())).toMatchObject({ tag: "b7000" });
    expect(out.bin).toBe(path.join(base(), installed[0]!, SERVER));
    expect(
      JSON.parse(readFileSync(path.join(base(), installed[0]!, engines.MARKER), "utf8")),
    ).toMatchObject({ installedAt: 400 });
  });
});
