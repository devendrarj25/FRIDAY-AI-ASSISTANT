/**
 * Review fixes on the capability lists: one plain vocabulary, plain count sentences, a focus that is never lost,
 * a badge that is valid inside a row, a reset that can never stay "working", rows that keep their identity when the
 * list shifts, an error with Retry when the list cannot be read, and an Update content report that does not go stale.
 * Drawn from fakes: no bridge, no clock, no DOM.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CapabilityBadge,
  ContentUpdateReport,
  ResetBuiltinView,
  type ResetBuiltinViewProps,
} from "../../src/components/friday/CapabilityBadge";
import {
  LIST_ERROR_TEXT,
  RESET_CONFIRM_TEXT,
  RESET_NO_ANSWER_TEXT,
  RESET_UNFINISHED_TEXT,
  alreadyInReleaseSummary,
  badgeSpec,
  itemCount,
  keptYoursSummary,
  resetBuiltin,
  rowFocusTarget,
  runBuiltinReset,
  settleCapabilityList,
  type CapabilityIndex,
} from "../../src/lib/friday/capability-trees";

const read = (file: string) =>
  readFileSync(path.join(import.meta.dirname, "..", "..", file), "utf8").replace(/\r\n/g, "\n");

type Bridge = Record<string, unknown>;
const globals = globalThis as unknown as { window?: { friday?: Bridge } };
const setBridge = (bridge?: Bridge) => {
  if (bridge) globals.window = { friday: { isDesktop: true, ...bridge } };
  else delete globals.window;
};
afterEach(() => setBridge());

const view = (over: Partial<ResetBuiltinViewProps> = {}) =>
  renderToStaticMarkup(
    createElement(ResetBuiltinView, {
      status: "overridden",
      name: "Daily brief",
      phase: { kind: "idle" },
      onAsk: vi.fn(),
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
      onRetry: vi.fn(),
      onDismiss: vi.fn(),
      ...over,
    }),
  );

describe("one plain vocabulary: built-in for the item, release for the version", () => {
  it.each([
    ["builtin", "Built-in"],
    ["custom", "Custom"],
    ["overridden", "Your copy"],
    ["forked-stale", "Out of date"],
    ["removed", "Not in release"],
    ["identical", "Same as built-in"],
  ] as const)("%s reads %s", (status, label) => {
    expect(badgeSpec(status)?.label).toBe(label);
  });

  it("the two hints that explain a state say it in full sentences", () => {
    expect(badgeSpec("forked-stale")?.hint).toBe(
      "The release changed this item; your copy is older.",
    );
    expect(badgeSpec("removed")?.hint).toBe("This release no longer includes it. Your copy stays.");
  });

  it("no label uses the old jargon", () => {
    const labels = (
      ["builtin", "custom", "overridden", "forked-stale", "removed", "identical"] as const
    ).map((status) => badgeSpec(status)?.label ?? "");
    for (const label of labels) expect(label).not.toMatch(/forked|stale|overridden|removed/i);
  });

  it("the reset confirm and the error fallbacks are the decided sentences", () => {
    expect(RESET_CONFIRM_TEXT).toBe(
      "A backup is saved first. Then your copy is removed and the built-in version is used.",
    );
    expect(RESET_NO_ANSWER_TEXT).toBe("FRIDAY got no answer. Nothing was changed. Try again.");
    expect(RESET_UNFINISHED_TEXT).toBe(
      "The reset did not finish. Check the list before you try again.",
    );
    expect(LIST_ERROR_TEXT).toMatch(/could not be read/);
  });

  it("an empty answer and a refusal without a reason use those sentences", async () => {
    setBridge({ resetBuiltinCapability: async () => undefined });
    expect(await resetBuiltin("x")).toEqual({ ok: false, error: RESET_NO_ANSWER_TEXT });
    setBridge({ resetBuiltinCapability: async () => ({ ok: false }) });
    expect(await resetBuiltin("x")).toEqual({ ok: false, error: RESET_UNFINISHED_TEXT });
  });
});

describe("counts read as sentences", () => {
  it("itemCount and the two summaries handle one and many", () => {
    expect(itemCount(1)).toBe("1 item");
    expect(itemCount(0)).toBe("0 items");
    expect(itemCount(3)).toBe("3 items");
    expect(keptYoursSummary(1)).toBe("Kept your version of 1 item");
    expect(keptYoursSummary(4)).toBe("Kept your version of 4 items");
    expect(alreadyInReleaseSummary(1)).toBe("1 item is already in this release");
    expect(alreadyInReleaseSummary(2)).toBe("2 items are already in this release");
  });

  it("the report shows the reason each owner item was kept", () => {
    const html = renderToStaticMarkup(
      createElement(ContentUpdateReport, {
        keptYours: [
          {
            id: "skills/core/gamma",
            tree: "skills",
            version: "2.0.0",
            incomingVersion: "1.5.0",
            provenance: "user",
            reason: "edited since it landed",
          },
          {
            id: "agents/core/delta",
            tree: "agents",
            version: null,
            incomingVersion: null,
            provenance: "user",
          },
        ],
      }),
    );
    expect(html).toContain("Kept your version of 2 items");
    expect(html).toContain("edited since it landed");
    expect(html).toContain("yours v2.0.0");
    expect(html).toContain("agents/core/delta");
  });
});

describe("the badge is valid inside a row and says its hint once", () => {
  const html = renderToStaticMarkup(createElement(CapabilityBadge, { status: "forked-stale" }));

  it("renders a span, never a div, so it can sit inside a span", () => {
    expect(html.startsWith("<span")).toBe(true);
    expect(html).not.toContain("<div");
  });

  it("carries the hint as the title only (no second hidden copy)", () => {
    expect(html).toContain('title="The release changed this item; your copy is older."');
    expect(html).not.toContain("sr-only");
  });
});

describe("the reset control announces and keeps the owner's place", () => {
  it("a working reset is a polite status", () => {
    const html = view({ phase: { kind: "working" } });
    expect(html).toMatch(/role="status"[^>]*>[^<]*Resetting Daily brief/);
  });

  it("an error wraps long text and stays readable", () => {
    const html = view({ phase: { kind: "error", message: "x".repeat(200) } });
    expect(html).toMatch(/role="alert"[^>]*class="[^"]*break-words/);
    expect(html).toMatch(/role="alert"[^>]*class="[^"]*max-w-prose/);
  });

  it("focus goes to the row when the button disappears, else to the page", () => {
    const row: { isConnected: boolean; id?: string } = { isConnected: true, id: "row" };
    const main: { isConnected: boolean; id?: string } = { isConnected: true, id: "main" };
    expect(rowFocusTarget(row, () => main)).toBe(row);
    expect(rowFocusTarget({ isConnected: false }, () => main)).toBe(main);
    expect(rowFocusTarget(null, () => main)).toBe(main);
    expect(rowFocusTarget(null, () => null)).toBeNull();
  });

  it("the view moves focus to Retry on an error and back to the button after Dismiss; the control hands focus to the row", () => {
    const source = read("src/components/friday/CapabilityBadge.tsx");
    expect(source).toMatch(/phase\.kind === "error"[\s\S]{0,200}retryRef\.current\?\.focus\(\)/);
    expect(source).toContain("rowFocusTarget(");
    expect(source).toMatch(/closest(<[^>]+>)?\(ROW_SELECTOR\)/);
    expect(source).not.toMatch(/setInterval|setTimeout|requestAnimationFrame/);
  });
});

describe("a reset can never stay working", () => {
  it("a throw from the reset itself ends as an error with a next step", async () => {
    const out = await runBuiltinReset({
      id: "x",
      name: "X",
      reset: async () => {
        throw new Error("boom");
      },
      refresh: vi.fn(),
      notify: { success: vi.fn() },
    });
    expect(out).toEqual({ ok: false, error: RESET_UNFINISHED_TEXT });
  });

  it("a list that fails to refresh after a good reset is still a success, with a warning", async () => {
    const warning = vi.fn();
    const out = await runBuiltinReset({
      id: "x",
      name: "X",
      reset: async () => ({ ok: true, id: "x" }),
      refresh: async () => {
        throw new Error("list down");
      },
      notify: { success: vi.fn(), warning },
    });
    expect(out).toEqual({ ok: true });
    expect(warning).toHaveBeenCalledTimes(1);
    expect(String(warning.mock.calls[0]?.[0])).toMatch(/list/i);
  });

  it("start() sets the final phase in a finally", () => {
    const source = read("src/components/friday/CapabilityBadge.tsx");
    expect(source).toMatch(
      /try \{[\s\S]{0,400}runBuiltinReset[\s\S]{0,600}\} finally \{[\s\S]{0,80}setPhase/,
    );
  });
});

describe("the list hook reports a failed read instead of an empty page", () => {
  const index = (n: number): CapabilityIndex => ({
    items: [],
    counts: { skills: { total: n, enabled: n } },
    scannedAt: n,
    appRoot: null,
    workspaceRoot: null,
  });

  it("a good read replaces the list and clears the error", () => {
    expect(settleCapabilityList(index(1), index(2))).toEqual({ index: index(2), error: null });
  });

  it("a failed read keeps what was shown and names the error", () => {
    expect(settleCapabilityList(index(1), null)).toEqual({
      index: index(1),
      error: LIST_ERROR_TEXT,
    });
    expect(settleCapabilityList(null, null)).toEqual({ index: null, error: LIST_ERROR_TEXT });
  });

  it("the hook exposes error and refresh, and every route shows the shared ErrorState with Retry", () => {
    expect(read("src/lib/friday/capability-trees.ts")).toMatch(/error,\s*\n\s*refresh,/);
    for (const route of ["skills", "agents", "modules", "plugins", "tools", "workflows"]) {
      const source = read(`src/routes/${route}.tsx`);
      expect(source, route).toContain('from "@/components/friday/PageStates"');
      expect(source, route).toMatch(/<ErrorState[\s\S]{0,260}onRetry=\{/);
      expect(source, route).toMatch(/\{[^}]*\berror\b[^}]*\} = useCapabilities/);
    }
  });
});

describe("rows keep their identity when the list shifts", () => {
  it("DataTable takes an optional rowKey and falls back to the index", () => {
    const source = read("src/components/friday/ui.tsx");
    expect(source).toMatch(/rowKey\?: \(index: number\) => string \| number/);
    expect(source).toMatch(/key=\{rowKey \? rowKey\(i\) : i\}/);
  });

  it.each(["skills", "agents", "plugins", "workflows"])(
    "%s keys its rows by capability id",
    (route) => {
      const source = read(`src/routes/${route}.tsx`);
      expect(source).toMatch(/<DataTable[\s\S]{0,400}rowKey=\{/);
    },
  );
});

describe("tools passes the toggle-busy flag to the reset button", () => {
  it("the toggle is guarded while it runs, and Reset follows the same flag", () => {
    const source = read("src/routes/tools.tsx");
    expect(source).toMatch(/const \[busyId, setBusyId\]/);
    expect(source).toMatch(/<ResetBuiltinButton[\s\S]{0,300}disabled=\{Boolean\(busyId\)\}/);
    expect(source).toMatch(/finally\b[\s\S]{0,40}setBusyId\(null\)/);
  });
});

describe("Update content clears a stale report", () => {
  const source = read("src/components/friday/settings/GithubUpdates.tsx");

  it("a changed checked ref and a reload both clear it", () => {
    expect(source).toMatch(
      /if \(check\?\.ref !== reportRef\) \{\s*setReportRef\(check\?\.ref\);\s*setContentReport\(null\);\s*\}/,
    );
    expect(source).toMatch(
      /const reload = useCallback\(async \(\) => \{\s*setContentReport\(null\);/,
    );
  });

  it("the fresh report is set after the reload, so reload does not erase it", () => {
    const run = source.slice(source.indexOf('run("content"'));
    expect(run.indexOf("await reload()")).toBeGreaterThan(-1);
    expect(run.indexOf("await reload()")).toBeLessThan(run.indexOf("setContentReport({"));
  });
});
