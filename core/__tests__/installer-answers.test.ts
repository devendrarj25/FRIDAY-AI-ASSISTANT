/**
 * FRIDAY answers questions about her tools from the Install Manager's own data,
 * and starts/stops a service when told to. Anything else is not hers.
 */
import { describe, expect, it } from "vitest";
import {
  answerInstallerQuestion,
  parseServiceRequest,
  type InstallerView,
} from "../../src/lib/friday/installer-answers";
import type { CatalogEntry } from "../../src/lib/friday/catalog";
import { handleInstallerCommand } from "../../src/lib/friday/installer-engine";

const entry = (
  pkg: string,
  requirement: CatalogEntry["requirement"],
  method: CatalogEntry["method"] = "winget",
): CatalogEntry => ({
  pkg,
  category: "Developer Tools",
  source: "x",
  url: "https://x.test",
  method,
  installed: null,
  latest: "1.0",
  size: "1 MB",
  requirement,
});

function view(over: Partial<InstallerView> = {}): InstallerView {
  const entries = [
    entry("Git", "required"),
    entry("Node.js LTS", "required"),
    entry("Rust", "recommended"),
    entry("Docker Desktop", "optional"),
    entry("OpenAI", "required", "api-key"),
  ];
  const installed: Record<string, string> = {
    Git: "2.50.0",
    "Node.js LTS": "22.19.0",
    "Docker Desktop": "28.0",
  };
  const newest: Record<string, string> = { Git: "2.51.0", "Node.js LTS": "22.19.0" };
  return {
    desktop: true,
    scanned: true,
    entries,
    installedVersion: (pkg) => installed[pkg] ?? null,
    latestOf: (e) => newest[e.pkg] ?? "—",
    latestKnown: (e) => Boolean(newest[e.pkg]),
    statusOf: (e) =>
      !installed[e.pkg]
        ? "Not installed"
        : newest[e.pkg] && newest[e.pkg] !== installed[e.pkg]
          ? "Update available"
          : "Up to date",
    probe: (pkg) =>
      pkg === "Docker Desktop"
        ? { status: "Error", path: "C:\\Docker\\docker.exe", manager: "winget" }
        : installed[pkg]
          ? { status: "Ready", path: `C:\\tools\\${pkg}.exe`, manager: "winget" }
          : undefined,
    services: [
      { id: "Docker Desktop", installed: true, running: false },
      { id: "Ollama", installed: true, running: true, ownedByFriday: true },
    ],
    failedJobs: [{ pkg: "Rust", detail: "winget exit 1" }],
    match: (text) => entries.find((e) => e.pkg.toLowerCase().includes(text.toLowerCase().trim())),
    ...over,
  };
}

describe("tool questions", () => {
  it("says what is missing, outdated and broken", () => {
    expect(answerInstallerQuestion("which tools are missing?", view())).toMatch(
      /Required and missing: .*none|Every required tool is installed/,
    );
    expect(answerInstallerQuestion("which tools are missing?", view())).toMatch(
      /Recommended: Rust/,
    );
    expect(answerInstallerQuestion("what packages need an update", view())).toMatch(
      /1 update\(s\) available: Git 2\.50\.0 → 2\.51\.0/,
    );
    const broken = answerInstallerQuestion("what tools are broken", view())!;
    expect(broken).toMatch(/Docker Desktop \(Error\)/);
    expect(broken).toMatch(/Rust: winget exit 1/);
  });

  it("describes one tool: version, newest, health, service", () => {
    expect(answerInstallerQuestion("is git installed?", view())).toMatch(
      /Git is at 2\.50\.0.*update is available/,
    );
    expect(answerInstallerQuestion("version of node", view())).toMatch(
      /Node\.js LTS is at 22\.19\.0.*up to date/,
    );
    expect(answerInstallerQuestion("is rust installed", view())).toMatch(
      /Rust is not installed \(recommended\)/,
    );
    expect(answerInstallerQuestion("tell me about docker", view())).toMatch(
      /Health check: Error.*service is stopped/,
    );
    expect(answerInstallerQuestion("is nothing installed", view())).toBeNull();
  });

  it("lists running and stopped services", () => {
    const answer = answerInstallerQuestion("which services are running", view())!;
    expect(answer).toMatch(/Running: Ollama \(mine\)/);
    expect(answer).toMatch(/stopped: Docker Desktop/);
  });

  it("will not guess before the PC was scanned, and ignores other talk", () => {
    expect(answerInstallerQuestion("which tools are missing", view({ scanned: false }))).toMatch(
      /not scanned/,
    );
    expect(answerInstallerQuestion("write a poem about tools", view())).toBeNull();
    expect(answerInstallerQuestion("what is the weather", view())).toBeNull();
    // Models are the models-command's to answer, not the Install Manager's.
    expect(answerInstallerQuestion("which models are installed", view())).toBeNull();
  });
});

describe("service requests", () => {
  it("reads English and Hinglish", () => {
    expect(parseServiceRequest("start docker")).toEqual({ op: "start", target: "docker" });
    expect(parseServiceRequest("restart the ollama")).toEqual({ op: "restart", target: "ollama" });
    expect(parseServiceRequest("stop postgres.")).toEqual({ op: "stop", target: "postgres" });
    expect(parseServiceRequest("docker band karo")).toEqual({ op: "stop", target: "docker" });
    expect(parseServiceRequest("ollama chalu kar do")).toEqual({ op: "start", target: "ollama" });
    expect(parseServiceRequest("hello there")).toBeNull();
  });

  it("only a known package with a service is acted on", () => {
    expect(handleInstallerCommand("start the meeting")).toBeNull();
    expect(handleInstallerCommand("stop everything")).toBeNull();
    expect(handleInstallerCommand("start git")).toMatch(/Git has no background service/);
  });
});
