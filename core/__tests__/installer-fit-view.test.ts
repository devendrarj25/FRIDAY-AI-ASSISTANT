/**
 * The Install Manager and Models page view-model (src/lib/friday/installer-fit.ts): three groups by what THIS PC can run,
 * version and update badges, the buttons a row may have, the notices, the refresh countdown. Real catalogue payloads for a
 * PC with no GPU and an NVIDIA 16 GB PC (the main process's own catalogue on fake facts and a fixed clock), plus table
 * tests on hand-made rows. Nothing here reads a real PC, a clock or the network.
 */
import { describe, expect, it } from "vitest";
import type { InstallerCatalog, InstallerCatalogRow } from "../../src/lib/friday/desktop";
import {
  bundleFit,
  catalogNotices,
  catalogPhase,
  checkedText,
  compareRows,
  consentWording,
  cudaHint,
  dialOf,
  doctorView,
  FIT_GROUPS,
  fitTitle,
  GROUP_WINDOW,
  groupRows,
  INSTALLER_SCOPES,
  installTargetOf,
  lastCheckedLine,
  needLines,
  reasonLines,
  refreshLabel,
  refreshOutcomeText,
  refreshWaitMs,
  rowActions,
  rowsInScope,
  sourceLabel,
  updateBadges,
  updateOutcome,
  windowRows,
} from "../../src/lib/friday/installer-fit";
import {
  FIXED_NOW,
  NO_GPU_PC,
  NVIDIA_16GB_PC,
  fakeRow,
  realCatalog,
  withRows,
} from "./helpers/installer-catalog-fixtures";

const group = (groups: ReturnType<typeof groupRows>, state: string) =>
  groups.find((g) => g.state === state)!;
const ids = (g: { rows: { id: string }[] }) => g.rows.map((r) => r.id);

describe("three groups on a PC with no graphics card", () => {
  const catalog = realCatalog(NO_GPU_PC);
  const groups = groupRows(catalog, { now: FIXED_NOW });

  it("lists the groups in order, with the not-supported one folded by default", () => {
    expect(groups.map((g) => g.title)).toEqual([
      "Ready for this PC",
      "Works with limits",
      "Not supported on this PC",
    ]);
    expect(groups.map((g) => g.collapsedByDefault)).toEqual([false, false, true]);
    expect(FIT_GROUPS.map((g) => fitTitle(g.state))).toEqual(groups.map((g) => g.title));
  });

  it("never drops a row: the three groups hold exactly the catalogue's rows, and agree with `split`", () => {
    const all = groups.flatMap((g) => g.rows.map((r) => r.id));
    expect(all.length).toBe(catalog.rows.length);
    expect(new Set(all).size).toBe(catalog.rows.length);
    expect(ids(group(groups, "supported")).sort()).toEqual([...catalog.split.supported].sort());
    expect(ids(group(groups, "unsupported")).sort()).toEqual([...catalog.split.unsupported].sort());
  });

  it("puts the NVIDIA-only rows under not supported with the plain reason, what they need and the alternative", () => {
    const unsupported = group(groups, "unsupported");
    const cuda = unsupported.rows.find((r) => r.id === "CUDA runtime libraries")!;
    expect(cuda.reasons).toEqual([
      { level: "block", text: "Needs an NVIDIA graphics card; none was found." },
    ]);
    expect(cuda.needs).toContain("an NVIDIA graphics card with CUDA");
    expect(cuda.needs).toContain("NVIDIA driver 527.41 or newer");
    expect(cuda.needs).toContain("a 1.2 GB download");
    const onnx = unsupported.rows.find((r) => r.id === "ONNX Runtime (GPU)")!;
    expect(onnx.alternative).toEqual({
      id: "ONNX Runtime (DirectML)",
      name: "ONNX Runtime (DirectML)",
    });
  });

  it("a supported row carries no needs list (only a row this PC cannot run does)", () => {
    for (const view of group(groups, "supported").rows) expect(view.needs).toEqual([]);
  });

  it("the Models scope shows the big speech models as not supported with their VRAM need", () => {
    const models = groupRows(catalog, { kinds: INSTALLER_SCOPES.models, now: FIXED_NOW });
    const medium = group(models, "unsupported").rows.find(
      (r) => r.id === "voice:faster-whisper-medium",
    )!;
    expect(medium.needs).toEqual([
      "2 GB of memory (RAM)",
      "3 GB of graphics memory (VRAM)",
      "1.9 GB of free disk",
      "a 1.4 GB download",
    ]);
    expect(medium.reasons[0]?.text).toMatch(/needs a graphics card/);
    expect(ids(group(models, "supported"))).toContain("voice:hindi-ear");
    expect(
      models.flatMap((g) => g.rows).every((r) => ["voice-model", "model"].includes(r.kind)),
    ).toBe(true);
  });

  it("scope and search narrow the list; an empty scope reads as empty", () => {
    expect(rowsInScope(catalog, INSTALLER_SCOPES.models)).toBeGreaterThan(10);
    expect(rowsInScope(catalog, [])).toBe(0);
    const search = groupRows(catalog, { query: "cuDNN", now: FIXED_NOW });
    expect(search.flatMap((g) => g.rows.map((r) => r.id))).toContain("cuDNN");
    const none = groupRows(catalog, { query: "no-such-row-anywhere", now: FIXED_NOW });
    expect(none.flatMap((g) => g.rows)).toEqual([]);
    // the search matches Hindi and symbols without throwing
    expect(() => groupRows(catalog, { query: "हिन्दी 100% & it's", now: FIXED_NOW })).not.toThrow();
  });
});

describe("an NVIDIA 16 GB PC", () => {
  const catalog = realCatalog(NVIDIA_16GB_PC, {
    detected: [{ id: "CUDA runtime libraries", installed: false }],
  });
  const groups = groupRows(catalog, { now: FIXED_NOW });

  it("has nothing it cannot run, and names the one row that works with a limit", () => {
    expect(group(groups, "unsupported").rows).toEqual([]);
    const limited = group(groups, "limited").rows;
    expect(limited.map((r) => r.id)).toEqual(["ONNX Runtime (GPU)"]);
    expect(limited[0]?.reasons[0]?.text).toMatch(
      /not installed; install the CUDA runtime libraries/,
    );
  });

  it("gives the CUDA runtime row its hint", () => {
    const row = catalog.rows.find((r) => r.id === "CUDA runtime libraries")!;
    expect(row.fit.state).toBe("supported");
    expect(cudaHint(row)).toBe("GPU found; install the CUDA runtime libraries");
    expect(cudaHint({ ...row, installed: true })).toBeNull();
    expect(cudaHint(fakeRow({ id: "ripgrep" }))).toBeNull();
    const view = group(groups, "supported").rows.find((r) => r.id === "CUDA runtime libraries")!;
    expect(view.hint).toBe("GPU found; install the CUDA runtime libraries");
  });

  it("shows the builds llama.cpp would use for this card, best first", () => {
    const view = group(groups, "supported").rows.find((r) => r.id === "llama.cpp")!;
    expect(view.engineLine).toMatch(/^Builds for this PC, best first: cuda/);
  });

  it("is a different list from the no-GPU PC for the same rows", () => {
    const noGpu = realCatalog(NO_GPU_PC);
    expect(catalog.split.unsupported.length).toBe(0);
    expect(noGpu.split.unsupported.length).toBeGreaterThan(0);
    expect(catalog.rows.length).toBe(noGpu.rows.length);
  });
});

describe("update badges (table)", () => {
  const cases: [Partial<InstallerCatalogRow>, string[]][] = [
    [
      { updateStatus: "update", installedVersion: "1.0", latestVersion: "1.1" },
      ["Update available"],
    ],
    [{ updateStatus: "current" }, ["Up to date"]],
    [{ updateStatus: "unknown" }, ["Unknown"]],
    [{ updateStatus: "error", error: "no source answered" }, ["Check failed"]],
    [{ updateStatus: "current", stale: true }, ["Up to date", "Stale"]],
    [{ updateStatus: "update", stale: true }, ["Update available", "Stale"]],
  ];
  it.each(cases)("%j reads %j", (over, labels) => {
    expect(updateBadges(fakeRow(over)).map((b) => b.label)).toEqual(labels);
  });

  it("carries the version change and the error as the badge's title", () => {
    const [update] = updateBadges(
      fakeRow({ updateStatus: "update", installedVersion: "1.0", latestVersion: "1.1" }),
    );
    expect(update?.title).toBe("1.0 -> 1.1");
    const [failed] = updateBadges(fakeRow({ updateStatus: "error", error: "timeout" }));
    expect(failed?.title).toBe("timeout");
    expect(failed?.tone).toBe("destructive");
  });

  it("says a pinned answer cannot prove an update status", () => {
    const [unknown] = updateBadges(fakeRow({ updateStatus: "unknown", pinnedAnswer: true }));
    expect(unknown?.title).toMatch(/only knows the version it ships/);
  });
});

describe("words for the versions, the source and the age", () => {
  it("names the official source in plain words and keeps an unknown one as it is", () => {
    expect(sourceLabel("github-api")).toBe("GitHub releases");
    expect(sourceLabel("pypi-simple")).toBe("PyPI");
    expect(sourceLabel("hf-api")).toBe("Hugging Face");
    expect(sourceLabel("pinned")).toBe("pinned by FRIDAY");
    expect(sourceLabel("brand-new")).toBe("brand-new");
    expect(sourceLabel(null)).toBe("no source yet");
  });

  it("words when a row was checked", () => {
    expect(checkedText(null, FIXED_NOW)).toBe("not checked yet");
    expect(checkedText(FIXED_NOW - 180_000, FIXED_NOW)).toBe("checked 3 min ago");
    expect(checkedText(FIXED_NOW - 2_000, FIXED_NOW)).toBe("checked just now");
  });

  it("builds each row's installed, latest, source and checked text", () => {
    const row = fakeRow({ installed: true, installedVersion: "14.1.0", updateStatus: "update" });
    const [view] = group(
      groupRows(withRows(realCatalog(NO_GPU_PC), {}, { rows: [row] }), { now: FIXED_NOW }),
      "supported",
    ).rows;
    expect(view?.installedText).toBe("Installed 14.1.0");
    expect(view?.latestText).toBe("Latest 14.2.0");
    expect(view?.sourceText).toBe("GitHub releases");
    expect(view?.checkedText).toBe("checked 3 min ago");
    expect(fakeRow({ installed: false })).toBeTruthy();
    const unscanned = groupRows(
      withRows(
        realCatalog(NO_GPU_PC),
        {},
        { rows: [fakeRow({ installed: null, latestVersion: null })] },
      ),
      { now: FIXED_NOW },
    );
    const text = group(unscanned, "supported").rows[0]!;
    expect(text.installedText).toBe("Not scanned yet");
    expect(text.latestText).toBe("Latest unknown");
  });

  it("lists each need once, only the ones the catalogue names", () => {
    expect(needLines(null)).toEqual([]);
    expect(needLines(fakeRow().fit.needs)).toEqual([]);
    expect(
      needLines({
        ramGb: 32,
        vramGb: 24,
        diskGb: 40,
        cuda: true,
        driverMin: "560.0",
        vulkan: true,
        avx2: true,
        network: true,
        downloadGb: 18,
      }),
    ).toEqual([
      "32 GB of memory (RAM)",
      "24 GB of graphics memory (VRAM)",
      "40 GB of free disk",
      "an NVIDIA graphics card with CUDA",
      "NVIDIA driver 560.0 or newer",
      "a Vulkan driver",
      "a processor with AVX2",
      "a 18 GB download",
    ]);
  });

  it("orders reasons blockers first", () => {
    const fit = fakeRow().fit;
    expect(
      reasonLines({
        ...fit,
        reasons: [
          { code: "a", text: "note", level: "info" },
          { code: "b", text: "limit", level: "limit" },
          { code: "c", text: "block", level: "block" },
        ],
      }).map((l) => l.text),
    ).toEqual(["block", "limit", "note"]);
  });
});

describe("sorting and windowing", () => {
  const a = fakeRow({ id: "a", name: "Alpha" });
  const b = fakeRow({ id: "b", name: "Beta", installed: true });
  const c = fakeRow({ id: "c", name: "Gamma", updateStatus: "update", installed: true });
  const d = fakeRow({ id: "d", name: "Delta", fit: { ...fakeRow().fit, recommended: true } });

  it("recommended first, then updates, then not installed, then by name", () => {
    expect([a, b, c, d].sort(compareRows).map((r) => r.id)).toEqual(["d", "c", "a", "b"]);
  });

  it("is stable for equal names (by id)", () => {
    const x = fakeRow({ id: "x1", name: "Same" });
    const y = fakeRow({ id: "x2", name: "Same" });
    expect([y, x].sort(compareRows).map((r) => r.id)).toEqual(["x1", "x2"]);
  });

  it("cuts a long ready list but never the not-supported one", () => {
    const rows = Array.from({ length: GROUP_WINDOW + 5 }, (_, i) => i);
    expect(windowRows("supported", rows, false)).toEqual({
      shown: rows.slice(0, GROUP_WINDOW),
      hidden: 5,
    });
    expect(windowRows("supported", rows, true).hidden).toBe(0);
    expect(windowRows("limited", rows, false).hidden).toBe(5);
    expect(windowRows("unsupported", rows, false)).toEqual({ shown: rows, hidden: 0 });
    expect(windowRows("supported", rows.slice(0, 3), false).hidden).toBe(0);
  });
});

describe("what a row may do (buttons)", () => {
  const installer = { via: "installer", id: "ripgrep" } as const;
  const limitedFit = {
    ...fakeRow().fit,
    state: "limited" as const,
    reasons: [
      {
        code: "metered-network",
        text: "A 4 GB download on a metered connection.",
        level: "limit" as const,
      },
      {
        code: "on-battery",
        text: "On battery; a heavy GPU load will drain it.",
        level: "limit" as const,
      },
    ],
  };
  const unsupportedFit = {
    ...fakeRow().fit,
    state: "unsupported" as const,
    reasons: [{ code: "no-gpu", text: "Needs a graphics card.", level: "block" as const }],
  };

  it("offers Install on a supported, not installed row, with no confirm", () => {
    const { install, update } = rowActions(fakeRow(), { target: installer, busy: false });
    expect(install).toMatchObject({ label: "Install", disabled: false, confirm: null });
    expect(update).toBeNull();
  });

  it("a limited row asks a confirm that carries every reason line", () => {
    const { install } = rowActions(fakeRow({ fit: limitedFit }), {
      target: installer,
      busy: false,
    });
    expect(install?.confirm).toEqual({
      title: "Install ripgrep with limits?",
      lines: [
        "A 4 GB download on a metered connection.",
        "On battery; a heavy GPU load will drain it.",
      ],
    });
  });

  it("an unsupported row has no Install or Update button at all", () => {
    const row = fakeRow({ fit: unsupportedFit, updateStatus: "update" });
    expect(rowActions(row, { target: installer, busy: false })).toEqual({
      install: null,
      update: null,
      note: null,
    });
  });

  it("an installed row has no Install; an unscanned row has none either", () => {
    expect(
      rowActions(fakeRow({ installed: true }), { target: installer, busy: false }).install,
    ).toBeNull();
    expect(
      rowActions(fakeRow({ installed: null }), { target: installer, busy: false }).install,
    ).toBeNull();
  });

  it("voice and chat models say Download and go through the Models store", () => {
    const row = fakeRow({ id: "voice:hindi-ear", kind: "voice-model" });
    const action = rowActions(row, { target: { via: "models", id: "hindi-ear" }, busy: false });
    expect(action.install?.label).toBe("Download");
    expect(action.update).toBeNull();
  });

  it("shows Update only for a toolchain row with an update this PC can run", () => {
    const row = fakeRow({ installed: true, updateStatus: "update", latestVersion: "15.0.0" });
    expect(rowActions(row, { target: installer, busy: false }).update).toMatchObject({
      label: "Update",
      disabled: false,
      title: "Update ripgrep to 15.0.0",
    });
    expect(
      rowActions(
        { ...row, kind: "voice-model" },
        { target: { via: "models", id: "x" }, busy: false },
      ).update,
    ).toBeNull();
    expect(rowActions(row, { target: null, busy: false }).update).toBeNull();
    expect(
      rowActions({ ...row, updateStatus: "current" }, { target: installer, busy: false }).update,
    ).toBeNull();
  });

  it("disables both buttons while the row's own job runs", () => {
    const row = fakeRow({ installed: false, updateStatus: "update" });
    expect(rowActions(row, { target: installer, busy: true }).install?.disabled).toBe(true);
    const upd = fakeRow({ installed: true, updateStatus: "update" });
    expect(rowActions(upd, { target: installer, busy: true }).update?.disabled).toBe(true);
  });

  it("a runtime pack says it installs with its tool instead of showing a dead button", () => {
    const pack = fakeRow({ id: "pack:python", kind: "runtime-pack" });
    expect(rowActions(pack, { target: null, busy: false })).toMatchObject({
      install: null,
      note: "Installs together with the tool it belongs to.",
    });
  });
});

describe("which store installs a row", () => {
  const lookups = {
    installerHas: (id: string) => id === "ripgrep",
    voiceModelId: (id: string) => (id === "hindi-ear" ? "hindi-ear" : null),
    modelIdForTag: (tag: string) => (tag === "qwen3:4b" ? "qwen3-4b" : null),
  };
  const target = (id: string, kind: InstallerCatalogRow["kind"]) =>
    installTargetOf({ id, kind }, lookups);

  it.each([
    ["ripgrep", "tool", { via: "installer", id: "ripgrep" }],
    ["unknown-tool", "tool", null],
    ["llama.cpp", "engine", null],
    ["voice:hindi-ear", "voice-model", { via: "models", id: "hindi-ear" }],
    ["voice:missing", "voice-model", null],
    ["model:ollama:qwen3:4b", "model", { via: "models", id: "qwen3-4b" }],
    ["model:ollama:nothing:1b", "model", null],
    ["pack:python", "runtime-pack", null],
  ] as const)("%s (%s) -> %j", (id, kind, expected) => {
    expect(target(id, kind)).toEqual(expected);
  });
});

describe("the autonomy dial, the consent words and the update answer", () => {
  it.each([
    ["strict", false, "ask"],
    ["balanced", false, "balanced"],
    ["trusted", false, "balanced"],
    ["full", false, "full"],
    ["full", true, "ask"],
    [undefined, false, "ask"],
    ["something-new", false, "ask"],
  ] as const)("%s (halted %s) is the %s dial", (level, halted, dial) => {
    expect(dialOf(level, halted)).toBe(dial);
  });

  it("words the consent dialog for each dial that asks", () => {
    const row = {
      name: "ripgrep",
      installedVersion: "14.1.0",
      latestVersion: "14.2.0",
      source: "github-api",
    };
    const ask = consentWording(row, "ask");
    expect(ask.title).toBe("Update ripgrep?");
    expect(ask.lines[0]).toBe("Ask every time is on, so updating needs your OK.");
    expect(ask.lines[1]).toBe("Installed 14.1.0, newest 14.2.0 (GitHub releases).");
    expect(consentWording(row, "balanced").lines[0]).toBe("Balanced asks before updating a tool.");
  });

  it.each([
    [
      {
        ok: false,
        allowed: false,
        needsConsent: true,
        reason: "Balanced asks before updating a tool",
      },
      "consent",
    ],
    [{ ok: true, allowed: true, via: "consent" }, "started"],
    [{ ok: true, allowed: true, via: "full-autonomy" }, "started"],
    [{ ok: false, allowed: false, reason: "this PC cannot run the update" }, "refused"],
    [{ ok: false, allowed: true, error: "installer exited 1" }, "failed"],
    [null, "failed"],
  ] as const)("%j is %s", (result, kind) => {
    expect(updateOutcome(result, "ripgrep").kind).toBe(kind);
  });

  it("keeps the backend's own reason or error in the text", () => {
    expect(updateOutcome({ ok: false, allowed: false, reason: "unknown row" }, "x").text).toBe(
      "unknown row",
    );
    expect(updateOutcome({ ok: false, allowed: true, error: "installer exited 1" }, "x").text).toBe(
      "installer exited 1",
    );
    expect(updateOutcome({ ok: true, via: "full-autonomy" }, "ripgrep").text).toBe(
      "ripgrep updated (Full autonomy)",
    );
  });
});

describe("notices above the list", () => {
  const base = realCatalog(NVIDIA_16GB_PC);
  const notice = (over: Partial<InstallerCatalog>) =>
    catalogNotices({ ...base, ...over }).map((n) => n.id);

  it("is quiet for a healthy, measured, online PC", () => {
    expect(notice({})).toEqual([]);
  });

  it("says it is using the saved list when privacy is on or the PC is offline", () => {
    expect(notice({ privacy: true, online: false })).toEqual(["privacy"]);
    expect(notice({ online: false })).toEqual(["offline"]);
    const text = catalogNotices({ ...base, online: false })[0]!.text;
    expect(text).toMatch(/using the saved list/);
    expect(catalogNotices({ ...base, privacy: true })[0]!.text).toMatch(/using the saved list/);
  });

  it("says the PC is still being measured, a failed check and a running refresh", () => {
    expect(notice({ hardwareKnown: false })).toEqual(["measuring"]);
    expect(notice({ lastError: "no official source answered" })).toEqual(["last-error"]);
    expect(notice({ refreshing: true })).toEqual(["refreshing"]);
    // offline already explains why no source answered
    expect(notice({ online: false, lastError: "no official source answered" })).toEqual([
      "offline",
    ]);
  });
});

describe("refresh list: countdown, label, outcome and last checked", () => {
  const base = {
    ...realCatalog(NVIDIA_16GB_PC),
    generatedAt: FIXED_NOW,
    nextManualRefreshInMs: 42_000,
  };

  it("counts the wait down from when the list was read, never below zero", () => {
    expect(refreshWaitMs(null, FIXED_NOW)).toBe(0);
    expect(refreshWaitMs(base, FIXED_NOW)).toBe(42_000);
    expect(refreshWaitMs(base, FIXED_NOW + 12_000)).toBe(30_000);
    expect(refreshWaitMs(base, FIXED_NOW + 90_000)).toBe(0);
    expect(refreshWaitMs(base, FIXED_NOW - 5_000)).toBe(42_000);
  });

  it("labels the button", () => {
    expect(refreshLabel(0, false)).toBe("Refresh list");
    expect(refreshLabel(41_200, false)).toBe("Refresh list (42 s)");
    expect(refreshLabel(0, true)).toBe("Refreshing…");
    expect(refreshLabel(30_000, true)).toBe("Refreshing…");
  });

  it("words each answer of the refresh", () => {
    expect(refreshOutcomeText({ started: true })).toBe("Checking the official sources…");
    expect(refreshOutcomeText({ started: false, running: true })).toBe(
      "A refresh is already running.",
    );
    expect(refreshOutcomeText({ started: false, retryInMs: 31_000 })).toBe(
      "Refreshed a moment ago. Try again in 31 s.",
    );
    expect(
      refreshOutcomeText({ started: false, reason: "privacy mode keeps the cached versions" }),
    ).toBe("Using the saved list: privacy mode keeps the cached versions");
    expect(refreshOutcomeText({ started: false })).toBe("Using the saved list.");
    expect(refreshOutcomeText(null)).toMatch(/no answer/);
  });

  it("says when the list was last checked", () => {
    expect(lastCheckedLine({ ...base, lastRefreshAt: FIXED_NOW - 300_000 }, FIXED_NOW)).toBe(
      "Last checked 5 min ago",
    );
    expect(
      lastCheckedLine(
        { ...base, lastRefreshAt: null, oldestCheckedAt: FIXED_NOW - 7_200_000 },
        FIXED_NOW,
      ),
    ).toBe("Last checked 2 h ago");
    expect(
      lastCheckedLine({ ...base, lastRefreshAt: null, oldestCheckedAt: null }, FIXED_NOW),
    ).toBe("Last checked: not yet");
  });
});

describe("which page state shows", () => {
  const catalog = realCatalog(NVIDIA_16GB_PC);
  it.each([
    [{ desktop: false, catalog: null, error: null, inScope: 0 }, "offline"],
    [{ desktop: true, catalog: null, error: null, inScope: 0 }, "loading"],
    [{ desktop: true, catalog: null, error: "ipc budget expired", inScope: 0 }, "error"],
    [{ desktop: true, catalog, error: null, inScope: 0 }, "empty"],
    [{ desktop: true, catalog, error: null, inScope: 5 }, "ready"],
    // a failed later read keeps the saved list on screen
    [{ desktop: true, catalog, error: "gone", inScope: 5 }, "ready"],
  ] as const)("%# is %s", (input, phase) => {
    expect(catalogPhase(input)).toBe(phase);
  });
});

describe("Doctor rows and bundles", () => {
  it("words a Doctor row and the label of its Repair button", () => {
    const catalog = realCatalog(NVIDIA_16GB_PC, {
      detected: [{ id: "CUDA runtime libraries", installed: false }],
    });
    const cuda = catalog.doctor.map(doctorView).find((d) => d.id === "cuda-libs")!;
    expect(cuda).toMatchObject({
      statusLabel: "Needs attention",
      tone: "warning",
      repair: { id: "CUDA runtime libraries", action: "install", label: "Install" },
    });
    const noGpu = realCatalog(NO_GPU_PC)
      .doctor.map(doctorView)
      .find((d) => d.id === "cuda-libs")!;
    expect(noGpu).toMatchObject({ statusLabel: "Skipped", tone: "muted", repair: null });
    expect(
      doctorView({
        id: "x",
        label: "X",
        status: "ok",
        detail: "fine",
        repair: { id: "x", action: "repair" },
      }),
    ).toMatchObject({ statusLabel: "OK", tone: "accent", repair: { label: "Repair" } });
    expect(
      doctorView({ id: "y", label: "Y", status: "fail", detail: "bad", repair: null }),
    ).toMatchObject({ statusLabel: "Failed", tone: "destructive", repair: null });
  });

  it("a voice pack's fit is the worst of its members, with their caveats", () => {
    const noGpu = realCatalog(NO_GPU_PC);
    expect(bundleFit(null, ["voice:hindi-ear"])).toBeNull();
    expect(bundleFit(noGpu, ["voice:not-a-row"])).toBeNull();
    expect(bundleFit(noGpu, ["voice:hindi-ear", "voice:hinglish-ear"])).toEqual({
      state: "supported",
      lines: [],
    });
    const mixed = bundleFit(noGpu, ["voice:hindi-ear", "voice:faster-whisper-medium"]);
    expect(mixed?.state).toBe("unsupported");
    expect(mixed?.lines[0]).toMatch(/^Speech medium: Too heavy for a CPU/);
  });
});
