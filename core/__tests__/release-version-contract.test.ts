/**
 * Official Publish run 38050484488 prepared 1.1.1.2 and then npm test still
 * required the literal line FRIDAY 1.0.1.2. The contract follows the version
 * file. A healed bump must satisfy it. A stale line must not.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, "../..");
const engine = require(path.join(ROOT, "scripts/release-engine.cjs")) as {
  syncDocs: (previous: string, clean: string, options: { root: string }) => string[];
  nextPublicRevision: (version: string) => string;
  readCanonicalIdentity: (options: { root: string }) => { releaseVersion: string };
};

function anchors(version: string) {
  return {
    line: `current public line **FRIDAY ${version}**`,
    next: `Next public revision is **${engine.nextPublicRevision(version)}**`,
  };
}

describe("release version contract", () => {
  it("follows the canonical identity instead of a frozen 1.0.1.2", () => {
    const identity = engine.readCanonicalIdentity({ root: ROOT });
    const text = fs.readFileSync(path.join(ROOT, "AGENTS.md"), "utf8");
    const expected = anchors(identity.releaseVersion);
    expect(text).toContain(expected.line);
    expect(text).toContain(expected.next);
  });

  it("accepts the major bump Official Publish prepared once the notes are healed", () => {
    expect(engine.nextPublicRevision("1.0.1.2")).toBe("1.0.1.3");
    expect(engine.nextPublicRevision("1.1.1.2")).toBe("1.1.1.3");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-version-"));
    const stale = [
      "# AGENTS.md — instructions for AI tools working on FRIDAY",
      "current public line **FRIDAY 1.0.1.2**",
      "Next public revision is **1.0.1.3**",
      "The four-part example stays (`1.0.0.0`).",
    ].join("\n");
    fs.writeFileSync(path.join(root, "AGENTS.md"), stale);
    expect(stale).not.toContain(anchors("1.1.1.2").line);
    engine.syncDocs("1.0.1.2", "1.1.1.2", { root });
    const healed = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
    expect(healed).toContain(anchors("1.1.1.2").line);
    expect(healed).toContain(anchors("1.1.1.2").next);
    expect(healed).toContain("(`1.0.0.0`)");
  });
});
