/**
 * A helper process that exits while FRIDAY is writing to it raises EPIPE on its
 * stdin, asynchronously. Every module that writes to a child's stdin must
 * listen for that error, and the main process must never turn a broken helper
 * pipe into the "could not start the interface" screen.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const dir = path.resolve(import.meta.dirname, "../../electron");
const files = readdirSync(dir).filter((f) => f.endsWith(".cjs"));

describe("child process stdin", () => {
  it("is guarded wherever FRIDAY writes to a spawned helper", () => {
    const writers = files.filter((f) => {
      const text = readFileSync(path.join(dir, f), "utf8");
      return /child\.stdin\??\.write\(|session\.child\.stdin\.write\(/.test(text);
    });
    expect(writers.length).toBeGreaterThan(3);
    const unguarded = writers.filter((f) => {
      const text = readFileSync(path.join(dir, f), "utf8");
      return !/stdin\??\.on\("error"/.test(text);
    });
    expect(unguarded).toEqual([]);
  });

  it("main never shows the load-failure screen for a broken pipe", () => {
    const main = readFileSync(path.join(dir, "main.cjs"), "utf8");
    expect(main).toContain("ERR_STREAM_DESTROYED");
    expect(main).toMatch(/const ignored =\s*brokenPipe \|\|/);
  });

  it("keeps a working window up when a stray error arrives after it loaded", () => {
    const main = readFileSync(path.join(dir, "main.cjs"), "utf8");
    expect(main).toContain("let interfaceLoaded = false;");
    expect(main).toMatch(/if \(interfaceLoaded && [\s\S]{0,260}the window stays up/);
    expect(main).toMatch(
      /interfaceLoaded = !String\(win\.webContents\.getURL\(\)\)\.startsWith\("data:"\)/,
    );
  });

  it("does not respawn a wake worker that keeps dying at once", () => {
    const wake = readFileSync(path.join(dir, "wake-engine.cjs"), "utf8");
    expect(wake).toContain("earlyDeathAt");
    expect(wake).toContain("paused for a minute");
  });
});
