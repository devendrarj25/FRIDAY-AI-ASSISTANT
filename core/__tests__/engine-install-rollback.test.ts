/**
 * The ONNX Runtime variants install with a rollback that tells the truth: a failed switch (DirectML to GPU) removes the
 * wheel it just put in, puts the previous variant back from a hashed local copy (never an unhashed network install),
 * checks every pip exit code, and reports what really happened. A fake pip that keeps an installed set; no network.
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
const engines = require_(path.join(root, "electron/engine-install.cjs"));

const python = { exe: "python", prefix: [] as string[] };
const norm = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
/** The wheel file name pip would use: the pinned one when this version is pinned, else an invented CPython 3.12 name. */
const wheelFile = (name: string, version: string) => {
  const prefix = `${name.replace(/-/g, "_")}-${version}-`;
  const pinned = engines.PINNED_WHEELS[name]?.assets.find(
    (a: { name: string }) => a.name.startsWith(prefix) && /cp312|py3-none/.test(a.name),
  );
  return pinned ? (pinned.name as string) : `${prefix}cp312-cp312-win_amd64.whl`;
};

type Script = {
  failDownloadOf?: string; // a package whose `pip download` fails
  failMainInstall?: boolean; // the hashed install from the new wheel folder
  failDeps?: boolean; // the dependency step (network install of dist==version)
  failProbe?: boolean;
  failRestoreInstall?: boolean; // the hashed install from the previous-version folder
  failUninstallOf?: string; // `pip uninstall` naming this package
  corruptPrevious?: boolean; // the previous wheel's bytes change after it was hashed
};

/** A pip that keeps a set of installed distributions, so the final state can be asserted. */
function fakePip(initial: Array<[string, string]>, script: Script = {}) {
  const installed = new Map<string, string>(initial.map(([n, v]) => [norm(n), v]));
  const calls: string[][] = [];
  const networkInstalls: string[] = [];
  const unhashedInstalls: string[][] = [];
  const exec = async (_exe: string, args: string[]) => {
    calls.push(args);
    if (args.includes("-c")) {
      return script.failProbe
        ? { code: 1, output: "ImportError: DLL load failed" }
        : { code: 0, output: "" };
    }
    const verb = args[args.indexOf("pip") + 1] ?? args[2]!;
    const after = (flag: string) => args[args.indexOf(flag) + 1]!;
    if (verb === "download") {
      const dest = after("-d");
      const specs = args.includes("-r")
        ? readFileSync(after("-r"), "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => l.split(" ")[0]!)
        : args.filter((a) => /==/.test(a));
      for (const spec of specs) {
        const [name, version] = spec.split("==") as [string, string];
        if (script.failDownloadOf && norm(name) === norm(script.failDownloadOf)) {
          return { code: 1, output: `ERROR: no matching distribution for ${spec}\nsecond line` };
        }
        mkdirSync(dest, { recursive: true });
        const file = wheelFile(name, version);
        writeFileSync(
          path.join(dest, file),
          args.includes("-r") ? `plan:${spec}` : `bytes:${spec}`,
        );
      }
      return { code: 0, output: "downloaded" };
    }
    if (verb === "uninstall") {
      const names = args.slice(args.indexOf("-y") + 1).map(norm);
      if (script.failUninstallOf && names.includes(norm(script.failUninstallOf))) {
        return { code: 1, output: "ERROR: access is denied\nsecond line" };
      }
      for (const n of names) installed.delete(n); // a missing package is a warning, exit 0
      return { code: 0, output: "uninstalled" };
    }
    if (verb === "install") {
      if (args.includes("--no-index")) {
        if (!args.includes("--require-hashes")) {
          unhashedInstalls.push(args);
          return { code: 1, output: "refused: no hashes" };
        }
        const folder = after("--find-links");
        const fromPrevious = path.basename(folder) === "previous";
        if (fromPrevious && script.failRestoreInstall) return { code: 1, output: "boom\nrestore" };
        if (!fromPrevious && script.failMainInstall) return { code: 1, output: "boom\nmain" };
        const lines = readFileSync(after("-r"), "utf8").split("\n").filter(Boolean);
        for (const line of lines) {
          const [spec, hash] = line.split(" --hash=sha256:") as [string, string];
          const [name, version] = spec.split("==") as [string, string];
          const file = wheelFile(name, version);
          let bytes: string;
          try {
            bytes = readFileSync(path.join(folder, file), "utf8");
          } catch {
            return { code: 1, output: `ERROR: no file ${file} in ${folder}` };
          }
          if (!bytes.startsWith("plan:") && sha(bytes) !== hash) {
            return { code: 1, output: `ERROR: hash mismatch for ${file}` };
          }
          installed.set(norm(name), version);
        }
        return { code: 0, output: "installed" };
      }
      // a network install (the dependency step): the only place the network is allowed
      const spec = args.find((a) => /==/.test(a))!;
      networkInstalls.push(spec);
      if (script.failDeps) return { code: 1, output: "ERROR: no matching numpy\nsecond line" };
      const [name, version] = spec.split("==") as [string, string];
      installed.set(norm(name), version);
      return { code: 0, output: "installed" };
    }
    return { code: 0, output: "" };
  };
  return {
    exec,
    calls,
    installed,
    networkInstalls,
    unhashedInstalls,
    freeze: async () => new Map(installed),
    variants: () =>
      [...installed.keys()].filter((n) => /^onnxruntime(-|$)/.test(n)).sort() as string[],
  };
}

const ort = (dist: string) => ({
  ok: true,
  version: engines.PINNED_WHEELS[dist].version,
  assets: engines.PINNED_WHEELS[dist].assets,
});

describe("ONNX Runtime install rollback", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "friday-ort-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const planFor = (bundleId: string, dist: string) =>
    engines.planWheels(engines.PIP_BUNDLES[bundleId], { [dist]: ort(dist) }, { pyTag: "cp312" });
  const install = (
    fake: ReturnType<typeof fakePip>,
    bundleId = "ort-gpu",
    dist = "onnxruntime-gpu",
    extra: Record<string, unknown> = {},
  ) =>
    engines.installPinnedWheels(
      dir,
      engines.PIP_BUNDLES[bundleId],
      planFor(bundleId, dist),
      python,
      { exec: fake.exec, freeze: fake.freeze, ...extra },
    );

  it("DirectML to GPU with a failing dependency step ends with exactly the DirectML variant, and says so", async () => {
    const fake = fakePip([["onnxruntime-directml", "1.23.2"]], { failDeps: true });
    const out = await install(fake);
    expect(out).toMatchObject({ ok: false, rolledBack: true });
    expect(out.error).toMatch(/dependencies could not be installed/);
    expect(out.error).toMatch(/previous version was put back/);
    expect(fake.variants()).toEqual(["onnxruntime-directml"]);
    expect(fake.installed.get("onnxruntime-directml")).toBe("1.23.2");
  });

  it("the previous variant comes back from a hashed local copy, never from an unhashed network install", async () => {
    const fake = fakePip([["onnxruntime-directml", "1.23.2"]], { failProbe: true });
    const out = await install(fake);
    expect(out).toMatchObject({ ok: false, rolledBack: true });
    expect(fake.variants()).toEqual(["onnxruntime-directml"]);
    // the only network installs are the new variant's dependency step, never the previous name
    expect(fake.networkInstalls.every((s) => s.startsWith("onnxruntime-gpu=="))).toBe(true);
    expect(fake.unhashedInstalls).toEqual([]);
    const restore = fake.calls.filter(
      (a) => a.includes("install") && a.some((x) => x.endsWith(`${path.sep}previous`)),
    );
    expect(restore).toHaveLength(1);
    expect(restore[0]).toEqual(
      expect.arrayContaining(["--no-index", "--require-hashes", "--no-deps"]),
    );
    const reqFile = restore[0]![restore[0]!.indexOf("-r") + 1]!;
    expect(readFileSync(reqFile, "utf8")).toMatch(
      /^onnxruntime-directml==1\.23\.2 --hash=sha256:[0-9a-f]{64}\n$/,
    );
  });

  it("the wheel just installed is uninstalled before the previous one is restored", async () => {
    const fake = fakePip([["onnxruntime", "1.30.0"]], { failProbe: true });
    await install(fake);
    const verbs = fake.calls.map((a) =>
      a.includes("-c") ? "probe" : (a[a.indexOf("-m") + 2] ?? "probe"),
    );
    // download new, keep previous, remove conflict, install, deps, probe, remove new, restore
    expect(verbs).toEqual([
      "download",
      "download",
      "uninstall",
      "install",
      "install",
      "probe",
      "uninstall",
      "install",
    ]);
    const second = fake.calls.filter((a) => a.includes("uninstall")).at(-1)!;
    expect(second).toContain("onnxruntime-gpu");
    expect(second).not.toContain("onnxruntime");
    expect(fake.variants()).toEqual(["onnxruntime"]);
  });

  it("a restore that fails is reported plainly: no 'put back', rolledBack false, the reason named", async () => {
    const fake = fakePip([["onnxruntime-directml", "1.23.2"]], {
      failProbe: true,
      failRestoreInstall: true,
    });
    const out = await install(fake);
    expect(out.ok).toBe(false);
    expect(out.rolledBack).toBe(false);
    expect(out.error).not.toMatch(/was put back/);
    expect(out.error).toMatch(/could NOT be put back/);
    expect(out.error).toMatch(/boom/);
    // the bad new variant is gone even though the old one could not return
    expect(fake.variants()).toEqual([]);
  });

  it("a failed uninstall of the new wheel is reported, and is not claimed as a clean rollback", async () => {
    const fake = fakePip([["onnxruntime-directml", "1.23.2"]], {
      failProbe: true,
      failUninstallOf: "onnxruntime-gpu",
    });
    const out = await install(fake);
    expect(out.ok).toBe(false);
    expect(out.rolledBack).toBe(false);
    expect(out.error).not.toMatch(/was put back/);
    expect(out.error).toMatch(/access is denied/);
    expect(fake.variants()).toContain("onnxruntime-gpu"); // the fake shows the truth the message reports
  });

  it("a bad hashed main install rolls back the same way, and the conflict set stays one variant", async () => {
    const fake = fakePip(
      [
        ["onnxruntime", "1.30.0"],
        ["numpy", "2.0.0"],
      ],
      { failMainInstall: true },
    );
    const out = await install(fake, "ort-directml", "onnxruntime-directml");
    expect(out).toMatchObject({ ok: false, rolledBack: true });
    expect(fake.variants()).toEqual(["onnxruntime"]);
    expect(fake.installed.get("numpy")).toBe("2.0.0"); // unrelated packages are never touched
  });

  it("a backup of the previous variant that cannot be made refuses the switch before anything is removed", async () => {
    const fake = fakePip([["onnxruntime-directml", "1.23.2"]], {
      failDownloadOf: "onnxruntime-directml",
    });
    const out = await install(fake);
    expect(out).toMatchObject({ ok: false, rolledBack: false });
    expect(out.error).toMatch(/untouched/);
    expect(fake.variants()).toEqual(["onnxruntime-directml"]);
    expect(fake.calls.some((a) => a.includes("uninstall"))).toBe(false);
  });

  it("a previous wheel whose bytes contradict the pinned digest is refused before anything is removed", async () => {
    const fake = fakePip([["onnxruntime-directml", "1.24.4"]]);
    // the pinned DirectML wheel is the one the previous install claims to be: serve other bytes under its name
    const real = fake.exec;
    const lying = async (exe: string, args: string[]) => {
      const out = await real(exe, args);
      if (args.includes("download") && !args.includes("-r")) {
        const dest = args[args.indexOf("-d") + 1]!;
        const pinned = engines.PINNED_WHEELS["onnxruntime-directml"].assets.find(
          (a: { name: string }) => a.name.includes("cp312"),
        );
        for (const f of readdirSync(dest)) rmSync(path.join(dest, f));
        writeFileSync(path.join(dest, pinned.name), "tampered");
      }
      return out;
    };
    const out = await engines.installPinnedWheels(
      dir,
      engines.PIP_BUNDLES["ort-gpu"],
      planFor("ort-gpu", "onnxruntime-gpu"),
      python,
      { exec: lying, freeze: fake.freeze },
    );
    expect(out).toMatchObject({ ok: false, rolledBack: false });
    expect(out.error).toMatch(/untouched/);
    expect(fake.variants()).toEqual(["onnxruntime-directml"]);
  });

  it("with nothing installed before, a failed import removes the new wheel and does not claim a rollback", async () => {
    const fake = fakePip([], { failProbe: true });
    const out = await install(fake, "ort-cpu", "onnxruntime");
    expect(out).toMatchObject({ ok: false, rolledBack: false });
    expect(out.error).toMatch(/failed/);
    expect(out.error).not.toMatch(/was put back/);
    expect(fake.variants()).toEqual([]);
  });

  it("a restore that exits 0 but leaves the wrong set is not reported as put back", async () => {
    const fake = fakePip([["onnxruntime-directml", "1.23.2"]], { failProbe: true });
    // the restore claims success but the machine still holds the new variant
    const exec = async (exe: string, args: string[]) => {
      const out = await fake.exec(exe, args);
      if (args.includes("uninstall") && args.includes("onnxruntime-gpu"))
        fake.installed.set("onnxruntime-gpu", "1.32.0");
      return out;
    };
    const out = await engines.installPinnedWheels(
      dir,
      engines.PIP_BUNDLES["ort-gpu"],
      planFor("ort-gpu", "onnxruntime-gpu"),
      python,
      { exec, freeze: fake.freeze },
    );
    expect(out.rolledBack).toBe(false);
    expect(out.error).not.toMatch(/was put back/);
    expect(out.error).toMatch(/onnxruntime-gpu/);
  });

  it("a repair of the same pinned version restores from the verified wheel folder, with no second download", async () => {
    const pair = engines.PIP_BUNDLES["cuda-libs"];
    const resolved = {
      "nvidia-cublas-cu12": ort("nvidia-cublas-cu12"),
      "nvidia-cudnn-cu12": ort("nvidia-cudnn-cu12"),
    };
    const fake = fakePip(
      [
        ["nvidia-cublas-cu12", "12.9.2.10"],
        ["nvidia-cudnn-cu12", "9.28.1.4"],
      ],
      { failProbe: true },
    );
    const out = await engines.installPinnedWheels(
      dir,
      pair,
      engines.planWheels(pair, resolved),
      python,
      { exec: fake.exec, freeze: fake.freeze, force: true },
    );
    expect(out).toMatchObject({ ok: false, rolledBack: true });
    expect(fake.calls.filter((a) => a.includes("download"))).toHaveLength(1);
    expect(fake.installed.get("nvidia-cublas-cu12")).toBe("12.9.2.10");
    expect(fake.installed.get("nvidia-cudnn-cu12")).toBe("9.28.1.4");
    expect(fake.networkInstalls).toEqual([]);
  });

  it("a successful switch still removes only the conflicting variants and keeps the one new variant", async () => {
    const fake = fakePip([["onnxruntime-directml", "1.23.2"]]);
    const out = await install(fake);
    expect(out).toMatchObject({ ok: true, removed: ["onnxruntime-directml"] });
    expect(fake.variants()).toEqual(["onnxruntime-gpu"]);
  });

  it("both GPU sets are verified by the real-session health check, and a CPU fallback restores the CPU build", async () => {
    for (const [bundleId, key, version] of [
      ["ort-gpu", "onnxruntime-gpu", engines.PINNED_WHEELS["onnxruntime-gpu"].version],
      ["ort-gpu-cu12", "onnxruntime-gpu-cu12", "1.26.0"],
    ] as const) {
      const bundle = engines.PIP_BUNDLES[bundleId];
      const resolved = { [key]: ort(key) };
      const plan = engines.planWheels(bundle, resolved, { pyTag: "cp312" });
      const run = async (script: Script) => {
        const fake = fakePip([["onnxruntime", "1.30.0"]], script);
        const out = await engines.installPinnedWheels(dir, bundle, plan, python, {
          exec: fake.exec,
          freeze: fake.freeze,
        });
        return { fake, out };
      };
      const bad = await run({ failProbe: true }); // exit 3: ONNX Runtime listed the CPU first
      expect(bad.out, bundleId).toMatchObject({ ok: false, rolledBack: true });
      expect(bad.out.error).toMatch(/failed/);
      expect(bad.fake.variants()).toEqual(["onnxruntime"]);
      expect(bad.fake.installed.get("onnxruntime")).toBe("1.30.0");

      const good = await run({});
      expect(good.out, bundleId).toMatchObject({ ok: true, removed: ["onnxruntime"] });
      expect(good.fake.variants()).toEqual(["onnxruntime-gpu"]);
      expect(good.fake.installed.get("onnxruntime-gpu")).toBe(version);
      const probes = good.fake.calls.filter((a) => a.includes("-c"));
      expect(probes).toHaveLength(1);
      expect(probes[0]![probes[0]!.indexOf("-c") + 1]).toBe(engines.GPU_HEALTH_PROBE);
    }
  });
});

describe("a wheel pip cannot fetch comes from a PyPI mirror, checked against its SHA-256 and size", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "friday-ort-mirror-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const HOST = "https://files.pythonhosted.org/packages/ab/cd/ef0123/";
  const body = "mirror-wheel-bytes";
  /** The one-wheel plan of ort-gpu with fake bytes behind its digest and a pythonhosted address. */
  const planWith = (bytes = body) => {
    const bundle = engines.PIP_BUNDLES["ort-gpu"];
    const plan = engines.planWheels(
      bundle,
      { "onnxruntime-gpu": ort("onnxruntime-gpu") },
      { pyTag: "cp312" },
    );
    const w = plan.wheels[0];
    const real = engines.PINNED_WHEELS["onnxruntime-gpu"].assets.find(
      (a: { name: string }) => a.name === w.name,
    );
    w.sha256 = sha(bytes);
    w.bytes = bytes.length;
    w.url = `${HOST}${w.name}`;
    plan.lines = [`onnxruntime-gpu==${w.version} --hash=sha256:${w.sha256}`];
    expect(real).toBeTruthy();
    return { bundle, plan };
  };
  const mirrorHosts = engines
    .pypiMirrors()
    .map((m: { packages: string }) => new URL(m.packages).host);

  it("tries files.pythonhosted.org first, then each mirror in order, and installs the first file that verifies", async () => {
    const { bundle, plan } = planWith();
    const fake = fakePip([["onnxruntime", "1.30.0"]], { failDownloadOf: "onnxruntime-gpu" });
    const asked: string[] = [];
    const download = async (url: string, dest: string) => {
      asked.push(url);
      if (asked.length === 1) throw new Error("connection reset");
      if (asked.length === 2) {
        writeFileSync(dest, "wrong bytes"); // a mirror that serves other bytes
        return;
      }
      writeFileSync(dest, body);
    };
    const out = await engines.installPinnedWheels(dir, bundle, plan, python, {
      exec: fake.exec,
      freeze: fake.freeze,
      download,
    });
    expect(out).toMatchObject({ ok: true });
    expect(asked[0]).toBe(plan.wheels[0].url);
    const rest = asked.slice(1).map((u) => new URL(u).host);
    expect(rest).toEqual(mirrorHosts.slice(0, 2));
    for (const url of asked.slice(1)) expect(url.endsWith(`/${plan.wheels[0].name}`)).toBe(true);
    expect(fake.installed.get("onnxruntime-gpu")).toBe(plan.wheels[0].version);
    expect(fake.unhashedInstalls).toEqual([]);
  });

  it("refuses a file of the wrong size or digest from every road and leaves the installed copy untouched", async () => {
    const { bundle, plan } = planWith();
    const fake = fakePip([["onnxruntime", "1.30.0"]], { failDownloadOf: "onnxruntime-gpu" });
    const asked: string[] = [];
    const download = async (url: string, dest: string) => {
      asked.push(url);
      writeFileSync(dest, asked.length % 2 ? "x" : "y".repeat(body.length)); // short, then right size wrong digest
    };
    const out = await engines.installPinnedWheels(dir, bundle, plan, python, {
      exec: fake.exec,
      freeze: fake.freeze,
      download,
    });
    expect(out).toMatchObject({ ok: false, rolledBack: false });
    expect(out.error).toMatch(/pip refused the download/);
    expect(out.error).toMatch(/untouched/);
    expect(asked).toHaveLength(1 + mirrorHosts.length);
    expect(fake.variants()).toEqual(["onnxruntime"]);
    expect(fake.calls.some((a) => a.includes("uninstall"))).toBe(false);
    expect(existsSync(path.join(dir, "runtime", "installers", "pip-pins"))).toBe(true);
  });

  it("a wheel with no pythonhosted address, or a pip download that worked, never asks a mirror", async () => {
    const { bundle, plan } = planWith();
    let asked = 0;
    const download = async () => {
      asked++;
    };
    const ok = fakePip([["onnxruntime", "1.30.0"]]);
    const first = await engines.installPinnedWheels(dir, bundle, plan, python, {
      exec: ok.exec,
      freeze: ok.freeze,
      download,
    });
    expect(first.ok).toBe(true);
    const bare = planWith().plan;
    delete bare.wheels[0].url;
    const bad = fakePip([["onnxruntime", "1.30.0"]], { failDownloadOf: "onnxruntime-gpu" });
    const second = await engines.installPinnedWheels(dir, bundle, bare, python, {
      exec: bad.exec,
      freeze: bad.freeze,
      download,
    });
    expect(second.ok).toBe(false);
    expect(asked).toBe(0);
  });

  it("builds the same mirror addresses as the wheelhouse stager, on the content-addressed path only", () => {
    const wheelhouse = require_(path.join(root, "scripts/wheelhouse.cjs"));
    const url = `${HOST}some_pkg-1.0-py3-none-win_amd64.whl`;
    expect(engines.mirrorUrls(url)).toEqual(wheelhouse.mirrorUrls(url));
    expect(engines.mirrorUrls(url)).toHaveLength(5);
    expect(engines.mirrorUrls("https://example.com/packages/a/b.whl")).toEqual([]);
    expect(engines.mirrorUrls("https://files.pythonhosted.org/nopath.whl")).toEqual([]);
  });

  it("the planned wheels carry the address of the file, for the mirror road", () => {
    const bundle = engines.PIP_BUNDLES["ort-gpu"];
    const answer = ort("onnxruntime-gpu");
    const assets = answer.assets.map((a: { name: string }) => ({ ...a, url: `${HOST}${a.name}` }));
    const plan = engines.planWheels(
      bundle,
      { "onnxruntime-gpu": { ...answer, assets } },
      { pyTag: "cp312" },
    );
    expect(plan.wheels[0].url).toBe(`${HOST}${plan.wheels[0].name}`);
  });
});
