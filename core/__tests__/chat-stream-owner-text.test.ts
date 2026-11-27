/**
 * What the owner brings into a turn besides the typed line (an attachment, recalled memory, screen text) travels apart
 * as `ownerText`. The main process screens it with the prompt before a cloud model is asked and hands it to the
 * kernel for its own check; the reply cap (`maxTokens`) goes to the kernel too, so "try a smaller reply" on a timeout
 * is a real, shorter reply; and the local model is warmed with the same context window the chat uses. The real
 * `streamOnceRaw` of electron/main.cjs runs here against a fake kernel socket.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { extractFromMain, mainText, streamHarness } from "./helpers/main-stream";

const require_ = createRequire(import.meta.url);
const firewall = require_("../../electron/privacy-firewall.cjs") as {
  classify: (content: string) => { level: string };
  cleanOwnerText: (value: unknown) => string;
  egressContent: (prompt: unknown, ownerText: unknown) => string;
};
const router = require_("../../electron/model-router.cjs") as {
  cleanReplyCap: (value: unknown) => number | null;
  smallerReplyCap: (current: unknown) => number;
  timeoutRetry: (input?: { firstDeltaMiss?: boolean; alreadyRetried?: boolean }) => {
    retrySmaller: boolean;
  };
  classifyError: (input: { message?: string }) => { category: string };
};
const models = require_("../../electron/models.cjs") as {
  ollamaNumCtx: (input?: {
    ramGb?: number | null;
    env?: Record<string, string>;
    tiers?: unknown;
  }) => number | null;
  ollamaWarmBody: (
    model: string,
    keepAlive: string,
    options?: { ramGb?: number | null; env?: Record<string, string>; tiers?: unknown },
  ) => Record<string, unknown>;
};

const cloud = { id: "cloud:test", type: "cloud", label: "Test", meta: { providerId: "test" } };
// Built at run time so no secret-looking literal sits in the source.
const SECRET = `${"pass"}${"word"}: ${"hunter"}${"2"}-${"correct"}-${"horse"}`;
const INNOCENT = "please summarise the file I attached";

async function open(
  harness: ReturnType<typeof streamHarness>,
  request: Record<string, unknown>,
  model: Record<string, unknown> = cloud,
) {
  const done = harness.run({ requestId: "r1", request, prompt: INNOCENT, model });
  await new Promise((resolve) => setImmediate(resolve));
  const socket = harness.socket();
  socket.ready();
  return { socket, done };
}

describe("ownerText is screened with the prompt before anything leaves", () => {
  it("is part of the egress authorisation content, so a secret in an attachment is a hard stop", async () => {
    const harness = streamHarness();
    const { socket, done } = await open(harness, { ownerText: `notes\n${SECRET}\nmore notes` });
    expect(harness.authorised).toHaveLength(1);
    const content = harness.authorised[0]?.content ?? "";
    expect(content).toContain(INNOCENT);
    expect(content).toContain(SECRET);
    // The point of the fix: the innocent prompt alone is public, the attachment makes it SENSITIVE.
    expect(firewall.classify(INNOCENT).level).toBe("public");
    expect(firewall.classify(content).level).toBe("sensitive");
    socket.delta("ok");
    socket.result();
    expect(await done).toMatchObject({ ok: true, received: true });
  });

  it("a list of strings is joined, blanks and non-strings are dropped, and no ownerText leaves the prompt alone", async () => {
    expect(firewall.cleanOwnerText(["a", "  ", 5, null, "b"])).toBe("a\nb");
    expect(firewall.cleanOwnerText(undefined)).toBe("");
    expect(firewall.egressContent("hello", undefined)).toBe("hello");
    expect(firewall.egressContent("hello", ["x", "y"])).toBe("hello\nx\ny");
    const harness = streamHarness();
    const { socket, done } = await open(harness, {});
    expect(harness.authorised[0]?.content).toBe(INNOCENT);
    expect(socket.params).not.toHaveProperty("ownerText");
    socket.delta("ok");
    socket.result();
    await done;
  });

  it("is sent to the kernel for its own check, cut at the kernel's size while the desktop screened all of it", async () => {
    const harness = streamHarness();
    const big = `${"a".repeat(800_000)}\n${SECRET}`;
    const { socket, done } = await open(harness, { ownerText: big });
    expect(String(socket.params["ownerText"]).length).toBe(800_000);
    expect(harness.authorised[0]?.content).toContain(SECRET);
    socket.delta("ok");
    socket.result();
    await done;
  });

  it("a blocked request never opens the kernel socket", async () => {
    const harness = streamHarness({ allowed: false });
    const result = await harness.run({
      requestId: "r2",
      request: { ownerText: SECRET },
      prompt: INNOCENT,
      model: cloud,
    });
    expect(result).toMatchObject({ ok: false, blocked: true });
    expect(harness.sockets()).toHaveLength(0);
  });

  it("the broker hands the whole request to the stream, so the page's ownerText reaches it", () => {
    const main = mainText();
    const start = main.slice(main.indexOf("async function startChat(request)"));
    expect(start.slice(0, start.indexOf("const checked = candidates.length"))).toMatch(
      /await streamOnce\(\{\s*requestId,\s*request,\s*prompt,/,
    );
    expect(extractFromMain("async function streamOnceRaw({")).toContain(
      "privacyFirewall.egressContent(prompt, ownerText)",
    );
  });
});

describe("maxTokens reaches the kernel, and the timeout retry halves it", () => {
  it("forwards a valid cap in the chat.stream params and nothing otherwise", async () => {
    for (const [given, sent] of [
      [180, 180],
      ["200", 200],
      [99_999, 8192],
    ] as const) {
      const harness = streamHarness();
      const { socket, done } = await open(harness, { maxTokens: given });
      expect(socket.params["maxTokens"]).toBe(sent);
      socket.delta("ok");
      socket.result();
      await done;
    }
    for (const bad of [undefined, 0, -5, 1.5, "abc", true, null, NaN]) {
      const harness = streamHarness();
      const { socket, done } = await open(harness, { maxTokens: bad });
      expect(socket.params).not.toHaveProperty("maxTokens");
      socket.delta("ok");
      socket.result();
      await done;
    }
  });

  it("halves the cap on a timeout, from the request's own cap or 1024, never below 128", () => {
    expect(router.smallerReplyCap(undefined)).toBe(512);
    expect(router.smallerReplyCap(180)).toBe(128);
    expect(router.smallerReplyCap(128)).toBe(128);
    expect(router.smallerReplyCap(2000)).toBe(1000);
    expect(router.smallerReplyCap(512)).toBe(256);
    expect(router.cleanReplyCap(0)).toBeNull();
    expect(router.cleanReplyCap("64")).toBe(64);
  });

  it("the retry is one smaller reply of the same model; a model that never started speaking goes straight to the next", () => {
    expect(router.timeoutRetry({})).toEqual({ retrySmaller: true });
    expect(router.timeoutRetry({ alreadyRetried: true })).toEqual({ retrySmaller: false });
    expect(router.timeoutRetry({ firstDeltaMiss: true })).toEqual({ retrySmaller: false });
    const main = mainText();
    expect(main).toContain("request.maxTokens = modelRouter.smallerReplyCap(request.maxTokens);");
    expect(main).toMatch(
      /modelRouter\.timeoutRetry\(\{\s*firstDeltaMiss: result\.firstDeltaMiss === true,/,
    );
    // The message the owner reads promises exactly this, and the cap now travels with the retry.
    expect(router.classifyError({ message: "timeout: no response" }).category).toBe("timeout");
  });
});

describe("the local model is warmed with the window the chat uses", () => {
  const tiers = { ollamaSettings: { options: { num_ctx: 8192 } } };

  it("reads one window: the shared plan, smaller on a PC with little memory, or the owner's override", () => {
    expect(models.ollamaNumCtx({ ramGb: 16, env: {}, tiers })).toBe(8192);
    expect(models.ollamaNumCtx({ ramGb: null, env: {}, tiers })).toBe(8192);
    expect(models.ollamaNumCtx({ ramGb: 11, env: {}, tiers })).toBe(6144);
    expect(models.ollamaNumCtx({ ramGb: 8, env: {}, tiers })).toBe(4096);
    expect(models.ollamaNumCtx({ ramGb: 4, env: {}, tiers })).toBe(2048);
    expect(models.ollamaNumCtx({ ramGb: 16, env: { FRIDAY_OLLAMA_NUM_CTX: "4096" }, tiers })).toBe(
      4096,
    );
    expect(
      models.ollamaNumCtx({ ramGb: 16, env: { FRIDAY_OLLAMA_NUM_CTX: "off" }, tiers }),
    ).toBeNull();
    expect(models.ollamaNumCtx({ ramGb: 16, env: { FRIDAY_OLLAMA_NUM_CTX: "100" }, tiers })).toBe(
      8192,
    );
    expect(models.ollamaNumCtx({ ramGb: 16, env: {}, tiers: {} })).toBe(8192);
    expect(models.ollamaNumCtx({ ramGb: 16, env: {} })).toBeGreaterThanOrEqual(2048);
  });

  it("the warm-up body carries options.num_ctx, and none when the owner turned it off", () => {
    const body = models.ollamaWarmBody("llama3.2:3b", "5m", { ramGb: 16, env: {}, tiers });
    expect(body).toEqual({
      model: "llama3.2:3b",
      prompt: "",
      keep_alive: "5m",
      stream: false,
      options: { num_ctx: 8192 },
    });
    const off = models.ollamaWarmBody("llama3.2:3b", "5m", {
      ramGb: 16,
      env: { FRIDAY_OLLAMA_NUM_CTX: "off" },
      tiers,
    });
    expect(off).not.toHaveProperty("options");
  });

  it("the table matches the kernel's reader, step for step", () => {
    const python = require_("node:fs").readFileSync(
      require_("node:path").resolve(__dirname, "../../kernel/router.py"),
      "utf8",
    ) as string;
    expect(python).toContain("_NUM_CTX_BY_RAM_GB = ((6.0, 2048), (9.0, 4096), (12.0, 6144))");
    expect(python).toContain("_MIN_NUM_CTX = 2048");
    expect(python).toContain("_DEFAULT_NUM_CTX = 8192");
    const source = require_("node:fs").readFileSync(
      require_("node:path").resolve(__dirname, "../../electron/models.cjs"),
      "utf8",
    ) as string;
    expect(source).toContain("const NUM_CTX_BY_RAM_GB = [");
    expect(source).toMatch(/\[6, 2048\],\s*\[9, 4096\],\s*\[12, 6144\]/);
    expect(source).toContain("const NUM_CTX_MIN = 2048;");
    expect(source).toContain("const NUM_CTX_DEFAULT = 8192;");
  });

  it("ollamaWarm sends that body", () => {
    const source = require_("node:fs").readFileSync(
      require_("node:path").resolve(__dirname, "../../electron/models.cjs"),
      "utf8",
    ) as string;
    const warm = source.slice(source.indexOf("async function ollamaWarm("));
    expect(warm.slice(0, 600)).toContain("JSON.stringify(ollamaWarmBody(model, keepAlive))");
  });
});
