/**
 * FRIDAY · "What's New", cross-channel install and data safety
 *
 * The contract these tests defend:
 *   • every build — TEST and OFFICIAL — publishes a real, detailed What's New
 *     entry generated from the actual commits, never empty or placeholder;
 *   • both workflows use that one generator;
 *   • an explicit Stable ⇄ Test switch is allowed, everything else still
 *     refuses a downgrade;
 *   • uninstall keeps FRIDAY data unless the delete checkbox is ticked.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const engine = require_(path.resolve(process.cwd(), "scripts/release-engine.cjs"));
const safety = require_(path.resolve(process.cwd(), "electron/update-safety.cjs"));

const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), "utf8");

describe("what's new generation", () => {
  it("renders version, date, summary and the real categorised changes", () => {
    const notes = engine.whatsNew({
      version: "1.3.2",
      previous: "v1.3.1",
      subjects: ["feat: add the update channel switch", "fix: stop the installer downgrade"],
      date: new Date("2026-02-03T00:00:00Z"),
    });
    expect(notes).toContain("## FRIDAY v1.3.2");
    expect(notes).toContain("**Released:** February 3, 2026");
    expect(notes).toContain("Stable (official release)");
    expect(notes).toContain("**Changes since:** v1.3.1");
    expect(notes).toContain(
      "You can switch between the Stable and Test update channels from Settings.",
    );
    expect(notes).toContain("The installer no longer installs an older FRIDAY over a newer one.");
    expect(notes).toContain("FRIDAY 1.3.2 is an update. Here is what changed for you.");
    expect(notes).not.toMatch(/\b(?:pull request|github|repository)\b/i);
    expect(notes).toContain("### Important Notes");
    expect(notes).toContain("SHA-256");
  });

  it("labels a test build and never renders an empty entry", () => {
    const notes = engine.whatsNew({
      version: "1.3.2-test.1",
      previous: "v1.3.1",
      subjects: [],
      channel: "test",
      ref: "feature/voice",
      commit: "abc1234",
    });
    expect(notes).toContain("TEST BUILD");
    expect(notes).toContain("feature/voice");
    expect(notes).toContain("abc1234");
    expect(notes).toContain("Verification build of the current source");
    expect(notes).not.toContain("No source changes were recorded");
    expect(notes.trim().length).toBeGreaterThan(200);
  });

  it("calls out breaking changes explicitly", () => {
    const notes = engine.whatsNew({
      version: "2.0.0",
      subjects: ["feat!: move the workspace root"],
    });
    expect(notes).toMatch(/Breaking change/i);
  });

  it("writes owner-facing What's New instead of a commit or pull-request dump", () => {
    const notes = engine.whatsNew({
      version: "1.0.0.2",
      previous: "v1.0.0.1",
      subjects: [
        "fix: resume Official Publish from origin/main and write 1.0.0.1 notes (#89)",
        "fix: brand-windows afterSign FileVersion for TEST EXE",
        "chore: bump prettier",
        "test: version-system-reset follows current identity",
        "docs: record #86 merge",
        "feat: add the update channel switch",
      ],
      date: new Date("2026-09-04T00:00:00Z"),
    });
    expect(notes).not.toMatch(/#89|#86/);
    expect(notes).not.toMatch(/^[-*] feat:/m);
    expect(notes).not.toMatch(/^[-*] fix:/m);
    expect(notes).toContain(
      "The test build now shows the same public version as the installed app.",
    );
    expect(notes).toContain(
      "You can switch between the Stable and Test update channels from Settings.",
    );
    expect(notes).not.toContain("bump prettier");
    expect(notes).not.toContain("Technical / Internal");
    expect(notes).not.toMatch(/\b(?:pull request|github|repository)\b/i);
    expect(engine.assertPublishableNotes(notes, { version: "1.0.0.2" }).ok).toBe(true);
  });

  it("refuses a commit-dump What's New before publish", () => {
    const dump = [
      "## FRIDAY v1.0.0.2",
      "",
      "### What's New",
      "",
      "#### Fixed",
      "- fix: resume Official Publish from origin/main (#89)",
      "",
    ].join("\n");
    expect(() => engine.assertPublishableNotes(dump, { version: "1.0.0.2" })).toThrow(
      /commit or pull-request dump/,
    );
  });

  it("keeps every published What's New in plain language and in step with the changelog", () => {
    const notesDir = path.resolve(process.cwd(), "releases/notes");
    const changelog = read("CHANGELOG.md");
    const files = fs.readdirSync(notesDir).filter((name) => /^v\d+\.\d+\.\d+\.\d+\.md$/.test(name));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const version = name.slice(1, -3);
      const notes = fs.readFileSync(path.join(notesDir, name), "utf8");
      expect(notes, name).not.toMatch(/\b(?:pull request|github|repository)\b/i);
      expect(notes, name).not.toContain("Technical / Internal");
      expect(notes, name).not.toMatch(/v0\.0\.0|FRIDAY v1\.8\.0|LEGACY RELEASE LINE/);
      engine.assertPublishableNotes(notes, { version, requireChanges: version !== "1.0.0.0" });
      const expected = engine.changelogEntry(notes, version).trim();
      expect(engine.changelogSectionFor(changelog, version).trim(), version).toBe(expected);
    }
  });
});

describe("both pipelines publish the generated notes", () => {
  it("official and test workflows use the one renderer and refuse empty notes", () => {
    const release = read(".github/workflows/release.yml");
    const test = read(".github/workflows/test-build.yml");
    expect(release).toContain("release-engine.cjs notes");
    expect(release).toContain("--channel stable");
    expect(release).toContain("release-engine.cjs guard-notes");
    expect(release).not.toContain("See CHANGELOG.md.");
    expect(test).toContain("release-engine.cjs notes");
    expect(test).toContain("--channel test");
    expect(test).toContain("release-engine.cjs guard-notes");
  });
});

describe("build ordering across channels", () => {
  it("places a test prerelease below the official version it precedes", () => {
    expect(engine.compareBuilds("1.3.2", "1.3.2-test.1")).toBeGreaterThan(0);
    expect(engine.compareBuilds("1.3.2-test.2", "1.3.2-test.1")).toBeGreaterThan(0);
    expect(engine.compareBuilds("1.3.2-test.1", "1.3.1")).toBeGreaterThan(0);
    expect(engine.compareBuilds("1.3.2", "1.3.2")).toBe(0);
  });
});

describe("explicit channel switch", () => {
  const tmp = path.join(process.cwd(), "node_modules", ".friday-switch-test.exe");
  fs.writeFileSync(tmp, Buffer.alloc(2 * 1024 * 1024, 3));

  it("still refuses a downgrade on the normal path", () => {
    const result = safety.verifyArtifact({
      file: tmp,
      version: "1.3.2-test.1",
      currentVersion: "1.3.2",
    });
    expect(result.ok).toBe(false);
  });

  it("allows the same build when the owner deliberately crosses channels", () => {
    const result = safety.verifyArtifact({
      file: tmp,
      version: "1.3.2-test.1",
      currentVersion: "1.3.2",
      channelSwitch: true,
    });
    expect(result.ok).toBe(true);
    expect(result.channelSwitch).toBe(true);
  });

  it("is gated in the main process by an explicit confirmation", () => {
    const main = read("electron/main.cjs");
    expect(main).toContain("payload.acceptChannelSwitch !== true");
    expect(main).toContain("requiresChannelSwitch: true");
    expect(main).toContain("channelSwitch: crossing");
  });

  it("reports the other channel's newest build without installing it", () => {
    const sync = read("electron/github-sync.cjs");
    expect(sync).toContain("otherChannel");
    expect(sync).toContain("requiresChannelSwitch: true");
  });
});

describe("uninstall data safety", () => {
  const nsh = read("installer/build/installer.nsh");

  it("offers a delete-all checkbox that is unchecked by default", () => {
    expect(nsh).toContain("customUnWelcomePage");
    expect(nsh).toContain("Delete all FRIDAY data and resources");
    expect(nsh).toContain("${NSD_SetState} $FridayUnDeleteData ${BST_UNCHECKED}");
  });

  it("keeps the data folder on every unattended path", () => {
    expect(nsh).toContain('StrCpy $FridayUnMode "keep"');
    expect(nsh).toContain("Keeping the FRIDAY data folder");
  });

  it("removes everything FRIDAY created only when the box was ticked", () => {
    const block = nsh.slice(nsh.indexOf("!macro customUnInstall"));
    expect(block).toContain('${If} $FridayUnMode == "delete"');
    expect(block).toContain('RMDir /r "$FridayUnRoot"');
    expect(block).toContain('RMDir /r "$APPDATA\\FRIDAY"');
  });
});
