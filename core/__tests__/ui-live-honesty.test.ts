import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  brainCoreStatus,
  discoveryStatus,
  modelsPresence,
  presenceLabel,
  presenceStatus,
} from "../../src/lib/friday/status-presentation";
import {
  appendLogLines,
  kernelChunkToLines,
  telemetryEntryToLine,
} from "../../src/lib/friday/log-stream";

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

describe("FRIDAY Status labels stay honest", () => {
  it("never calls enabled-but-idle subsystems Running or Active", () => {
    expect(presenceLabel(0)).toBe("none installed");
    expect(presenceLabel(3)).toBe("Ready");
    expect(presenceLabel(3, 1)).toBe("Active");
    expect(presenceStatus(2)).toBe("Ready");
    expect(presenceStatus(0)).toBe("Idle");
  });

  it("treats a connected idle kernel as Ready, not Active", () => {
    expect(brainCoreStatus(false, 0)).toEqual({
      status: "Offline",
      details: "kernel not connected",
    });
    expect(brainCoreStatus(true, 0).status).toBe("Ready");
    expect(brainCoreStatus(true, 2).status).toBe("Active");
    expect(modelsPresence(0).status).toBe("Idle");
    expect(modelsPresence(1).state).toBe("Installed");
    expect(discoveryStatus(true)).toBe("Available");
    expect(discoveryStatus(false)).toBe("Idle");
  });

  it("keeps the Status page off the Hardware console", () => {
    const src = read("src/routes/status.tsx");
    expect(src).not.toContain("MachineTiles");
    expect(src).not.toContain("MachinePanel");
    expect(src).not.toContain("Resource Load");
    expect(src).toContain("Open Hardware");
    expect(src).not.toMatch(/enabled\("workflows"\) \? "Running"/);
  });
});

describe("live Auto Mode HUD is not sample catalog data", () => {
  it("does not import hud.ts sample plugins/skills", () => {
    expect(read("src/lib/friday/use-friday-live.ts")).not.toMatch(/from ["']\.\/hud["']/);
    expect(read("src/lib/friday/use-friday-live.ts")).not.toContain("Idle · listening");
    expect(read("src/lib/friday/assistant-mode.ts")).not.toMatch(
      /this\.to\("resume"\);\s*this\.state\.status = "Listening…"/,
    );
  });

  it("shows the formal voice status string on the Auto Mode HUD", () => {
    expect(read("src/components/friday/AutoMode.tsx")).toContain("{voice.status}");
    expect(read("src/components/friday/AutoMode.tsx")).not.toContain(
      'voice.listening ? "listening" : voice.micReady ? "idle"',
    );
  });
});

describe("Logs stream", () => {
  it("splits kernel chunks and caps the ring", () => {
    const lines = kernelChunkToLines("info", "alpha\n\nbeta\n");
    expect(lines.map((l) => l.message)).toEqual(["alpha", "beta"]);
    expect(lines[0]?.source).toBe("kernel");
    const entry = telemetryEntryToLine(
      {
        at: Date.parse("2026-09-03T12:00:00.123Z"),
        level: "warn",
        source: "plugin",
        message: "hi",
      },
      0,
    );
    expect(entry.level).toBe("warn");
    expect(entry.source).toBe("plugin");
    const grown = appendLogLines(
      Array.from({ length: 299 }, (_, i) => ({
        id: String(i),
        at: "00:00:00.000",
        level: "info" as const,
        source: "kernel",
        message: "x",
      })),
      lines,
    );
    expect(grown).toHaveLength(300);
    expect(grown.at(-1)?.message).toBe("beta");
  });

  it("subscribes to the live telemetry ring instead of a 3s poll", () => {
    const src = read("src/routes/logs.tsx");
    expect(src).toContain("onTelemetryLog");
    expect(src).toContain("onTelemetryIpc");
    expect(src).not.toContain("setInterval");
    const main = read("electron/main.cjs");
    expect(main).toContain("telemetry.recordLog");
    expect(main).toContain("telemetry.init(send)");
    expect(main).toContain("telemetry.hydrate");
    expect(main).toContain(', "kernel", line)');
    expect(main).toContain('telemetry.recordLog("info", "plugin", message)');
    expect(main).not.toMatch(/log\(message\);\s*\n\s*telemetry\.recordLog\("info", "plugin"/);
    expect(read("electron/telemetry.cjs")).toContain('sendToRenderer("telemetry:log"');
    expect(read("electron/telemetry.cjs")).toContain('sendToRenderer("telemetry:ipc"');
    expect(read("electron/telemetry.cjs")).toContain('sendToRenderer("telemetry:cleared"');
  });
});

describe("Tasks stream", () => {
  it("subscribes to the live graph and ledger instead of a poll", () => {
    const src = read("src/routes/tasks.tsx");
    expect(src).toContain("useTaskGraph");
    expect(src).toContain("useLedger");
    expect(src).toContain("Ask FRIDAY");
    expect(src).toContain("taskGraph.interrupt");
    expect(src).toContain("taskGraph.resume");
    expect(src).toContain("taskGraph.cancel");
    expect(src).toContain("taskGraph.retry");
    expect(src).toContain("taskGraph.pauseAll");
    expect(src).toContain("taskGraph.resumeAllPaused");
    expect(src).toContain("taskGraph.moveInQueue");
    expect(src).toContain("taskGraph.requeue");
    expect(src).toContain("Approve all");
    expect(src).toContain("backgroundTasks.runNow");
    expect(src).not.toContain("setInterval");
    expect(read("src/lib/friday/self/task-graph.ts")).toContain("retry(graphId");
  });
});

describe("Doctor stream", () => {
  it("subscribes to the live diagnostic store instead of a poll", () => {
    const src = read("src/routes/doctor.tsx");
    expect(src).toContain("useDoctor");
    expect(src).toContain("Ask FRIDAY");
    expect(src).toContain("doctor.scan");
    expect(src).toContain("doctor.fix");
    expect(src).toContain("doctor.autoDiagnose");
    expect(src).toContain("doctor.fixAllSafe");
    expect(src).toContain("doctor.fixSelected");
    expect(src).toContain("doctor.rollback");
    expect(src).toContain("formatDoctorExtra");
    expect(src).not.toContain("setInterval");
    expect(read("src/lib/friday/doctor-engine.ts")).toContain("onDiagnosticFixProgress");
    expect(read("src/lib/friday/doctor-engine.ts")).toContain("handleDoctorCommand");
    expect(read("src/lib/friday/use-doctor.ts")).toContain("useSyncExternalStore");
  });
});

describe("Install Manager stream", () => {
  it("subscribes to the live installer store instead of a poll", () => {
    const src = read("src/routes/install-manager.tsx");
    expect(src).toContain("useInstaller");
    expect(src).toContain("Ask FRIDAY");
    expect(src).toContain("installer.enqueue");
    expect(src).toContain("installer.scanAll");
    expect(src).toContain("installer.updateAll");
    expect(src).toContain("installer.installMissingRequired");
    expect(src).toContain("installer.verifyAll");
    expect(src).toContain("formatInstallerExtra");
    expect(src).toContain("liveUpdateScopes");
    expect(src).not.toContain("setInterval");
    expect(src).not.toContain("D:\\\\FRIDAY\\\\Logs");
    expect(src).not.toContain("1.4.2");
    expect(read("src/lib/friday/installer-engine.ts")).toContain("onToolProgress");
    expect(read("src/lib/friday/installer-engine.ts")).toContain("handleInstallerCommand");
    expect(read("src/lib/friday/use-installer.ts")).toContain("useSyncExternalStore");
    expect(read("src/lib/friday/catalog.ts")).not.toContain("1.4.2");
    expect(read("src/lib/friday/catalog.ts")).not.toContain("RTX 4080");
  });
});

describe("Library section", () => {
  it("is a live owner file index, not a second Import & Build or poll loop", () => {
    const src = read("src/routes/library.tsx");
    expect(src).toContain("Ask FRIDAY");
    expect(src).toContain("library.teach");
    expect(src).toContain("Analyse");
    expect(src).toContain("library.scan");
    expect(src).toContain("formatLibraryExtra");
    expect(src).toContain("readAttachments");
    expect(src).toContain("libraryTypeHonesty");
    expect(src).not.toContain("setInterval");
    expect(src).toContain("not Import & Build");
    expect(read("src/lib/friday/navigation.ts")).toContain('label: "Library"');
    expect(read("electron/preload.cjs")).toContain("libraryList");
    expect(read("electron/preload.cjs")).toContain("libraryPatch");
    expect(read("electron/main.cjs")).toContain('ipcMain.handle("library:list"');
    expect(read("src/lib/friday/owner-desk-hydrate.ts")).toContain("hydrateOwnerDesk");
  });
});

describe("Projects & Workspaces section", () => {
  it("is a live owner work desk, not a second Sandbox, Folders, or ChatDock", () => {
    const src = read("src/routes/projects.tsx");
    expect(src).toContain("Ask FRIDAY");
    expect(src).toContain("formatProjectExtra");
    expect(src).toContain("projectWorkspaces.create");
    expect(src).toContain("setHandsOff");
    expect(src).toContain("installer.enqueue");
    expect(src).not.toContain("setInterval");
    expect(src).toContain("not Folders");
    expect(src).toContain("Phase 2");
    expect(src).toContain("projectWorkspaces.readFile");
    expect(src).toContain("Open Terminal here");
    expect(src).not.toContain("Monaco");
    expect(read("src/lib/friday/navigation.ts")).toContain('label: "Projects & Workspaces"');
    expect(read("electron/preload.cjs")).toContain("projectList");
    expect(read("electron/preload.cjs")).toContain("projectPickFolder");
    expect(read("electron/preload.cjs")).toContain("projectReadFile");
    expect(read("electron/main.cjs")).toContain('ipcMain.handle("projects:list"');
    expect(read("electron/main.cjs")).toContain('ipcMain.handle("projects:pick-folder"');
    expect(read("electron/main.cjs")).toContain('ipcMain.handle("projects:read-file"');
  });
});

describe("FRIDAY Browser section", () => {
  it("is a live Chromium desk with Ask FRIDAY, not a second ChatDock or poll loop", () => {
    const src = read("src/routes/browser.tsx");
    expect(src).toContain("Ask FRIDAY");
    expect(src).toContain("formatBrowserExtra");
    expect(src).toContain("LIVE_TAB_CAP");
    expect(src).toContain("persist:friday-browser");
    expect(src).toContain("Sign out this site");
    expect(src).toContain("backgroundThrottling=no");
    expect(src).toContain("waitForView");
    expect(src).toContain("Previous");
    expect(src).not.toContain("setInterval");
    expect(src).not.toContain("WebContentsView");
    expect(read("src/lib/friday/navigation.ts")).toContain('label: "FRIDAY Browser"');
    expect(read("src/lib/friday/turn-awareness.ts")).toContain("formatBrowserExtra");
    expect(read("src/lib/friday/turn-awareness.ts")).toContain("shouldAttachBrowserExtra");
    expect(read("src/components/friday/ChatDock.tsx")).toContain("turnAwarenessExtra");
    expect(read("electron/preload.cjs")).toContain("browserCommand");
    expect(read("electron/preload.cjs")).toContain("clearOriginCookies");
    expect(read("electron/main.cjs")).toContain('ipcMain.handle("browser:live-command"');
    expect(read("electron/main.cjs")).toContain("backgroundThrottling = false");
    expect(read("electron/browser-live.cjs")).toContain("setProxy");
    expect(read("electron/browser.cjs")).toContain("searchViaLive");
    expect(read("electron/browser.cjs")).toContain("waitForLoad");
  });
});
