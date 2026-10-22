import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const root = join(__dirname, "../..");
const diagnostics = require_(join(root, "electron/diagnostics.cjs")) as {
  kernelLogLevel: (line: string, stream?: string) => string;
  isErrorLogLine: (line: string) => boolean;
  answeredProviders: (health: unknown) => Set<string>;
  NETWORK_PROBES: string[];
};
const netFetch = require_(join(root, "electron/net-fetch.cjs")) as {
  combinedNetworkError: (chromium: Error | null, node: Error) => Error;
};
const read = (file: string) => readFileSync(join(root, file), "utf8");

/** The owner's 2026-10-22 Doctor report, row by row. */
describe("Doctor reports what is really wrong", () => {
  it("does not count uvicorn INFO lines written to stderr as errors", () => {
    expect(diagnostics.kernelLogLevel("INFO:     connection open")).toBe("info");
    expect(diagnostics.kernelLogLevel("WARNING:  slow request")).toBe("warn");
    expect(diagnostics.kernelLogLevel("ERROR:    Exception in ASGI application")).toBe("error");
    expect(diagnostics.kernelLogLevel("Traceback (most recent call last):")).toBe("error");
    expect(diagnostics.kernelLogLevel("plain stdout line", "stdout")).toBe("info");
    const owner = "[2026-10-22T17:31:36.209Z] [error] kernel INFO:     connection open";
    expect(diagnostics.isErrorLogLine(owner)).toBe(false);
    expect(diagnostics.isErrorLogLine("[x] [error] kernel ERROR: model load failed")).toBe(true);
    expect(diagnostics.isErrorLogLine("[x] [error] main provider fetch failed")).toBe(true);
    expect(read("electron/main.cjs")).toContain("kernelLogLevel(line, ");
  });

  it("checks the internet through the provider network stack, on three hosts", () => {
    expect(diagnostics.NETWORK_PROBES).toHaveLength(3);
    const toolchain = read("electron/toolchain.cjs");
    const ping = toolchain.slice(toolchain.indexOf("async function ping("));
    expect(ping.slice(0, 600)).toContain("fetchCompat");
    expect(read("electron/diagnostics.cjs")).toContain("anyReachable(NETWORK_PROBES, 6000)");
    const chat = read("electron/models.cjs");
    expect(chat).toContain("const fetcher = fetchImpl || fetchCompat;");
  });

  it("keeps Chromium's reason when both network stacks fail", () => {
    const chromium = new Error("net::ERR_PROXY_CONNECTION_FAILED");
    const node = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    });
    const error = netFetch.combinedNetworkError(chromium, node);
    expect(error.message).toBe("net::ERR_PROXY_CONNECTION_FAILED (Node fallback: ECONNREFUSED)");
    expect(netFetch.combinedNetworkError(null, node)).toBe(node);
  });

  it("does not call a provider down when it answered a chat this session", () => {
    const answered = diagnostics.answeredProviders({
      decisions: [
        { modelId: "openrouter:openrouter/free", outcome: "ok answered" },
        { modelId: "openrouter:openrouter/free", outcome: "planned cloud-free" },
        { modelId: "gemini:gemini-2.5-flash", outcome: "failed 503" },
      ],
    });
    expect([...answered]).toEqual(["openrouter"]);
    expect(diagnostics.answeredProviders(null).size).toBe(0);
    expect(read("electron/diagnostics.cjs")).toContain("but it answered a chat in this session");
  });

  it("lets the network meter's own hosts through the CSP", () => {
    const csp = require_(join(root, "electron/csp.cjs")) as { reportOnlyHeader: () => string };
    const connect = csp
      .reportOnlyHeader()
      .split("; ")
      .find((part) => part.startsWith("connect-src"));
    for (const host of [
      "https://cloudflare.com",
      "https://www.gstatic.com",
      "https://speed.cloudflare.com",
    ]) {
      expect(connect).toContain(host);
    }
    const meter = read("src/lib/friday/network.ts");
    expect(meter).toContain("https://www.gstatic.com/generate_204");
    expect(meter).toContain("https://cloudflare.com/cdn-cgi/trace");
    expect(meter).toContain("https://speed.cloudflare.com/__down");
  });
});

describe("Doctor history is not a standing warning", () => {
  it("warns about a recent stall and reports an old one as recovered", () => {
    const watchdog = require_(join(root, "electron/watchdog.cjs")) as {
      note: (entry: { kind: string; detail: string }) => { at: number };
      doctorCheck: (now?: number) => { status: string; detail: string };
    };
    const row = watchdog.note({ kind: "event-loop", detail: "event loop lag 2063ms" });
    expect(watchdog.doctorCheck(row.at + 60_000).status).toBe("Warning");
    expect(watchdog.doctorCheck(row.at + 60_000).detail).toContain("1 min ago");
    const old = watchdog.doctorCheck(row.at + 11 * 60_000);
    expect(old.status).toBe("Ready");
    expect(old.detail).toContain("recovered");
  });

  it("reads only the tail of a large log", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const file = join(mkdtempSync(join(tmpdir(), "friday-log-")), "main.log");
    const lines = Array.from({ length: 5000 }, (_, i) => `[t] [info] line ${i}`);
    writeFileSync(file, `${lines.join("\n")}\n`);
    const readLogTail = (
      diagnostics as unknown as { readLogTail: (f: string, b: number) => string }
    ).readLogTail;
    const tail = readLogTail(file, 2048);
    expect(tail.length).toBeLessThanOrEqual(2048);
    expect(tail.startsWith("[t] [info] line ")).toBe(true);
    expect(tail.trimEnd().endsWith("line 4999")).toBe(true);
  });
});
