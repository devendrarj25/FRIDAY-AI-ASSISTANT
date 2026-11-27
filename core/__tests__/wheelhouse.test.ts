/**
 * The offline Python wheelhouse the Setup EXE carries: the pinned Windows wheels of the kernel and voice packages
 * (config/wheelhouse.lock.json), checked against their SHA-256 at build, packed into one stored zip
 * (resources/toolchain/wheelhouse/pack.bin) and installed by the runtime repair with no network first.
 * Fake fetches and temp folders only; no network, no date, no Windows.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasCommand } from "./helpers/environment";

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, "../..");

type Wheel = {
  name: string;
  version: string;
  filename: string;
  url: string;
  sha256: string;
  bytes: number;
  tags: string[];
};
type Lock = {
  schema: number;
  platform: string;
  index: string;
  requirements: string;
  pythonTags: string[];
  wheels: Wheel[];
};
type Spec = { op: string; version: string };
type Plan = { wheels: Wheel[]; sum: number; budget: number; tags: string[]; errors: string[] };
type Staged = { file: string; wheels: number; bytes: number; tags: string[] };

const wheelhouse = require_("../../scripts/wheelhouse.cjs") as {
  DEST: string;
  parseWheelFilename: (
    name: string,
  ) => { name: string; version: string; python: string; abi: string; platform: string } | null;
  wheelFits: (filename: string, tag: string) => boolean;
  compareVersions: (a: string, b: string) => number;
  parseRequirements: (text: string) => Array<{ name: string; specs: Spec[] }>;
  satisfies: (version: string, specs: Spec[]) => boolean;
  planWheelhouse: (
    lock: unknown,
    options?: { budgetBytes?: number; requirementsText?: string },
  ) => Plan;
  constraintsFor: (lock: unknown, tag: string) => string;
  requirementsFor: (lock: unknown, tag: string) => string;
  readZipIndex: (
    file: string,
  ) => Array<{ name: string; size: number; crc: number; offset: number }>;
  verifyWheelhouseZip: (
    file: string,
    wheels: Array<{ filename: string; sha256: string; bytes: number }>,
  ) => string[];
  stageWheelhouse: (options: Record<string, unknown>) => Promise<Staged>;
  buildLock: (input: Record<string, unknown>) => Lock;
};
const stage = require_("../../scripts/stage-toolchain.cjs") as {
  stageAll: (options: Record<string, unknown>) => Promise<{
    staged: unknown[];
    sum: number;
    wheelhouse: Staged | null;
  }>;
};

const sha = (body: Buffer) => createHash("sha256").update(body).digest("hex");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const made: string[] = [];
const temp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "friday-wheelhouse-"));
  made.push(dir);
  return dir;
};
afterEach(() => {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
});

const HOST = "https://files.pythonhosted.org/packages/aa/bb/";
function wheel(filename: string, body: Buffer, tags: string[]): Wheel {
  const parsed = wheelhouse.parseWheelFilename(filename)!;
  return {
    name: parsed.name,
    version: parsed.version,
    filename,
    url: `${HOST}${filename}`,
    sha256: sha(body),
    bytes: body.length,
    tags,
  };
}

/** A tiny lock: one pure wheel and one abi3 wheel shared by both tags, one binary wheel per tag. */
function fixture() {
  const bodies = new Map<string, Buffer>([
    ["av-18.1.1-cp311-abi3-win_amd64.whl", Buffer.from("pyav abi3")],
    ["fastapi-0.165.0-py3-none-any.whl", Buffer.from("fastapi wheel body")],
    ["pyyaml-6.0.4-cp312-cp312-win_amd64.whl", Buffer.from("yaml for 3.12")],
    ["pyyaml-6.0.4-cp313-cp313-win_amd64.whl", Buffer.from("yaml for 3.13 ...")],
  ]);
  const tagsOf = (filename: string) =>
    filename.includes("cp312-cp312")
      ? ["cp312"]
      : filename.includes("cp313-cp313")
        ? ["cp313"]
        : ["cp312", "cp313"];
  const lock: Lock = {
    schema: 1,
    platform: "win_amd64",
    index: "https://pypi.org/simple",
    requirements: "kernel/requirements.txt",
    pythonTags: ["cp312", "cp313"],
    wheels: [...bodies].map(([filename, body]) => wheel(filename, body, tagsOf(filename))),
  };
  const byUrl = new Map(lock.wheels.map((w) => [w.url, bodies.get(w.filename)!]));
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    const body = byUrl.get(url);
    if (!body) throw new Error(`no such file ${url}`);
    return { body };
  };
  const requirementsText = "fastapi>=0.162.5\nPyYAML>=6.0.3\nav>=17.0.0,<19\n";
  return { lock, fetchImpl, calls, requirementsText };
}

describe("wheel names, versions and requirement floors", () => {
  it("reads a wheel file name and knows which interpreter it fits", () => {
    expect(wheelhouse.parseWheelFilename("pydantic_core-2.50.5-cp312-cp312-win_amd64.whl")).toEqual(
      {
        name: "pydantic-core",
        version: "2.50.5",
        python: "cp312",
        abi: "cp312",
        platform: "win_amd64",
      },
    );
    expect(wheelhouse.parseWheelFilename("../evil-1.0-py3-none-any.whl")).toBeNull();
    expect(wheelhouse.parseWheelFilename("not-a-wheel.zip")).toBeNull();
    expect(wheelhouse.wheelFits("av-18.1.1-cp311-abi3-win_amd64.whl", "cp313")).toBe(true);
    expect(wheelhouse.wheelFits("av-18.1.1-cp311-abi3-win_amd64.whl", "cp310")).toBe(false);
    expect(wheelhouse.wheelFits("colorama-0.4.6-py2.py3-none-any.whl", "cp314")).toBe(true);
    expect(wheelhouse.wheelFits("numpy-2.5.5-cp313-cp313-win_amd64.whl", "cp312")).toBe(false);
    expect(wheelhouse.wheelFits("numpy-2.5.5-cp312-cp312-manylinux_2_28_x86_64.whl", "cp312")).toBe(
      false,
    );
  });

  it("compares versions by number and honours the floor and the PyAV ceiling", () => {
    expect(wheelhouse.compareVersions("0.165.0", "0.162.5")).toBeGreaterThan(0);
    expect(wheelhouse.compareVersions("6.0.10", "6.0.9")).toBeGreaterThan(0);
    expect(wheelhouse.compareVersions("19", "19.0.0")).toBe(0);
    expect(wheelhouse.compareVersions("2.0.0rc1", "2.0.0")).toBeLessThan(0);
    const reqs = wheelhouse.parseRequirements(
      "# comment\nuvicorn[standard]>=0.54.0\n\nav>=17.0.0,<19\n-r other.txt\n",
    );
    expect(reqs.map((r) => r.name)).toEqual(["uvicorn", "av"]);
    const av = reqs[1]!.specs;
    expect(wheelhouse.satisfies("18.1.1", av)).toBe(true);
    expect(wheelhouse.satisfies("19.0.0", av)).toBe(false);
    expect(wheelhouse.satisfies("16.9", av)).toBe(false);
  });
});

describe("the committed lock", () => {
  const lock = JSON.parse(read("config/wheelhouse.lock.json")) as Lock;
  const manifest = JSON.parse(read("config/toolchain-manifest.json"));

  it("covers every kernel and voice requirement for every carried Python series, inside its budget", () => {
    const plan = wheelhouse.planWheelhouse(lock, {
      budgetBytes: manifest.wheelhouse.budgetBytes,
      requirementsText: read("kernel/requirements.txt"),
    });
    expect(plan.errors).toEqual([]);
    expect(plan.sum).toBeGreaterThan(0);
    expect(plan.sum).toBeLessThanOrEqual(manifest.wheelhouse.budgetBytes);
    // The venv Python is whatever install-python.ps1 reuses or installs: 3.12.10 up to pythonWheelProven.
    const proven = JSON.parse(read("config/toolchain-versions.json")).pythonWheelProven as string;
    expect(lock.pythonTags).toContain("cp312");
    expect(lock.pythonTags).toContain(`cp${proven.replace(".", "")}`);
    for (const name of ["fastapi", "uvicorn", "httpx", "pydantic", "pydantic-core", "pyyaml"]) {
      for (const tag of lock.pythonTags) {
        expect(
          plan.wheels.some((w) => w.name === name && w.tags.includes(tag)),
          `${name} ${tag}`,
        ).toBe(true);
      }
    }
    for (const name of [
      "faster-whisper",
      "ctranslate2",
      "av",
      "edge-tts",
      "onnxruntime",
      "numpy",
    ]) {
      expect(
        plan.wheels.some((w) => w.name === name),
        name,
      ).toBe(true);
    }
  });

  it("names only official PyPI files for Windows x64, never the optional capabilities file", () => {
    expect(lock.platform).toBe("win_amd64");
    expect(lock.requirements).toBe("kernel/requirements.txt");
    for (const w of lock.wheels) {
      expect(w.url.startsWith("https://files.pythonhosted.org/"), w.filename).toBe(true);
      expect(w.url.endsWith(`/${w.filename}`)).toBe(true);
      expect(w.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(/win_amd64|none-any/.test(w.filename), w.filename).toBe(true);
    }
    const names = new Set(lock.wheels.map((w) => w.name));
    for (const optional of ["chromadb", "bleak", "zeroconf", "uvloop"]) {
      expect(names.has(optional), optional).toBe(false);
    }
  });

  it("keeps the toolchain budget separate, so the old pack readers see the same packs", () => {
    expect(manifest.wheelhouse.lock).toBe("config/wheelhouse.lock.json");
    expect(manifest.packs.some((p: { id: string }) => p.id === "wheelhouse")).toBe(false);
    expect(manifest.budgetBytes + manifest.wheelhouse.budgetBytes).toBeLessThan(2 * 1024 ** 3 - 1);
    expect(wheelhouse.DEST).toBe("toolchain/wheelhouse");
  });
});

describe("the lock plan refuses what it cannot trust", () => {
  const { lock, requirementsText } = fixture();
  const errorsOf = (mutate: (copy: Lock) => void, options: Record<string, unknown> = {}) => {
    const copy = JSON.parse(JSON.stringify(lock)) as Lock;
    mutate(copy);
    return wheelhouse.planWheelhouse(copy, { requirementsText, ...options }).errors.join("\n");
  };

  it("accepts the fixture", () => {
    expect(wheelhouse.planWheelhouse(lock, { requirementsText }).errors).toEqual([]);
  });

  it("rejects a bad digest, a foreign or plain-http host, a path in a name, a duplicate and no size", () => {
    expect(errorsOf((c) => (c.wheels[0]!.sha256 = "abc"))).toMatch(/sha256/);
    const foreign = (c: Lock) =>
      (c.wheels[0]!.url = c.wheels[0]!.url.replace("files.pythonhosted.org", "evil.example"));
    expect(errorsOf(foreign)).toMatch(/files\.pythonhosted\.org/);
    const plain = (c: Lock) => (c.wheels[0]!.url = c.wheels[0]!.url.replace("https:", "http:"));
    expect(errorsOf(plain)).toMatch(/files\.pythonhosted\.org/);
    const pathName = (c: Lock) => (c.wheels[0]!.filename = "../av-18.1.1-cp311-abi3-win_amd64.whl");
    expect(errorsOf(pathName)).toMatch(/file name/);
    expect(errorsOf((c) => c.wheels.push({ ...c.wheels[0]! }))).toMatch(/twice/);
    expect(errorsOf((c) => (c.wheels[0]!.bytes = 0))).toMatch(/size/);
  });

  it("rejects a binary wheel listed for the wrong Python, and two versions of one package for one Python", () => {
    expect(errorsOf((c) => c.wheels[2]!.tags.push("cp313"))).toMatch(/does not fit cp313/);
    const twoVersions = (c: Lock) =>
      c.wheels.push({
        ...c.wheels[1]!,
        version: "0.166.0",
        filename: "fastapi-0.166.0-py3-none-any.whl",
        url: `${HOST}fastapi-0.166.0-py3-none-any.whl`,
      });
    expect(errorsOf(twoVersions)).toMatch(/two versions/);
  });

  it("rejects a lock that no longer meets a floor, misses a package, or outgrows its budget", () => {
    const floor = wheelhouse.planWheelhouse(lock, { requirementsText: "fastapi>=0.200.0\n" });
    expect(floor.errors.join()).toMatch(/fastapi>=0.200.0.*cp312/);
    const missing = wheelhouse.planWheelhouse(lock, { requirementsText: "edge-tts>=7.3.1\n" });
    expect(missing.errors.join()).toMatch(/edge-tts/);
    expect(errorsOf(() => {}, { budgetBytes: 10 })).toMatch(/exceeds budget 10/);
    expect(wheelhouse.planWheelhouse({ schema: 1, wheels: [] }).errors.join()).toMatch(/no wheels/);
  });

  it("writes one exact pin per package for each Python, sorted", () => {
    expect(wheelhouse.constraintsFor(lock, "cp313")).toBe(
      "av==18.1.1\nfastapi==0.165.0\npyyaml==6.0.4\n",
    );
    expect(wheelhouse.constraintsFor(lock, "cp399")).toBe("");
  });

  it("writes a hashed requirements file per Python: every pin carries the SHA-256 of each wheel for that series", () => {
    const hashOf = (filename: string) => lock.wheels.find((w) => w.filename === filename)!.sha256;
    expect(wheelhouse.requirementsFor(lock, "cp313")).toBe(
      `av==18.1.1 --hash=sha256:${hashOf("av-18.1.1-cp311-abi3-win_amd64.whl")}\n` +
        `fastapi==0.165.0 --hash=sha256:${hashOf("fastapi-0.165.0-py3-none-any.whl")}\n` +
        `pyyaml==6.0.4 --hash=sha256:${hashOf("pyyaml-6.0.4-cp313-cp313-win_amd64.whl")}\n`,
    );
    // The other series never lists a wheel of this one, and an unknown series lists nothing.
    expect(wheelhouse.requirementsFor(lock, "cp312")).toContain(
      hashOf("pyyaml-6.0.4-cp312-cp312-win_amd64.whl"),
    );
    expect(wheelhouse.requirementsFor(lock, "cp312")).not.toContain(
      hashOf("pyyaml-6.0.4-cp313-cp313-win_amd64.whl"),
    );
    expect(wheelhouse.requirementsFor(lock, "cp399")).toBe("");
    // Every line is an exact pin with a hash: pip --require-hashes refuses anything else.
    for (const line of wheelhouse.requirementsFor(lock, "cp312").trim().split("\n")) {
      expect(line).toMatch(/^[a-z0-9-]+==[^\s]+( --hash=sha256:[0-9a-f]{64})+$/);
    }
  });

  it("lists every wheel of one package and version for the series, so pip may take any of them", () => {
    const twin = structuredClone(lock);
    const extra = wheel("pyyaml-6.0.4-cp312-abi3-win_amd64.whl", Buffer.from("yaml abi3"), [
      "cp312",
    ]);
    twin.wheels.push(extra);
    const line = wheelhouse
      .requirementsFor(twin, "cp312")
      .split("\n")
      .find((row) => row.startsWith("pyyaml=="))!;
    expect(line.match(/--hash=sha256:/g)?.length).toBe(2);
    expect(line).toContain(extra.sha256);
  });
});

describe("staging the wheelhouse at build", () => {
  it("checks every wheel, packs one stored zip with the pins, and reuses the cache next time", async () => {
    const { lock, fetchImpl, calls, requirementsText } = fixture();
    const dir = temp();
    const cacheDir = path.join(dir, "cache");
    const stageDir = path.join(dir, "resources");
    const opts = { lock, requirementsText, cacheDir, stageDir, fetchImpl };
    const first = await wheelhouse.stageWheelhouse(opts);
    expect(first.file).toBe(path.join(stageDir, "toolchain", "wheelhouse", "pack.bin"));
    expect(first.wheels).toBe(4);
    expect(first.tags).toEqual(["cp312", "cp313"]);
    expect(calls.length).toBe(4);
    expect(wheelhouse.readZipIndex(first.file).map((e) => e.name)).toEqual([
      "av-18.1.1-cp311-abi3-win_amd64.whl",
      "constraints-cp312.txt",
      "constraints-cp313.txt",
      "fastapi-0.165.0-py3-none-any.whl",
      "pyyaml-6.0.4-cp312-cp312-win_amd64.whl",
      "pyyaml-6.0.4-cp313-cp313-win_amd64.whl",
      "requirements-cp312.txt",
      "requirements-cp313.txt",
      "wheelhouse.json",
    ]);
    expect(wheelhouse.verifyWheelhouseZip(first.file, lock.wheels)).toEqual([]);
    const bytes = readFileSync(first.file);
    // The same lock gives the same bytes: no timestamps inside, so CMD and CI pack the same file.
    const second = await wheelhouse.stageWheelhouse(opts);
    expect(calls.length).toBe(4);
    expect(readFileSync(second.file).equals(bytes)).toBe(true);
    // Offline after a full fetch is fine.
    await expect(wheelhouse.stageWheelhouse({ ...opts, offline: true })).resolves.toMatchObject({
      wheels: 4,
    });
  });

  it("finds a wrong byte inside the packed zip", async () => {
    const { lock, fetchImpl, requirementsText } = fixture();
    const dir = temp();
    const staged = await wheelhouse.stageWheelhouse({
      lock,
      requirementsText,
      cacheDir: path.join(dir, "cache"),
      stageDir: path.join(dir, "resources"),
      fetchImpl,
    });
    const body = readFileSync(staged.file);
    const at = body.indexOf(Buffer.from("fastapi wheel body"));
    body[at] = body[at]! ^ 1;
    writeFileSync(staged.file, body);
    expect(wheelhouse.verifyWheelhouseZip(staged.file, lock.wheels).join()).toMatch(/fastapi/);
  });

  it("refuses a tampered download and a cold offline build, and leaves no pack behind", async () => {
    const { lock, fetchImpl, requirementsText } = fixture();
    const dir = temp();
    const stageDir = path.join(dir, "resources");
    const tampered = async (url: string) => {
      const res = await fetchImpl(url);
      return url.includes("fastapi") ? { body: Buffer.from("not the pinned bytes") } : res;
    };
    const base = { lock, requirementsText, stageDir };
    await expect(
      wheelhouse.stageWheelhouse({
        ...base,
        cacheDir: path.join(dir, "cache"),
        fetchImpl: tampered,
      }),
    ).rejects.toThrow(/fastapi.*SHA-256/);
    expect(existsSync(path.join(stageDir, "toolchain", "wheelhouse", "pack.bin"))).toBe(false);
    await expect(
      wheelhouse.stageWheelhouse({
        ...base,
        cacheDir: path.join(dir, "cold"),
        fetchImpl,
        offline: true,
      }),
    ).rejects.toThrow(/offline build: .* is not in the staging cache/);
  });

  it("refuses a lock that fails its plan before downloading anything", async () => {
    const { lock, fetchImpl, calls } = fixture();
    const dir = temp();
    await expect(
      wheelhouse.stageWheelhouse({
        lock,
        requirementsText: "fastapi>=0.200.0\n",
        cacheDir: path.join(dir, "cache"),
        stageDir: path.join(dir, "resources"),
        fetchImpl,
      }),
    ).rejects.toThrow(/wheelhouse lock: .*fastapi/);
    expect(calls.length).toBe(0);
  });

  it("refetches a cache file that rotted on disk", async () => {
    const { lock, fetchImpl, calls, requirementsText } = fixture();
    const dir = temp();
    const opts = {
      lock,
      requirementsText,
      cacheDir: path.join(dir, "cache"),
      stageDir: path.join(dir, "resources"),
      fetchImpl,
    };
    await wheelhouse.stageWheelhouse(opts);
    writeFileSync(path.join(dir, "cache", `${lock.wheels[0]!.sha256}.whl`), "rot");
    await wheelhouse.stageWheelhouse(opts);
    expect(calls.length).toBe(5);
  });

  it("packs a zip that Python's own zip reader opens and checks, where Python exists", async () => {
    const { lock, fetchImpl, requirementsText } = fixture();
    const dir = temp();
    const staged = await wheelhouse.stageWheelhouse({
      lock,
      requirementsText,
      cacheDir: path.join(dir, "cache"),
      stageDir: path.join(dir, "resources"),
      fetchImpl,
    });
    const python = ["python3", "python"].find((cmd) => hasCommand(cmd));
    if (!python) {
      console.warn(
        "[wheelhouse.test] no Python on this machine: the zip was checked by readZipIndex only",
      );
      expect(wheelhouse.readZipIndex(staged.file).length).toBe(9);
      return;
    }
    const code =
      "import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);print(z.testzip());" +
      "print(z.read('constraints-cp312.txt').decode(),end='');" +
      "print(z.read('requirements-cp312.txt').decode(),end='')";
    const run = spawnSync(python, ["-I", "-c", code, staged.file], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout.replace(/\r\n/g, "\n")).toBe(
      "None\nav==18.1.1\nfastapi==0.165.0\npyyaml==6.0.4\n" +
        wheelhouse.requirementsFor(lock, "cp312"),
    );
  });

  it("is part of the toolchain stage that the build, setup and doctor already run", async () => {
    const { lock, fetchImpl, requirementsText } = fixture();
    const dir = temp();
    const body = Buffer.from("python embeddable zip");
    const manifest = {
      budgetBytes: 100,
      packs: [
        {
          id: "python-embed",
          tier: "bundled",
          sha256: sha(body),
          bytes: body.length,
          license: "PSF-2.0",
          url: "https://www.python.org/x.zip",
        },
      ],
      wheelhouse: { lock: "config/wheelhouse.lock.json", budgetBytes: 1000 },
    };
    const base = {
      manifest,
      lock,
      requirementsText,
      cacheDir: path.join(dir, "cache"),
      wheelCacheDir: path.join(dir, "wheels"),
      stageDir: path.join(dir, "resources"),
      env: {},
    };
    const packed = path.join(dir, "resources", "toolchain", "wheelhouse", "pack.bin");
    const result = await stage.stageAll({
      ...base,
      fetchImpl: async (url: string) => (url.endsWith("x.zip") ? { body } : fetchImpl(url)),
    });
    expect(result.staged.length).toBe(1);
    expect(result.wheelhouse?.wheels).toBe(4);
    expect(existsSync(packed)).toBe(true);
    // FRIDAY_WHEELHOUSE=0 turns the wheelhouse off (the installer then installs from the network as before),
    // and a stale pack from an earlier build is removed so it never ships.
    const off = await stage.stageAll({ ...base, fetchImpl, env: { FRIDAY_WHEELHOUSE: "0" } });
    expect(off.wheelhouse).toBeNull();
    expect(existsSync(packed)).toBe(false);
    // The manifest budget, not the lock, bounds what ships.
    await expect(
      stage.stageAll({
        ...base,
        fetchImpl,
        manifest: { ...manifest, wheelhouse: { ...manifest.wheelhouse, budgetBytes: 5 } },
      }),
    ).rejects.toThrow(/exceeds budget 5/);
  });
});

describe("building the lock", () => {
  const report = (files: Array<[string, string, string, string]>) => ({
    install: files.map(([name, version, filename, digest]) => ({
      metadata: { name, version },
      download_info: { url: `${HOST}${filename}`, archive_info: { hashes: { sha256: digest } } },
    })),
  });
  const A = "a".repeat(64);
  const B = "b".repeat(64);
  const C = "c".repeat(64);

  it("merges each Python's resolution, takes sizes from PyPI and cross-checks the digest", () => {
    const reports = {
      cp312: report([
        ["fastapi", "0.165.0", "fastapi-0.165.0-py3-none-any.whl", A],
        ["PyYAML", "6.0.4", "pyyaml-6.0.4-cp312-cp312-win_amd64.whl", B],
      ]),
      cp313: report([
        ["fastapi", "0.165.0", "fastapi-0.165.0-py3-none-any.whl", A],
        ["PyYAML", "6.0.4", "pyyaml-6.0.4-cp313-cp313-win_amd64.whl", C],
      ]),
    };
    const pypi = {
      "fastapi==0.165.0": {
        urls: [{ filename: "fastapi-0.165.0-py3-none-any.whl", size: 10, digests: { sha256: A } }],
      },
      "pyyaml==6.0.4": {
        urls: [
          { filename: "pyyaml-6.0.4-cp312-cp312-win_amd64.whl", size: 20, digests: { sha256: B } },
          { filename: "pyyaml-6.0.4-cp313-cp313-win_amd64.whl", size: 21, digests: { sha256: C } },
        ],
      },
    };
    const lock = wheelhouse.buildLock({ reports, pypi, checked: "2000-01-01" });
    expect(lock.pythonTags).toEqual(["cp312", "cp313"]);
    expect(lock.wheels.map((w) => [w.filename, w.name, w.bytes, w.tags.join(",")])).toEqual([
      ["fastapi-0.165.0-py3-none-any.whl", "fastapi", 10, "cp312,cp313"],
      ["pyyaml-6.0.4-cp312-cp312-win_amd64.whl", "pyyaml", 20, "cp312"],
      ["pyyaml-6.0.4-cp313-cp313-win_amd64.whl", "pyyaml", 21, "cp313"],
    ]);
    const bad = JSON.parse(JSON.stringify(pypi));
    bad["fastapi==0.165.0"].urls[0].digests.sha256 = C;
    expect(() => wheelhouse.buildLock({ reports, pypi: bad, checked: "2000-01-01" })).toThrow(
      /fastapi.*digest/,
    );
  });
});

describe("the installed runtime repair installs from the wheelhouse first", () => {
  const repair = read("installer/build/repair-runtime.ps1");
  const between = (from: string, to: string) =>
    repair.slice(repair.indexOf(from), repair.indexOf(to, repair.indexOf(from)));

  it("reads the wheelhouse the EXE carries, unpacks it only when something must be installed, and cleans up", () => {
    expect(repair).toContain("resources\\toolchain\\wheelhouse\\pack.bin");
    expect(repair).toContain("[System.IO.Compression.ZipFile]::ExtractToDirectory(");
    expect(repair).toContain("function Get-Wheelhouse");
    expect(repair).toContain("function Install-FromWheelhouse");
    // Lazy: the healthy-runtime path that installs nothing never unpacks it.
    expect([...repair.matchAll(/Get-Wheelhouse/g)].length).toBe(2);
    expect(between("function Finish(", "function Test-Runtime")).toContain(
      "Remove-Item -LiteralPath $wheelhouseDir -Recurse -Force",
    );
  });

  it("tries no network first, then the network only for what is missing at the same pins", () => {
    const fn = between("function Install-FromWheelhouse", "function Install-VoiceCore");
    const offline = fn.indexOf("--no-index");
    expect(offline).toBeGreaterThan(-1);
    expect(fn).toContain("--find-links $house");
    expect(fn.indexOf("-c $constraints")).toBeGreaterThan(offline);
    expect(fn).toContain("constraints-$tag.txt");
    // It never ends Setup: no Finish and no exit inside; a failure falls through to the network methods.
    expect(fn).not.toContain("Finish ");
    expect(fn).not.toMatch(/\bexit\b/);
    // pip's own output goes to the log, so the function's answer is only $true or $false.
    expect(fn.match(/-m pip install[^\r\n]*\| Out-Host/g)?.length).toBe(2);
  });

  it("installs only hashed pins: the offline pass and the network fill both use --require-hashes on requirements-<tag>.txt", () => {
    const fn = between("function Install-FromWheelhouse", "function Install-VoiceCore");
    expect(fn).toContain('"requirements-$tag.txt"');
    const calls = [...fn.matchAll(/& \$venvPython -m pip install[^\r\n]*/g)].map((m) => m[0]);
    expect(calls.length).toBe(2);
    const [offline, fill] = calls as [string, string];
    expect(offline).toContain("--no-index");
    expect(offline).toContain("--find-links $house");
    expect(offline).toContain("--require-hashes");
    expect(offline).toContain("-r $hashed");
    expect(fill).not.toContain("--no-index");
    expect(fill).toContain("--only-binary=:all:");
    expect(fill).toContain("--require-hashes");
    expect(fill).toContain("-r $hashed");
    // The plain kernel requirements file is never what pip installs from the wheelhouse: it has no hashes.
    expect(calls.join("\n")).not.toContain("-r $Requirements");
    // A pack without the hashed file is not trusted: the function answers $false, never installs unhashed.
    expect(fn).toMatch(/Test-Path -LiteralPath \$hashed -PathType Leaf\)\) \{ return \$false \}/);
  });

  it("unpacks under a per-run random folder in the install's own temporary folder, never the shared TEMP", () => {
    const decl = repair.match(/^\$wheelhouseDir = [^\r\n]*/m)?.[0] ?? "";
    expect(decl).toContain("NewGuid()");
    expect(decl).toContain("$wheelhouseTemp");
    expect(repair).toMatch(/^\$wheelhouseTemp = Join-Path \$InstallDir 'temporary'/m);
    expect(decl).not.toContain("$env:TEMP");
    expect(decl).not.toContain("$PID");
    // Leftovers of a run that was killed are removed before a new one unpacks.
    const fn = between("function Get-Wheelhouse", "# Offline first");
    expect(fn).toContain("friday-wheelhouse-*");
    expect(fn.indexOf("friday-wheelhouse-*")).toBeLessThan(fn.indexOf("ExtractToDirectory"));
    expect(between("function Finish(", "function Test-Runtime")).toContain(
      "Remove-Item -LiteralPath $wheelhouseDir -Recurse -Force",
    );
  });

  it("runs before the four network methods on a fresh environment and for a missing voice core", () => {
    const voice = between("function Install-VoiceCore", "function Test-RuntimeTwice");
    const call = "Install-FromWheelhouse $requirements";
    expect(voice.indexOf(call)).toBeGreaterThan(-1);
    expect(voice.indexOf(call)).toBeLessThan(voice.indexOf("$voiceMethods = @("));
    const fresh = repair.slice(repair.indexOf("if (-not (Install-Pip))"));
    expect(fresh.indexOf(call)).toBeGreaterThan(-1);
    expect(fresh.indexOf(call)).toBeLessThan(fresh.indexOf("foreach ($method in $pipMethods)"));
    expect(fresh).toContain("Finish 'requirements-failed' 8");
    // The optional capabilities file stays online only.
    expect(between("function Install-CapabilityExtras", "function Test-VoiceCore")).not.toContain(
      "Wheelhouse",
    );
  });

  it("reports a failed pip bootstrap as such: Install-Pip answers only $true or $false", () => {
    const fn = between("function Install-Pip", "if (-not (Install-Pip))");
    expect(fn).toContain("& $venvPython -m ensurepip --upgrade | Out-Host");
    expect(fn).toContain("& $venvPython $file | Out-Host");
  });

  it("stays 7-bit ASCII with CRLF line ends", () => {
    const raw = readFileSync(path.join(ROOT, "installer/build/repair-runtime.ps1"));
    expect([...raw].filter((b) => b > 127)).toEqual([]);
    expect(raw.toString("latin1").replace(/\r\n/g, "").includes("\n")).toBe(false);
  });
});

describe("the CMD chain output stays the same", () => {
  it("keeps the stage-toolchain summary line and its FAIL line", () => {
    const src = read("scripts/stage-toolchain.cjs");
    expect(src).toContain("[friday] ok       ");
    expect(src).toContain("for the EXE are ready (");
    expect(src).toContain("[friday] FAIL     packs for the EXE: ");
  });
});

describe("a hash mismatch in the wheelhouse install ends that path and never falls through to unhashed pip", () => {
  const repair = read("installer/build/repair-runtime.ps1");
  const fnText = (name: string) =>
    repair.match(new RegExp(`^function ${name}\\b[\\s\\S]*?^}\\r?$`, "m"))?.[0] ?? "";

  it("scans pip's own log for the hash failure after each hashed pass, and says so in the pip command", () => {
    const fn = fnText("Install-FromWheelhouse");
    const calls = [...fn.matchAll(/& \$venvPython -m pip install[^\r\n]*/g)].map((m) => m[0]);
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call).toContain("--log $log");
    const scan = fnText("Test-PipHashMismatch");
    expect(scan).toContain("DO NOT MATCH THE HASHES");
    expect(scan).toContain("Select-String -LiteralPath $Log");
    expect(fn.match(/Test-PipHashMismatch \$log/g)).toHaveLength(2);
    expect(fn).toContain("$script:wheelhouseMismatch = $true");
    // The first thing the function does is clear the flag: an answer of an earlier call never leaks.
    expect(fn.indexOf("$script:wheelhouseMismatch = $false")).toBeLessThan(
      fn.indexOf("pip install"),
    );
  });

  it("stops the voice-core install and the fresh install at a mismatch, records it, and skips the network methods", () => {
    const voice = fnText("Install-VoiceCore");
    const stop = "if ($script:wheelhouseMismatch) { return }";
    expect(voice).toContain(stop);
    expect(voice.indexOf(stop)).toBeLessThan(voice.indexOf("$voiceMethods = @("));
    const tail = repair.slice(repair.indexOf("if (Test-RuntimeTwice)"));
    // Healthy runtime, voice core missing: the mismatch ends Setup's repair before the optional extras.
    const healthy = tail.slice(0, tail.indexOf("if (-not (Test-Path -LiteralPath $requirements"));
    expect(healthy.indexOf("Install-VoiceCore")).toBeLessThan(
      healthy.indexOf("if ($script:wheelhouseMismatch) { Finish 'wheelhouse-hash-mismatch' 11 }"),
    );
    expect(healthy.indexOf("wheelhouse-hash-mismatch")).toBeLessThan(
      healthy.indexOf("Install-CapabilityExtras"),
    );
    // Fresh environment: the check sits between the wheelhouse pass and the four network methods.
    const fresh = tail.slice(tail.indexOf("$installed = Install-FromWheelhouse $requirements"));
    expect(fresh.indexOf("Finish 'wheelhouse-hash-mismatch' 11")).toBeGreaterThan(-1);
    expect(fresh.indexOf("Finish 'wheelhouse-hash-mismatch' 11")).toBeLessThan(
      fresh.indexOf("foreach ($method in $pipMethods)"),
    );
    // NSIS records runtime-repair-<code> as PythonSetupPending for any non-zero code, so code 11 reaches Setup & Doctor.
    expect(read("installer/build/installer.nsh")).toContain('StrCpy $R5 "runtime-repair-$0"');
  });

  it("names exactly what the network pass can add, and what the old unhashed methods are still for", () => {
    expect(repair).toContain("NETWORK PASS");
    const note = repair.slice(
      repair.indexOf("NETWORK PASS"),
      repair.indexOf("function Install-FromWheelhouse"),
    );
    expect(note).toContain("requirements-<tag>.txt");
    expect(note).toContain("wheels only");
    expect(note).toContain("SHA-256");
    expect(note).toMatch(/unhashed[\s\S]*no usable pack/i);
  });

  it("removes only stale unpack folders and falls back to a random folder under the user's temp folder", () => {
    const fn = fnText("Get-Wheelhouse");
    // Old behaviour removed every friday-wheelhouse-* folder, which deletes another run's files: a filter now stands between.
    expect(fn).not.toMatch(/friday-wheelhouse-\*'[^\r\n]*\|\s*\r?\n\s*Remove-Item/);
    expect(fn).toMatch(/friday-wheelhouse-\*'[^\r\n]*\|\s*\r?\n\s*Where-Object/);
    expect(fn).toContain("AddHours(-1)");
    expect(fn).toContain("run.lock");
    expect(fn).toContain("[System.IO.Path]::GetTempPath()");
    expect(fn).toContain("-ErrorAction Stop");
    expect(fn).toContain("$script:wheelhouseDir = $dir");
  });

  it("states in wheelhouse.cjs what only hashed wheels can do, and what a mismatch does", () => {
    const head = read("scripts/wheelhouse.cjs").slice(0, 1800);
    expect(head).toContain("hash mismatch");
    expect(head).toContain("unhashed network methods");
    expect(head).not.toContain("so only a wheel with a pinned hash can be installed.");
  });
});

/** PowerShell 7 where this machine has it (PATH, FRIDAY_PWSH, or a FRIDAY_PWSH_PREFIX/<version>/pwsh install). */
function findPwsh(): string | null {
  if (process.env["FRIDAY_PWSH"] && existsSync(process.env["FRIDAY_PWSH"]))
    return process.env["FRIDAY_PWSH"];
  if (hasCommand("pwsh")) return "pwsh";
  const prefix = process.env["FRIDAY_PWSH_PREFIX"];
  if (prefix && existsSync(prefix)) {
    for (const version of readdirSync(prefix)) {
      const exe = path.join(prefix, version, "pwsh");
      if (existsSync(exe)) return exe;
    }
  }
  return null;
}
const pwsh = findPwsh();

describe.skipIf(pwsh === null)(
  "the repair functions, run for real in PowerShell with a fake pip",
  () => {
    const repair = read("installer/build/repair-runtime.ps1");
    const fnText = (name: string) =>
      repair.match(new RegExp(`^function ${name}\\b[\\s\\S]*?^}\\r?$`, "m"))?.[0] ?? "";
    const made: string[] = [];
    afterEach(() => {
      while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
    });

    /** One temp world: a fake python (a shell script), a pack, the requirements file and a call log. */
    function world(plan: string[]) {
      const dir = mkdtempSync(path.join(tmpdir(), "friday-repair-"));
      made.push(dir);
      const fake = path.join(dir, "fakepy");
      writeFileSync(
        fake,
        [
          "#!/bin/bash",
          'echo "$@" >> "$FAKE_CALLS"',
          'if [ "$1" = "-c" ]; then echo cp312; exit 0; fi',
          'if [ "$3" != "install" ]; then exit 0; fi',
          'log=""; for ((i=1;i<=$#;i++)); do if [ "${!i}" = "--log" ]; then j=$((i+1)); log="${!j}"; fi; done',
          'step=$(head -n1 "$FAKE_PLAN"); tail -n +2 "$FAKE_PLAN" > "$FAKE_PLAN.next"; mv "$FAKE_PLAN.next" "$FAKE_PLAN"',
          'case "$step" in',
          '  mismatch) [ -n "$log" ] && echo "ERROR: THESE PACKAGES DO NOT MATCH THE HASHES FROM THE REQUIREMENTS FILE." >> "$log"; exit 1;;',
          '  fail) [ -n "$log" ] && echo "ERROR: No matching distribution found" >> "$log"; exit 1;;',
          "  *) exit 0;;",
          "esac",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      writeFileSync(path.join(dir, "plan.txt"), plan.length ? `${plan.join("\n")}\n` : "");
      writeFileSync(path.join(dir, "requirements.txt"), "fastapi==1.0\n");
      return {
        dir,
        calls: path.join(dir, "calls.txt"),
        installs: () =>
          (existsSync(path.join(dir, "calls.txt"))
            ? readFileSync(path.join(dir, "calls.txt"), "utf8")
            : ""
          )
            .split("\n")
            .filter((l) => l.includes("-m pip install")),
      };
    }

    /** Runs a scenario with the shipped functions defined; returns what it printed. */
    function run(
      w: ReturnType<typeof world>,
      scenario: string,
      env: Record<string, string> = {},
    ): string {
      const script = [
        "$ErrorActionPreference = 'SilentlyContinue'",
        "$ProgressPreference = 'SilentlyContinue'",
        `$venvPython = '${path.join(w.dir, "fakepy")}'`,
        `$requirements = '${path.join(w.dir, "requirements.txt")}'`,
        `$wheelhousePack = '${path.join(w.dir, "pack.bin")}'`,
        `$wheelhouseTemp = '${path.join(w.dir, "temporary")}'`,
        "$wheelhouseDir = Join-Path $wheelhouseTemp ('friday-wheelhouse-' + [guid]::NewGuid().ToString('N'))",
        "$script:wheelhouse = $null",
        "$script:wheelhouseMismatch = $false",
        // A pack with a manifest and the two per-series files, built the way the build packs them (a zip of a folder).
        `$src = Join-Path '${w.dir}' 'src'; New-Item -ItemType Directory -Force -Path $src | Out-Null`,
        "Set-Content -LiteralPath (Join-Path $src 'wheelhouse.json') -Value '{}'",
        "Set-Content -LiteralPath (Join-Path $src 'constraints-cp312.txt') -Value 'fastapi==1.0'",
        "Set-Content -LiteralPath (Join-Path $src 'requirements-cp312.txt') -Value 'fastapi==1.0 --hash=sha256:aa'",
        "Add-Type -AssemblyName System.IO.Compression.FileSystem",
        "[System.IO.Compression.ZipFile]::CreateFromDirectory($src, $wheelhousePack)",
        "function Test-VoiceCore { return $false }",
        fnText("Test-PipHashMismatch"),
        fnText("Get-Wheelhouse"),
        fnText("Install-FromWheelhouse"),
        fnText("Install-VoiceCore"),
        scenario,
      ].join("\n");
      const file = path.join(w.dir, "h.ps1");
      writeFileSync(file, script);
      const out = spawnSync(pwsh!, ["-NoProfile", "-NonInteractive", "-File", file], {
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_CALLS: w.calls,
          FAKE_PLAN: path.join(w.dir, "plan.txt"),
          TMPDIR: path.join(w.dir, "tmp"),
          ...env,
        },
      });
      return `${out.stdout}${out.stderr}`;
    }

    it("a mismatch in the offline pass answers false with the flag set and runs no second pip", () => {
      const w = world(["mismatch"]);
      const out = run(
        w,
        '$r = Install-FromWheelhouse $requirements; Write-Output "RESULT=$r MISMATCH=$($script:wheelhouseMismatch)"',
      );
      expect(out).toContain("RESULT=False MISMATCH=True");
      expect(w.installs()).toHaveLength(1);
      expect(w.installs()[0]).toContain("--no-index");
    });

    it("a mismatch in the network pass sets the flag too", () => {
      const w = world(["fail", "mismatch"]);
      const out = run(
        w,
        '$r = Install-FromWheelhouse $requirements; Write-Output "RESULT=$r MISMATCH=$($script:wheelhouseMismatch)"',
      );
      expect(out).toContain("RESULT=False MISMATCH=True");
      expect(w.installs()).toHaveLength(2);
      expect(w.installs()[1]).not.toContain("--no-index");
    });

    it("a plain failure (a missing wheel, no network) leaves the flag clear, so the old fallback still applies", () => {
      const w = world(["fail", "fail"]);
      const out = run(
        w,
        '$r = Install-FromWheelhouse $requirements; Write-Output "RESULT=$r MISMATCH=$($script:wheelhouseMismatch)"',
      );
      expect(out).toContain("RESULT=False MISMATCH=False");
      const ok = world(["ok"]);
      expect(
        run(ok, '$r = Install-FromWheelhouse $requirements; Write-Output "RESULT=$r"'),
      ).toContain("RESULT=True");
    });

    it("the voice-core install runs only hashed pip after a mismatch, and the four network methods after a plain failure", () => {
      const bad = world(["mismatch"]);
      run(bad, "Install-VoiceCore");
      expect(bad.installs().length).toBeGreaterThan(0);
      for (const call of bad.installs()) expect(call).toContain("--require-hashes");

      const plain = world(["fail", "fail", "ok"]);
      run(plain, "Install-VoiceCore");
      const installs = plain.installs();
      expect(installs.slice(0, 2).every((c) => c.includes("--require-hashes"))).toBe(true);
      expect(installs.length).toBeGreaterThan(2);
      expect(installs[2]).not.toContain("--require-hashes");
    });

    it("removes only a stale unpack folder (no lock, or a lock over an hour old) and keeps a live run's folder", () => {
      const w = world([]);
      const parent = path.join(w.dir, "temporary");
      const make = (name: string, lock: "none" | "old" | "fresh") => {
        const dir = path.join(parent, name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "marker.txt"), name);
        if (lock !== "none") {
          const file = path.join(dir, "run.lock");
          writeFileSync(file, "1");
          if (lock === "old") utimesSync(file, new Date(2000, 0, 1), new Date(2000, 0, 1));
        }
      };
      make("friday-wheelhouse-live", "fresh");
      make("friday-wheelhouse-old", "old");
      make("friday-wheelhouse-nolock", "none");
      make("kept-other-folder", "none");
      const out = run(w, '$d = Get-Wheelhouse; Write-Output "DIR=$d"');
      const dir = /DIR=(.*)/.exec(out)?.[1]?.trim() ?? "";
      expect(dir.startsWith(parent)).toBe(true);
      expect(existsSync(path.join(dir, "wheelhouse.json"))).toBe(true);
      expect(existsSync(path.join(dir, "run.lock"))).toBe(true);
      expect(existsSync(path.join(parent, "friday-wheelhouse-live", "marker.txt"))).toBe(true);
      expect(existsSync(path.join(parent, "kept-other-folder", "marker.txt"))).toBe(true);
      expect(existsSync(path.join(parent, "friday-wheelhouse-old"))).toBe(false);
      expect(existsSync(path.join(parent, "friday-wheelhouse-nolock"))).toBe(false);
    });

    it("falls back to a random folder under the user's temp folder when the install's temporary folder cannot be made", () => {
      const w = world([]);
      // The parent is a plain file here, so a folder cannot be created under it (a per-machine install without rights).
      const blocked = path.join(w.dir, "blocked");
      writeFileSync(blocked, "not a folder");
      mkdirSync(path.join(w.dir, "tmp"), { recursive: true });
      const out = run(
        w,
        `$wheelhouseTemp = '${blocked}/inner'; $wheelhouseDir = Join-Path $wheelhouseTemp 'friday-wheelhouse-x'; ` +
          '$d = Get-Wheelhouse; Write-Output "DIR=$d"; Write-Output "KEPT=$wheelhouseDir"',
      );
      const dir = /DIR=(.*)/.exec(out)?.[1]?.trim() ?? "";
      expect(dir.startsWith(path.join(w.dir, "tmp"))).toBe(true);
      expect(path.basename(dir)).toMatch(/^friday-wheelhouse-[0-9a-f]{32}$/);
      expect(existsSync(path.join(dir, "wheelhouse.json"))).toBe(true);
      // The script-wide folder name now points at it, so Finish removes the folder that was really used.
      expect(/KEPT=(.*)/.exec(out)?.[1]?.trim()).toBe(dir);
    });
  },
);
