/**
 * The main process hands the ONE kernel privacy classifier to the fine-tune rails. Without it every training row
 * fails closed, so the wiring is pinned in the source.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const main = readFileSync(path.resolve(import.meta.dirname, "../../electron/main.cjs"), "utf8");

describe("finetune.init gets the kernel classifier", () => {
  const start = main.indexOf("finetune.init({");
  const call = main.slice(start, main.indexOf("});", start));

  it("calls finetune.init with a classify that asks the kernel privacy.classify", () => {
    expect(start).toBeGreaterThan(-1);
    expect(call).toMatch(/classify:\s*\(text\)\s*=>\s*kernelRequest\("privacy\.classify"/);
  });

  it("never classifies with anything the page sends", () => {
    expect(call).not.toMatch(/payload|arg\b|event/i);
  });
});
