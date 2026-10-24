/**
 * Install Manager and the Ollama path: the version it shows is the client the
 * owner installed, an update is claimed only when the machine is really older,
 * the newest official release is chosen with its own digest, and an installer
 * download is the app's one verified downloader. No network: stand-ins only.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { isOlderVersion } from "../../src/lib/friday/installer-engine";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const toolchain = require_("../../electron/toolchain.cjs") as {
  TOOLS: Array<Record<string, unknown>>;
  probeTool: (
    tool: Record<string, unknown>,
    freeze: Map<string, string>,
  ) => Promise<{ installed: boolean; version: string | null; path: string | null }>;
};
const library = require_("../../electron/local-library.cjs") as {
  latestOfficialRelease: (
    id: string,
    options?: { fetchImpl?: (url: string) => Promise<unknown> },
  ) => Promise<{ tag: string; url: string; sha256: string; source: string } | null>;
  checkRunnerRelease: (id: string) => Promise<{ ok: boolean; updateAvailable: boolean }>;
};

const ollama = () => toolchain.TOOLS.find((t) => t["id"] === "Ollama")!;

describe("what the Install Manager calls an update", () => {
  it("claims an update only when the installed build is older", () => {
    expect(isOlderVersion("0.12.3", "0.40.4")).toBe(true);
    expect(isOlderVersion("0.40.4", "0.40.4")).toBe(false);
    expect(isOlderVersion("0.41.0", "0.40.4")).toBe(false);
    expect(isOlderVersion("0.40.4.1", "0.40.4")).toBe(false);
    expect(isOlderVersion("0.9.0", "0.10.0")).toBe(true);
    expect(isOlderVersion("installed", "0.40.4")).toBe(false);
    expect(isOlderVersion("configured", "1.0.0")).toBe(false);
    expect(isOlderVersion(null, "1.0.0")).toBe(false);
  });
});

describe("Ollama detection", () => {
  // The test binary stands in for `ollama`, so no script or shell stub is needed.
  const printing = (...lines: string[]) => ({
    cmd: process.execPath,
    args: ["-e", lines.map((line) => `console.error(${JSON.stringify(line)})`).join(";")],
  });

  it("reads the client version when an older daemon is still running", async () => {
    const probe = await toolchain.probeTool(
      {
        ...ollama(),
        ...printing("ollama version is 0.12.3", "Warning: client version is 0.40.4"),
        service: undefined,
      },
      new Map(),
    );
    expect(probe.installed).toBe(true);
    expect(probe.version).toBe("0.40.4");
  });

  it("falls back to the plain version line when client and daemon agree", async () => {
    const probe = await toolchain.probeTool(
      { ...ollama(), ...printing("ollama version is 0.40.4"), service: undefined },
      new Map(),
    );
    expect(probe.version).toBe("0.40.4");
  });

  it("finds a per-user install that is not on PATH yet", async () => {
    const probe = await toolchain.probeTool(
      {
        ...ollama(),
        ...printing("ollama version is 0.40.4"),
        cmd: "friday-no-such-ollama",
        fallbackBins: [process.execPath],
        service: undefined,
      },
      new Map(),
    );
    expect(probe).toMatchObject({ installed: true, version: "0.40.4", path: process.execPath });
  });
});

describe("the newest official release", () => {
  const release = (tag: string, digest?: string) => ({
    tag_name: tag,
    assets: [
      {
        name: "OllamaSetup.exe",
        browser_download_url: `https://github.com/ollama/ollama/releases/download/${tag}/OllamaSetup.exe`,
        size: 10,
        ...(digest ? { digest } : {}),
      },
    ],
  });

  it("takes a newer live release only with the digest GitHub published for it", async () => {
    const live = await library.latestOfficialRelease("ollama", {
      fetchImpl: async () => release("v99.0.0", `sha256:${"b".repeat(64)}`),
    });
    expect(live).toMatchObject({ tag: "v99.0.0", source: "live", sha256: "b".repeat(64) });
    expect(live?.url).toContain("/v99.0.0/OllamaSetup.exe");
  });

  it("keeps the verified pin when the release is older, has no digest, or the lookup fails", async () => {
    for (const fetchImpl of [
      async () => release("v0.0.1", `sha256:${"c".repeat(64)}`),
      async () => release("v99.0.0"),
      async () => {
        throw new Error("offline");
      },
    ]) {
      const got = await library.latestOfficialRelease("ollama", { fetchImpl });
      expect(got?.source).toBe("pinned");
      expect(got?.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(await library.latestOfficialRelease("no-such-runner")).toBeNull();
  });

  it("reads the release API through the allowlisted fetch (a response, not a wrapper)", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      status: 200,
      ok: true,
      headers: new Headers(),
      json: async () => release("v99.0.0", `sha256:${"d".repeat(64)}`),
    })) as unknown as typeof fetch;
    try {
      const check = await library.checkRunnerRelease("ollama");
      expect(check.ok).not.toBe(false);
      expect(check.updateAvailable).toBe(true);
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe("Ollama install job", () => {
  const source = readFileSync(path.join(root, "electron", "toolchain.cjs"), "utf8");

  it("installs the official release first, downloads through the verified downloader, and keeps winget as fallback", () => {
    const tool = ollama();
    expect(tool["release"]).toBe("ollama");
    expect(tool["installerArgs"]).toContain("/VERYSILENT");
    expect(tool["installerMirrors"]).toEqual(["https://ollama.com/download/OllamaSetup.exe"]);
    expect(tool["winget"]).toBe("Ollama.Ollama");
    expect(source).toContain('require("./model-download.cjs").downloadUrl');
    expect(source).not.toContain('require("https")');
    expect(source).toContain("tool.release && fallback");
    expect(source).toContain("authenticodeStatus(file)");
  });

  it("reports real transfer numbers and a restart of the service it stopped", () => {
    expect(source).toContain('phase: "Downloading"');
    expect(source).toContain("gbDone: event.gbDone");
    expect(source).toContain("startService(tool, probe.path)");
    const engine = readFileSync(
      path.join(root, "src", "lib", "friday", "installer-engine.ts"),
      "utf8",
    );
    expect(engine).toContain('event.phase === "Downloading"');
    expect(engine).toContain("if (!force) return true;");
  });
});
