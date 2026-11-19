/**
 * What rides inside app.asar is exactly what the main process requires at run time. The renderer is bundled by Vite
 * into dist-desktop, so its packages (and the build tools) are devDependencies; before this, 72 of them were
 * production dependencies and app.asar grew to 187 MB with vite, babel, tailwind's native binaries and prettier in it.
 * The release engine is loaded through one loader because the archive may not hold its own copy.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");
const pkg = JSON.parse(read("package.json")) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

function files(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) files(full, out);
    else if (entry.endsWith(".cjs")) out.push(full);
  }
  return out;
}

function bareRequires(): Set<string> {
  const builtin = new Set(require_("node:module").builtinModules as string[]);
  const found = new Set<string>();
  for (const file of files(path.join(root, "electron"))) {
    for (const match of readFileSync(file, "utf8").matchAll(
      /require\(\s*["']([^"'./][^"']*)["']\s*\)/g,
    )) {
      const id = match[1]!;
      if (id.startsWith("node:")) continue;
      const name = id.startsWith("@") ? id.split("/").slice(0, 2).join("/") : id.split("/")[0]!;
      if (name === "electron" || builtin.has(name)) continue;
      found.add(name);
    }
  }
  return found;
}

describe("production dependencies are the main process's own", () => {
  it("lists exactly the packages electron/ requires, and nothing the renderer or the build uses", () => {
    expect(Object.keys(pkg.dependencies).sort()).toEqual([...bareRequires()].sort());
    for (const name of [
      "react",
      "vite",
      "tailwindcss",
      "@tanstack/react-start",
      "lucide-react",
      "prettier",
    ]) {
      expect(pkg.dependencies[name], name).toBeUndefined();
      expect(pkg.devDependencies[name], name).toBeTruthy();
    }
  });

  it("keeps the main-process dependency guard green", () => {
    const run = spawnSync(process.execPath, [path.join(root, "scripts/verify-deps.cjs")], {
      encoding: "utf8",
    });
    expect(run.status, run.stdout + run.stderr).toBe(0);
  });

  it("keeps the lockfile's root manifest in step", () => {
    const lock = JSON.parse(read("package-lock.json")) as {
      packages: Record<
        string,
        { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
      >;
    };
    expect(lock.packages[""]!.dependencies).toEqual(pkg.dependencies);
    expect(lock.packages[""]!.devDependencies).toEqual(pkg.devDependencies);
  });

  it("audits the whole tree, because the shipped renderer packages are now development dependencies", () => {
    const audit = read("scripts/advisory-audit.cjs");
    expect(audit).toContain('["audit", "--json"]');
    expect(audit).not.toContain('"--omit=dev"]');
  });

  it("makes the build refuse an archive that carries more packages than that", () => {
    const verify = read("scripts/verify-build.cjs");
    expect(verify).toContain("BLOATED");
    expect(verify).toContain("devDependencies");
  });
});

describe("the release engine loader", () => {
  const loader = require_("../../electron/release-engine-loader.cjs") as {
    load: (o: {
      inArchive: string;
      beside: () => string | null;
      load?: (id: string) => unknown;
    }) => unknown;
    releaseEngine: () => { compareBuilds: unknown };
  };

  it("uses the archive's copy when there is one", () => {
    const seen: string[] = [];
    const got = loader.load({
      inArchive: "/app.asar/scripts/release-engine.cjs",
      beside: () => "/resources/scripts/release-engine.cjs",
      load: (id) => {
        seen.push(id);
        return { from: id };
      },
    });
    expect(got).toEqual({ from: "/app.asar/scripts/release-engine.cjs" });
    expect(seen).toHaveLength(1);
  });

  it("falls back to resources/scripts when the archive has none, and rethrows when neither does", () => {
    const requireFn = (id: string) => {
      if (id.startsWith("/app.asar")) throw new Error("Cannot find module");
      return { from: id };
    };
    expect(
      loader.load({
        inArchive: "/app.asar/x.cjs",
        beside: () => "/resources/scripts/release-engine.cjs",
        load: requireFn,
      }),
    ).toEqual({ from: "/resources/scripts/release-engine.cjs" });
    expect(() =>
      loader.load({ inArchive: "/app.asar/x.cjs", beside: () => null, load: requireFn }),
    ).toThrow(/Cannot find module/);
  });

  it("loads the real engine in the checkout, and the five modules that need it go through the loader", () => {
    expect(typeof loader.releaseEngine().compareBuilds).toBe("function");
    for (const name of [
      "friday-version",
      "github-release",
      "github-sync",
      "update-safety",
      "updater",
    ]) {
      const source = read(`electron/${name}.cjs`);
      expect(source, name).toContain('require("./release-engine-loader.cjs").releaseEngine()');
      expect(source, name).not.toMatch(
        /require\(path\.resolve\(__dirname, "\.\.", "scripts", "release-engine\.cjs"\)\)/,
      );
    }
  });
});

describe("Electron fuses", () => {
  const yaml = require_("js-yaml") as {
    load: (text: string) => { electronFuses?: Record<string, boolean> };
  };
  const fuses = yaml.load(read("electron-builder.yml")).electronFuses ?? {};

  it("turns off the file:// extras and the inspect arguments, and never turns off RunAsNode", () => {
    expect(fuses["grantFileProtocolExtraPrivileges"]).toBe(false);
    expect(fuses["enableNodeCliInspectArguments"]).toBe(false);
    // FRIDAY starts its own executable as Node (MCP launcher, tool sandbox, in-app builder).
    const users = ["mcp-launch", "mcp-paths", "sandbox", "builder-run"].map((n) =>
      read(`electron/${n}.cjs`),
    );
    for (const source of users) expect(source).toContain("ELECTRON_RUN_AS_NODE");
    expect(fuses["runAsNode"]).not.toBe(false);
  });

  it("serves the renderer from friday://, not file://, which is what makes the file:// fuse safe", () => {
    const renderer = read("electron/renderer.cjs");
    expect(renderer).toContain("friday");
    const code = renderer
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join("\n");
    expect(code).not.toMatch(/\.loadFile\(/);
  });

  it("is checked on the built executable", () => {
    const verify = read("scripts/verify-build.cjs");
    expect(verify).toContain("RunAsNode");
    expect(verify).toContain("EnableNodeCliInspectArguments");
    expect(verify).toContain("GrantFileProtocolExtraPrivileges");
  });
});
