import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { ownEarsRows } = require("../../electron/voice-verify.cjs");
const { cleanOwnEars } = require("../../electron/stt.cjs");

const IDS = ["friday-ear-swift", "friday-ear-quick", "friday-ear-english"];
const ear = (catalogId: string, status: string, reason = "", ms = 12) => ({
  id: catalogId.replace("friday-ear-", ""),
  label: `Ear ${catalogId}`,
  catalogId,
  status,
  reason,
  ms,
});
const reply = (ears: unknown[]) => async () => ({
  ok: true,
  stdout: `${JSON.stringify({ ok: true, local: true, ears })}\n`,
  stderr: "",
});

describe("own ears in the Doctor", () => {
  it("asks the kernel for --ears-self-test with the shared 120 s timeout", async () => {
    let args: string[] = [];
    let timeout = 0;
    await ownEarsRows("py", ["-3"], async (_e: string, a: string[], t: number) => {
      args = a;
      timeout = t;
      return { ok: true, stdout: "{}", stderr: "" };
    });
    expect(args[0]).toBe("-3");
    expect(args).toContain("--ears-self-test");
    expect(timeout).toBe(120000);
  });

  it("shows ok, missing, refused and failed as one row per ear", async () => {
    const rows = await ownEarsRows(
      "py",
      [],
      reply([
        ear(IDS[0]!, "ok"),
        ear(IDS[1]!, "missing", "not installed"),
        ear(IDS[2]!, "refused", "low memory"),
      ]),
    );
    expect(rows.map((r: { id: string }) => r.id)).toEqual(IDS);
    expect(rows[0]).toMatchObject({ ok: true, required: false });
    expect(rows[1]).toMatchObject({ ok: false });
    expect(rows[1].detail).toContain("not installed");
    expect(rows[2].detail).toContain("low memory");
    const failed = await ownEarsRows("py", [], reply([ear(IDS[0]!, "failed", "bad graph")]));
    expect(failed[0]).toMatchObject({ ok: false });
    expect(failed[0].detail).toContain("bad graph");
    expect(failed[1].detail).toContain("did not list");
  });

  it("gives three visible not-ready rows when the kernel is down, slow or throws", async () => {
    const down = await ownEarsRows("py", [], async () => ({
      ok: false,
      stdout: "",
      stderr: "boom",
    }));
    const slow = await ownEarsRows("py", [], async () => ({
      ok: false,
      stdout: "",
      stderr: "",
      timedOut: true,
    }));
    const thrown = await ownEarsRows("py", [], async () => {
      throw new Error("spawn failed");
    });
    for (const rows of [down, slow, thrown]) {
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.ok).toBe(false);
        expect(String(row.detail).length).toBeGreaterThan(3);
      }
    }
    expect(down[0].detail).toContain("boom");
    expect(slow[0].detail).toContain("timed out");
    expect(thrown[0].detail).toContain("spawn failed");
  });

  it("trims the ownEars status list to plain values", () => {
    const list = cleanOwnEars([
      {
        id: "swift",
        label: "FRIDAY Ear Swift",
        catalogId: IDS[0],
        ready: true,
        loaded: false,
        error: null,
      },
      { nope: 1 },
    ]);
    expect(list).toEqual([
      {
        id: "swift",
        label: "FRIDAY Ear Swift",
        catalogId: IDS[0],
        ready: true,
        loaded: false,
        error: "",
      },
    ]);
    expect(cleanOwnEars("x")).toEqual([]);
  });

  it("no longer says the three ears are not routed", () => {
    const text = readFileSync("src/lib/friday/voice-engine/voice-engine-table.ts", "utf8");
    expect(text).not.toMatch(/not routed in kernel\/stt\.py yet/);
    for (const id of IDS) expect(text).toContain(id);
  });
});
