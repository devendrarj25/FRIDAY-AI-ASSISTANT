/**
 * Lightweight documentation honesty.
 *
 * Catches the cheap, reliable stale-doc failures:
 *   - FRIDAY_FEATURES.md names a test / source file / IPC channel that is gone
 *   - a sidebar route (or any src/routes page) is never mentioned in the catalog
 *   - a live CLOUD / LOCAL_ENGINES provider is missing from the owning provider doc
 *
 * Not a full English audit. Version numbers stay owned by version-sync.test.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { ALL_NAV_ITEMS, SETTINGS_NAV } from "../../src/lib/friday/navigation";

const require_ = createRequire(import.meta.url);
const engine = require_("../../scripts/release-engine.cjs") as {
  VERSION_DOCS: string[];
  GOVERNED_DOCS: string[];
};
const models = require_("../../electron/models.cjs") as {
  CLOUD: Record<string, { name?: string }>;
  LOCAL_ENGINES: Record<string, { name?: string }>;
};

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const FEATURES = "docs/FRIDAY_FEATURES.md";
const PROVIDERS = "docs/FRIDAY_PROVIDERS_AND_SECRETS.md";

const FILE_ROOTS = [
  "src/",
  "electron/",
  "kernel/",
  "core/",
  "scripts/",
  "config/",
  "builder/",
  "updater/",
  "installer/",
  ".github/",
  "docs/",
];
const FILE_EXT = /\.(?:ts|tsx|cjs|js|mjs|py|json|yml|yaml|md|cmd|ps1)$/;
const layout = JSON.parse(read("config/project-structure.json")) as {
  forbidden?: { paths?: string[] };
};
const FORBIDDEN = new Set(layout.forbidden?.paths ?? []);
const REPO_CONFIG = new Set(
  fs.readdirSync(path.join(ROOT, "config")).map((name) => `config/${name}`),
);
const NEGATION =
  /\b(legacy|forbidden|resurrected|must never|never come back|removed|deleted|does not exist|no longer|was removed|not part of)\b/i;

function backtickChunks(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map((m) => (m[1] ?? "").trim()).filter(Boolean);
}

function fileRefs(text: string): Array<{ ref: string; line: string }> {
  const out: Array<{ ref: string; line: string }> = [];
  for (const line of text.split("\n")) {
    if (line.trim().startsWith("```")) continue;
    if (NEGATION.test(line)) continue;
    for (const raw of backtickChunks(line)) {
      const token = raw.split(/\s+/)[0] ?? "";
      const leaf = token.split("/").pop() ?? "";
      if (!token || token.includes("*") || token.includes("?") || token.includes("{")) continue;
      if (!FILE_EXT.test(leaf)) continue;
      if (!FILE_ROOTS.some((root) => token.startsWith(root))) continue;
      if (FORBIDDEN.has(token)) continue;
      // Runtime data under <FRIDAY_ROOT>/config is not in the git tree.
      if (token.startsWith("config/") && !REPO_CONFIG.has(token)) continue;
      out.push({ ref: token, line: line.trim() });
    }
  }
  return out;
}

function routeFileFor(to: string): string {
  if (to === "/") return "src/routes/index.tsx";
  return `src/routes/${to.replace(/^\//, "")}.tsx`;
}

describe("FRIDAY_FEATURES honesty", () => {
  const features = read(FEATURES);

  it("every Verified-by test file exists", () => {
    const named = [...features.matchAll(/core\/__tests__\/[A-Za-z0-9._-]+\.test\.ts/g)].map(
      (m) => m[0],
    );
    expect(named.length).toBeGreaterThan(20);
    const missing = [...new Set(named)].filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
    expect(missing, missing.join(", ")).toEqual([]);
  });

  it("names every sidebar route's page file", () => {
    const items = [...ALL_NAV_ITEMS, SETTINGS_NAV];
    const missing = items
      .map((item) => ({ label: item.label, file: routeFileFor(item.to) }))
      .filter((row) => !features.includes(row.file));
    expect(missing, missing.map((row) => `${row.label} (${row.file})`).join(", ")).toEqual([]);
  });

  it("names every src/routes page except the router root", () => {
    const files = fs
      .readdirSync(path.join(ROOT, "src/routes"))
      .filter((name) => name.endsWith(".tsx") && name !== "__root.tsx");
    const missing = files.filter((name) => !features.includes(`src/routes/${name}`));
    expect(missing, missing.join(", ")).toEqual([]);
  });

  it("cites source files that still exist", () => {
    const missing = fileRefs(features)
      .filter(({ ref }) => !fs.existsSync(path.join(ROOT, ref)))
      .map(({ ref, line }) => `${ref}  ←  ${line.slice(0, 120)}`);
    expect(missing, missing.join("\n")).toEqual([]);
  });

  it("names IPC / event channels that still exist in the desktop bridge", () => {
    const haystack = [
      read("electron/main.cjs"),
      read("electron/preload.cjs"),
      read("src/lib/friday/capability-trees.ts"),
    ].join("\n");
    const channels = features
      .split("\n")
      .flatMap((line) =>
        backtickChunks(line).filter((chunk) => /^[a-z][a-z0-9_-]*:[a-z0-9_.:-]+$/.test(chunk)),
      );
    expect(channels.length).toBeGreaterThan(0);
    const missing = [...new Set(channels)].filter((channel) => !haystack.includes(`"${channel}"`));
    expect(missing, missing.join(", ")).toEqual([]);
  });

  it("names every auto-detected local engine", () => {
    expect(features).toMatch(/Ollama/);
    for (const spec of Object.values(models.LOCAL_ENGINES)) {
      expect(features, spec.name).toContain(String(spec.name));
    }
  });
});

describe("provider documentation honesty", () => {
  const providersDoc = read(PROVIDERS);

  it("names every CLOUD provider that models.cjs can dispatch", () => {
    const missing = Object.entries(models.CLOUD)
      .filter(([id, spec]) => {
        const name = String(spec.name ?? "");
        return !providersDoc.includes(id) && !(name && providersDoc.includes(name));
      })
      .map(([id, spec]) => `${id} (${spec.name ?? "?"})`);
    expect(missing, missing.join(", ")).toEqual([]);
  });

  it("names every LOCAL_ENGINES entry plus Ollama", () => {
    expect(providersDoc).toMatch(/Ollama/);
    const missing = Object.entries(models.LOCAL_ENGINES)
      .filter(([id, spec]) => {
        const name = String(spec.name ?? "");
        return !providersDoc.includes(id) && !(name && providersDoc.includes(name));
      })
      .map(([id]) => id);
    expect(missing, missing.join(", ")).toEqual([]);
  });
});

describe("governed documentation file refs", () => {
  it("does not cite source files that no longer exist", () => {
    const docs = [...engine.VERSION_DOCS, ...engine.GOVERNED_DOCS];
    const missing: string[] = [];
    for (const rel of docs) {
      const file = path.join(ROOT, rel);
      if (!fs.existsSync(file)) continue;
      for (const { ref, line } of fileRefs(read(rel))) {
        if (fs.existsSync(path.join(ROOT, ref))) continue;
        missing.push(`${rel}: ${ref}  ←  ${line.slice(0, 120)}`);
      }
    }
    expect(missing, missing.join("\n")).toEqual([]);
  });
});

describe("FRIDAY_FEATURES named functions", () => {
  it("named function calls still appear in the source tree", () => {
    const features = read(FEATURES);
    const names = features
      .split("\n")
      .flatMap((line) =>
        [...line.matchAll(/`(?:[A-Za-z][\w]*\.)*([A-Za-z_][A-Za-z0-9_]{3,})\(\)`/g)]
          .map((m) => m[1])
          .filter((name): name is string => Boolean(name)),
      );
    const unique = [...new Set(names)];
    expect(unique.length).toBeGreaterThan(0);
    try {
      execFileSync("rg", ["--version"], { stdio: "pipe" });
    } catch {
      return;
    }
    const missing = unique.filter((name) => {
      try {
        execFileSync(
          "rg",
          [
            "-F",
            "-l",
            "--glob",
            "!node_modules",
            "--glob",
            "!dist*",
            "--glob",
            "!release/**",
            name,
            "src",
            "electron",
            "kernel",
            "core",
            "scripts",
          ],
          { cwd: ROOT, stdio: "pipe" },
        );
        return false;
      } catch {
        return true;
      }
    });
    expect(missing, missing.join(", ")).toEqual([]);
  });
});

describe("README production-validation honesty", () => {
  it("does not freeze stale test counts or claim an unbuilt 1.0.0.0 EXE", () => {
    const readme = read("README.md");
    expect(readme).not.toMatch(/903 tests in 128 files/);
    expect(readme).not.toMatch(/69 files checked/);
    expect(readme).toContain("AUDIT.md");
    expect(readme).toContain("FRIDAY_STATE.md");
    expect(readme).toMatch(/NOT VERIFIED/);
  });
});
