import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { followPending, isThenable } from "../../src/lib/friday/pending-action";
import { Button } from "../../src/components/ui/button";
import { iconForLabel } from "../../src/components/friday/button-icons";

describe("pending action", () => {
  it("recognises only thenables", () => {
    expect(isThenable(Promise.resolve())).toBe(true);
    expect(isThenable({ then: () => undefined })).toBe(true);
    expect(isThenable(undefined)).toBe(false);
    expect(isThenable(3)).toBe(false);
    expect(isThenable({})).toBe(false);
  });

  it("calls done on success and reports nothing", async () => {
    let done = 0;
    const failures: string[] = [];
    followPending(
      Promise.resolve(1),
      () => done++,
      "Scan",
      (t) => failures.push(t),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(1);
    expect(failures).toEqual([]);
  });

  it("calls done and reports a readable failure on rejection", async () => {
    let done = 0;
    const failures: string[][] = [];
    followPending(
      Promise.reject(new Error("kernel offline")),
      () => done++,
      "Scan",
      (t, d) => failures.push([t, d]),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(done).toBe(1);
    expect(failures).toEqual([["Scan failed", "kernel offline"]]);
  });

  it("stays quiet when a cancelled request rejects", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const failures: string[] = [];
    followPending(
      Promise.reject(abort),
      () => undefined,
      "Scan",
      (t) => failures.push(t),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(failures).toEqual([]);
  });

  it("renders an idle button unchanged and gives the new verbs their icons", () => {
    const html = renderToStaticMarkup(
      createElement(Button, { onClick: () => undefined }, "Refresh"),
    );
    expect(html).not.toContain("data-pending");
    expect(html).not.toContain("aria-busy");
    for (const label of ["Forge", "Archive", "System wiring", "Cast", "List files"]) {
      expect(iconForLabel(label), label).not.toBeNull();
    }
  });
});
