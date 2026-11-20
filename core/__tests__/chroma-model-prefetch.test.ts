/**
 * Chroma downloads a 79 MB embedding model the first time memory is used. That download used to run on the kernel's
 * event loop, which froze every request on a slow line (the readiness RESTART step of two Dependabot pull requests
 * timed out on it). Setup now fetches it once with a "still working" line, and the kernel runs every Chroma call
 * in a worker thread (kernel/tests/test_memory_chroma_off_loop.py).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..", "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

describe("the semantic-memory embedding model", () => {
  const setup = read("scripts/setup-python.cjs");

  it("is fetched by setup:python after Chroma imports, with proof of life, and a failure only costs a note", () => {
    expect(setup).toContain("function fetchChromaEmbeddingModel()");
    const at = setup.indexOf('log("chromadb ok (semantic memory enabled)");');
    expect(at).toBeGreaterThan(-1);
    expect(setup.slice(at, at + 200)).toContain("fetchChromaEmbeddingModel();");
    const start = setup.indexOf("function fetchChromaEmbeddingModel()");
    const fn = setup.slice(start, setup.indexOf("\n}\n", start));
    expect(fn).toContain('"semantic-memory model"');
    expect(fn).toContain("withActivityCommand(");
    expect(fn).toContain("DefaultEmbeddingFunction");
    expect(fn).toContain("FRIDAY_PREFETCH");
    expect(fn).toContain("FRIDAY_OFFLINE");
    expect(fn).toContain("NOTE the semantic-memory model was not downloaded");
    expect(fn).not.toContain("process.exit");
  });

  it("is never an event-loop call in the kernel: every Chroma call goes through the worker-thread wrapper", () => {
    const memory = read("kernel/memory.py");
    expect(memory).toContain("async def _chroma(self, fn, /, *args, **kwargs):");
    expect(memory).toContain("asyncio.to_thread(fn, *args, **kwargs)");
    for (const call of ["col.query", "col.upsert", "col.add", ".delete"]) {
      expect(memory, call).not.toMatch(
        new RegExp(`(?<!self\\._chroma\\()${call.replace(".", "\\.")}\\(`),
      );
    }
  });
});
