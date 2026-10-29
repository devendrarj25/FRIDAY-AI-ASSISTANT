/**
 * Launcher paths, client snippets, and the not-running plan.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const launch = require_("../../electron/mcp-launch.cjs");
const paths = require_("../../electron/mcp-paths.cjs");
const entry = require_("../../electron/friday-mcp.cjs");
const proto = require_("../../electron/mcp-protocol.cjs");

const spec = {
  command: "C:\\Program Files\\FRIDAY\\FRIDAY.exe",
  args: ["C:\\Program Files\\FRIDAY\\resources\\app.asar.unpacked\\electron\\friday-mcp.cjs"],
  env: { ELECTRON_RUN_AS_NODE: "1", FRIDAY_MCP_TOKEN: "<paste the token FRIDAY shows once>" },
};

describe("MCP client snippets", () => {
  const rows = launch.clients(spec);

  it("covers the desktop and CLI clients with the checked keys", () => {
    expect(rows.map((row: { id: string }) => row.id)).toEqual([
      "claude-desktop",
      "claude-code",
      "cursor",
      "vscode",
      "windsurf",
      "zed",
      "cline",
      "continue",
      "gemini-cli",
      "codex-cli",
    ]);
    const byId = Object.fromEntries(rows.map((row: { id: string }) => [row.id, row])) as Record<
      string,
      {
        path: string;
        write: boolean;
        format: string;
        body:
          | string
          | {
              mcpServers?: { friday?: { command?: string; trust?: boolean } };
              servers?: { friday?: { type?: string } };
              context_servers?: { friday?: { command?: string } };
            };
      }
    >;
    expect(byId["claude-desktop"]?.path).toContain("%APPDATA%\\Claude\\claude_desktop_config.json");
    const shown = (body: unknown) => (typeof body === "string" ? body : JSON.stringify(body));
    expect(shown(byId["claude-desktop"]?.body)).toContain("FRIDAY.exe");
    expect(byId["cursor"]?.path).toContain(".cursor\\mcp.json");
    expect(shown(byId["vscode"]?.body)).toContain('"type":"stdio"');
    expect(shown(byId["zed"]?.body)).toContain("context_servers");
    expect(byId["windsurf"]?.write).toBe(false);
    expect(byId["continue"]?.format).toBe("yaml");
    expect(shown(byId["codex-cli"]?.body)).toContain("[mcp_servers.friday]");
    expect(shown(byId["gemini-cli"]?.body)).toContain('"trust":false');
    expect(JSON.stringify(rows)).not.toContain("npx");
  });

  it("merges JSON without dropping other keys and refuses a second FRIDAY block", () => {
    const next = launch.mergeJson('{"other":true}\n', "mcpServers", "friday", {
      command: "friday",
    });
    const parsed = JSON.parse(next);
    expect(parsed.other).toBe(true);
    expect(parsed.mcpServers.friday.command).toBe("friday");
    const again = launch.mergeText("name: FRIDAY\n", "yaml", "name: FRIDAY\n", "name: FRIDAY");
    expect(again.ok).toBe(false);
  });

  it("writes a client file inside a tmp home and keeps a backup", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "friday-mcp-home-"));
    const env = { USERPROFILE: home, APPDATA: path.join(home, "Roaming") };
    const wrote = launch.writeClientConfig({
      id: "cursor",
      spec,
      workspace: home,
      env,
      home,
    });
    expect(wrote.ok).toBe(true);
    const text = fs.readFileSync(wrote.file, "utf8");
    expect(text).toContain("mcpServers");
    const second = launch.writeClientConfig({ id: "cursor", spec, workspace: home, env, home });
    expect(second.ok).toBe(true);
    expect(fs.existsSync(second.backup)).toBe(true);
    const refused = launch.writeClientConfig({ id: "windsurf", spec, workspace: home, env, home });
    expect(refused.ok).toBe(false);
    const outside = launch.writeClientConfig({
      id: "claude-code",
      spec,
      workspace: "",
      env,
      home,
    });
    expect(outside.ok).toBe(false);
  });
});

describe("MCP launcher", () => {
  it("resolves dev and packaged scripts without a system Node", () => {
    const dev = paths.resolveLauncher({
      packaged: false,
      appPath: "/apps/friday",
      execPath: "/apps/friday/electron",
    });
    expect(dev.script).toBe(path.join("/apps/friday", "electron", "friday-mcp.cjs"));
    expect(dev.command).toBe("/apps/friday/electron");
    expect(dev.env.ELECTRON_RUN_AS_NODE).toBe("1");
    const packed = paths.resolveLauncher({
      packaged: true,
      appPath: "/apps/friday/resources/app.asar",
      execPath: "/apps/FRIDAY.exe",
    });
    expect(packed.script).toContain("app.asar.unpacked");
    expect(packed.command).toBe("/apps/FRIDAY.exe");
  });

  it("returns a clear error when FRIDAY is not running and does not run tools", () => {
    let out = "";
    let err = "";
    const plan = entry.runLauncher({
      running: false,
      stdout: {
        write: (chunk: string) => {
          out += chunk;
        },
      },
      stderr: {
        write: (chunk: string) => {
          err += chunk;
        },
      },
    });
    expect(plan.action).toBe("error");
    expect(err).toMatch(/not running/i);
    expect(out).toMatch(/not running/i);
    expect(out.trim().startsWith("{")).toBe(true);
    const quiet = entry.runLauncher({
      running: false,
      startMinimized: true,
      stdout: {
        write: () => {
          throw new Error("stdout");
        },
      },
      stderr: {
        write: (chunk: string) => {
          err += chunk;
        },
      },
    });
    expect(quiet.action).toBe("start-minimized");
  });

  it("proxies one frame and keeps logs off stdout", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let out = "";
    let err = "";
    stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    stderr.on("data", (chunk) => {
      err += String(chunk);
    });
    const proxy = entry.attachProxy({
      stdin,
      stdout,
      stderr,
      post: async (message: { id: number }) => ({
        jsonrpc: "2.0",
        id: message.id,
        result: { resultType: "complete" },
      }),
    });
    stdin.write(proto.encodeLine({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} }));
    await proxy.flush();
    const parsed = JSON.parse(out);
    expect(parsed.id).toBe(7);
    expect(parsed.result.resultType).toBe("complete");
    expect(err).toBe("");
    expect(out).not.toContain("tools/list");
  });
});
