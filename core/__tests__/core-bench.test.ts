/**
 * Core A/B bench: a fake streaming server and an injected fetch, a fake clock, a fake load. No model, no network beyond
 * a loopback server on an ephemeral port, no dependence on today's date.
 */
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

type Json = Record<string, unknown>;
type Call = { name: string; arguments: unknown };
type RunResult = {
  text: string;
  toolCalls: Call[];
  ttftMs: number | null;
  tokPerSec: number | null;
  tokens: number;
  error: string | null;
};
type Item = {
  id: string;
  group: string;
  lang: string;
  prompt: string;
  expect: Json;
  image?: { kind: string; rgb: number[]; size: number };
};
type Dataset = { items: Item[]; tools: { function: Json }[] };
type Boot = {
  n: number;
  meanA: number | null;
  meanB: number | null;
  meanDiff: number | null;
  ci: (number | null)[];
  pBetter: number | null;
  significant: boolean;
};
type Bench = {
  EXIT: Record<string, number>;
  percentile: (v: number[], p: number) => number | null;
  wilson: (
    k: number,
    n: number,
  ) => { rate: number | null; lo: number | null; hi: number | null; n: number };
  pairedBootstrap: (a: number[], b: number[], o?: Json) => Boot;
  scriptMatch: (t: string, s: string) => { pass: boolean; share: number };
  languageConsistency: (t: string, l: string) => { pass: boolean };
  validateToolCall: (c: Call, t: unknown) => { valid: boolean; reason: string };
  scoreTool: (
    e: Json | null,
    r: Json,
    t: unknown,
  ) => { pass: boolean; jsonValid: boolean; toolOk: boolean; argsOk: boolean };
  scoreItem: (i: Item, r: Json, t: unknown) => { score: number; checks: Json };
  readSse: (body: unknown, on: (e: unknown) => void) => Promise<void>;
  solidPng: (rgb: number[], size?: number) => Buffer;
  completionsUrl: (u: string) => string;
  runPrompt: (i: Item, o: Json, d: Json) => Promise<RunResult & { serverTokPerSec?: number }>;
  startLoad: (spec: string | undefined, deps?: Json) => { info: Json; stop: () => Promise<Json> };
  loadDataset: () => Dataset;
  validateDataset: (d: Dataset) => string[];
  compareReports: (
    a: Json,
    b: Json,
    o?: Json,
  ) => {
    pairs: number;
    loadMatch: boolean;
    overall: Record<string, Boot & { verdict: string }>;
  };
  main: (argv: string[], deps?: Json) => Promise<number>;
};

const req = createRequire(import.meta.url);
const bench = req("../../scripts/core-bench.cjs") as Bench;
const dataset = bench.loadDataset();
const encoder = new TextEncoder();

const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
const delta = (d: Json) => frame({ choices: [{ index: 0, delta: d }] });
const usage = (n: number) => frame({ choices: [], usage: { completion_tokens: n } });

/** A fetch whose body arrives frame by frame; the fake clock moves by `steps[i]` before frame i is read. */
function fakeFetch(
  frames: string[],
  steps: number[],
  clock: { t: number },
  seen: Json[] = [],
  status = 200,
) {
  return async (url: string, init: { body: string; headers: Record<string, string> }) => {
    seen.push({ url, body: JSON.parse(init.body), headers: init.headers });
    let i = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (i >= frames.length) return controller.close();
          clock.t += steps[i] ?? 0;
          controller.enqueue(encoder.encode(frames[i]));
          i += 1;
        },
      },
      { highWaterMark: 0 },
    );
    return { ok: status === 200, status, body };
  };
}

const textItem = dataset.items.find((i) => i.group === "en") as Item;
const toolItem = dataset.items.find((i) => i.group === "tool") as Item;
const base = {
  url: "http://127.0.0.1:8080",
  maxTokens: 64,
  tools: dataset.tools,
};

describe("streaming: TTFT and tokens per second", () => {
  it("measures TTFT at the first content chunk and the decode rate after it, from the server usage", async () => {
    const clock = { t: 0 };
    const frames = [
      delta({ role: "assistant" }),
      ...["He", "llo", " the", "re", "!"].map((c) => delta({ content: c })),
      usage(5),
      "data: [DONE]\n\n",
    ];
    // role frame at 50, then content at 300, 400, 500, 600, 700
    const steps = [50, 250, 100, 100, 100, 100, 0, 0];
    const seen: Json[] = [];
    const r = await bench.runPrompt(
      textItem,
      { ...base, apiKey: "k-test" },
      { fetch: fakeFetch(frames, steps, clock, seen), now: () => clock.t },
    );
    expect(r.error).toBeNull();
    expect(r.text).toBe("Hello there!");
    expect(r.ttftMs).toBe(300);
    expect(r.tokens).toBe(5);
    expect(r.tokPerSec).toBeCloseTo(10, 6); // 4 tokens after the first over 400 ms
    const sent = seen[0] as {
      url: string;
      body: Json;
      headers: Record<string, string>;
    };
    expect(sent.url).toBe("http://127.0.0.1:8080/v1/chat/completions");
    expect(sent.body.stream).toBe(true);
    expect(sent.body.tools).toBeUndefined();
    expect(sent.headers.authorization).toBe("Bearer k-test");
  });

  it("counts chunks when the server sends no usage, and keeps the server's own timing", async () => {
    const clock = { t: 0 };
    const frames = [
      delta({ content: "a" }),
      delta({ content: "b" }),
      frame({
        choices: [{ delta: { content: "c" } }],
        timings: { predicted_per_second: 12.5 },
      }),
    ];
    const r = await bench.runPrompt(textItem, base, {
      fetch: fakeFetch(frames, [200, 100, 100], clock),
      now: () => clock.t,
    });
    expect(r.tokens).toBe(3);
    expect(r.ttftMs).toBe(200);
    expect(r.tokPerSec).toBeCloseTo(10, 6);
    expect(r.serverTokPerSec).toBe(12.5);
  });

  it("assembles tool-call deltas, sends the tools only for tool items and counts reasoning as the first token", async () => {
    const clock = { t: 0 };
    const frames = [
      delta({ reasoning_content: "thinking" }),
      delta({
        tool_calls: [{ index: 0, function: { name: "set_timer", arguments: '{"min' } }],
      }),
      delta({
        tool_calls: [{ index: 0, function: { arguments: 'utes": 10}' } }],
      }),
    ];
    const seen: Json[] = [];
    const r = await bench.runPrompt(toolItem, base, {
      fetch: fakeFetch(frames, [120, 10, 10], clock, seen),
      now: () => clock.t,
    });
    expect(r.ttftMs).toBe(120);
    expect(r.toolCalls).toEqual([{ name: "set_timer", arguments: '{"minutes": 10}' }]);
    expect(((seen[0] as { body: Json }).body.tools as unknown[]).length).toBe(dataset.tools.length);
    expect(bench.validateToolCall(r.toolCalls[0], dataset.tools).valid).toBe(true);
  });

  it("reports an http error or a stream with no tokens as an error row instead of throwing", async () => {
    const clock = { t: 0 };
    const bad = await bench.runPrompt(textItem, base, {
      fetch: fakeFetch([], [], clock, [], 503),
      now: () => clock.t,
    });
    expect(bad.error).toBe("http 503");
    const empty = await bench.runPrompt(textItem, base, {
      fetch: fakeFetch(["data: [DONE]\n\n"], [5], clock),
      now: () => clock.t,
    });
    expect(empty.error).toBe("no tokens");
    expect(empty.ttftMs).toBeNull();
    const thrown = await bench.runPrompt(textItem, base, {
      fetch: async () => {
        throw new Error("connection refused");
      },
      now: () => 0,
    });
    expect(thrown.error).toBe("connection refused");
  });

  it("parses SSE that arrives split mid-line with CRLF, and ignores comments and broken lines", async () => {
    const text = `: keep-alive\r\ndata: {"a":1}\r\n\r\ndata: {broken\n\ndata: {"b":2}\n\ndata: [DONE]\n`;
    const bytes = encoder.encode(text);
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
        c.close();
      },
    });
    const events: unknown[] = [];
    await bench.readSse(body, (e) => events.push(e));
    expect(events).toEqual([{ a: 1 }, { b: 2 }, "[DONE]"]);
    expect(bench.completionsUrl("http://127.0.0.1:1/v1/")).toBe(
      "http://127.0.0.1:1/v1/chat/completions",
    );
  });
});

describe("scorers", () => {
  it("script match: Devanagari items need mostly Devanagari, Latin items need none", () => {
    expect(bench.scriptMatch("आज मौसम अच्छा है।", "devanagari").pass).toBe(true);
    expect(
      bench.scriptMatch("आज मौसम बहुत अच्छा है, कल बारिश होगी, Chrome खोलो", "devanagari").pass,
    ).toBe(true);
    expect(bench.scriptMatch("Aaj mausam accha hai.", "devanagari").pass).toBe(false);
    expect(bench.scriptMatch("Aaj mausam accha hai.", "latin").pass).toBe(true);
    expect(bench.scriptMatch("Aaj मौसम accha hai.", "latin").pass).toBe(false);
    expect(bench.scriptMatch("12345 ...", "latin").pass).toBe(false);
    expect(bench.scriptMatch("```python\nprint('x')\n```", "latin").pass).toBe(false);
  });

  it("language consistency: Hindi stays Devanagari, Hinglish stays Roman with Hindi words, English stays English", () => {
    expect(bench.languageConsistency("सुबह जल्दी उठो। पानी पियो। थोड़ा टहलो।", "hi").pass).toBe(true);
    expect(bench.languageConsistency("Wake up early. Drink water. Take a walk.", "hi").pass).toBe(
      false,
    );
    expect(
      bench.languageConsistency("सुबह जल्दी उठो। Drink water and take a walk. Then relax.", "hi")
        .pass,
    ).toBe(false);
    expect(
      bench.languageConsistency(
        "Subah jaldi utho, paani piyo aur thoda tehlo. Yeh bahut accha hai.",
        "hinglish",
      ).pass,
    ).toBe(true);
    expect(bench.languageConsistency("Wake up early and drink some water.", "hinglish").pass).toBe(
      false,
    );
    expect(bench.languageConsistency("सुबह जल्दी उठो और पानी पियो।", "hinglish").pass).toBe(false);
    expect(bench.languageConsistency("Wake up early and drink some water.", "en").pass).toBe(true);
    expect(
      bench.languageConsistency("Wake up early, aur paani piyo, yeh accha hai.", "en").pass,
    ).toBe(false);
    expect(bench.languageConsistency("", "en").pass).toBe(false);
  });

  it("tool JSON validity: name, JSON object, required keys, types", () => {
    const ok = (c: Call) => bench.validateToolCall(c, dataset.tools);
    expect(ok({ name: "set_timer", arguments: '{"minutes": 10}' }).valid).toBe(true);
    expect(ok({ name: "set_timer", arguments: { minutes: 2.5 } }).valid).toBe(true);
    expect(ok({ name: "set_timer", arguments: "{}" }).reason).toBe("missing minutes");
    expect(ok({ name: "set_volume", arguments: '{"level": 30.5}' }).reason).toBe(
      "level is not integer",
    );
    expect(ok({ name: "set_timer", arguments: '{"minutes": "ten"}' }).valid).toBe(false);
    expect(ok({ name: "set_timer", arguments: "{minutes: 10" }).reason).toBe(
      "arguments are not JSON",
    );
    expect(ok({ name: "set_timer", arguments: "[1]" }).valid).toBe(false);
    expect(ok({ name: "launch_missiles", arguments: "{}" }).reason).toBe(
      "unknown tool launch_missiles",
    );
  });

  it("tool scoring: right tool and arguments, wrong arguments, no call wanted, and a call printed as text", () => {
    const want = { tool: "set_volume", args: { level: 30 } };
    const good = {
      text: "",
      toolCalls: [{ name: "set_volume", arguments: '{"level": 30}' }],
    };
    expect(bench.scoreTool(want, good, dataset.tools)).toMatchObject({
      pass: true,
      jsonValid: true,
      toolOk: true,
      argsOk: true,
    });
    const wrongArgs = {
      text: "",
      toolCalls: [{ name: "set_volume", arguments: '{"level": 40}' }],
    };
    expect(bench.scoreTool(want, wrongArgs, dataset.tools)).toMatchObject({
      pass: false,
      jsonValid: true,
      argsOk: false,
    });
    const wrongTool = {
      text: "",
      toolCalls: [{ name: "set_timer", arguments: '{"minutes": 30}' }],
    };
    expect(bench.scoreTool(want, wrongTool, dataset.tools)).toMatchObject({
      pass: false,
      toolOk: false,
    });
    const printed = {
      text: 'Sure: {"name": "set_volume", "arguments": {"level": 30}} done',
      toolCalls: [],
    };
    expect(bench.scoreTool(want, printed, dataset.tools).pass).toBe(true);
    expect(bench.scoreTool(want, { text: "Okay!", toolCalls: [] }, dataset.tools)).toMatchObject({
      pass: false,
      jsonValid: false,
    });
    expect(
      bench.scoreTool({ tool: null }, { text: "Paris.", toolCalls: [] }, dataset.tools).pass,
    ).toBe(true);
    expect(bench.scoreTool({ tool: null }, good, dataset.tools).pass).toBe(false);
  });

  it("scoreItem combines the checks per group and scores an error as zero", () => {
    const hi = dataset.items.find((i) => i.group === "hi") as Item;
    const code = dataset.items.find((i) => i.id === "cd-01") as Item;
    const vision = dataset.items.find((i) => i.group === "vision") as Item;
    expect(bench.scoreItem(hi, { text: "सुबह जल्दी उठो। पानी पियो।" }, dataset.tools).score).toBe(1);
    expect(bench.scoreItem(hi, { text: "Wake up early." }, dataset.tools).score).toBe(0);
    expect(bench.scoreItem(code, { text: "```python\ns[::-1]\n```" }, dataset.tools).score).toBe(1);
    expect(bench.scoreItem(code, { text: "use reversed()" }, dataset.tools).score).toBe(0);
    expect(bench.scoreItem(vision, { text: "Red." }, dataset.tools).score).toBe(1);
    expect(bench.scoreItem(vision, { text: "Blue." }, dataset.tools).score).toBe(0);
    expect(bench.scoreItem(hi, { text: "", error: "timeout" }, dataset.tools)).toEqual({
      score: 0,
      checks: { error: "timeout" },
    });
  });
});

describe("statistics", () => {
  it("percentile and Wilson interval on fixed numbers", () => {
    expect(bench.percentile([4, 1, 3, 2], 0.5)).toBe(2.5);
    expect(bench.percentile([1, 2, 3, 4, 5], 0.95)).toBeCloseTo(4.8, 10);
    expect(bench.percentile([], 0.5)).toBeNull();
    const w = bench.wilson(5, 10);
    expect(w.rate).toBe(0.5);
    expect(w.lo).toBeCloseTo(0.2366, 3);
    expect(w.hi).toBeCloseTo(0.7634, 3);
    expect(bench.wilson(0, 0).rate).toBeNull();
    expect(bench.wilson(10, 10).hi).toBe(1);
  });

  it("paired bootstrap: a constant gain is significant, no gain is not, the seed makes it repeatable", () => {
    const a = [1, 2, 3, 4, 5, 6];
    const gain = bench.pairedBootstrap(
      a,
      a.map((x) => x + 2),
    );
    expect(gain).toMatchObject({
      n: 6,
      meanDiff: 2,
      significant: true,
      pBetter: 1,
    });
    expect(gain.ci).toEqual([2, 2]);
    const same = bench.pairedBootstrap(a, a);
    expect(same.significant).toBe(false);
    expect(same.meanDiff).toBe(0);
    const mixed = bench.pairedBootstrap([0, 0, 0, 0, 0, 0, 0, 0], [1, -1, 1, -1, 1, -1, 1, -1]);
    expect(mixed.significant).toBe(false);
    expect(mixed.ci[0] as number).toBeLessThan(0);
    expect(mixed.ci[1] as number).toBeGreaterThan(0);
    expect(bench.pairedBootstrap(a, [2, 1, 5, 3, 9, 1], { seed: 7 })).toEqual(
      bench.pairedBootstrap(a, [2, 1, 5, 3, 9, 1], { seed: 7 }),
    );
  });

  it("paired bootstrap drops pairs with a missing side and returns no data for none", () => {
    const r = bench.pairedBootstrap([1, NaN, 3], [2, 5, Number.NaN]);
    expect(r.n).toBe(1);
    expect(r.meanDiff).toBe(1);
    expect(bench.pairedBootstrap([], [])).toMatchObject({
      n: 0,
      meanDiff: null,
      significant: false,
    });
  });

  it("compareReports pairs by id and names the better side, lower TTFT being better", () => {
    const mk = (label: string, ttft: number, load: string) => ({
      kind: "core-bench",
      label,
      load: { mode: load },
      items: Array.from({ length: 12 }, (_, i) => ({
        id: `en-${i}`,
        group: "en",
        score: 1,
        ttftMs: ttft + (i % 3),
        tokPerSec: 8 + (i % 2),
        error: null,
      })).concat([
        {
          id: "only-in-a",
          group: "en",
          score: 1,
          ttftMs: 1,
          tokPerSec: 1,
          error: null,
        },
      ]),
    });
    const faster = {
      ...mk("B", 400, "stt"),
      items: mk("B", 400, "stt").items.filter((i) => i.id !== "only-in-a"),
    };
    const res = bench.compareReports(mk("A", 900, "stt"), faster);
    expect(res.pairs).toBe(12);
    expect(res.loadMatch).toBe(true);
    expect(res.overall.ttftMs.verdict).toBe("B better");
    expect(res.overall.ttftMs.meanDiff).toBe(-500);
    expect(res.overall.score.verdict).toBe("no clear difference");
    expect(bench.compareReports(mk("A", 900, "none"), faster).loadMatch).toBe(false);
  });
});

describe("the committed prompt set", () => {
  it("has 120 sound prompts: 30 Hindi, 30 Hinglish, 30 English, 15 tool, 10 vision, 5 code", () => {
    expect(bench.validateDataset(dataset)).toEqual([]);
    expect(dataset.items.length).toBe(120);
    const count = (g: string) => dataset.items.filter((i) => i.group === g).length;
    expect([
      count("hi"),
      count("hinglish"),
      count("en"),
      count("tool"),
      count("vision"),
      count("code"),
    ]).toEqual([30, 30, 30, 15, 10, 5]);
    expect(new Set(dataset.items.map((i) => i.prompt + i.id)).size).toBe(120);
  });

  it("prompts are in the script they claim, and the vision images are valid generated PNGs", () => {
    for (const item of dataset.items.filter((i) => i.group === "hi")) {
      expect(bench.scriptMatch(item.prompt, "devanagari").pass, item.id).toBe(true);
    }
    for (const item of dataset.items.filter((i) => ["hinglish", "en"].includes(i.group))) {
      expect(bench.scriptMatch(item.prompt, "latin").pass, item.id).toBe(true);
    }
    expect(dataset.items.filter((i) => i.group === "tool" && i.expect.tool === null).length).toBe(
      3,
    );
    for (const item of dataset.items.filter((i) => i.group === "vision")) {
      const png = bench.solidPng(
        (item.image as { rgb: number[] }).rgb,
        (item.image as { size: number }).size,
      );
      expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(png.readUInt32BE(16)).toBe((item.image as { size: number }).size);
      const ihdrCrc = png.readUInt32BE(29);
      expect(ihdrCrc).toBe(zlib.crc32(png.subarray(12, 29)));
      const idatLength = png.readUInt32BE(33);
      const raw = zlib.inflateSync(png.subarray(41, 41 + idatLength));
      expect(raw.length).toBe(
        (item.image as { size: number }).size * ((item.image as { size: number }).size * 3 + 1),
      );
    }
  });

  it("flags a broken set: duplicate id, wrong counts, unknown tool", () => {
    const broken: Dataset = {
      tools: dataset.tools,
      items: [
        {
          id: "x",
          group: "hi",
          lang: "hi",
          prompt: "p",
          expect: { script: "devanagari" },
        },
        {
          id: "x",
          group: "tool",
          lang: "en",
          prompt: "p",
          expect: { tool: "nope" },
        },
      ],
    };
    const problems = bench.validateDataset(broken);
    expect(problems).toContain("duplicate id x");
    expect(problems).toContain("x: unknown tool");
    expect(problems.some((p) => p.startsWith("hi: 1 items"))).toBe(true);
  });
});

describe("concurrent load", () => {
  it("cpu load starts the asked number of busy threads and terminates them on stop", async () => {
    const made: { code: string; ended: boolean }[] = [];
    class FakeWorker {
      rec: { code: string; ended: boolean };
      constructor(code: string) {
        this.rec = { code, ended: false };
        made.push(this.rec);
      }
      async terminate() {
        this.rec.ended = true;
      }
    }
    const load = bench.startLoad("cpu:3", { Worker: FakeWorker });
    expect(load.info).toEqual({ mode: "cpu", threads: 3 });
    expect(made.length).toBe(3);
    await load.stop();
    expect(made.every((m) => m.ended)).toBe(true);
    expect(bench.startLoad(undefined).info).toEqual({ mode: "none" });
    expect(() => bench.startLoad("gpu")).toThrow(/unknown load/);
  });

  it("stt load repeats the kernel self-test until stopped and reports its runs", async () => {
    const handlers: Record<string, ((v?: unknown) => void)[]> = {};
    let launched = 0;
    let killed = false;
    const spawn = (python: string, args: string[]) => {
      launched += 1;
      expect(python).toBe("py");
      expect(args[0].replace(/\\/g, "/")).toMatch(/kernel\/stt\.py$/);
      expect(args[1]).toBe("--self-test");
      const h: Record<string, ((v?: unknown) => void)[]> = {};
      handlers.current = [];
      return {
        on: (ev: string, fn: (v?: unknown) => void) => {
          (h[ev] ||= []).push(fn);
          if (ev === "exit") handlers.current.push(() => fn(launched === 1 ? 0 : 1));
        },
        kill: () => {
          killed = true;
        },
      };
    };
    const load = bench.startLoad("stt", { spawn, python: "py" });
    expect(launched).toBe(1);
    handlers.current[0](); // first run ends well, the next one starts
    expect(launched).toBe(2);
    const end = await load.stop();
    expect(killed).toBe(true);
    expect(end).toEqual({ sttRuns: 1, sttFailures: 0, sttError: null });
  });
});

describe("command line against a fake streaming server", () => {
  let server: Server | null = null;
  let dir = "";
  afterEach(async () => {
    if (server) await new Promise((r) => server?.close(r));
    server = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  const miniSet: Dataset = {
    tools: dataset.tools,
    items: [
      {
        id: "hi-a",
        group: "hi",
        lang: "hi",
        prompt: "नमस्ते कहो।",
        expect: { script: "devanagari" },
      },
      {
        id: "en-a",
        group: "en",
        lang: "en",
        prompt: "Say hello.",
        expect: { script: "latin" },
      },
      {
        id: "tl-a",
        group: "tool",
        lang: "en",
        prompt: "Set a timer for 10 minutes.",
        expect: { tool: "set_timer", args: { minutes: 10 } },
      },
    ],
  };

  async function serve(reply: (prompt: string, hasTools: boolean) => string[], status = 200) {
    const seenAuth: (string | undefined)[] = [];
    server = createServer((rq, rs) => {
      let raw = "";
      rq.on("data", (c) => (raw += c));
      rq.on("end", () => {
        const body = JSON.parse(raw);
        seenAuth.push(rq.headers.authorization);
        if (status !== 200) {
          rs.writeHead(status).end();
          return;
        }
        rs.writeHead(200, { "content-type": "text/event-stream" });
        const prompt = String(body.messages[1].content);
        for (const f of reply(prompt, Boolean(body.tools))) rs.write(f);
        rs.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    return { url: `http://127.0.0.1:${port}`, seenAuth };
  }

  const answers = (prompt: string, hasTools: boolean) => {
    if (hasTools) {
      return [
        delta({
          tool_calls: [
            {
              index: 0,
              function: { name: "set_timer", arguments: '{"minutes":10}' },
            },
          ],
        }),
        usage(12),
      ];
    }
    return [
      delta({
        content: prompt.includes("नमस्ते") ? "नमस्ते! कैसे हैं आप।" : "Hello there, friend.",
      }),
      usage(6),
    ];
  };

  it("runs the prompts, scores them, writes a report without the key, and prints a table", async () => {
    const { url, seenAuth } = await serve(answers);
    dir = mkdtempSync(join(tmpdir(), "core-bench-"));
    const out = join(dir, "r.json");
    const lines: string[] = [];
    const code = await bench.main(
      [
        "run",
        "--url",
        url,
        "--label",
        "core-a",
        "--warmup",
        "1",
        "--repeat",
        "2",
        "--api-key",
        "secret-key-xyz",
        "--out",
        out,
        "--with-load",
        "cpu:1",
      ],
      {
        dataset: miniSet,
        out: (l: string) => lines.push(l),
        startLoad: () => ({
          info: { mode: "cpu", threads: 1 },
          stop: async () => ({}),
        }),
      },
    );
    expect(code).toBe(bench.EXIT.OK);
    const report = JSON.parse(readFileSync(out, "utf8"));
    expect(report).toMatchObject({
      kind: "core-bench",
      label: "core-a",
      load: { mode: "cpu" },
      options: { repeat: 2, warmup: 1 },
    });
    expect(report.items.map((i: Json) => i.id)).toEqual(["hi-a", "en-a", "tl-a"]);
    expect(report.items.every((i: Json) => i.score === 1)).toBe(true);
    expect(report.summary.all.score.rate).toBe(1);
    expect(report.summary.groups.tool.n).toBe(1);
    expect(JSON.stringify(report)).not.toContain("secret-key-xyz");
    expect(report.unverified).toMatch(/unverified/);
    expect(seenAuth.length).toBe(1 + 3 * 2);
    expect(seenAuth.every((a) => a === "Bearer secret-key-xyz")).toBe(true);
    expect(lines.some((l) => l.startsWith("group"))).toBe(true);
    expect(lines.join("\n")).toMatch(/unverified/);
  });

  it("a Hindi item answered in English scores zero, and --groups narrows the run", async () => {
    const { url } = await serve(() => [delta({ content: "Hello there, friend." }), usage(4)]);
    dir = mkdtempSync(join(tmpdir(), "core-bench-"));
    const out = join(dir, "r.json");
    const code = await bench.main(
      ["run", "--url", url, "--groups", "hi", "--warmup", "0", "--out", out],
      { dataset: miniSet, out: () => undefined },
    );
    expect(code).toBe(0);
    const report = JSON.parse(readFileSync(out, "utf8"));
    expect(report.items.length).toBe(1);
    expect(report.items[0].score).toBe(0);
    expect(report.items[0].checks.script.pass).toBe(false);
  });

  it("exits 3 with no data when every request fails, and writes no report", async () => {
    const { url } = await serve(() => [], 503);
    dir = mkdtempSync(join(tmpdir(), "core-bench-"));
    const out = join(dir, "r.json");
    const lines: string[] = [];
    const code = await bench.main(["run", "--url", url, "--warmup", "0", "--out", out], {
      dataset: miniSet,
      out: (l: string) => lines.push(l),
    });
    expect(code).toBe(bench.EXIT.NO_DATA);
    expect(existsSync(out)).toBe(false);
    expect(lines.join(" ")).toMatch(/no data/);
  });

  it("refuses a remote server, a report inside the repository, and a load that cannot start", async () => {
    const quiet = { dataset: miniSet, out: () => undefined };
    expect(await bench.main(["run", "--url", "http://203.0.113.9:8080"], quiet)).toBe(
      bench.EXIT.REFUSED,
    );
    expect(
      await bench.main(
        ["run", "--url", "http://127.0.0.1:1", "--out", join(__dirname, "report.json")],
        quiet,
      ),
    ).toBe(bench.EXIT.REFUSED);
    const failing = {
      ...quiet,
      startLoad: () => {
        throw new Error("no python");
      },
    };
    expect(
      await bench.main(["run", "--url", "http://127.0.0.1:1", "--with-load", "stt"], failing),
    ).toBe(bench.EXIT.REFUSED);
    expect(await bench.main(["run"], quiet)).toBe(bench.EXIT.USAGE);
    expect(await bench.main(["bogus"], quiet)).toBe(bench.EXIT.USAGE);
  });

  it("compare reads two reports and prints the paired verdict", async () => {
    dir = mkdtempSync(join(tmpdir(), "core-bench-"));
    const mk = (label: string, ttft: number) => ({
      kind: "core-bench",
      label,
      load: { mode: "none" },
      items: Array.from({ length: 10 }, (_, i) => ({
        id: `en-${i}`,
        group: "en",
        score: 1,
        ttftMs: ttft,
        tokPerSec: 9,
        error: null,
      })),
    });
    writeFileSync(join(dir, "a.json"), JSON.stringify(mk("A", 800)));
    writeFileSync(join(dir, "b.json"), JSON.stringify(mk("B", 500)));
    writeFileSync(join(dir, "bad.json"), JSON.stringify({ kind: "other" }));
    const lines: string[] = [];
    const out = (l: string) => lines.push(l);
    expect(
      await bench.main(
        ["compare", join(dir, "a.json"), join(dir, "b.json"), "--out", join(dir, "c.json")],
        { out },
      ),
    ).toBe(0);
    expect(lines.join("\n")).toMatch(/ttftMs\s+800\.00 to 500\.00\s+diff -300\.000 .* B better/);
    expect(JSON.parse(readFileSync(join(dir, "c.json"), "utf8")).pairs).toBe(10);
    expect(await bench.main(["compare", join(dir, "a.json"), join(dir, "bad.json")], { out })).toBe(
      bench.EXIT.USAGE,
    );
    expect(await bench.main(["compare", join(dir, "a.json")], { out })).toBe(bench.EXIT.USAGE);
  });
});
