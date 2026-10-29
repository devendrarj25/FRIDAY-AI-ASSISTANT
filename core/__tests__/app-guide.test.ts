import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  capabilitiesFor,
  describeLiveSelf,
  describeSections,
  explainFeature,
  findFeature,
  looksLikeFeatureQuestion,
  looksLikeSelfStatusQuestion,
  parseRouteSource,
  routeFileFor,
} from "../../src/lib/friday/brain/app-guide";
import { baselineRespond } from "../../src/lib/friday/brain/baseline-responder";

const require_ = createRequire(import.meta.url);
const sourceAccess = require_("../../electron/source-access.cjs");

describe("FRIDAY explains her own interface", () => {
  it("recognises a question about one of her sections", () => {
    expect(looksLikeFeatureQuestion("what does the Sandbox section do?")).toBe(true);
    expect(findFeature("what does the Sandbox section do?")?.to).toBe("/sandbox");
    expect(findFeature("explain the Install Manager page")?.to).toBe("/install-manager");
  });

  it("reads the explanation out of the real route file, not a hardcoded blurb", () => {
    const file = routeFileFor("/sandbox");
    expect(file).toBe("src/routes/sandbox.tsx");
    const parsed = parseRouteSource(readFileSync(file, "utf8"));
    expect(parsed.headline).toBe("Sandbox");
    expect(parsed.subtitle).toMatch(/isolated development/i);
    expect(parsed.panels.map((p) => p.title)).toContain("Isolation engines");
  });

  it("lists sections from the navigation registry so it can never go stale", () => {
    const text = describeSections();
    expect(text).toMatch(/Setup & Doctor/);
    expect(text).toMatch(/Install Manager/);
  });

  it("routes a feature question through the baseline brain, not a model", async () => {
    const reply = baselineRespond("explain the Install Manager section");
    expect(reply.handled).toBe(true);
    expect(reply.kind).toBe("guide");
    // No desktop bridge in the test environment: she still answers from the
    // registry and says what she could not read, rather than inventing it.
    const text = await reply.resolve!();
    expect(text).toMatch(/Install Manager/);
  });

  it("explains a section using the live capability registry, not a hardcoded blurb", () => {
    const item = findFeature("what does the Sandbox section do?");
    expect(item?.to).toBe("/sandbox");
    const caps = capabilitiesFor(item!);
    expect(caps.some((line) => /sandbox/i.test(line))).toBe(true);
  });
});

describe("self-status answers come from live registries", () => {
  it("recognises capability and 'how smart' questions", () => {
    expect(looksLikeSelfStatusQuestion("what can you do")).toBe(true);
    expect(looksLikeSelfStatusQuestion("how smart are you right now")).toBe(true);
    expect(looksLikeSelfStatusQuestion("write a haiku about rain")).toBe(false);
  });

  it("assembles what-can-you-do from the matrix, models, and navigation — not a static blurb", () => {
    const text = describeLiveSelf("what can you do");
    expect(text).toMatch(/capability matrix/i);
    expect(text).toMatch(/provisional/i);
    expect(text).toMatch(/Coding/);
    expect(text).toMatch(/model registry/i);
    expect(text).toMatch(/Setup & Doctor/);
    expect(text).not.toMatch(/\bworking\b/i);
    expect(text).not.toMatch(/\bsmart\b/i);
    console.log(["what can you do →", text].join("\n"));
  });

  it("labels a measured domain as measured and a never-run domain as provisional", async () => {
    const { capabilityMatrix } = await import("../../src/lib/friday/self/capability-matrix");
    capabilityMatrix.reset();
    capabilityMatrix.record("coding", true);
    const text = describeLiveSelf("how smart are you right now");
    expect(text).toMatch(/Coding: .*measured/i);
    expect(text).toMatch(/Conversation: .*provisional/i);
    expect(text).toMatch(/no single intelligence number/i);
    capabilityMatrix.reset();
  });

  it("explainFeature answers a general capability question from the same live digest", async () => {
    const text = await explainFeature("what can you do");
    expect(text).toMatch(/provisional/i);
    expect(text).toMatch(/Install Manager/);
  });
});

describe("read-only source access", () => {
  const root = process.cwd();

  it("reads a real project file", () => {
    const result = sourceAccess.readSource(root, "package.json");
    expect(result.ok).toBe(true);
    expect(result.text).toContain('"name"');
  });

  it("refuses to escape the project root", () => {
    expect(sourceAccess.readSource(root, "../../../etc/passwd").ok).toBe(false);
    expect(sourceAccess.readSource(root, "/etc/passwd").ok).toBe(false);
  });

  it("searches her own source and finds real matches", () => {
    const result = sourceAccess.searchSource(root, "createFileRoute", {
      limit: 5,
      under: "src/routes",
    });
    expect(result.ok).toBe(true);
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0].path).toMatch(/^src\/routes\//);
  });

  it("exposes no write path", () => {
    expect(Object.keys(sourceAccess)).not.toContain("writeSource");
  });
});

describe("self-improvement evidence", () => {
  it("ranks real implementation files above docs and tests", async () => {
    const root = process.cwd();
    (globalThis as unknown as { window: unknown }).window = globalThis;
    (globalThis as unknown as { friday: unknown }).friday = {
      selfReadSource: async (rel: string) => sourceAccess.readSource(root, rel),
      selfSearchSource: async (q: string, o: unknown) => sourceAccess.searchSource(root, q, o),
    };
    const { devPipeline } = await import("../../src/lib/friday/self/dev-pipeline");
    const hits: string[] = await (
      devPipeline as unknown as {
        locate: (r: string, a: string[]) => Promise<string[]>;
      }
    ).locate("the voice wake-word keeps missing my greeting", ["voice"]);
    expect(hits.length).toBeGreaterThan(0);
    // Code first: docs mention every keyword, so they must not outrank source.
    expect(hits[0]).not.toMatch(/\.md /);
    expect(hits.some((h) => h.startsWith("src/"))).toBe(true);
  });
});
