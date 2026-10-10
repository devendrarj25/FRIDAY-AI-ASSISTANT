# FRIDAY — Model Context Protocol

FRIDAY speaks MCP twice, through one module: `electron/mcp-protocol.cjs`. The desktop process is the server. The Connectors page is the client. Both use the same framing, versions, and error codes. There is no second protocol stack.

The server is off until you turn it on. A fresh install does not listen. The transports are a stdio launcher (`electron/friday-mcp.cjs`) and Streamable HTTP on `127.0.0.1` only. A public tunnel is not created.

## What you do

1. Open Connectors and turn the MCP server on. The install secret is shown once.
2. Choose a client, copy the snippet, or use Write it for me where that client has a documented file.
3. Start the client. It receives a short pairing code. Approve that code and the scopes in FRIDAY.
4. Paste the token the page shows once into the client's environment if the snippet still has the placeholder.
5. Revoke a client, or use Panic, from the same page. Panic is Stop everything plus the server off and every client revoked.

If FRIDAY is not running, the launcher writes one JSON-RPC error and a stderr line that says to open FRIDAY. It does not run tools. A minimized start is owner-configured and still does not run tools until the app is up.

## Scopes and gates

The default scope is read. The others are write, exec, memory, browser, sandbox, and files. A client cannot raise its own scope and cannot approve its own call.

A safe tool runs. A write or exec tool waits for an approval card unless the autonomy dial is Full. Always-allow exists for read and write only, never exec. Approvals expire. Stop everything halts in-flight calls. The undo journal records write and exec. The audit row names the client. Secrets are redacted. SENSITIVE text is not sent to a model, a search query, or an MCP client. Paid and unknown-cost models stay behind the billing firewall.

Shell strings, desktop input, the clipboard, the screen, and device control stay on the desktop. They are mapped so the risk table stays complete, and they are withheld from `tools/list`. No microphone tool and no speech tool is exposed. A notify tool appends text and does not speak.

## Research record (2026-10-10)

Read from the current specification, the SDK pages, and each client's own setup page. Ideas only. No client source was copied.

| Idea | Source | Decision | Reason | Where |
| --- | --- | --- | --- | --- |
| Current revision 2026-07-28 | modelcontextprotocol.io/specification/2026-07-28/changelog and blog.modelcontextprotocol.io/posts/2026-07-28/ | ADOPT | It is the current revision. Older revisions stay for negotiation. | `electron/mcp-protocol.cjs` |
| No protocol session id; state is an ordinary argument | same changelog, SEP-2567 | ADOPT | A session header is not part of this revision. | server results |
| `server/discover` plus per-request `_meta` | modelcontextprotocol.io/specification/2026-07-28/server/discover | ADOPT | Replaces initialize for a 2026 peer. | server and client handshake |
| Keep `initialize` for 2024-11-05 through 2025-11-25 | changelog compatibility note | ADAPT | The echo fixture and desktop apps still send initialize. | `handleMessage` |
| `resultType` complete or input_required | changelog, SEP-2322 | ADOPT | Sampling and elicitation prompts are an input-required result. | approval and prompts |
| Tool annotations | blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/ | ADOPT | Hints follow the kernel risk tier. They are not a grant. | catalog |
| Streamable HTTP on loopback, Origin checked, no wildcard CORS | specification security and transport pages | ADOPT | DNS rebinding and a reflected Origin are refused. | `handleHttp` |
| Official TypeScript server SDK 2.x | npm `@modelcontextprotocol/server` | REJECT | It speaks only 2026-07-28 and is ESM. The echo fixture still speaks initialize. | not a dependency |
| Legacy SDK 1.32.1 | npm `@modelcontextprotocol/sdk` | REJECT | It stops at 2025-11-25 and needs zod. One first-party layer covers both eras. | not a dependency |
| MCP Inspector as a required check | modelcontextprotocol.io inspector docs | REJECT | It is a networked dev tool. The offline fake client is the check. | `core/__tests__/mcp-platform.test.ts` |
| Public tunnel | not required by the desktop clients below | REJECT | Loopback and stdio reach every listed desktop client. | not built |
| Read-only tools while FRIDAY is closed | launcher behaviour | REJECT | A closed app must not run tools. | `electron/friday-mcp.cjs` |
| Held `subscriptions/listen` | modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions | ADOPT | The first frame is `notifications/subscriptions/acknowledged`. The socket stays open for later change notices, each tagged with `io.modelcontextprotocol/subscriptionId`. A disconnect closes it. | `electron/mcp-server.cjs` |
| Desktop extension bundle | [mcpb MANIFEST.md](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md), manifest 0.3, checked 2026-10-10 | ADOPT | The 2026-07-28 post did not name a file format. The mcpb repository specifies a zip named `.mcpb` with `manifest_version` `0.3`. FRIDAY packs the existing stdio launcher. Snippets stay the install path for clients that do not read `.mcpb`. | `scripts/mcp-bundle.cjs` |
| A2A agent card | a2a-protocol.org v1.0 agent card | ADAPT | A local card is served on loopback only. No public host. | `GET /.well-known/agent-card.json` |
| Claude Desktop config | code.claude.com MCP local servers page: `%APPDATA%\Claude\claude_desktop_config.json`, key `mcpServers` | ADOPT | Quit the app after saving. An MSIX install may redirect the file. | snippet `claude-desktop` |
| Claude Code config | code.claude.com/docs/en/mcp: project `.mcp.json`, key `mcpServers`, `type` stdio | ADOPT | User scope is `%USERPROFILE%\.claude.json`, not a second path. | snippet `claude-code` |
| Cursor config | cursor.com/docs/mcp: `%USERPROFILE%\.cursor\mcp.json`, key `mcpServers` | ADOPT | A project file overrides the global name. | snippet `cursor` |
| VS Code config | code.visualstudio.com/docs/agents/reference/mcp-configuration: `.vscode/mcp.json`, key `servers` | ADOPT | Windows has no sandbox. Portable files use `mcpServers`. | snippet `vscode` |
| Windsurf path | the VS Code discovery table names `~/.codeium/windsurf/mcp_config.json` | ADAPT | The key was not confirmed on a Windsurf page, so the snippet is copy only. | snippet `windsurf` |
| Zed config | zed.dev/docs/ai/mcp: key `context_servers` | ADOPT | The command is absolute. Zed does not inherit a login shell. | snippet `zed` |
| Cline config | docs.cline.bot MCP overview: `%USERPROFILE%\.cline\data\settings\cline_mcp_settings.json` | ADAPT | The IDE button opens the extension file if that path is wrong. | snippet `cline` |
| Continue config | docs.continue.dev: `.continue/mcpServers/friday.yaml` | ADOPT | The block is YAML. A `.cmd` spawn bug was reported fixed upstream. | snippet `continue` |
| Gemini CLI config | geminicli.com/docs/tools/mcp-server/: `%USERPROFILE%\.gemini\settings.json` | ADOPT | `trust` stays false. | snippet `gemini-cli` |
| Codex CLI config | developers.openai.com/codex/config-reference: `%USERPROFILE%\.codex\config.toml` | ADOPT | Keys are flat `mcp_servers` entries. A project file loads only when trusted. | snippet `codex-cli` |

## Limits

Windows quoting in the snippets uses the launcher path the app resolves. A real Claude Desktop, Cursor, VS Code, or other client was not started in this check. That run is the owner's. Hosted Actions, the CMD pack, and a packaged boot are unverified here.

Tool, resource, and prompt names below are generated. Edit the catalog, then run `npm run docs:sync`.

<!-- docs-engine: generated mcp surface. Edit scripts/docs-engine.cjs, not this. -->

Protocol `2026-07-28`. Kernel tools in the risk table: 51.

| Tool | Risk | Scopes |
| --- | --- | --- |
| `friday.ask` | safe | read |
| `friday.browser.act` | exec | exec, browser |
| `friday.browser.read` | safe | read, browser |
| `friday.calendar.list` | safe | read |
| `friday.doctor` | safe | read |
| `friday.files.read` | safe | read, files |
| `friday.files.search` | safe | read, files |
| `friday.files.write` | write | write, files |
| `friday.memory.forget` | write | write, memory |
| `friday.memory.read` | safe | read, memory |
| `friday.memory.remember` | write | write, memory |
| `friday.memory.search` | safe | read, memory |
| `friday.models` | safe | read |
| `friday.notify` | write | write |
| `friday.plan` | safe | read |
| `friday.reminders.list` | safe | read |
| `friday.run_task` | exec | exec |
| `friday.sandbox.run` | exec | exec, sandbox |
| `friday.status` | safe | read |
| `friday.task.result` | safe | read |
| `friday.tasks.list` | safe | read |
| `friday.thread.append` | write | write |
| `friday.thread.read` | safe | read |
| `friday.web.search` | safe | read |
| `kernel.ci.run` | exec | exec, sandbox |
| `kernel.cpp.build` | exec | exec, sandbox |
| `kernel.cpp.run` | exec | exec, sandbox |
| `kernel.fs.read` | safe | read, files |
| `kernel.fs.write` | write | write, files |
| `kernel.git` | write | write |
| `kernel.git.branch` | write | write |
| `kernel.git.commit` | write | write |
| `kernel.git.diff` | safe | read |
| `kernel.git.log` | safe | read |
| `kernel.git.push` | exec | exec |
| `kernel.git.status` | safe | read |
| `kernel.http.fetch` | write | write |
| `kernel.java.compile` | exec | exec, sandbox |
| `kernel.java.run` | exec | exec, sandbox |
| `kernel.node.run` | exec | exec, sandbox |
| `kernel.npm.install` | write | write |
| `kernel.npm.run` | exec | exec, sandbox |
| `kernel.pip.freeze` | safe | read |
| `kernel.pip.install` | write | write |
| `kernel.pip.list` | safe | read |
| `kernel.pip.show` | safe | read |
| `kernel.pip.uninstall` | write | write |
| `kernel.python.exec` | exec | exec, sandbox |
| `kernel.test.run` | exec | exec, sandbox |

Resources:

- `friday://status`
- `friday://doctor`
- `friday://activity`
- `friday://thread/recent`
- `friday://tasks`
- `friday://memory/{id}`
- `friday://workspace/{path}`
- `friday://docs/{name}`

Prompts:

- `daily_brief`
- `plan_goal`
- `summarize_folder`
- `meeting_prep`
- `review_code`

Withheld kernel tools stay on the desktop:

- `android.input` — Typing on another device stays on the desktop.
- `android.list` — A device list is not an MCP tool.
- `android.mirror` — Showing another device's screen is not an MCP tool.
- `android.open_app` — Controlling another device stays on the desktop.
- `android.transfer` — Copying to another device stays on the desktop.
- `app.close` — Closing another application stays on the desktop.
- `app.focus` — Focusing another application stays on the desktop.
- `app.launch` — Launching another application stays on the desktop.
- `app.list_windows` — Window titles stay on the desktop.
- `bluetooth.list` — A device list is not an MCP tool.
- `bluetooth.media` — Media keys on another device stay on the desktop.
- `bluetooth.scan` — A nearby-device scan is not an MCP tool.
- `bluetooth.send_file` — Sending a file to another device stays on the desktop.
- `clipboard.read` — The clipboard can hold a secret.
- `clipboard.write` — The clipboard can hold a secret.
- `input.click` — Desktop input is not an MCP tool.
- `input.drag` — Desktop input is not an MCP tool.
- `input.hotkey` — Desktop input is not an MCP tool.
- `input.scroll` — Desktop input is not an MCP tool.
- `input.type` — Desktop input is not an MCP tool.
- `network.cast` — Casting to another device stays on the desktop.
- `network.discover` — A network scan is not an MCP tool.
- `screen.perceive` — Screen capture can read a credential prompt.
- `screen.read_text` — Screen capture can read a credential prompt.
- `shell.cmd` — Arbitrary shell strings are not an MCP tool.
- `shell.powershell` — Arbitrary shell strings are not an MCP tool.

<!-- docs-engine: end generated mcp surface -->
