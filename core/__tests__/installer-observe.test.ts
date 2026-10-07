import { beforeEach, describe, expect, it } from "vitest";
import { baselineRespond } from "../../src/lib/friday/brain/baseline-responder";
import {
  installerLookRequested,
  observeInstallerState,
  shouldAttachInstallerExtra,
} from "../../src/lib/friday/brain/installer-observe";
import {
  formatInstallerExtra,
  publishInstallerSession,
  resetInstallerSession,
} from "../../src/lib/friday/installer-awareness";
import { handleInstallerCommand } from "../../src/lib/friday/installer-engine";
import { inspectSelf, describeSelfReport } from "../../src/lib/friday/brain/self-diagnosis";

describe("installer observe LOOK (does not steal inspectSelf / other pages)", () => {
  it.each([
    "look at the install manager",
    "install manager catalog",
    "scan install manager",
    "installer status",
    "install required",
    "update all packages",
    "what is on the install manager",
  ])("looks at install manager for %s", (text) => {
    expect(installerLookRequested(text)).toBe(true);
    expect(shouldAttachInstallerExtra(text)).toBe(true);
  });

  it.each([
    "what's wrong",
    "whats wrong",
    "diagnose yourself",
    "look at the doctor",
    "quick doctor",
    "find errors in the logs",
    "look at the logs",
    "look at the tasks",
    "queue status",
    "look at the terminal",
    "look at the sandbox",
  ])("does not steal %s", (text) => {
    expect(installerLookRequested(text)).toBe(false);
    expect(shouldAttachInstallerExtra(text)).toBe(false);
  });
});

describe("installer session extra", () => {
  beforeEach(() => {
    resetInstallerSession();
    publishInstallerSession({
      tab: "required",
      query: "python",
      follow: true,
      selectedPkg: "Python",
    });
  });

  it("formats INSTALL SESSION from the live store plus page session", () => {
    const extra = formatInstallerExtra();
    expect(extra).toContain("INSTALL SESSION");
    expect(extra).toContain("tab: required");
    expect(extra).toContain("query: python");
    expect(extra).toContain("follow: on");
    expect(extra).toContain("selected: Python");
  });

  it("observeInstallerState includes the shared extra", () => {
    const live = observeInstallerState();
    expect(live.readOnly).toBe(true);
    expect(live.spawned).toBe(false);
    expect(live.extra).toContain("INSTALL SESSION");
    expect(live.extra).toContain("tab: required");
  });
});

describe("handleInstallerCommand does not collide with inspectSelf", () => {
  it("scan install manager starts a scan through the existing store", () => {
    const handled = handleInstallerCommand("scan install manager");
    expect(handled).toMatch(/Install Manager scan started/);
  });

  it("install python queues the catalog Python row", () => {
    const handled = handleInstallerCommand("install python");
    expect(handled).toMatch(/Python queued for install/);
  });

  it("installer status returns a spoken summary", () => {
    const handled = handleInstallerCommand("installer status");
    expect(handled).toBeTruthy();
    expect(handled).toMatch(/Install Manager/);
  });

  it("does not swallow what's wrong or doctor/logs/tasks looks", () => {
    expect(handleInstallerCommand("what's wrong")).toBeNull();
    expect(handleInstallerCommand("diagnose yourself")).toBeNull();
    expect(handleInstallerCommand("quick doctor")).toBeNull();
    expect(handleInstallerCommand("find errors in the logs")).toBeNull();
    expect(handleInstallerCommand("look at the tasks")).toBeNull();
  });
});

describe("inspectSelf stays the owner of what's wrong", () => {
  it("inspectSelf still answers diagnose yourself", () => {
    const report = inspectSelf();
    expect(report).toBeTruthy();
    expect(describeSelfReport(report)).not.toContain("INSTALL SESSION");
  });
});

describe("baseline installer look", () => {
  it("look at the install manager includes the live session extra", async () => {
    resetInstallerSession();
    publishInstallerSession({
      tab: "all",
      query: "",
      follow: true,
      selectedPkg: null,
    });
    const reply = baselineRespond("look at the install manager");
    expect(reply.handled).toBe(true);
    expect(reply.resolve).toBeTypeOf("function");
    const text = await reply.resolve?.();
    expect(text).toContain("INSTALL SESSION");
  });

  it("what's wrong does not attach INSTALL SESSION", async () => {
    const reply = baselineRespond("what's wrong");
    expect(reply.handled).toBe(true);
    const text = reply.text || (await reply.resolve?.()) || "";
    expect(text).not.toContain("INSTALL SESSION");
  });
});
