/**
 * FRIDAY · MCP client setup snippets and the not-running plan.
 *
 * Paths and keys were checked against the vendor pages named in
 * docs/FRIDAY_MCP.md on 2026-10-10. A snippet is not a second installer.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const proto = require("./mcp-protocol.cjs");

const PRESETS = [
  {
    id: "loopback-http",
    title: "Loopback HTTP",
    url: "http://127.0.0.1:3000/mcp",
    command: "",
  },
  {
    id: "local-command",
    title: "Local command",
    url: "",
    command: "",
  },
];

function launcherEnv(token) {
  return {
    ELECTRON_RUN_AS_NODE: "1",
    FRIDAY_MCP_TOKEN: token || "<paste the token FRIDAY shows once>",
  };
}

function jsonEntry(spec) {
  return {
    command: spec.command,
    args: spec.args,
    env: spec.env,
  };
}

function tomlBasic(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function clients(spec) {
  const entry = jsonEntry(spec);
  const command = proto.quoteWindows(spec.command);
  return [
    {
      id: "claude-desktop",
      title: "Claude Desktop",
      format: "json",
      root: "mcpServers",
      path: "%APPDATA%\\Claude\\claude_desktop_config.json",
      write: true,
      note: "Quit Claude Desktop fully after saving. An MSIX install may redirect this file under %LOCALAPPDATA%\\Packages.",
      body: { mcpServers: { friday: entry } },
    },
    {
      id: "claude-code",
      title: "Claude Code",
      format: "json",
      root: "mcpServers",
      path: ".mcp.json",
      write: true,
      note: 'Project scope. User scope is the mcpServers key in %USERPROFILE%\\.claude.json. Add "type": "stdio".',
      body: { mcpServers: { friday: { type: "stdio", ...entry } } },
    },
    {
      id: "cursor",
      title: "Cursor",
      format: "json",
      root: "mcpServers",
      path: "%USERPROFILE%\\.cursor\\mcp.json",
      write: true,
      note: "A project file .cursor/mcp.json overrides this name. Restart Cursor.",
      body: { mcpServers: { friday: entry } },
    },
    {
      id: "vscode",
      title: "VS Code",
      format: "json",
      root: "servers",
      path: ".vscode/mcp.json",
      write: true,
      note: "Sandboxing is not available on Windows. The portable file is .mcp.json with an mcpServers key.",
      body: { servers: { friday: { type: "stdio", ...entry } } },
    },
    {
      id: "windsurf",
      title: "Windsurf",
      format: "json",
      root: "mcpServers",
      path: "%USERPROFILE%\\.codeium\\windsurf\\mcp_config.json",
      write: false,
      note: "The path is the one VS Code's discovery table names. Confirm the key in Windsurf before writing.",
      body: { mcpServers: { friday: entry } },
    },
    {
      id: "zed",
      title: "Zed",
      format: "json",
      root: "context_servers",
      path: "%APPDATA%\\Zed\\settings.json",
      write: true,
      note: "The key is context_servers. Use an absolute command. Zed does not inherit a login shell.",
      body: { context_servers: { friday: entry } },
    },
    {
      id: "cline",
      title: "Cline",
      format: "json",
      root: "mcpServers",
      path: "%USERPROFILE%\\.cline\\data\\settings\\cline_mcp_settings.json",
      write: true,
      note: "CLI path from the Cline docs. The IDE button Configure MCP Servers opens the extension file.",
      body: { mcpServers: { friday: { ...entry, disabled: false, autoApprove: [] } } },
    },
    {
      id: "continue",
      title: "Continue",
      format: "yaml",
      root: "mcpServers",
      path: ".continue/mcpServers/friday.yaml",
      write: true,
      note: "A block file. Continue also accepts JSON in that folder. MCP servers run in agent mode.",
      body: `name: FRIDAY\nversion: 1.0.0\nschema: v1\nmcpServers:\n  - name: FRIDAY\n    command: ${command}\n    args:\n      - ${proto.quoteWindows(spec.args[0] || "")}\n`,
    },
    {
      id: "gemini-cli",
      title: "Gemini CLI",
      format: "json",
      root: "mcpServers",
      path: "%USERPROFILE%\\.gemini\\settings.json",
      write: true,
      note: "User scope. Project scope is .gemini/settings.json. trust stays false.",
      body: { mcpServers: { friday: { ...entry, trust: false } } },
    },
    {
      id: "codex-cli",
      title: "Codex CLI",
      format: "toml",
      root: "mcp_servers",
      path: "%USERPROFILE%\\.codex\\config.toml",
      write: true,
      note: "Flat mcp_servers keys from the Codex config reference. Project files load only when the project is trusted.",
      body: `[mcp_servers.friday]\nenabled = true\ncommand = ${tomlBasic(spec.command)}\nargs = [${spec.args.map(tomlBasic).join(", ")}]\n`,
    },
  ];
}

function snippet(id, spec) {
  const row = clients(spec).find((item) => item.id === id);
  if (!row) return { ok: false, error: "Unknown client." };
  const text = typeof row.body === "string" ? row.body : JSON.stringify(row.body, null, 2);
  return { ok: true, ...row, text };
}

function mergeJson(existing, root, name, entry) {
  let parsed = {};
  if (String(existing || "").trim()) {
    parsed = JSON.parse(existing);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("The config file is not a JSON object.");
    }
  }
  const bucket = parsed[root] && typeof parsed[root] === "object" ? { ...parsed[root] } : {};
  bucket[name] = entry;
  parsed[root] = bucket;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function mergeText(existing, format, block, marker) {
  const text = String(existing || "");
  if (text.includes(marker)) return { ok: false, error: "FRIDAY is already in this file." };
  if (format === "toml" || format === "yaml") {
    return { ok: true, next: `${text.replace(/\s*$/, "")}\n\n${block}` };
  }
  return { ok: false, error: "This file is not merged as text." };
}

function expandConfigPath(input, env = process.env, home = os.homedir()) {
  let text = String(input || "");
  const appData = env.APPDATA || path.join(home, "AppData", "Roaming");
  const local = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const profile = env.USERPROFILE || home;
  text = text.replace(/%APPDATA%/gi, appData);
  text = text.replace(/%LOCALAPPDATA%/gi, local);
  text = text.replace(/%USERPROFILE%/gi, profile);
  if (text === "~") return home;
  if (text.startsWith("~/") || text.startsWith("~\\")) text = path.join(home, text.slice(2));
  return text.replace(/[\\/]/g, path.sep);
}

function insideRoot(root, file) {
  if (!root) return false;
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function writeClientConfig({ id, spec, workspace, env, home, fsImpl } = {}) {
  const row = snippet(id, spec);
  if (!row.ok) return row;
  if (!row.write)
    return { ok: false, error: "This client is copy only. Paste the snippet yourself." };
  const disk = fsImpl || fs;
  const baseHome = home || os.homedir();
  const expanded = expandConfigPath(row.path, env || process.env, baseHome);
  const file = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(workspace || "", expanded);
  if (!insideRoot(baseHome, file) && !insideRoot(workspace, file)) {
    return {
      ok: false,
      error: "That config path is outside the home directory and the workspace.",
    };
  }
  let existing = "";
  if (disk.existsSync(file)) existing = disk.readFileSync(file, "utf8");
  let next = "";
  if (row.format === "json") {
    const bucket = row.body[row.root];
    const name = Object.keys(bucket)[0];
    try {
      next = mergeJson(existing, row.root, name, bucket[name]);
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  } else {
    const marker = row.format === "toml" ? "[mcp_servers.friday]" : "name: FRIDAY";
    const merged = mergeText(
      existing,
      row.format,
      typeof row.body === "string" ? row.body : row.text,
      marker,
    );
    if (!merged.ok) return merged;
    next = merged.next.endsWith("\n") ? merged.next : `${merged.next}\n`;
  }
  disk.mkdirSync(path.dirname(file), { recursive: true });
  if (existing) disk.writeFileSync(`${file}.friday-bak`, existing, "utf8");
  disk.writeFileSync(file, next, "utf8");
  return { ok: true, file, backup: existing ? `${file}.friday-bak` : "" };
}

function planWhenAbsent({ running, startMinimized }) {
  if (running) return { action: "proxy" };
  if (startMinimized) {
    return {
      action: "start-minimized",
      message:
        "FRIDAY is not running. The owner allowed a minimized start. Tools stay off until the app is up.",
    };
  }
  return {
    action: "error",
    message: "FRIDAY is not running. Open FRIDAY, turn the MCP server on, and try again.",
  };
}

module.exports = {
  PRESETS,
  launcherEnv,
  clients,
  snippet,
  mergeJson,
  mergeText,
  expandConfigPath,
  writeClientConfig,
  planWhenAbsent,
};
