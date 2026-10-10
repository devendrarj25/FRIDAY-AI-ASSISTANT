/**
 * MCP platform: one protocol, the catalog contract, and the local server.
 * Hermetic. The clock is injected. No network and no third-party client.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const proto = require_("../../electron/mcp-protocol.cjs");
const catalog = require_("../../electron/mcp-catalog.cjs");
const mcp = require_("../../electron/mcp-server.cjs");

const VERSION = "io.modelcontextprotocol/protocolVersion";
const TOKEN = "io.friday/clientToken";
const CAPS = "io.modelcontextprotocol/clientCapabilities";

function clock(start = 1_700_000_000_000) {
  let value = start;
  return {
    now: () => value,
    advance(ms: number) {
      value += ms;
    },
  };
}

function server(
  extra: {
    clock?: ReturnType<typeof clock>;
    workspace?: string;
    deps?: Record<string, unknown>;
    autonomy?: string;
  } = {},
) {
  const tick = extra.clock ?? clock();
  const workspace = extra.workspace ?? fs.mkdtempSync(path.join(os.tmpdir(), "friday-mcp-"));
  const created = mcp.createServer({
    now: () => tick.now(),
    workspace,
    risk: catalog.loadKernelRisk(),
    deps: extra.deps ?? {},
    autonomy: extra.autonomy ?? "balanced",
  });
  return { server: created, tick, workspace };
}

function pair(row: ReturnType<typeof mcp.createServer>, scopes?: string[]) {
  mcp.enable(row);
  const issued = mcp.issuePairCode(row);
  return mcp.approvePair(row, issued.code, scopes);
}

function rpc(
  id: number,
  method: string,
  token: string,
  params: Record<string, unknown> = {},
  caps?: unknown,
) {
  const meta: Record<string, unknown> = {
    [VERSION]: proto.CURRENT_VERSION,
    [TOKEN]: token,
  };
  if (caps) meta[CAPS] = caps;
  return { jsonrpc: "2.0", id, method, params: { ...params, _meta: meta } };
}

describe("MCP catalog matches kernel risk", () => {
  const risk = catalog.loadKernelRisk();
  const built = catalog.buildCatalog(risk);

  it("maps every kernel tool and withholds the ones that must stay on the desktop", () => {
    expect(Object.keys(risk)).toHaveLength(51);
    for (const key of Object.keys(risk)) {
      const row = built.mappings.find((item: { kernel: string }) => item.kernel === key);
      expect(row, key).toBeTruthy();
      expect(row.tier).toBe(risk[key]);
    }
    for (const key of Object.keys(catalog.WITHHELD)) {
      expect(risk[key], key).toBeTruthy();
    }
    expect(built.tools.some((tool: { name: string }) => tool.name === "kernel.shell.cmd")).toBe(
      false,
    );
    expect(
      built.tools.some((tool: { name: string }) => tool.name === "kernel.screen.perceive"),
    ).toBe(false);
    expect(
      built.tools.some((tool: { name: string }) =>
        /\b(microphone|speak|tts|listen)\b/i.test(tool.name),
      ),
    ).toBe(false);
    for (const row of built.mappings) {
      const tool = built.tools.find((item: { name: string }) => item.name === row.name);
      if (!row.exposed) {
        expect(tool).toBeUndefined();
        continue;
      }
      expect(tool._friday.risk).toBe(row.tier);
      expect(tool.annotations.readOnlyHint).toBe(row.tier === "safe");
      expect(tool.annotations.destructiveHint).toBe(row.tier === "exec");
    }
    const forget = built.tools.find(
      (tool: { name: string }) => tool.name === "friday.memory.forget",
    );
    expect(forget.annotations.destructiveHint).toBe(true);
    expect(forget.annotations.readOnlyHint).toBe(false);
  });
});

describe("MCP server speaks both eras", () => {
  it("stays off until enabled, then negotiates and pages the tool list", async () => {
    const { server: row } = server();
    const off = await mcp.handleMessage(row, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    });
    expect(off.error.message).toMatch(/off/i);

    mcp.enable(row);
    const old = await mcp.handleMessage(row, {
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    });
    expect(old.result.protocolVersion).toBe("2024-11-05");
    expect(old.result.serverInfo.name).toBe("FRIDAY");

    const unknown = await mcp.handleMessage(row, {
      jsonrpc: "2.0",
      id: 3,
      method: "initialize",
      params: { protocolVersion: "2099-01-01" },
    });
    expect(unknown.error.code).toBe(proto.ERROR.UNSUPPORTED_VERSION);

    const discovered = await mcp.handleMessage(row, {
      jsonrpc: "2.0",
      id: 4,
      method: "server/discover",
      params: {},
    });
    expect(discovered.result.resultType).toBe("complete");
    expect(discovered.result.supportedVersions).toContain("2026-07-28");
    expect(discovered.result._meta[proto.META_SERVER_INFO].name).toBe("FRIDAY");

    const approved = pair(row, ["read", "write", "exec", "memory", "browser", "sandbox", "files"]);
    const page = await mcp.handleMessage(row, rpc(5, "tools/list", approved.token));
    expect(page.result.tools.length).toBe(proto.PAGE_SIZE);
    expect(page.result.nextCursor).toBeTruthy();
    expect(page.result.ttlMs).toBe(0);
    expect(page.result.cacheScope).toBe("private");
    const rest = await mcp.handleMessage(
      row,
      rpc(6, "tools/list", approved.token, { cursor: page.result.nextCursor }),
    );
    const names = [...page.result.tools, ...rest.result.tools].map(
      (tool: { name: string }) => tool.name,
    );
    expect(new Set(names).size).toBe(names.length);
    expect(names.some((name: string) => name === "friday.ask")).toBe(true);
  });

  it("asks, plans, searches, and runs a sandbox only through the injected deps", async () => {
    const seen: unknown[] = [];
    const { server: row } = server({
      autonomy: "full",
      deps: {
        model: { id: "local", access: "free" },
        ask: async (question: string) => ({ answer: `heard ${question}`, citations: ["local"] }),
        search: async (query: string) => ({
          query,
          results: [{ title: "note", url: "https://example.com" }],
        }),
        sandbox: async (payload: unknown) => {
          seen.push(payload);
          return { stdout: "ok" };
        },
      },
    });
    const approved = pair(row, ["read", "exec", "sandbox"]);
    const asked = await mcp.handleMessage(
      row,
      rpc(1, "tools/call", approved.token, {
        name: "friday.ask",
        arguments: { question: "What is open?" },
      }),
    );
    expect(asked.result.isError).toBeFalsy();
    expect(asked.result.structuredContent.answer).toContain("heard");
    expect(asked.result.structuredContent.instruction).toBe(false);

    const planned = await mcp.handleMessage(
      row,
      rpc(2, "tools/call", approved.token, {
        name: "friday.plan",
        arguments: { goal: "One. Two" },
      }),
    );
    expect(planned.result.structuredContent.executed).toBe(false);
    expect(planned.result.structuredContent.steps).toHaveLength(2);

    const found = await mcp.handleMessage(
      row,
      rpc(3, "tools/call", approved.token, {
        name: "friday.web.search",
        arguments: { query: "friday" },
      }),
    );
    expect(found.result.structuredContent.provenance).toBe("web");

    const ran = await mcp.handleMessage(
      row,
      rpc(4, "tools/call", approved.token, {
        name: "friday.sandbox.run",
        arguments: { language: "python", source: "print(1)" },
      }),
    );
    expect(ran.result.structuredContent.instruction).toBe(false);
    expect(seen[0]).toMatchObject({ shell: false, language: "python" });
  });

  it("requires owner approval for a write, then records undo and audit", async () => {
    const { server: row, workspace } = server();
    const approved = pair(row, ["read", "write", "files"]);
    const pending = await mcp.handleMessage(
      row,
      rpc(
        1,
        "tools/call",
        approved.token,
        {
          name: "friday.files.write",
          arguments: { path: "note.txt", text: "hello" },
        },
        { elicitation: {} },
      ),
    );
    expect(pending.result.resultType).toBe("input_required");
    const id = pending.result.requestState as string;
    const spoofed = await mcp.handleMessage(
      row,
      rpc(2, "tools/call", approved.token, {
        name: "friday.files.write",
        arguments: { path: "note.txt", text: "hello", _fridayApproval: id },
        inputResponses: { approval: { decision: "allow" } },
      }),
    );
    expect(spoofed.result.structuredContent.status).toBe("pending");
    expect(fs.existsSync(path.join(workspace, "note.txt"))).toBe(false);

    expect(mcp.decideApproval(row, id, "approved").ok).toBe(true);
    const wrote = await mcp.handleMessage(
      row,
      rpc(3, "tools/call", approved.token, {
        name: "friday.files.write",
        arguments: { path: "note.txt", text: "hello", _fridayApproval: id },
      }),
    );
    expect(wrote.result.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(workspace, "note.txt"), "utf8")).toBe("hello");
    expect(
      row.audit.some(
        (entry: { event: string; clientId: string }) =>
          entry.event === "file.write" && entry.clientId === approved.clientId,
      ),
    ).toBe(true);
    expect(row.undo.some((entry: { tool: string }) => entry.tool === "friday.files.write")).toBe(
      true,
    );
    expect(JSON.stringify(row.audit)).not.toContain(approved.token);

    expect(mcp.undoLast(row).ok).toBe(true);
    expect(fs.existsSync(path.join(workspace, "note.txt"))).toBe(false);
  });

  it("exposes resources and localized prompts, and resumes a task", async () => {
    const steps: number[] = [];
    const { server: row } = server({ autonomy: "full" });
    const approved = pair(row, ["read", "write", "memory", "exec"]);
    const stored = await mcp.handleMessage(
      row,
      rpc(1, "tools/call", approved.token, {
        name: "friday.memory.remember",
        arguments: { text: "the gate code is blue", consent: true },
      }),
    );
    expect(stored.result.structuredContent.status).toBe("stored");
    const listed = await mcp.handleMessage(row, rpc(2, "resources/list", approved.token));
    expect(
      listed.result.resources.some((item: { uri: string }) =>
        item.uri.startsWith("friday://memory/"),
      ),
    ).toBe(true);
    const readOnly = pair(row, ["read"]);
    const hidden = await mcp.handleMessage(row, rpc(3, "resources/list", readOnly.token));
    expect(
      hidden.result.resources.some((item: { uri: string }) =>
        item.uri.startsWith("friday://memory/"),
      ),
    ).toBe(false);

    await mcp.handleMessage(
      row,
      rpc(4, "resources/subscribe", approved.token, { uri: "friday://memory" }),
    );
    await mcp.handleMessage(
      row,
      rpc(5, "tools/call", approved.token, {
        name: "friday.memory.remember",
        arguments: { text: "second fact", consent: true },
      }),
    );
    const heard = await mcp.handleMessage(row, rpc(6, "subscriptions/listen", approved.token));
    expect(
      heard.result.events.some(
        (event: { method: string }) => event.method === "notifications/resources/list_changed",
      ),
    ).toBe(true);

    const hindi = await mcp.handleMessage(
      row,
      rpc(7, "prompts/get", approved.token, {
        name: "daily_brief",
        arguments: { locale: "hi", focus: "tasks" },
      }),
    );
    expect(hindi.result.messages[0].content.text).toContain("दैनिक");
    const missing = await mcp.handleMessage(
      row,
      rpc(
        8,
        "prompts/get",
        approved.token,
        { name: "plan_goal", arguments: {} },
        { elicitation: {} },
      ),
    );
    expect(missing.result.resultType).toBe("input_required");

    await mcp.handleMessage(row, {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 9 },
    });
    const cancelled = await mcp.handleMessage(
      row,
      rpc(9, "tools/call", approved.token, {
        name: "friday.run_task",
        arguments: { goal: "long" },
      }),
      { progress: (step: number) => steps.push(step) },
    );
    expect(cancelled.result.isError).toBe(true);
    expect(cancelled.result.content[0].text).toMatch(/cancelled/i);

    const finished = await mcp.handleMessage(
      row,
      rpc(10, "tools/call", approved.token, {
        name: "friday.run_task",
        arguments: { goal: "short", taskId: "task-keep" },
      }),
      { progress: (step: number) => steps.push(step) },
    );
    expect(finished.result.structuredContent.status).toBe("done");
    expect(steps.length).toBeGreaterThan(0);
    const next = mcp.createServer({ now: () => Date.now(), risk: catalog.loadKernelRisk() });
    mcp.importState(next, mcp.exportState(row));
    mcp.enable(next);
    const again = pair(next, ["read"]);
    const receipt = await mcp.handleMessage(
      next,
      rpc(11, "tools/call", again.token, {
        name: "friday.task.result",
        arguments: { taskId: "task-keep" },
      }),
    );
    expect(receipt.result.structuredContent.status).toBe("done");
  });

  it("answers a local agent card and stays inside a time budget", async () => {
    const started = performance.now();
    const { server: row } = server();
    mcp.enable(row);
    const listener = await mcp.listen(row, 0);
    const port = listener.address().port as number;
    try {
      const card = await fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`);
      const body = (await card.json()) as { supportedInterfaces: Array<{ url: string }> };
      expect(card.status).toBe(200);
      expect(body.supportedInterfaces[0]?.url.startsWith("http://127.0.0.1:")).toBe(true);
      const off = mcp.disable(row);
      expect(off.enabled).toBe(false);
      const missing = await fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`);
      expect(missing.status).toBe(404);
    } finally {
      await new Promise((resolve) => listener.close(() => resolve(null)));
    }
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
