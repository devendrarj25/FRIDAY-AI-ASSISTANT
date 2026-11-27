/**
 * Built-in versus your-own layers in the six capability lists: the badge per status, the Reset to built-in
 * button (confirm, working, error with Retry, success, desktop-only), the live refresh afterwards, and the
 * "Update content" report of what was already in the release or kept as yours. Drawn from fakes: no bridge, no clock.
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
  ResetConfirmBody,
  type ResetBuiltinViewProps,
} from "../../src/components/friday/CapabilityBadge";
import {
  RESET_CONFIRM_TEXT,
  RESET_DESKTOP_ONLY,
  badgeSpec,
  canResetBuiltin,
  resetBuiltin,
  resetErrorText,
  runBuiltinReset,
  type CapabilityStatus,
} from "../../src/lib/friday/capability-trees";
import { githubUpdateNow } from "../../src/lib/friday/github-updates";

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

const badge = (status?: CapabilityStatus, origin?: string) =>
  renderToStaticMarkup(createElement(CapabilityBadge, { status, origin }));

describe("the badge says which layer an item is", () => {
  it.each([
    ["builtin", "Built-in", "Ships with FRIDAY"],
    ["identical", "Built-in", "Ships with FRIDAY"],
    ["custom", "Custom", "Added by you"],
    ["overridden", "Overridden", "Your copy wins"],
    ["forked-stale", "Forked-stale", "The release changed this item, your fork is older"],
    ["removed", "Removed", "no longer ships it"],
  ] as const)("%s shows %s with its meaning", (status, label, meaning) => {
    const html = badge(status);
    expect(html).toContain(`>${label}<`);
    expect(html).toContain(meaning);
    expect(html).toContain(`data-capability-status="${status}"`);
  });

  it("falls back to the origin for a row without a status, and shows nothing when nothing is known", () => {
    expect(badge(undefined, "app")).toContain(">Built-in<");
    expect(badge(undefined, "workspace")).toContain(">Custom<");
    expect(badge(undefined, undefined)).toBe("");
    expect(badgeSpec(undefined, "")).toBeNull();
  });

  it("uses only existing design tokens (no raw colours)", () => {
    for (const status of ["overridden", "forked-stale", "removed"] as const)
      expect(badgeSpec(status)?.tone ?? "").not.toMatch(/#|rgb|oklch|\[/);
  });
});

describe("only your own copy of a built-in can be reset", () => {
  it.each([
    ["overridden", true],
    ["forked-stale", true],
    ["builtin", false],
    ["custom", false],
    ["identical", false],
    ["removed", false],
    [undefined, false],
  ] as const)("%s -> %s", (status, expected) => {
    expect(canResetBuiltin(status)).toBe(expected);
    expect(view({ status }).includes("Reset to built-in")).toBe(expected);
  });

  it("an idle row has a named, enabled button", () => {
    const html = view();
    expect(html).toContain('aria-label="Reset Daily brief to built-in"');
    expect(html).not.toContain('disabled=""');
    expect(html).toContain("Reset to built-in");
  });

  it("is locked while another action on the row runs, and while it works", () => {
    expect(view({ disabled: true })).toContain('disabled=""');
    const working = view({ phase: { kind: "working" } });
    expect(working).toContain("Resetting…");
    expect(working).toContain('aria-busy="true"');
    expect(working).toContain('disabled=""');
  });

  it("the confirm tells that a backup is saved first", () => {
    const html = renderToStaticMarkup(createElement(ResetConfirmBody, { name: "Daily brief" }));
    expect(html).toContain("Daily brief");
    expect(html).toContain(
      "A backup copy is saved first, then your copy is removed and the release version is used.",
    );
    expect(RESET_CONFIRM_TEXT).toContain("backup copy is saved first");
  });

  it("an error is announced and has a Retry and a Dismiss", () => {
    const html = view({ phase: { kind: "error", message: "No FRIDAY workspace is selected." } });
    expect(html).toContain('role="alert"');
    expect(html).toContain("No FRIDAY workspace is selected.");
    expect(html).toContain('aria-label="Retry resetting Daily brief to built-in"');
    expect(html).toContain("Dismiss");
  });
});

describe("the renderer wrapper", () => {
  it("is a no-op outside the desktop app", async () => {
    expect(await resetBuiltin("skills/core/brief")).toEqual({
      ok: false,
      error: RESET_DESKTOP_ONLY,
    });
    setBridge({}); // a bridge object without the method
    expect(await resetBuiltin("x")).toEqual({ ok: false, error: "desktop-only" });
    globals.window = { friday: { resetBuiltinCapability: vi.fn() } }; // not the desktop shell
    expect(await resetBuiltin("x")).toEqual({ ok: false, error: "desktop-only" });
  });

  it("passes the id to the bridge and returns its answer", async () => {
    const reset = vi.fn(async () => ({ ok: true, id: "skills/core/brief", backup: "/b/brief-1" }));
    setBridge({ resetBuiltinCapability: reset });
    expect(await resetBuiltin("skills/core/brief")).toEqual({
      ok: true,
      id: "skills/core/brief",
      backup: "/b/brief-1",
    });
    expect(reset).toHaveBeenCalledWith("skills/core/brief");
  });

  it("turns a refusal, an empty answer and a throw into an error", async () => {
    setBridge({ resetBuiltinCapability: async () => ({ ok: false, error: "No copy." }) });
    expect(await resetBuiltin("x")).toEqual({ ok: false, error: "No copy." });
    setBridge({ resetBuiltinCapability: async () => ({ ok: false }) });
    expect((await resetBuiltin("x")).error).toBeTruthy();
    setBridge({ resetBuiltinCapability: async () => undefined });
    expect((await resetBuiltin("x")).ok).toBe(false);
    setBridge({
      resetBuiltinCapability: async () => {
        throw new Error("channel closed");
      },
    });
    expect(await resetBuiltin("x")).toEqual({ ok: false, error: "channel closed" });
  });
});

describe("one reset, then the list is read again from its source", () => {
  it("success: toast, then refresh (in that order)", async () => {
    const order: string[] = [];
    const out = await runBuiltinReset({
      id: "skills/core/brief",
      name: "Daily brief",
      reset: async (id) => {
        order.push(`reset:${id}`);
        return { ok: true, id };
      },
      refresh: async () => {
        order.push("refresh");
      },
      notify: { success: () => order.push("toast") },
    });
    expect(out).toEqual({ ok: true });
    expect(order).toEqual(["reset:skills/core/brief", "toast", "refresh"]);
  });

  it("failure: no toast, no refresh, the error is returned for Retry", async () => {
    const refresh = vi.fn();
    const success = vi.fn();
    const out = await runBuiltinReset({
      id: "x",
      name: "X",
      reset: async () => ({ ok: false, error: "Refusing to remove outside the workspace." }),
      refresh,
      notify: { success },
    });
    expect(out).toEqual({ ok: false, error: "Refusing to remove outside the workspace." });
    expect(refresh).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
  });

  it("outside the desktop app the owner reads a plain sentence", async () => {
    const out = await runBuiltinReset({
      id: "x",
      name: "X",
      refresh: vi.fn(),
      notify: { success: vi.fn() },
    });
    expect(out).toEqual({ ok: false, error: "This change needs the FRIDAY desktop app." });
    expect(resetErrorText()).toBe("This change needs the FRIDAY desktop app.");
    expect(resetErrorText("Nope")).toBe("Nope");
  });

  it("a retry after an error runs the same reset again", async () => {
    const answers = [
      { ok: false, error: "disk busy" },
      { ok: true, id: "x" },
    ];
    const reset = vi.fn(async () => answers.shift() as { ok: boolean });
    const base = { id: "x", name: "X", reset, refresh: vi.fn(), notify: { success: vi.fn() } };
    expect((await runBuiltinReset(base)).ok).toBe(false);
    expect((await runBuiltinReset(base)).ok).toBe(true);
    expect(reset).toHaveBeenCalledTimes(2);
    expect(base.refresh).toHaveBeenCalledTimes(1);
  });
});

describe("the six capability lists show the badge and the reset", () => {
  const routes = ["skills", "agents", "modules", "plugins", "tools", "workflows"] as const;

  it.each(routes)("%s imports the shared badge and shows one per row", (route) => {
    const source = read(`src/routes/${route}.tsx`);
    expect(source).toContain('from "@/components/friday/CapabilityBadge"');
    expect(source).toContain("<CapabilityBadge");
    expect(source).toMatch(/status=\{[^}]+\}/);
  });

  it.each(routes)("%s offers Reset to built-in from the shared control, and re-lists", (route) => {
    const source = read(`src/routes/${route}.tsx`);
    expect(source).toContain("<ResetBuiltinButton");
    expect(source).toMatch(/<ResetBuiltinButton[\s\S]{0,300}refresh=\{refresh\w*\}/);
  });

  it("the shared control returns its promise to the Button and starts no timer", () => {
    const source = read("src/components/friday/CapabilityBadge.tsx");
    expect(source).not.toMatch(/onClick=\{\(\) =>\s+void /);
    expect(source).not.toMatch(/setInterval|setTimeout/);
    expect(source).toContain("onClick={props.onRetry}");
  });

  it("the typed row carries the layer fields the main process sends", () => {
    const source = read("src/lib/friday/capability-trees.ts");
    for (const field of ["status?:", "fork?:", "identicalCopy?:", "provenance?:"])
      expect(source).toContain(field);
    expect(source).toContain("resetBuiltinCapability");
  });
});

describe("Update content reports what it left alone", () => {
  const shipped = [
    {
      id: "skills/core/alpha",
      tree: "skills",
      version: "1.0.0",
      builtinVersion: "1.2.0",
      reason: "already in this release",
    },
    {
      id: "agents/core/beta",
      tree: "agents",
      version: null,
      builtinVersion: null,
      reason: "already in this release",
    },
  ];
  const mine = [
    {
      id: "skills/core/gamma",
      tree: "skills",
      version: "2.0.0",
      incomingVersion: "1.5.0",
      provenance: "user",
    },
  ];

  it("lists the count and the ids of items already in this release", () => {
    const html = renderToStaticMarkup(
      createElement(ContentUpdateReport, { alreadyInRelease: shipped }),
    );
    expect(html).toContain("2 items already in this release");
    expect(html).toContain("skills/core/alpha");
    expect(html).toContain("agents/core/beta");
    expect(html).toContain("<details");
    expect(html).not.toContain("kept your version");
  });

  it("says how many of the owner's own items were kept", () => {
    const html = renderToStaticMarkup(createElement(ContentUpdateReport, { keptYours: mine }));
    expect(html).toContain("1 item kept your version");
    expect(html).toContain("skills/core/gamma");
    expect(html).not.toContain("already in this release");
  });

  it("shows nothing when nothing was skipped", () => {
    expect(renderToStaticMarkup(createElement(ContentUpdateReport, {}))).toBe("");
    expect(
      renderToStaticMarkup(
        createElement(ContentUpdateReport, { alreadyInRelease: [], keptYours: [] }),
      ),
    ).toBe("");
  });

  it("githubUpdateNow passes both lists from the importer through", async () => {
    setBridge({
      githubPull: async () => ({ ok: true, id: "scan-1", githubRef: "abc" }),
      applyImport: async () => ({
        ok: true,
        applied: 0,
        areas: [],
        backup: null,
        alreadyInRelease: shipped,
        keptYours: mine,
      }),
      githubRecord: async () => ({ ok: true }),
    });
    const result = await githubUpdateNow("abc", { contentOnly: true });
    expect(result.ok).toBe(true);
    expect(result.alreadyInRelease).toEqual(shipped);
    expect(result.keptYours).toEqual(mine);
  });

  it("githubUpdateNow gives empty lists when the importer sent none", async () => {
    setBridge({
      githubPull: async () => ({ ok: true, id: "scan-1", githubRef: "abc" }),
      applyImport: async () => ({ ok: true, applied: 3, areas: [], backup: null }),
      githubRecord: async () => ({ ok: true }),
    });
    const result = await githubUpdateNow("abc");
    expect(result.alreadyInRelease).toEqual([]);
    expect(result.keptYours).toEqual([]);
  });

  it("the Update content button shows the report and nothing else about it changed", () => {
    const source = read("src/components/friday/settings/GithubUpdates.tsx");
    expect(source).toContain("<ContentUpdateReport");
    expect(source).toContain("Update content");
    expect(source).toContain("{ contentOnly: true }");
  });
});
