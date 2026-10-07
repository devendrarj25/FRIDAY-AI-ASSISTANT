/**
 * FRIDAY · identity contract
 *
 * One identity must reach every packaged surface: EXE resources, installer,
 * portable build, release manifest and documentation. `scripts/identity.cjs`
 * is the only place the strings live; this test proves nothing drifted away
 * from it.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const ROOT = process.cwd();
const IDENTITY = require_(path.resolve(ROOT, "scripts/identity.cjs")) as {
  APP: string;
  PRODUCT: string;
  OWNER: string;
  GITHUB: string;
  REPOSITORY: string;
  PUBLISHER: string;
  COPYRIGHT: string;
  EXECUTABLE: string;
  TEST_PRODUCT: string;
  PACKAGE_KINDS: string[];
  auditPackageIdentity: (root: string) => {
    ok: boolean;
    problems: string[];
    kinds: string[];
  };
  windowsResourceStamp: (input: {
    productName: string;
    fileVersion: string;
    productVersion: string;
  }) => { CompanyName: string; LegalCopyright: string };
};

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("identity", () => {
  it("declares the owner exactly once, in one packaging module", () => {
    expect(IDENTITY.APP).toBe("FRIDAY AI");
    expect(IDENTITY.PRODUCT).toBe("FRIDAY");
    expect(IDENTITY.OWNER).toBe("Devendra Singh Meena");
    expect(IDENTITY.GITHUB).toBe("devendrarj25");
    expect(IDENTITY.REPOSITORY).toBe("https://github.com/devendrarj25/FRIDAY-AI-ASSISTANT");
    expect(IDENTITY.PUBLISHER).toBe("Devendra Singh Meena (devendrarj25)");
    expect(IDENTITY.EXECUTABLE).toBe("FRIDAY.exe");
    expect(IDENTITY.TEST_PRODUCT).toBe("FRIDAY Test");
  });

  it("runtime project-identity mirrors scripts/identity.cjs", async () => {
    const { PROJECT_IDENTITY } = await import("../../src/lib/friday/brain/project-identity");
    expect(PROJECT_IDENTITY.product).toBe(IDENTITY.PRODUCT);
    expect(PROJECT_IDENTITY.owner).toBe(IDENTITY.OWNER);
    expect(PROJECT_IDENTITY.github).toBe(IDENTITY.GITHUB);
    expect(PROJECT_IDENTITY.publisher).toBe(IDENTITY.PUBLISHER);
    expect(PROJECT_IDENTITY.repository).toBe(IDENTITY.REPOSITORY);
    expect(PROJECT_IDENTITY.copyright).toBe(IDENTITY.COPYRIGHT);
    const runtime = read("src/lib/friday/brain/identity.ts");
    expect(runtime).toContain("lockedIdentityFields");
    expect(runtime).toContain("PROJECT_IDENTITY");
    expect(runtime).not.toContain('"Devendra Singh Meena (devendrarj25)"');
  });

  it("is read, not retyped, by the branding, manifest and verification scripts", () => {
    for (const file of [
      "scripts/brand-windows.cjs",
      "scripts/release-manifest.cjs",
      "scripts/verify-build.cjs",
    ]) {
      const body = read(file);
      expect(body).toContain('require("./identity.cjs")');
      expect(body).not.toContain('"Devendra Singh Meena (devendrarj25)"');
    }
  });

  it("stamps the publisher and copyright into the packaged Windows app", () => {
    const builder = read("electron-builder.yml");
    expect(builder).toContain(IDENTITY.COPYRIGHT);
    expect(builder).toContain(`publisherName: ${IDENTITY.PUBLISHER}`);
    expect(builder).toContain(`productName: ${IDENTITY.PRODUCT}`);
    expect(builder).toContain(`executableName: ${IDENTITY.PRODUCT}`);
  });

  it("keeps package.json aligned with the packaged product", () => {
    const pkg = JSON.parse(read("package.json")) as {
      productName: string;
      author: { name: string; url: string; email?: string };
      homepage: string;
      repository: { url: string };
      bugs: { url: string };
    };
    expect(pkg.productName).toBe(IDENTITY.PRODUCT);
    expect(pkg.author.name).toBe(IDENTITY.OWNER);
    expect(pkg.author.url).toContain(IDENTITY.GITHUB);
    expect(pkg.author.email).toBeUndefined();
    expect(pkg.homepage).toBe(IDENTITY.REPOSITORY);
    expect(pkg.repository.url).toBe(`${IDENTITY.REPOSITORY}.git`);
    expect(pkg.bugs.url).toBe(`${IDENTITY.REPOSITORY}/issues`);
  });

  it("verifies every package kind as the project id, with no contact fields", () => {
    const audit = IDENTITY.auditPackageIdentity(ROOT);
    expect(audit.problems).toEqual([]);
    expect(audit.ok).toBe(true);
    expect(audit.kinds).toEqual(IDENTITY.PACKAGE_KINDS);
    const stamp = IDENTITY.windowsResourceStamp({
      productName: "FRIDAY",
      fileVersion: "1.0.1.2",
      productVersion: "1.0.1.2",
    });
    expect(stamp.CompanyName).toBe("Devendra Singh Meena (devendrarj25)");
    expect(stamp.LegalCopyright).toContain("devendrarj25");
    expect(JSON.stringify(stamp)).not.toMatch(/@/);
  });

  it("names the owner in the user-facing documentation", () => {
    for (const file of [
      "README.md",
      "INSTALL.md",
      "CONTRIBUTING.md",
      "docs/FRIDAY_BUILD_AND_RELEASE.md",
    ]) {
      expect(read(file)).toContain(IDENTITY.PUBLISHER);
    }
  });
});
