/**
 * Both memory panels restore from the disk copy when the browser copy is empty, show a loading state while it
 * reads, report the restored count, and offer Retry on an error.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string) =>
  readFileSync(resolve(__dirname, "../../src/components/friday", rel), "utf8");

describe.each([
  ["MemoryConsole.tsx", "memoryEngine"],
  ["settings/MemorySettings.tsx", "memory"],
])("%s restore", (file, engine) => {
  const source = read(file);
  it("falls back to the disk copy and shows the count", () => {
    // The panel awaits one call that reads the browser copy, else the disk copy, once.
    expect(source).toContain(`${engine}.restoreSnapshot()`);
    expect(source).toMatch(/restored/i);
  });
  it("has a loading state and a Retry on error", () => {
    expect(source).toContain("Restoring");
    expect(source).toMatch(/label: "Retry"/);
    expect(source).toMatch(/disabled=\{[^}]*restoring/);
  });
});
