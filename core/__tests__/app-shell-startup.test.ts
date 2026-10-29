/**
 * Startup chrome: no model-connect gate, one persistent sidebar.
 *
 * The owner-facing "Setting FRIDAY up" screen used to replace the workspace
 * until first-run.json was completed. That gate is gone. Folder pick
 * (WorkspaceSetup) stays. Nested AppShell must not remount the sidebar.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");

describe("startup does not force the first-run model-connect screen", () => {
  it("AppShell no longer returns FirstRunSetup as a launch gate", () => {
    const shell = read("src/components/friday/AppShell.tsx");
    expect(shell).not.toContain("FirstRunSetup");
    expect(shell).not.toContain("needsFirstRun");
    expect(shell).not.toContain("firstRunState");
    expect(shell).toContain("WorkspaceSetup");
    expect(read("src/components/friday/FirstRunSetup.tsx")).toContain("Setting FRIDAY up");
    expect(read("src/lib/friday/first-run.ts")).toContain("runFirstRunBootstrap");
  });

  it("opens the workspace as soon as a folder exists", () => {
    const shell = read("src/components/friday/AppShell.tsx");
    expect(shell).toContain("if (workspaceRoot === undefined) return null");
    expect(shell).toContain("if (workspaceRoot === null) return <WorkspaceSetup />");
    expect(shell).not.toMatch(/if \(needsFirstRun/);
  });
});

describe("sidebar chrome survives route changes", () => {
  it("wraps the outlet once at the root except the companion overlay", () => {
    const root = read("src/routes/__root.tsx");
    expect(root).toContain('import { AppShell } from "@/components/friday/AppShell"');
    expect(root).toContain("<AppShell>");
    expect(root).toContain("<Outlet />");
    expect(root).toContain('pathname === "/character"');
  });

  it("nested AppShell renders only the page frame, not a second aside", () => {
    const shell = read("src/components/friday/AppShell.tsx");
    expect(shell).toContain("ShellPresenceContext");
    expect(shell).toContain("savedSidebarScroll");
    expect(shell).toContain("function AppShellPage");
    expect(shell).toContain("function AppShellChrome");
    expect(shell).toContain("if (inShell) return <AppShellPage");
    const asides = shell.split("<aside").length - 1;
    expect(asides).toBe(1);
  });
});
