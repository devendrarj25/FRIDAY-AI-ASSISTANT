/**
 * ComfyUI stays a separate local program. A real HTTP server stands in for its
 * documented API (/system_stats, /prompt, /history/{id}, /view).
 */
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const comfy = require_("../../electron/comfyui-client.cjs");

const WORKFLOW = {
  "3": { class_type: "KSampler", inputs: { seed: 1 } },
  "9": { class_type: "SaveImage", inputs: { images: ["8", 0] } },
};
let server: http.Server;
let base = "";
let historyCalls = 0;
let posted: Record<string, unknown> | null = null;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const url = new URL(req.url || "/", "http://x");
      if (url.pathname === "/system_stats") {
        res.end(
          JSON.stringify({
            system: { comfyui_version: "0.3.99" },
            devices: [{ name: "cuda:0 test" }],
          }),
        );
        return;
      }
      if (url.pathname === "/object_info/CheckpointLoaderSimple") {
        res.end(
          JSON.stringify({
            CheckpointLoaderSimple: {
              input: { required: { ckpt_name: [["sdxl_base.safetensors"]] } },
            },
          }),
        );
        return;
      }
      if (url.pathname === "/prompt" && req.method === "POST") {
        posted = JSON.parse(body);
        res.end(
          JSON.stringify({ prompt_id: (posted as { prompt_id: string }).prompt_id, number: 1 }),
        );
        return;
      }
      if (url.pathname.startsWith("/history/")) {
        historyCalls += 1;
        const id = decodeURIComponent(url.pathname.slice("/history/".length));
        if (historyCalls < 2) {
          res.end("{}");
          return;
        }
        res.end(
          JSON.stringify({
            [id]: {
              status: { status_str: "success" },
              outputs: {
                "9": { images: [{ filename: "../evil name.png", subfolder: "", type: "output" }] },
              },
            },
          }),
        );
        return;
      }
      if (url.pathname === "/view") {
        res.setHeader("content-type", "image/png");
        res.end(Buffer.from(`PNG:${url.searchParams.get("filename")}`));
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("ComfyUI local runner", () => {
  it("reports the running server, and a plain reason when it is down", async () => {
    const up = await comfy.status({ env: { FRIDAY_COMFYUI_ENDPOINT: base } });
    expect(up).toMatchObject({ online: true, version: "0.3.99", device: "cuda:0 test" });
    const down = await comfy.status({ env: { FRIDAY_COMFYUI_ENDPOINT: "http://127.0.0.1:1" } });
    expect(down.online).toBe(false);
    expect(down.reason).toMatch(/not running/);
  });

  it("refuses any address that is not on this PC", async () => {
    for (const where of ["http://192.168.1.5:8188", "https://example.com", "file:///etc/passwd"]) {
      const row = await comfy.status({ env: { FRIDAY_COMFYUI_ENDPOINT: where } });
      expect(row.online, where).toBe(false);
      expect(row.reason).toMatch(/this PC|not a URL/);
    }
  });

  it("validates the API format before sending anything", async () => {
    expect(comfy.validateWorkflow([])).toMatch(/JSON object/);
    expect(comfy.validateWorkflow({})).toMatch(/no nodes/);
    expect(comfy.validateWorkflow({ "1": { inputs: {} } })).toMatch(/class_type/);
    expect(comfy.validateWorkflow(WORKFLOW)).toBe("");
    const refused = await comfy.run({ nodes: [] }, { env: { FRIDAY_COMFYUI_ENDPOINT: base } });
    expect(refused.ok).toBe(false);
  });

  it("queues, waits on history, and saves outputs with safe names", async () => {
    const outDir = mkdtempSync(path.join(os.tmpdir(), "friday-comfy-"));
    const result = await comfy.run(WORKFLOW, {
      env: { FRIDAY_COMFYUI_ENDPOINT: base },
      outDir,
      promptId: "abcdef12-0000",
      pollMs: 1,
    });
    expect(result.ok).toBe(true);
    expect(posted).toMatchObject({
      prompt: WORKFLOW,
      client_id: "friday",
      prompt_id: "abcdef12-0000",
    });
    expect(historyCalls).toBeGreaterThanOrEqual(2);
    expect(result.files).toHaveLength(1);
    const saved = result.files[0] as string;
    expect(path.dirname(saved)).toBe(outDir);
    expect(path.basename(saved)).toBe("abcdef12-evil_name.png");
    expect(readFileSync(saved, "utf8")).toBe("PNG:../evil name.png");
  });

  it("builds the standard text-to-image graph that passes validation", () => {
    const graph = comfy.textToImageWorkflow({
      prompt: "a red fox",
      checkpoint: "x.safetensors",
      width: 1001,
      steps: 500,
      seed: 7,
    });
    expect(comfy.validateWorkflow(graph)).toBe("");
    expect(graph["6"].inputs.text).toBe("a red fox");
    expect(graph["5"].inputs.width % 8).toBe(0);
    expect(graph["3"].inputs.steps).toBe(80);
    expect(graph["3"].inputs.seed).toBe(7);
    expect(graph["9"].class_type).toBe("SaveImage");
  });

  it("the chat tool makes an image from a prompt with the first checkpoint", async () => {
    const previous = process.env["FRIDAY_COMFYUI_ENDPOINT"];
    process.env["FRIDAY_COMFYUI_ENDPOINT"] = base;
    historyCalls = 0;
    try {
      expect(await comfy.checkpoints()).toEqual(["sdxl_base.safetensors"]);
      const tool = require_("../../tools/media/comfyui-generate/index.cjs");
      const outDir = mkdtempSync(path.join(os.tmpdir(), "friday-comfy-tool-"));
      const made = await tool.run({ prompt: "a red fox", outDir });
      expect(made.ok).toBe(true);
      expect(made.checkpoint).toBe("sdxl_base.safetensors");
      expect(
        (posted as { prompt: Record<string, { inputs: { text?: string } }> }).prompt["6"]?.inputs
          .text,
      ).toBe("a red fox");
      const missing = await tool.run({ prompt: "x", checkpoint: "nope.safetensors", outDir });
      expect(missing.ok).toBe(false);
      expect(missing.reason).toMatch(/no checkpoint named/);
      expect((await tool.run({ prompt: "  " })).reason).toMatch(/what the image should show/);
    } finally {
      if (previous === undefined) delete process.env["FRIDAY_COMFYUI_ENDPOINT"];
      else process.env["FRIDAY_COMFYUI_ENDPOINT"] = previous;
    }
  });
});
