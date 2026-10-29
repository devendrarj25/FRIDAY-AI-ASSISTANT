/**
 * The MCP desktop bundle is a zip of the existing stdio launcher.
 * A client that cannot read .mcpb still uses the Connectors snippets.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, "../..");
const bundle = require(path.join(ROOT, "scripts/mcp-bundle.cjs")) as {
  FILES: string[];
  bundleManifest: (root?: string) => {
    manifest_version: string;
    version: string;
    author: { name: string };
    server: { entry_point: string; mcp_config: { command: string; args: string[] } };
  };
  buildBundle: (root?: string, outFile?: string) => { file: string; files: string[] };
};

describe("MCP desktop bundle", () => {
  it("packs manifest 0.3 and the existing launcher, then answers initialize", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-mcpb-"));
    const built = bundle.buildBundle(ROOT, path.join(root, "friday.mcpb"));
    const manifest = bundle.bundleManifest(ROOT);
    expect(manifest.manifest_version).toBe("0.3");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(manifest.author.name).toBe("Devendra Singh Meena");
    expect(manifest.server.entry_point).toBe("server/friday-mcp.cjs");
    expect(manifest.server.mcp_config.args[0]).toContain("friday-mcp.cjs");
    expect(built.files).toEqual(["manifest.json", ...bundle.FILES.map((file) => `server/${file}`)]);

    const extracted = path.join(root, "out");
    fs.mkdirSync(extracted);
    const unzip = spawnSync(
      "python3",
      [
        "-c",
        "import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])",
        built.file,
        extracted,
      ],
      { encoding: "utf8" },
    );
    expect(unzip.status, unzip.stderr).toBe(0);
    const packed = JSON.parse(fs.readFileSync(path.join(extracted, "manifest.json"), "utf8")) as {
      manifest_version: string;
      server: { entry_point: string };
    };
    expect(packed.manifest_version).toBe("0.3");
    expect(packed.server.entry_point).toBe("server/friday-mcp.cjs");
    for (const file of bundle.FILES) {
      expect(fs.existsSync(path.join(extracted, "server", file))).toBe(true);
    }

    const launcher = require(path.join(extracted, "server", "friday-mcp.cjs")) as {
      attachProxy: (input: {
        stdin: { on: (event: string, fn: (chunk: string) => void) => void; resume: () => void };
        stdout: { write: (text: string) => void };
        stderr: { write: (text: string) => void };
        post: (message: { id?: number; method?: string }) => Promise<unknown>;
      }) => { flush: () => Promise<void> };
    };
    const chunks: string[] = [];
    const handlers: Record<string, (chunk: string) => void> = {};
    const attached = launcher.attachProxy({
      stdin: {
        on: (event, fn) => {
          handlers[event] = fn;
        },
        resume: () => undefined,
      },
      stdout: {
        write: (text) => {
          chunks.push(text);
        },
      },
      stderr: { write: () => undefined },
      post: async (message) => ({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-11-25",
          serverInfo: { name: "friday" },
          capabilities: {},
        },
      }),
    });
    handlers["data"]?.(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`,
    );
    await attached.flush();
    const text = chunks.join("");
    expect(text).toContain("friday");
    expect(text).toContain("2025-11-25");
  });
});
