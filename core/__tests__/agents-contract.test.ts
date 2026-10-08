/**
 * Pins the load-bearing sentences in AGENTS.md and checks that the file
 * only names paths, scripts, and registered docs that exist.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const require = createRequire(import.meta.url);
const docs = require(path.join(ROOT, "scripts", "docs-engine.cjs")) as {
  DOCUMENTS: { file: string }[];
};

const agents = () => fs.readFileSync(path.join(ROOT, "AGENTS.md"), "utf8");

describe("AGENTS.md anchors", () => {
  it("keeps the version, landing, and conduct sentences the suite reads", () => {
    const text = agents();
    expect(text.startsWith("# AGENTS.md — instructions for AI tools working on FRIDAY")).toBe(true);
    expect(text).toContain("current public line **FRIDAY 1.0.1.2**");
    expect(text).toContain("Next public revision is **1.0.1.3**");
    expect(text).toContain("(`1.0.0.0`)");
    expect(text).toContain("## Owner directive and build autonomy");
    expect(text).toContain("Flow Studio canvas");
    expect(text).toContain("Full autonomy");
    expect(text).toContain("The look of the app stays");
    expect(text).toContain("Locked areas may be changed");
    expect(text).toContain("## Assistant standard (voice and Auto mode)");
    expect(text).toContain("unverified until the owner re-checks");
    expect(text).toContain("copyleft (GPL or LGPL) voice component");
    expect(text).toMatch(/required deliverable/i);
    expect(text).toContain("A session that leaves `FRIDAY_STATE.md` stale has not finished");
    expect(text).toMatch(/Finish the landing checklist/);
    expect(text).toContain("scripts\\build-windows.cmd");
    expect(text).toContain("docs:sync");
    expect(text).toMatch(/never a later cleanup/);
    expect(text).toMatch(/not dispatch/i);
    expect(text).toContain("Changing something that already works");
    expect(text).toContain("## Upgrade flow");
    expect(text).toContain("`delete_branch_on_merge` setting is off");
    expect(text).toContain("One open pull request into `main`");
    expect(text).toMatch(/hunt for bugs and weak spots and fix them in the\s+same change/);
    expect(text).toMatch(/Never delete, skip, weaken, or\s+fake-pass a test/);
    expect(text).toContain("Never dispatch a workflow");
    expect(text).toContain("Do not add a thirteenth");
    expect(text).toContain("## Direction");
    expect(text).toContain("only `main`");
    expect(text.match(/Never commit, push, or land work on `main`/g)?.length).toBe(1);
    expect(text).not.toContain("-a9ef");
    expect(text).not.toContain('A new kind of UI control is "needs owner OK"');
    expect(text).not.toContain("stop and say so");
  });

  it("names no removed planning file", () => {
    const text = agents();
    expect(text).not.toContain("READMEFIRST");
    expect(text).not.toContain("FRIDAY-DEVELOPMENT & VISION");
    expect(text).not.toContain("ADOPTION_LEDGER");
  });

  it("only links and names paths that exist", () => {
    const text = agents();
    const links = [...text.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1] ?? "");
    const missingLinks = links.filter((link) => {
      if (link.startsWith("http")) return false;
      const rel = link.split("#")[0] ?? "";
      return rel.length > 0 && !fs.existsSync(path.join(ROOT, rel));
    });
    expect(missingLinks).toEqual([]);

    const roots = "src|core|electron|kernel|scripts|config|docs|installer|builder|modules|agents";
    const refs = [...text.matchAll(new RegExp("`((?:" + roots + ")/[A-Za-z0-9_./-]+)`", "g"))]
      .map((m) => (m[1] ?? "").replace(/[.,]+$/, ""))
      .filter((rel) => !/[*<>{}]/.test(rel));
    const missing = refs.filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
    expect(missing).toEqual([]);
  });

  it("only names npm scripts that package.json defines", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const text = agents();
    const named = [...text.matchAll(/npm run ([a-z0-9:-]+)/g)].map((m) => m[1] ?? "");
    expect(named.length).toBeGreaterThan(8);
    const missing = [...new Set(named)].filter((name) => !(name in pkg.scripts));
    expect(missing).toEqual([]);
    for (const required of [
      "test:fast",
      "lint",
      "typecheck",
      "test:kernel",
      "docs:sync",
      "docs:check",
      "arrange:check",
      "validate:local",
      "check:provenance",
    ]) {
      expect(named).toContain(required);
    }
    expect(text).toContain("`npm test`");
    expect(pkg.scripts.test).toBeTruthy();
  });

  it("only names registered product docs", () => {
    const text = agents();
    const registered = new Set(docs.DOCUMENTS.map((doc) => doc.file));
    const named = [...text.matchAll(/docs\/[A-Za-z0-9_.-]+\.md/g)].map((m) => m[0] ?? "");
    expect(named.length).toBeGreaterThan(3);
    const missing = [...new Set(named)].filter(
      (file) => file !== "docs/README.md" && !registered.has(file),
    );
    expect(missing).toEqual([]);
  });
});
