/**
 * FRIDAY · repository-automation documentation contract
 *
 * Every workflow that exists in .github/workflows must be described in the
 * GitHub Actions catalog, and the catalog must never describe a workflow that
 * no longer exists. Automation drift fails like any other regression.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const WORKFLOW_DIR = path.join(ROOT, ".github", "workflows");
const CATALOG = "docs/FRIDAY_GITHUB_ACTIONS.md";
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const workflows = fs
  .readdirSync(WORKFLOW_DIR)
  .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

describe("repository automation documentation", () => {
  const catalog = read(CATALOG);

  it("documents every workflow file", () => {
    for (const file of workflows) {
      expect(catalog, `${file} is not documented in ${CATALOG}`).toContain(file);
    }
  });

  it("documents every workflow display name", () => {
    for (const file of workflows) {
      const name = /^name:\s*(.+)$/m.exec(read(path.join(".github", "workflows", file)))?.[1];
      expect(name, `${file} has no name:`).toBeTruthy();
      expect(catalog, `"${name}" is missing from ${CATALOG}`).toContain(String(name).trim());
    }
  });

  it("does not advertise workflows that were removed", () => {
    const referenced = [...catalog.matchAll(/`([a-z0-9-]+\.yml)`/g)].map((m) => m[1]);
    for (const file of new Set(referenced)) {
      expect(workflows, `${CATALOG} references a missing workflow ${file}`).toContain(file);
    }
  });

  it("keeps the documentation index linking the catalog and the guides", () => {
    const index = read("docs/README.md");
    for (const link of [
      "FRIDAY_GITHUB_ACTIONS.md",
      "FRIDAY_USER_GUIDE.md",
      "FRIDAY_FEATURES.md",
      "FRIDAY_BUILD_AND_RELEASE.md",
    ]) {
      expect(index, `docs/README.md does not link ${link}`).toContain(link);
    }
  });
});
