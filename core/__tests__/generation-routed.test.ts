/**
 * The picture handler asks the kernel router which model may draw, and draws with that model only.
 * The handler is cut out of electron/main.cjs and run against a fake kernel RPC and a fake images module.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const main = readFileSync(resolve(process.cwd(), "electron/main.cjs"), "utf8");
const start = main.indexOf("async function generateImageRouted(payload)");
const source = main.slice(start, main.indexOf('ipcMain.handle("image:generate"', start));

type Model = { id: string; providerModelId: string; providerId: string; displayName: string };
type Route = { ok: boolean; modelId: string | null; candidates?: string[]; reason?: string };
type Result = { ok: boolean; error?: string; model?: string };

const cloud = (id: string): Model => ({
  id,
  providerModelId: `${id}-provider`,
  providerId: "openai",
  displayName: id,
});

function setup(
  options: {
    route?: Route | Error;
    models?: Model[];
    auth?: { allowed: boolean; message?: string };
    refuse?: string[];
    failDraw?: string[];
    privacy?: boolean;
  } = {},
) {
  const calls = {
    rpc: [] as Array<{ method: string; params: Record<string, unknown> }>,
    draw: [] as Array<Record<string, unknown>>,
    authorise: [] as string[],
  };
  const models = options.models ?? [cloud("img-a"), cloud("img-b")];
  const images = {
    candidates: (list: Model[], allowed: (m: Model) => boolean) => list.filter(allowed),
    draw: async (args: Record<string, unknown>) => {
      calls.draw.push(args);
      if (options.failDraw?.includes(String(args["model"])))
        return { ok: false, error: "provider error" };
      return { ok: true, type: "image/png", buffer: Buffer.from("png") };
    },
    save: () => "assets/images/one.png",
  };
  const kernelRequest = async (method: string, params: Record<string, unknown>) => {
    calls.rpc.push({ method, params });
    const route = options.route ?? { ok: true, modelId: "img-b" };
    if (route instanceof Error) throw route;
    return route;
  };
  const run = new Function(
    "require",
    "path",
    "paths",
    "refreshRoutable",
    "modelUsagePolicy",
    "modelRouter",
    "syncKernelModels",
    "kernelRequest",
    "voicePrivacyOn",
    "modelRouteMode",
    "authoriseProviderRequest",
    `${source}; return generateImageRouted;`,
  )(
    () => images,
    { join: (...parts: string[]) => parts.join("/") },
    { ensureDir: (name: string) => name },
    async () => ({ models }),
    () => ({}),
    { modelAvailability: () => ({ visibility: "show" }) },
    async () => ({ ok: true }),
    kernelRequest,
    () => options.privacy === true,
    () => "auto",
    async ({ model }: { model: Model }) => {
      calls.authorise.push(model.id);
      if (options.refuse?.includes(model.id)) return { allowed: false, message: "refused here" };
      return options.auth ?? { allowed: true };
    },
  ) as (payload: Record<string, unknown>) => Promise<Result>;
  return { run, calls };
}

describe("a picture is drawn only with the model the router picked", () => {
  it("passes the router's pick, and only that model, to the drawing module", async () => {
    const { run, calls } = setup();
    const result = await run({ prompt: "a red apple" });
    expect(result.ok).toBe(true);
    expect(calls.rpc[0]?.method).toBe("model.route_generation");
    expect(calls.rpc[0]?.params).toMatchObject({ kind: "image", content: "a red apple" });
    expect(calls.draw).toHaveLength(1);
    expect(calls.draw[0]?.["model"]).toBe("img-b-provider");
    expect(calls.authorise).toEqual(["img-b"]);
  });

  it("draws nothing and returns the reason when the router refuses", async () => {
    const reason = "no image model is allowed right now";
    const { run, calls } = setup({ route: { ok: false, modelId: null, reason } });
    expect(await run({ prompt: "a red apple" })).toEqual({ ok: false, error: reason });
    expect(calls.draw).toHaveLength(0);
    expect(calls.authorise).toHaveLength(0);
  });

  it("draws nothing when the kernel cannot answer", async () => {
    const { run, calls } = setup({ route: new Error("kernel not ready") });
    const result = await run({ prompt: "a red apple" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("kernel not ready");
    expect(calls.draw).toHaveLength(0);
  });

  it("never draws with a model the router did not name, even if one is offered", async () => {
    const { run, calls } = setup({ route: { ok: true, modelId: "img-elsewhere" } });
    expect((await run({ prompt: "a red apple" })).ok).toBe(false);
    expect(calls.draw).toHaveLength(0);
  });

  it("ignores a renderer-named model for choosing and refuses one the router did not pick", async () => {
    const { run, calls } = setup();
    const refused = await run({ prompt: "a red apple", modelId: "img-a" });
    expect(refused.ok).toBe(false);
    expect(calls.draw).toHaveLength(0);
    expect(calls.rpc[0]?.params).not.toHaveProperty("modelId");
    const confirmed = await run({ prompt: "a red apple", modelId: "img-b" });
    expect(confirmed.ok).toBe(true);
    expect(calls.draw.map((d) => d["model"])).toEqual(["img-b-provider"]);
  });

  it("keeps the own gate as a second check on the picked model", async () => {
    const { run, calls } = setup({ auth: { allowed: false, message: "needs your yes" } });
    const result = await run({ prompt: "a red apple" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("needs your yes");
    expect(calls.draw).toHaveLength(0);
  });

  it("asks for private routing when speech privacy is on, and never claims an explicit paid yes", async () => {
    const { run, calls } = setup({ privacy: true });
    await run({ prompt: "a red apple", modelId: "img-b" });
    expect(calls.rpc[0]?.params).toMatchObject({ privacyMode: "private", explicitPaid: false });
  });

  it("tries the router's candidates in order; a refusal or an error moves on, the first success wins", async () => {
    const { run, calls } = setup({
      route: { ok: true, modelId: "img-a", candidates: ["img-a", "img-b", "img-c"] },
      models: [cloud("img-a"), cloud("img-b"), cloud("img-c")],
      refuse: ["img-a"],
      failDraw: ["img-b-provider"],
    });
    const result = await run({ prompt: "a red apple" });
    expect(result).toMatchObject({ ok: true, model: "img-c" });
    expect(calls.authorise).toEqual(["img-a", "img-b", "img-c"]);
    expect(calls.draw.map((d) => d["model"])).toEqual(["img-b-provider", "img-c-provider"]);
  });

  it("stops at the first success and tries at most three candidates", async () => {
    const ids = ["m1", "m2", "m3", "m4"];
    const first = setup({
      route: { ok: true, modelId: "m1", candidates: ids },
      models: ids.map(cloud),
    });
    expect((await first.run({ prompt: "x" })).ok).toBe(true);
    expect(first.calls.draw).toHaveLength(1);
    const all = setup({
      route: { ok: true, modelId: "m1", candidates: ids },
      models: ids.map(cloud),
      refuse: ids,
    });
    expect((await all.run({ prompt: "x" })).ok).toBe(false);
    expect(all.calls.authorise).toEqual(["m1", "m2", "m3"]);
  });

  it("draws nothing and joins the reasons when every candidate is refused", async () => {
    const { run, calls } = setup({
      route: { ok: true, modelId: "img-a", candidates: ["img-a", "img-b"] },
      refuse: ["img-a", "img-b"],
    });
    const result = await run({ prompt: "a red apple" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("img-a: refused here");
    expect(result.error).toContain("img-b: refused here");
    expect(calls.draw).toHaveLength(0);
  });

  it("skips a candidate that cannot draw from here but never adds one the router did not name", async () => {
    const { run, calls } = setup({
      route: { ok: true, modelId: "gone", candidates: ["gone", "img-b"] },
      models: [cloud("img-a"), cloud("img-b")],
    });
    expect((await run({ prompt: "x" })).ok).toBe(true);
    expect(calls.draw.map((d) => d["model"])).toEqual(["img-b-provider"]);
  });

  it("is the handler behind image:generate", () => {
    expect(main).toContain(
      'ipcMain.handle("image:generate", (_e, payload) => generateImageRouted(payload));',
    );
  });
});
