/**
 * A real HTTP server stands in for Ollama. The desktop models layer must find
 * the model, class it as local and free, and the billing firewall must let it
 * through with paid access off. No Ollama install is needed.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const policy = require_("../../electron/billing-policy.cjs");
const firewall = require_("../../electron/billing-firewall.cjs");

let server: http.Server;
let port = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/tags") {
      res.end(
        JSON.stringify({
          models: [
            {
              name: "llama3.2:3b",
              model: "llama3.2:3b",
              size: 2019393189,
              details: { family: "llama", parameter_size: "3.2B", quantization_level: "Q4_K_M" },
            },
          ],
        }),
      );
      return;
    }
    if (req.url === "/api/ps") {
      res.end(JSON.stringify({ models: [] }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("a running local runner becomes a routable, free, allowed model", () => {
  it("detects the model through the real inventory path", async () => {
    // OLLAMA_HOST is read when models.cjs loads, so a child process gets its own copy.
    const script = `
      const m = require("./electron/models.cjs");
      (async () => {
        const routable = await m.routable({});
        const engines = await m.engineStatus();
        console.log(JSON.stringify({ models: routable.models, ollama: engines.find((e) => e.id === "ollama") }));
        process.exit(0);
      })();`;
    const { stdout: out } = await promisify(execFile)(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, OLLAMA_HOST: `http://127.0.0.1:${port}` },
      encoding: "utf8",
      timeout: 60000,
    });
    const report = JSON.parse(out.trim().split("\n").pop() as string);
    const found = report.models.find((row: { id: string }) => row.id === "ollama:llama3.2:3b");
    expect(found?.type).toBe("local");
    expect(report.ollama.running).toBe(true);
    const verdict = firewall.guardProviderRequest({
      model: found,
      billing: policy.normaliseBilling({ ...policy.DEFAULT_BILLING }),
      policy: "free-only",
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.billingClass).toBe("free");
  });
});
