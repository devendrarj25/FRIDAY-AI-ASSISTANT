/**
 * Drawing with a connected cloud provider: the request each provider is sent,
 * what counts as a picture, where it is kept, and which models are asked in
 * which order. A stand-in fetch; no network, no key.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { parseImageRequest } from "../../src/lib/friday/image-command";

type Picture =
  { ok: true; buffer: Buffer; type: string; ext: string } | { ok: false; error: string };
const images = createRequire(import.meta.url)("../../electron/image-generation.cjs") as {
  PROVIDERS: string[];
  sniffImage: (b: Buffer) => { ext: string; type: string } | null;
  requestFor: (
    p: string,
    m: string,
    prompt: string,
    key: string,
    size?: string,
  ) => { url: string; init: { headers: Record<string, string>; body: string } } | null;
  draw: (args: Record<string, unknown>) => Promise<Picture>;
  save: (dir: string, prompt: string, picture: Picture, now?: number) => string;
  candidates: (models: unknown[], allowed?: (m: unknown) => boolean) => Array<{ id: string }>;
};

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("rest-of-the-file"),
]);
const folders: string[] = [];
afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const answer =
  (body: unknown, init: ResponseInit = {}) =>
  async () =>
    new Response(
      typeof body === "string" || Buffer.isBuffer(body) ? (body as BodyInit) : JSON.stringify(body),
      init,
    );

describe("what a provider is sent", () => {
  it("asks OpenAI-style providers for an inline picture", () => {
    const request = images.requestFor(
      "together",
      "black-forest-labs/FLUX.1-schnell",
      "a red car",
      "k",
      "1024x1024",
    )!;
    expect(request.url).toBe("https://api.together.xyz/v1/images/generations");
    expect(request.init.headers["authorization"]).toBe("Bearer k");
    expect(JSON.parse(request.init.body)).toMatchObject({
      model: "black-forest-labs/FLUX.1-schnell",
      prompt: "a red car",
      response_format: "b64_json",
      size: "1024x1024",
    });
  });

  it("does not send response_format to gpt-image, which rejects it", () => {
    const body = JSON.parse(images.requestFor("openai", "gpt-image-1", "x", "k")!.init.body);
    expect(body).not.toHaveProperty("response_format");
    expect(JSON.parse(images.requestFor("openai", "dall-e-3", "x", "k")!.init.body)).toHaveProperty(
      "response_format",
      "b64_json",
    );
  });

  it("sends Hugging Face the prompt as inputs to the hf-inference route", () => {
    const request = images.requestFor("huggingface", "stabilityai/sdxl-turbo", "a lake", "hf_x")!;
    expect(request.url).toBe(
      "https://router.huggingface.co/hf-inference/models/stabilityai/sdxl-turbo",
    );
    expect(JSON.parse(request.init.body)).toEqual({ inputs: "a lake" });
  });

  it("has no request for a provider that cannot draw", () => {
    expect(images.requestFor("groq", "x", "y", "k")).toBeNull();
    expect(images.PROVIDERS).toEqual(
      expect.arrayContaining(["openai", "together", "xai", "gemini", "deepinfra", "huggingface"]),
    );
  });
});

describe("what comes back", () => {
  it("accepts an inline base64 picture", async () => {
    const result = await images.draw({
      providerId: "openai",
      model: "gpt-image-1",
      prompt: "a cat",
      key: "k",
      fetchImpl: answer({ data: [{ b64_json: PNG.toString("base64") }] }),
    });
    expect(result).toMatchObject({ ok: true, type: "image/png", ext: "png" });
  });

  it("accepts raw image bytes from Hugging Face", async () => {
    const result = await images.draw({
      providerId: "huggingface",
      model: "m/m",
      prompt: "a cat",
      key: "k",
      fetchImpl: answer(PNG, { headers: { "content-type": "image/png" } }),
    });
    expect(result.ok).toBe(true);
  });

  it("follows a picture link, https only", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      return url.includes("images.example")
        ? new Response(PNG, { headers: { "content-type": "image/png" } })
        : new Response(JSON.stringify({ data: [{ url: "https://images.example/a.png" }] }));
    };
    expect(
      (
        await images.draw({
          providerId: "xai",
          model: "grok-2-image",
          prompt: "x",
          key: "k",
          fetchImpl,
        })
      ).ok,
    ).toBe(true);
    expect(calls).toHaveLength(2);
    const plain = await images.draw({
      providerId: "xai",
      model: "grok-2-image",
      prompt: "x",
      key: "k",
      fetchImpl: answer({ data: [{ url: "http://insecure.example/a.png" }] }),
    });
    expect(plain.ok).toBe(false);
  });

  it("refuses an answer that is not a picture", async () => {
    const result = await images.draw({
      providerId: "openai",
      model: "dall-e-3",
      prompt: "x",
      key: "k",
      fetchImpl: answer({
        data: [{ b64_json: Buffer.from("<html>error</html>").toString("base64") }],
      }),
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toMatch(/not a picture/);
  });

  it("reports the provider's own reason when it says no", async () => {
    const result = await images.draw({
      providerId: "openai",
      model: "dall-e-3",
      prompt: "x",
      key: "k",
      fetchImpl: answer({ error: { message: "Billing hard limit reached" } }, { status: 400 }),
    });
    expect((result as { error: string }).error).toBe("HTTP 400: Billing hard limit reached");
  });

  it("will not draw nothing, or without a key", async () => {
    expect(
      (await images.draw({ providerId: "openai", model: "m", prompt: " ", key: "k" })).ok,
    ).toBe(false);
    expect((await images.draw({ providerId: "openai", model: "m", prompt: "x", key: "" })).ok).toBe(
      false,
    );
  });

  it("recognises real image types and nothing else", () => {
    expect(images.sniffImage(PNG)?.ext).toBe("png");
    expect(
      images.sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(20).fill(0)]))?.ext,
    ).toBe("jpg");
    expect(images.sniffImage(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))?.ext).toBe("webp");
    expect(images.sniffImage(Buffer.from("<!doctype html><html>"))).toBeNull();
  });
});

describe("keeping it and choosing who draws", () => {
  it("saves under the folder it is given with a readable name", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "friday-img-"));
    folders.push(dir);
    const file = images.save(
      dir,
      "A Red Car, at dusk!",
      { ok: true, buffer: PNG, type: "image/png", ext: "png" },
      1700000000000,
    );
    expect(path.basename(file)).toBe("1700000000000-a-red-car-at-dusk.png");
    expect(readFileSync(file).equals(PNG)).toBe(true);
  });

  it("asks free models before paid ones, and only models that draw", () => {
    const models = [
      {
        id: "paid",
        type: "cloud",
        providerId: "openai",
        access: "paid",
        capabilities: { imageGeneration: true },
      },
      {
        id: "free",
        type: "cloud",
        providerId: "together",
        access: "free",
        capabilities: { imageGeneration: true },
      },
      {
        id: "chat",
        type: "cloud",
        providerId: "openai",
        access: "free",
        capabilities: { chat: true },
      },
      {
        id: "local",
        type: "local",
        providerId: "ollama",
        access: "free",
        capabilities: { imageGeneration: true },
      },
      {
        id: "nodraw",
        type: "cloud",
        providerId: "groq",
        access: "free",
        capabilities: { imageGeneration: true },
      },
    ];
    expect(images.candidates(models).map((m) => m.id)).toEqual(["free", "paid"]);
    expect(
      images
        .candidates(models, (m) => (m as { access: string }).access === "free")
        .map((m) => m.id),
    ).toEqual(["free"]);
  });
});

describe("recognising a drawing request", () => {
  it.each([
    ["generate an image of a sunset over the sea", "a sunset over the sea"],
    ["draw a red car", "a red car"],
    ["please create a picture of two cats playing", "two cats playing"],
    ["image banao: ek sher jungle me", "ek sher jungle me"],
    ["billi ki tasveer banao", "billi"],
    ["make a logo for my coffee shop", "for my coffee shop"],
  ])("%s", (text, prompt) => {
    expect(parseImageRequest(text)?.prompt).toBe(prompt);
  });

  it.each([
    "draw a conclusion from this data",
    "draw a flowchart of the login",
    "make a table of prices",
    "create a plan for the week",
    "what is an image",
    "hello",
  ])("leaves %s to the normal brain", (text) => {
    expect(parseImageRequest(text)).toBeNull();
  });
});
