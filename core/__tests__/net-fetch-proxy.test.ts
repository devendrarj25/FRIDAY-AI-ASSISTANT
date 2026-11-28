/**
 * electron/net-fetch.cjs on Node's own stack follows the proxy variables (undici EnvHttpProxyAgent), and the
 * downloads of the main process go through fetchCompat instead of a bare fetch. A loopback server stands in for the
 * proxy: no network, no Windows.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const netFetch = require_("../../electron/net-fetch.cjs") as {
  nodeDispatcher: () => { constructor: { name: string } };
  fetchCompat: (url: string, init?: Record<string, unknown>) => Promise<Response>;
};
const undici = require_("undici") as {
  Agent: new () => object;
  EnvHttpProxyAgent: new () => object;
};

const KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"];
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
const servers: Server[] = [];
function clearProxyEnv() {
  for (const key of KEYS) delete process.env[key];
}
afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  for (const server of servers.splice(0)) server.close();
});

const source = (file: string) =>
  readFileSync(path.resolve(__dirname, "../../electron", file), "utf8");

describe("the Node dispatcher of net-fetch", () => {
  it("is the plain Agent without a proxy variable and the env-proxy agent with one", () => {
    clearProxyEnv();
    const plain = netFetch.nodeDispatcher();
    expect(plain).toBeInstanceOf(undici.Agent);
    expect(plain).not.toBeInstanceOf(undici.EnvHttpProxyAgent);
    expect(netFetch.nodeDispatcher()).toBe(plain);

    process.env["HTTPS_PROXY"] = "http://127.0.0.1:9";
    const proxied = netFetch.nodeDispatcher();
    expect(proxied).toBeInstanceOf(undici.EnvHttpProxyAgent);
    expect(netFetch.nodeDispatcher()).toBe(proxied);

    clearProxyEnv();
    expect(netFetch.nodeDispatcher()).toBeInstanceOf(undici.Agent);
    expect(netFetch.nodeDispatcher()).not.toBeInstanceOf(undici.EnvHttpProxyAgent);
  });

  it("sends an https request to the proxy as CONNECT", async () => {
    clearProxyEnv();
    const connects: string[] = [];
    const proxy = createServer();
    proxy.on("connect", (req, socket) => {
      connects.push(String(req.url));
      socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
    servers.push(proxy);
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    process.env["HTTPS_PROXY"] = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    await expect(
      netFetch.fetchCompat("https://downloads.example.invalid/file.bin"),
    ).rejects.toThrow();
    expect(connects).toEqual(["downloads.example.invalid:443"]);
  });

  it("keeps the loopback (the local engine) off the proxy", async () => {
    clearProxyEnv();
    const viaProxy: string[] = [];
    const proxy = createServer((req, res) => {
      viaProxy.push(String(req.url));
      res.writeHead(502).end();
    });
    servers.push(proxy);
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const origin = createServer((_req, res) => res.end("local"));
    servers.push(origin);
    await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
    process.env["HTTP_PROXY"] = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    const res = await netFetch.fetchCompat(
      `http://127.0.0.1:${(origin.address() as AddressInfo).port}/x`,
    );
    expect(await res.text()).toBe("local");
    expect(viaProxy).toEqual([]);
  });

  it("still returns a 3xx when a caller asks for redirect manual", async () => {
    clearProxyEnv();
    const origin = createServer((_req, res) => {
      res.writeHead(302, { location: "/elsewhere" });
      res.end();
    });
    servers.push(origin);
    await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(origin.address() as AddressInfo).port}/start`;
    const res = await netFetch.fetchCompat(url, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/elsewhere");
  });
});

describe("the main-process downloads use the Chromium-first fetch", () => {
  it("download-safety has no bare fetch and model-download lists Hugging Face through fetchCompat", () => {
    const safety = source("download-safety.cjs");
    expect(safety.match(/(^|[^a-zA-Z.])fetch\(/gm) ?? []).toEqual([]);
    expect(safety).toContain("await fetchCompat(current, bounded.init)");
    const download = source("model-download.cjs");
    expect(download).toContain("await fetchCompat(listingUrl,");
    expect(download).not.toContain("await fetch(listingUrl");
    expect(download).toContain("const call = io.fetch || fetch;");
    // A caller that follows redirects itself never goes through Chromium, which cancels on any 3xx.
    expect(source("net-fetch.cjs")).toContain('init?.redirect !== "manual"');
  });
});
