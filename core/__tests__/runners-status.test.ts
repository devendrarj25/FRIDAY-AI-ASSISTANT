/**
 * Pinned local runners against the newest official release. Nothing here reaches the network: a fake fetch stands
 * in for GitHub, and no result depends on today's date.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const status = require("../../scripts/runners-status.cjs") as {
  compareTags: (a: string, b: string) => -1 | 0 | 1 | null;
  classify: (pinned: string, newest: string | null) => "current" | "behind" | "unknown";
  newestTag: (repo: string, options: { fetchImpl: unknown }) => Promise<string | null>;
  pinnedRunners: (config: unknown) => Array<{ id: string; repo: string; pinned: string }>;
  report: (
    config: unknown,
    options: { fetchImpl: unknown },
  ) => Promise<Array<{ id: string; state: string }>>;
  format: (rows: unknown, checked: string) => string;
};

describe("comparing release tags", () => {
  it("orders llama.cpp build numbers and semver tags by number, not by text", () => {
    expect(status.compareTags("b9000", "b11609")).toBe(-1);
    expect(status.compareTags("b12230", "b12230")).toBe(0);
    expect(status.compareTags("v0.40.15", "v0.40.4")).toBe(1);
    expect(status.compareTags("v0.8.6", "v0.10.0")).toBe(-1);
    expect(status.compareTags("v1.2", "v1.2.0")).toBe(0);
  });

  it("does not compare what it cannot read", () => {
    expect(status.compareTags("v1.0.0-rc1", "v1.0.0")).toBeNull();
    expect(status.compareTags("", "b1")).toBeNull();
    expect(status.classify("b1", null)).toBe("unknown");
    expect(status.classify("nightly", "b2")).toBe("unknown");
  });

  it("says behind only when the newest is really newer", () => {
    expect(status.classify("b11609", "b12230")).toBe("behind");
    expect(status.classify("b12230", "b12230")).toBe("current");
    expect(status.classify("b12231", "b12230")).toBe("current");
  });
});

describe("reading the newest release", () => {
  const ok = (tag: string) => async () => ({ ok: true, json: async () => ({ tag_name: tag }) });

  it("returns the tag, and null for a refusal, a failure or a body without one", async () => {
    expect(await status.newestTag("a/b", { fetchImpl: ok("v1.2.3") })).toBe("v1.2.3");
    expect(await status.newestTag("a/b", { fetchImpl: async () => ({ ok: false }) })).toBeNull();
    expect(
      await status.newestTag("a/b", {
        fetchImpl: async () => {
          throw new Error("offline");
        },
      }),
    ).toBeNull();
    expect(
      await status.newestTag("a/b", {
        fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
      }),
    ).toBeNull();
  });

  it("builds one row per pinned runner and never fails when GitHub is out of reach", async () => {
    const config = {
      runners: [
        { id: "ollama", name: "Ollama", release: { repo: "ollama/ollama", tag: "v0.40.4" } },
        { id: "lmstudio", name: "LM Studio", release: null },
        {
          id: "llamacpp",
          name: "llama.cpp",
          release: { repo: "ggml-org/llama.cpp", tag: "b12230" },
        },
      ],
    };
    expect(status.pinnedRunners(config).map((row) => row.id)).toEqual(["ollama", "llamacpp"]);
    const rows = await status.report(config, {
      fetchImpl: async (url: string) =>
        url.includes("ollama/ollama")
          ? { ok: true, json: async () => ({ tag_name: "v0.40.15" }) }
          : { ok: false },
    });
    expect(rows.map((row) => [row.id, row.state])).toEqual([
      ["ollama", "behind"],
      ["llamacpp", "unknown"],
    ]);
    const text = status.format(rows, "2026-11-09");
    expect(text).toContain("BEHIND");
    expect(text).toContain("record its SHA-256");
    expect(text).toContain("UNKNOWN");
  });
});

describe("the pins that setup downloads", () => {
  const config = JSON.parse(readFileSync("config/local-runners.json", "utf8")) as {
    runners: Array<{
      id: string;
      release: {
        tag: string;
        asset: string;
        url: string;
        sha256: string | null;
        bytes: number;
      } | null;
    }>;
  };
  const pin = (id: string) => config.runners.find((row) => row.id === id)!.release!;

  it("names the same tag in the asset, the address and the pin, with a SHA-256 and a size", () => {
    for (const id of ["ollama", "llamacpp"]) {
      const release = pin(id);
      expect(release.url, id).toContain(`/download/${release.tag}/${release.asset}`);
      expect(release.sha256, id).toMatch(/^[0-9a-f]{64}$/);
      expect(release.bytes, id).toBeGreaterThan(1_000_000);
    }
    expect(pin("llamacpp").asset).toBe(`llama-${pin("llamacpp").tag}-bin-win-cpu-x64.zip`);
  });

  it("is run by Doctor as information that cannot fail the run", () => {
    const doctor = readFileSync("scripts/doctor.cjs", "utf8");
    expect(doctor).toContain('node("runners-status.cjs")');
    const script = readFileSync("scripts/runners-status.cjs", "utf8");
    expect(script).toMatch(/process\.exitCode =\s*args\.includes\("--strict"\)\s*&&\s*rows\.some/);
    expect(readFileSync("package.json", "utf8")).toContain(
      '"runners:status": "node scripts/runners-status.cjs"',
    );
  });
});
