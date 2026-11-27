#!/usr/bin/env node
/**
 * FRIDAY Core A/B bench: the owner runs it on his own PC against a local llama-server (OpenAI-compatible API).
 * Prompts are synthetic and live in testing/evals/core-ab/; no model, no audio and no network beyond the loopback
 * server lives in the repository, and nothing here invents a number: with no data it says so and exits 3.
 *
 *   node scripts/core-bench.cjs run --url http://127.0.0.1:<port> [--model NAME] [--api-key KEY] [--label NAME]
 *        [--groups hi,hinglish,en,tool,vision,code] [--limit N] [--repeat N] [--warmup N] [--max-tokens N]
 *        [--with-load cpu[:THREADS]|stt] [--python PYTHON] [--system TEXT] [--timeout-ms N]
 *        [--allow-remote] [--out REPORT.json]
 *   node scripts/core-bench.cjs compare A.json B.json [--iterations N] [--seed N] [--out RESULT.json]
 *
 * run: for each prompt it streams the answer (SSE) and records the time to the first token (TTFT) and the decode rate
 * (tokens per second after the first token). Scorers: script match (Devanagari or Latin as the item expects), language
 * consistency of the reply, tool-call JSON validity against the tool schema (plus the right tool and arguments, and no
 * call when none is wanted), and a contains check for the vision caption and the short code items.
 *
 * --with-load starts a concurrent load for the whole run, because on a 4-core PC the speech ear, the embedder and the
 * Core compete for the same cores in a voice turn: `cpu[:N]` busy threads, or `stt` which repeats the kernel STT
 * self-test. A run without load and a run with load are different measurements; the report says which one it is.
 *
 * compare: pairs the two reports by prompt id and runs a seeded paired bootstrap on the score, TTFT and tokens per
 * second (overall and per group), giving the mean difference, a 95% interval and the verdict.
 *
 * The server must be on this PC (loopback) unless --allow-remote is given; the report goes to the temp folder or to
 * --out, never inside the repository, and never holds the API key. Exit: 0 done, 1 bad usage or invalid files,
 * 2 refused (remote server, report path inside the repository, load could not start), 3 no data (nothing measured).
 * A number from a Linux machine is a floor; the real A/B on the owner's Windows PC is unverified until he runs it.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const ROOT = path.resolve(__dirname, "..");
const EVAL_DIR = path.join(ROOT, "testing", "evals", "core-ab");
const EXIT = { OK: 0, USAGE: 1, REFUSED: 2, NO_DATA: 3 };
const GROUPS = ["hi", "hinglish", "en", "tool", "vision", "code"];
const EXPECTED_COUNTS = {
  hi: 30,
  hinglish: 30,
  en: 30,
  tool: 15,
  vision: 10,
  code: 5,
};
const DEFAULT_SYSTEM = "You are FRIDAY, a calm and concise desktop assistant. Keep answers short.";
const UNVERIFIED =
  "A number from one run is a floor for that machine; the real A/B on the owner's Windows PC (4 cores, STT loaded) is unverified until he runs it.";

/* ---------------------------------------------------------------- statistics */

function sortedNumbers(values) {
  return values.filter((v) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
}

function percentile(values, p) {
  const s = sortedNumbers(values);
  if (!s.length) return null;
  const pos = (s.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function median(values) {
  return percentile(values, 0.5);
}

function mean(values) {
  const s = sortedNumbers(values);
  return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null;
}

/** Wilson score interval for k successes in n trials (z = 1.96). */
function wilson(k, n, z = 1.96) {
  if (!n) return { rate: null, lo: null, hi: null, n: 0 };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return {
    rate: p,
    lo: Math.max(0, (c - m) / d),
    hi: Math.min(1, (c + m) / d),
    n,
  };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Paired bootstrap of b minus a. Pairs with a missing side are dropped. Seeded, so the same numbers always give the
 * same interval. `significant` means the 95% interval of the mean difference excludes zero.
 */
function pairedBootstrap(a, b, { iterations = 2000, seed = 1, alpha = 0.05 } = {}) {
  const diffs = [];
  const as = [];
  const bs = [];
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    if (Number.isFinite(a[i]) && Number.isFinite(b[i])) {
      diffs.push(b[i] - a[i]);
      as.push(a[i]);
      bs.push(b[i]);
    }
  }
  const n = diffs.length;
  if (!n)
    return {
      n: 0,
      meanA: null,
      meanB: null,
      meanDiff: null,
      ci: [null, null],
      pBetter: null,
      significant: false,
    };
  const rand = mulberry32(seed);
  const means = new Array(iterations);
  let positive = 0;
  for (let it = 0; it < iterations; it += 1) {
    let sum = 0;
    for (let i = 0; i < n; i += 1) sum += diffs[Math.floor(rand() * n)];
    means[it] = sum / n;
    if (means[it] > 0) positive += 1;
  }
  means.sort((x, y) => x - y);
  const lo = means[Math.floor((alpha / 2) * (iterations - 1))];
  const hi = means[Math.ceil((1 - alpha / 2) * (iterations - 1))];
  return {
    n,
    meanA: mean(as),
    meanB: mean(bs),
    meanDiff: mean(diffs),
    ci: [lo, hi],
    pBetter: positive / iterations,
    significant: lo > 0 || hi < 0,
  };
}

/* ---------------------------------------------------------------- scorers */

const DEVANAGARI = /\p{Script=Devanagari}/u;
const LATIN = /[A-Za-z]/;
const HINGLISH_MARKERS = new Set(
  (
    "hai hain hota hoti hote karo kare karein karna kya nahi nahin aur ke ki ka ko se mein par toh bhi ek do teen " +
    "batao bataiye aap tum mera meri mere kaise kyun kab kahan sabse pehle phir lekin agar jab ya yeh woh jaise liye " +
    "rakho rakhna chahiye sakte sakta sakti accha achha thoda bahut abhi apna apni"
  ).split(" "),
);

function stripCode(text) {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ");
}

function scriptStats(text) {
  let devanagari = 0;
  let latin = 0;
  for (const ch of stripCode(text)) {
    if (DEVANAGARI.test(ch)) devanagari += 1;
    else if (LATIN.test(ch)) latin += 1;
  }
  const total = devanagari + latin;
  return {
    devanagari,
    latin,
    total,
    devanagariShare: total ? devanagari / total : 0,
    latinShare: total ? latin / total : 0,
  };
}

/** Devanagari items need mostly Devanagari letters; Latin items need no real Devanagari at all. */
function scriptMatch(text, expected) {
  const s = scriptStats(text);
  if (!s.total) return { pass: false, share: 0, reason: "no letters" };
  if (expected === "devanagari") {
    return {
      pass: s.devanagariShare >= 0.6,
      share: s.devanagariShare,
      reason: "devanagari share",
    };
  }
  return {
    pass: s.devanagariShare <= 0.05 && s.latin > 0,
    share: s.latinShare,
    reason: "latin share",
  };
}

function hinglishRatio(text) {
  const words = stripCode(text)
    .toLowerCase()
    .match(/[a-z]+/g);
  if (!words || !words.length) return 0;
  return words.filter((w) => HINGLISH_MARKERS.has(w)).length / words.length;
}

/**
 * Does the whole reply stay in the language the item asked for? Sentence by sentence: Hindi must stay Devanagari
 * (at least 80% of sentences), English must stay Latin with next to no Hindi marker words, Hinglish must stay
 * Roman script and use real Hindi words (so a pure English or pure Devanagari reply does not count).
 */
function languageConsistency(text, lang) {
  const sentences = stripCode(text)
    .split(/[.!?।\n]+/)
    .map((s) => scriptStats(s))
    .filter((s) => s.total >= 3);
  if (!sentences.length) return { pass: false, reason: "no sentences" };
  const devShare = sentences.filter((s) => s.devanagariShare >= 0.5).length / sentences.length;
  const marker = hinglishRatio(text);
  if (lang === "hi") return { pass: devShare >= 0.8, devShare, reason: "devanagari sentences" };
  const overall = scriptStats(text);
  if (lang === "hinglish") {
    return {
      pass: overall.devanagariShare <= 0.05 && marker >= 0.08,
      marker,
      reason: "roman script with hindi words",
    };
  }
  return {
    pass: overall.devanagariShare === 0 && marker <= 0.06,
    marker,
    reason: "english only",
  };
}

function typeOk(value, type) {
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "array") return Array.isArray(value);
  if (type === "object")
    return value !== null && typeof value === "object" && !Array.isArray(value);
  return typeof value === type;
}

/** Checks one call against the tool list: known name, JSON object arguments, required keys, types and enums. */
function validateToolCall(call, tools) {
  const def = (tools || []).map((t) => t.function || t).find((f) => f && f.name === call.name);
  if (!def) return { valid: false, reason: `unknown tool ${call.name}` };
  let args = call.arguments;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args || "{}");
    } catch {
      return { valid: false, reason: "arguments are not JSON" };
    }
  }
  if (!typeOk(args, "object")) return { valid: false, reason: "arguments are not an object" };
  const schema = def.parameters || {};
  for (const key of schema.required || []) {
    if (!(key in args)) return { valid: false, reason: `missing ${key}` };
  }
  const props = schema.properties || {};
  for (const [key, value] of Object.entries(args)) {
    const spec = props[key];
    if (!spec) continue;
    if (spec.type && !typeOk(value, spec.type))
      return { valid: false, reason: `${key} is not ${spec.type}` };
    if (spec.enum && !spec.enum.includes(value))
      return { valid: false, reason: `${key} not in enum` };
  }
  return { valid: true, reason: "ok", args };
}

/** The first balanced JSON object in a text (a model that prints the call instead of using tool_calls). */
function extractJsonObject(text) {
  const s = String(text || "");
  for (let start = s.indexOf("{"); start !== -1; start = s.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < s.length; i += 1) {
      const c = s[i];
      if (inString) {
        if (c === "\\") i += 1;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === "{") depth += 1;
      else if (c === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(s.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

function callsFromText(text) {
  const obj = extractJsonObject(text);
  if (!obj) return [];
  const inner = obj.tool_call || obj.function || obj;
  const name = inner.name || inner.tool;
  return name ? [{ name, arguments: inner.arguments ?? inner.parameters ?? {} }] : [];
}

function sameValue(want, got) {
  if (typeof want === "number") return Number(got) === want;
  return String(got).trim().toLowerCase() === String(want).trim().toLowerCase();
}

/** Tool item: valid JSON against the schema, the right tool, the expected arguments; or no call when none is wanted. */
function scoreTool(expect, result, tools) {
  const calls =
    result.toolCalls && result.toolCalls.length ? result.toolCalls : callsFromText(result.text);
  if (!expect || expect.tool === null || expect.tool === undefined) {
    const pass = calls.length === 0;
    return {
      pass,
      jsonValid: true,
      toolOk: pass,
      argsOk: pass,
      reason: pass ? "no call" : "called a tool",
    };
  }
  if (!calls.length)
    return {
      pass: false,
      jsonValid: false,
      toolOk: false,
      argsOk: false,
      reason: "no call",
    };
  const call = calls[0];
  const check = validateToolCall(call, tools);
  const toolOk = call.name === expect.tool;
  const argsOk =
    check.valid &&
    Object.entries(expect.args || {}).every(
      ([key, want]) => key in check.args && sameValue(want, check.args[key]),
    );
  return {
    pass: check.valid && toolOk && argsOk,
    jsonValid: check.valid,
    toolOk,
    argsOk,
    reason: check.reason,
  };
}

function containsAll(text, needles) {
  const t = String(text || "").toLowerCase();
  return needles.every((n) => t.includes(String(n).toLowerCase()));
}

/** One item, one result: score 1 or 0 with the checks that decided it. */
function scoreItem(item, result, tools) {
  if (result.error) return { score: 0, checks: { error: result.error } };
  const expect = item.expect || {};
  const checks = {};
  if (item.group === "tool") {
    checks.tool = scoreTool(expect, result, tools);
    return { score: checks.tool.pass ? 1 : 0, checks };
  }
  if (expect.script) {
    checks.script = scriptMatch(result.text, expect.script);
    checks.language = languageConsistency(result.text, item.lang);
  }
  if (expect.contains) checks.contains = { pass: containsAll(result.text, expect.contains) };
  const all = Object.values(checks);
  return { score: all.length && all.every((c) => c.pass) ? 1 : 0, checks };
}

/* ---------------------------------------------------------------- streaming */

/** Calls onEvent(parsedJson | "[DONE]") for every SSE data line of a fetch body (web stream or async iterable). */
async function readSse(body, onEvent) {
  const decoder = new TextDecoder();
  let buffer = "";
  const handleLine = (line) => {
    const trimmed = line.replace(/\r$/, "");
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") {
      onEvent("[DONE]");
      return;
    }
    try {
      onEvent(JSON.parse(payload));
    } catch {
      /* a partial or non-JSON line is ignored */
    }
  };
  const feed = (chunk) => {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      handleLine(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");
    }
  };
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      feed(value);
    }
  } else if (body) {
    for await (const chunk of body) feed(chunk);
  }
  if (buffer.trim()) handleLine(buffer);
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n += 1) {
    let c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A solid-colour PNG built in memory (so no image file lives in the repository). */
function solidPng(rgb, size = 8) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(Array.from({ length: size }, () => rgb).flat()),
  ]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function userContent(item) {
  if (!item.image) return item.prompt;
  const url = `data:image/png;base64,${solidPng(item.image.rgb, item.image.size).toString("base64")}`;
  return [
    { type: "text", text: item.prompt },
    { type: "image_url", image_url: { url } },
  ];
}

function completionsUrl(base) {
  const trimmed = String(base).replace(/\/+$/, "");
  return /\/v1$/.test(trimmed) ? `${trimmed}/chat/completions` : `${trimmed}/v1/chat/completions`;
}

/**
 * One streamed request. TTFT is the time from sending to the first chunk that carries content, reasoning or a tool
 * call; the decode rate counts tokens after the first one over the time from the first to the last such chunk. The
 * token count is the server's usage when it sends one, else the number of chunks.
 */
async function runPrompt(item, opts, deps = {}) {
  const fetchFn = deps.fetch || globalThis.fetch;
  const now = deps.now || (() => performance.now());
  const body = {
    model: opts.model || "core",
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: opts.maxTokens,
    temperature: 0,
    messages: [
      { role: "system", content: opts.system || DEFAULT_SYSTEM },
      { role: "user", content: userContent(item) },
    ],
  };
  if (item.group === "tool") {
    body.tools = opts.tools;
    body.tool_choice = "auto";
  }
  const headers = { "content-type": "application/json" };
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || 120000);
  const t0 = now();
  const out = {
    text: "",
    reasoning: "",
    toolCalls: [],
    ttftMs: null,
    tokPerSec: null,
    tokens: 0,
    error: null,
  };
  try {
    const res = await fetchFn(completionsUrl(opts.url), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      out.error = `http ${res.status}`;
      return out;
    }
    let tFirst = null;
    let tLast = null;
    let chunks = 0;
    let usageTokens = null;
    const calls = new Map();
    await readSse(res.body, (event) => {
      if (event === "[DONE]") return;
      if (event.error) out.error = String(event.error.message || event.error);
      if (event.usage && Number.isFinite(event.usage.completion_tokens))
        usageTokens = event.usage.completion_tokens;
      if (event.timings && Number.isFinite(event.timings.predicted_per_second)) {
        out.serverTokPerSec = event.timings.predicted_per_second;
      }
      const delta = event.choices && event.choices[0] && event.choices[0].delta;
      if (!delta) return;
      let carried = false;
      if (delta.content) {
        out.text += delta.content;
        carried = true;
      }
      if (delta.reasoning_content) {
        out.reasoning += delta.reasoning_content;
        carried = true;
      }
      for (const tc of delta.tool_calls || []) {
        const slot = calls.get(tc.index ?? 0) || { name: "", arguments: "" };
        if (tc.function && tc.function.name) slot.name += tc.function.name;
        if (tc.function && tc.function.arguments) slot.arguments += tc.function.arguments;
        calls.set(tc.index ?? 0, slot);
        carried = true;
      }
      if (!carried) return;
      const t = now();
      if (tFirst === null) tFirst = t;
      tLast = t;
      chunks += 1;
    });
    out.toolCalls = [...calls.values()];
    out.tokens = usageTokens ?? chunks;
    if (tFirst === null) {
      out.error = out.error || "no tokens";
    } else {
      out.ttftMs = tFirst - t0;
      if (out.tokens > 1 && tLast > tFirst)
        out.tokPerSec = (out.tokens - 1) / ((tLast - tFirst) / 1000);
    }
  } catch (error) {
    out.error = controller.signal.aborted
      ? "timeout"
      : String(error && error.message ? error.message : error);
  } finally {
    clearTimeout(timer);
  }
  return out;
}

/* ---------------------------------------------------------------- load */

/**
 * Starts the concurrent load and returns { info, stop() }. `cpu[:N]` runs N busy worker threads; `stt` repeats the
 * kernel STT self-test in a child process. A load that cannot start throws, so a run never silently measures an idle
 * machine when a loaded one was asked for.
 */
function startLoad(spec, deps = {}) {
  const mode = String(spec || "none").split(":")[0];
  if (mode === "none" || !spec) return { info: { mode: "none" }, stop: async () => ({}) };
  if (mode === "cpu") {
    const wanted = Number(String(spec).split(":")[1]);
    const threads =
      Number.isInteger(wanted) && wanted > 0
        ? wanted
        : Math.max(1, Math.floor(os.cpus().length / 2));
    const WorkerCtor = deps.Worker || require("node:worker_threads").Worker;
    const workers = Array.from(
      { length: threads },
      () =>
        new WorkerCtor("let x=1;for(;;){x=(x*1.0000001)%1000+1}", {
          eval: true,
        }),
    );
    return {
      info: { mode: "cpu", threads },
      stop: async () => {
        await Promise.all(workers.map((w) => w.terminate()));
        return {};
      },
    };
  }
  if (mode === "stt") {
    const spawn = deps.spawn || require("node:child_process").spawn;
    const python = deps.python || "python";
    const root = deps.root || ROOT;
    const script = path.join(root, "kernel", "stt.py");
    const state = {
      stopped: false,
      runs: 0,
      failures: 0,
      child: null,
      error: null,
    };
    const launch = () => {
      if (state.stopped) return;
      const child = spawn(python, [script, "--self-test"], { stdio: "ignore" });
      state.child = child;
      child.on("error", (error) => {
        state.error = String(error.message || error);
        state.stopped = true;
      });
      child.on("exit", (code) => {
        state.runs += 1;
        if (code !== 0) state.failures += 1;
        launch();
      });
    };
    launch();
    return {
      info: { mode: "stt", python, script: path.relative(root, script) },
      stop: async () => {
        state.stopped = true;
        if (state.child && typeof state.child.kill === "function") state.child.kill();
        return {
          sttRuns: state.runs,
          sttFailures: state.failures,
          sttError: state.error,
        };
      },
    };
  }
  throw new Error(`unknown load ${spec}; use cpu[:N] or stt`);
}

/* ---------------------------------------------------------------- dataset and report */

function loadDataset(dir = EVAL_DIR) {
  const prompts = JSON.parse(fs.readFileSync(path.join(dir, "prompts.json"), "utf8"));
  const tools = JSON.parse(fs.readFileSync(path.join(dir, "tools.json"), "utf8"));
  return { items: prompts.items, tools: tools.tools };
}

/** Problems with a dataset (an empty list means it is sound): ids unique, group counts, shapes per group. */
function validateDataset(dataset) {
  const problems = [];
  const ids = new Set();
  const counts = {};
  const toolNames = new Set(dataset.tools.map((t) => t.function.name));
  for (const item of dataset.items) {
    if (ids.has(item.id)) problems.push(`duplicate id ${item.id}`);
    ids.add(item.id);
    counts[item.group] = (counts[item.group] || 0) + 1;
    if (!GROUPS.includes(item.group)) problems.push(`${item.id}: unknown group`);
    if (!item.prompt) problems.push(`${item.id}: empty prompt`);
    if (item.group === "tool" && item.expect.tool && !toolNames.has(item.expect.tool)) {
      problems.push(`${item.id}: unknown tool`);
    }
    if (["hi", "hinglish", "en"].includes(item.group) && !item.expect.script)
      problems.push(`${item.id}: no script`);
  }
  for (const [group, want] of Object.entries(EXPECTED_COUNTS)) {
    if ((counts[group] || 0) !== want)
      problems.push(`${group}: ${counts[group] || 0} items, want ${want}`);
  }
  return problems;
}

function summariseGroup(rows) {
  const ok = rows.filter((r) => !r.error);
  const passed = rows.filter((r) => r.score >= 0.5).length;
  return {
    n: rows.length,
    errors: rows.length - ok.length,
    ttftMs: {
      median: median(ok.map((r) => r.ttftMs)),
      p95: percentile(
        ok.map((r) => r.ttftMs),
        0.95,
      ),
    },
    tokPerSec: { median: median(ok.map((r) => r.tokPerSec)) },
    score: wilson(passed, rows.length),
  };
}

function summarise(rows) {
  const groups = {};
  for (const g of GROUPS) {
    const part = rows.filter((r) => r.group === g);
    if (part.length) groups[g] = summariseGroup(part);
  }
  return { all: summariseGroup(rows), groups };
}

/** Runs the whole bench: warm-up, then every selected prompt `repeat` times; one row per prompt. */
async function runBench(opts, dataset, deps = {}) {
  const wanted = opts.groups && opts.groups.length ? opts.groups : GROUPS;
  let items = dataset.items.filter((i) => wanted.includes(i.group));
  if (opts.limit) items = items.slice(0, opts.limit);
  if (!items.length) return { rows: [], warmup: 0 };
  const run = { ...opts, tools: dataset.tools };
  const plain = items.find((i) => i.group !== "tool" && !i.image) || items[0];
  const warmup = opts.warmup ?? 1;
  for (let w = 0; w < warmup; w += 1) await runPrompt(plain, run, deps);
  const rows = [];
  for (const item of items) {
    const runs = [];
    for (let r = 0; r < (opts.repeat || 1); r += 1) {
      const result = await runPrompt(item, run, deps);
      runs.push({ ...result, ...scoreItem(item, result, dataset.tools) });
    }
    const good = runs.filter((r) => !r.error);
    rows.push({
      id: item.id,
      group: item.group,
      lang: item.lang,
      score: mean(runs.map((r) => r.score)),
      ttftMs: median(good.map((r) => r.ttftMs)),
      tokPerSec: median(good.map((r) => r.tokPerSec)),
      tokens: median(good.map((r) => r.tokens)),
      error: good.length ? null : runs[0].error,
      checks: runs[0].checks,
      reply: runs[0].text.slice(0, 400),
    });
  }
  return { rows, warmup };
}

/** Paired comparison of two reports (b minus a), overall and per group, on score, TTFT and tokens per second. */
function compareReports(ra, rb, opts = {}) {
  const byId = new Map(rb.items.map((r) => [r.id, r]));
  const pairs = ra.items.filter((r) => byId.has(r.id)).map((r) => [r, byId.get(r.id)]);
  const metrics = { score: false, ttftMs: true, tokPerSec: false };
  const section = (subset) => {
    const out = {};
    for (const [metric, lowerIsBetter] of Object.entries(metrics)) {
      const a = subset.map(([x]) => (x.error ? NaN : x[metric]));
      const b = subset.map(([, y]) => (y.error ? NaN : y[metric]));
      const res = pairedBootstrap(a, b, opts);
      const better = lowerIsBetter ? res.meanDiff < 0 : res.meanDiff > 0;
      res.verdict = !res.n
        ? "no data"
        : !res.significant
          ? "no clear difference"
          : better
            ? "B better"
            : "A better";
      out[metric] = res;
    }
    return out;
  };
  const groups = {};
  for (const g of GROUPS) {
    const part = pairs.filter(([x]) => x.group === g);
    if (part.length) groups[g] = section(part);
  }
  return {
    schemaVersion: 1,
    kind: "core-bench-compare",
    a: ra.label,
    b: rb.label,
    pairs: pairs.length,
    loadMatch: (ra.load && ra.load.mode) === (rb.load && rb.load.mode),
    overall: section(pairs),
    groups,
  };
}

/* ---------------------------------------------------------------- command line */

function parseArgs(argv) {
  const args = { _: [] };
  const flags = new Set(["allow-remote"]);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      args[key] = flags.has(key) ? true : argv[(i += 1)];
    } else args._.push(a);
  }
  return args;
}

function isLoopback(url) {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return ["127.0.0.1", "localhost", "::1"].includes(host);
  } catch {
    return false;
  }
}

function insideRepo(file) {
  const rel = path.relative(ROOT, path.resolve(file));
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function fmt(n, digits = 0) {
  return n === null || n === undefined || Number.isNaN(n) ? "-" : Number(n).toFixed(digits);
}

function printSummary(summary, out) {
  out("group     n  err  ttft p50/p95 ms   tok/s p50   score (95% interval)");
  const row = (name, s) =>
    out(
      `${name.padEnd(9)} ${String(s.n).padStart(2)} ${String(s.errors).padStart(4)}  ${fmt(s.ttftMs.median).padStart(7)}/${fmt(s.ttftMs.p95).padEnd(7)} ${fmt(s.tokPerSec.median, 1).padStart(9)}   ${fmt(s.score.rate, 2)} (${fmt(s.score.lo, 2)}-${fmt(s.score.hi, 2)})`,
    );
  for (const [g, s] of Object.entries(summary.groups)) row(g, s);
  row("all", summary.all);
}

function compareCommand(args, files, out, deps) {
  if (files.length !== 2) {
    out("usage: node scripts/core-bench.cjs compare A.json B.json");
    return EXIT.USAGE;
  }
  let reports;
  try {
    reports = files.map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
  } catch (error) {
    out(`cannot read a report: ${error.message}`);
    return EXIT.USAGE;
  }
  if (reports.some((r) => r.kind !== "core-bench" || !Array.isArray(r.items))) {
    out("not a core-bench report");
    return EXIT.USAGE;
  }
  const result = compareReports(reports[0], reports[1], {
    iterations: Number(args.iterations) || 2000,
    seed: Number(args.seed) || 1,
  });
  if (!result.pairs) {
    out("no data: the two reports share no prompt id");
    return EXIT.NO_DATA;
  }
  if (!result.loadMatch)
    out("warning: the two runs used different loads; speed numbers are not comparable");
  out(`pairs: ${result.pairs}  (difference is B minus A, 95% interval)`);
  for (const [metric, r] of Object.entries(result.overall)) {
    out(
      `${metric.padEnd(10)} ${fmt(r.meanA, 2)} to ${fmt(r.meanB, 2)}  diff ${fmt(r.meanDiff, 3)} [${fmt(r.ci[0], 3)}, ${fmt(r.ci[1], 3)}]  ${r.verdict}`,
    );
  }
  if (args.out) {
    const file = path.resolve(args.out);
    if (insideRepo(file) && !(deps && deps.allowRepoOut)) {
      out("refused: the result must not be written inside the repository");
      return EXIT.REFUSED;
    }
    fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  }
  return EXIT.OK;
}

async function main(argv, deps = {}) {
  const out = deps.out || ((line) => console.log(line));
  const args = parseArgs(argv);
  const [command, ...rest] = args._;
  if (command === "compare") return compareCommand(args, rest, out, deps);
  if (command !== "run") {
    out("usage: node scripts/core-bench.cjs run --url URL [options] | compare A.json B.json");
    return EXIT.USAGE;
  }
  if (!args.url) {
    out("run needs --url of a llama-server, for example http://127.0.0.1:<port>");
    return EXIT.USAGE;
  }
  if (!args["allow-remote"] && !isLoopback(args.url)) {
    out("refused: the server must be on this PC (loopback); --allow-remote overrides");
    return EXIT.REFUSED;
  }
  const outFile = args.out
    ? path.resolve(args.out)
    : path.join(os.tmpdir(), `core-bench-${(args.label || "run").replace(/[^\w.-]/g, "_")}.json`);
  if (insideRepo(outFile)) {
    out("refused: the report must not be written inside the repository");
    return EXIT.REFUSED;
  }
  const dataset = deps.dataset || loadDataset();
  const problems = validateDataset(dataset);
  if (problems.length && !deps.dataset) {
    out(`invalid dataset: ${problems.slice(0, 3).join("; ")}`);
    return EXIT.USAGE;
  }
  const opts = {
    url: args.url,
    model: args.model,
    apiKey: args["api-key"] || process.env.FRIDAY_CORE_BENCH_KEY,
    system: args.system,
    maxTokens: Number(args["max-tokens"]) || 160,
    timeoutMs: Number(args["timeout-ms"]) || 120000,
    groups: args.groups ? args.groups.split(",") : null,
    limit: Number(args.limit) || 0,
    repeat: Number(args.repeat) || 1,
    warmup: args.warmup === undefined ? 1 : Number(args.warmup),
  };
  let load;
  try {
    load = (deps.startLoad || startLoad)(args["with-load"], {
      python: args.python,
      ...deps.loadDeps,
    });
  } catch (error) {
    out(`refused: load did not start: ${error.message}`);
    return EXIT.REFUSED;
  }
  let result;
  let loadEnd = {};
  try {
    result = await runBench(opts, dataset, deps);
  } finally {
    loadEnd = (await load.stop()) || {};
  }
  if (!result.rows.length || result.rows.every((r) => r.error)) {
    out("no data: nothing was measured (no prompts selected, or every request failed)");
    return EXIT.NO_DATA;
  }
  const summary = summarise(result.rows);
  const report = {
    schemaVersion: 1,
    kind: "core-bench",
    label: args.label || "run",
    server: new URL(args.url).host,
    model: args.model || null,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    cpuCount: os.cpus().length,
    totalMemGb: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
    options: {
      maxTokens: opts.maxTokens,
      repeat: opts.repeat,
      warmup: result.warmup,
      groups: opts.groups,
      limit: opts.limit,
    },
    load: { ...load.info, ...loadEnd },
    summary,
    items: result.rows,
    unverified: UNVERIFIED,
  };
  fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
  printSummary(summary, out);
  out(`load: ${report.load.mode}; report: ${outFile}`);
  out(UNVERIFIED);
  return EXIT.OK;
}

module.exports = {
  EXIT,
  GROUPS,
  DEFAULT_SYSTEM,
  percentile,
  median,
  wilson,
  pairedBootstrap,
  scriptStats,
  scriptMatch,
  languageConsistency,
  validateToolCall,
  extractJsonObject,
  scoreTool,
  scoreItem,
  readSse,
  solidPng,
  completionsUrl,
  runPrompt,
  startLoad,
  loadDataset,
  validateDataset,
  summarise,
  runBench,
  compareReports,
  main,
};

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error.message);
      process.exit(1);
    },
  );
}
