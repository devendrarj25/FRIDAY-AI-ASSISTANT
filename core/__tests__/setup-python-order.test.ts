/**
 * The Python setup installs every package before it fetches any model. On the owner's PC a chat model
 * whose registry timed out ended the setup with exit 1 BEFORE the capability packages (supertonic,
 * moonshine-voice, pyrnnoise, soundfile, uharfbuzz, py7zr, comtypes) were installed, so Doctor and the
 * build could not repair anything and every run repeated the same failure.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..", "..");
const setup = readFileSync(path.join(root, "scripts/setup-python.cjs"), "utf8");

describe("setup-python order", () => {
  it("installs the kernel and capability packages before it fetches any model", () => {
    const kernel = setup.indexOf("installing kernel requirements from");
    const capability = setup.indexOf("installing capability extras from");
    const models = setup.indexOf("fetchModelsAndProbe();");
    expect(kernel).toBeGreaterThan(-1);
    expect(capability).toBeGreaterThan(kernel);
    expect(models).toBeGreaterThan(capability);
  });

  it("collects a model failure for the final report instead of exiting on the spot", () => {
    const start = setup.indexOf("function fetchModelsAndProbe()");
    const end = setup.indexOf("function voiceImportable()");
    const body = setup.slice(start, end);
    expect(body).not.toContain("process.exit(");
    expect(body).toContain('incomplete.push("the speech, voice and chat models are not complete")');
    // The final verdict still fails a Windows setup that is incomplete, and names everything at once.
    expect(setup).toContain("if (incomplete.length) {");
    expect(setup.slice(setup.indexOf("if (incomplete.length) {"))).toContain("process.exit(1)");
  });

  it("installs the capability packages one by one when the set fails as a whole", () => {
    const block = setup.slice(setup.indexOf("installing capability extras from"));
    expect(block).toContain("installing each package on its own");
    expect(block).toContain("noUpgrade: true");
    expect(block).toContain("did not install");
  });

  it("saves the package list before a newest-release install and restores it when the kernel stops loading", () => {
    expect(setup).toContain("takeUpgradeSnapshot();");
    expect(setup).toContain("function rollbackUpgrade()");
    expect(setup).toContain("pip-before-upgrade.txt");
    // Both the early import check and the check after the capability packages can roll back.
    expect(setup.match(/rollbackUpgrade\(\)/g)?.length).toBeGreaterThanOrEqual(3);
    // A rolled-back run is never recorded as checked, so the next run asks again.
    expect(setup).toContain("upgradeTried = false;");
  });
});
