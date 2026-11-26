#!/usr/bin/env node
/**
 * Doctor probes: the small, injectable checks that `check-environment.cjs` and `voice-stack.cjs` share.
 *
 *   - sources     every download source of an item (a model, runtime, package or tool) as an ordered list of host names
 *   - reachability one cheap HEAD request per distinct host, in parallel, short timeout, cached for the run; "not checked"
 *                 when the PC is offline (never a failure: a missing item is already its own row)
 *   - tesseract   the languages `tesseract --list-langs` reports (English is required, Hindi is a language pack)
 *   - onnxruntime the installed flavour (cpu, gpu, directml) against what this PC's plan recommends
 *   - python      which importable modules exist in the FRIDAY venv (importlib.util.find_spec, nothing is imported)
 *
 *   node scripts/doctor-probes.cjs --probe host [host ...]   prints one JSON line (used by reachSync)
 */
"use strict";

const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const HUGGING_FACE = "huggingface.co";
const PYPI_HOSTS = Object.freeze(["pypi.org", "files.pythonhosted.org"]);
/** winget's package index; the installer itself comes from the vendor (the tool's own host follows it). */
const WINGET_HOST = "cdn.winget.microsoft.com";
const PROBE_TIMEOUT_MS = 4000;
const CACHE_TTL_MS = 5 * 60 * 1000;

/* ------------------------------------------------------------------------------------------------ sources */

function hostOfUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    return new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`,
    ).host.toLowerCase();
  } catch {
    return "";
  }
}

/** The host a download source is fetched from: its url, a mirror endpoint or host, or Hugging Face for a repo. */
function sourceHost(source) {
  if (!source || typeof source !== "object") return "";
  for (const key of ["url", "endpoint", "mirror", "host"]) {
    const host = hostOfUrl(source[key]);
    if (host) return host;
  }
  if (source.kind === "hf-repo" || source.kind === "hf-gguf" || source.repo) return HUGGING_FACE;
  return "";
}

/** Distinct hosts of a list of sources, in the order the downloader tries them. */
function sourceHosts(sources) {
  const hosts = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    const host = sourceHost(source);
    if (host && !hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}

/** A setup job (`{ job: { sources } }`) or a bare `{ sources }` object. */
function jobHosts(job) {
  return sourceHosts(job?.job?.sources ?? job?.sources);
}

/** A tool of electron/toolchain.cjs: winget's index first, then the vendor's installer host. */
function toolHosts(tool) {
  const hosts = [];
  const add = (host) => {
    if (host && !hosts.includes(host)) hosts.push(host);
  };
  if (tool?.winget) add(WINGET_HOST);
  add(hostOfUrl(tool?.installerUrl));
  if (!hosts.length) add(hostOfUrl(tool?.url));
  return hosts;
}

/* ---------------------------------------------------------------------------------------------- reachability */

/** Probing is off when the PC is offline on purpose, when the owner turned it off, and under the test runner. */
function reachEnabled(env = process.env) {
  if (String(env.FRIDAY_OFFLINE || "") === "1") return false;
  if (String(env.FRIDAY_REACH_PROBE ?? "") === "0") return false;
  if (env.VITEST) return false;
  return true;
}

function unchecked(env) {
  return String(env.FRIDAY_OFFLINE || "") === "1" ? "offline" : "probe off";
}

/** One host: any answer below 500 means the host is up; a network error, a timeout or a 5xx means down. */
async function probeHost(
  host,
  { fetchImpl = globalThis.fetch, timeoutMs = PROBE_TIMEOUT_MS, now = Date.now } = {},
) {
  const started = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`https://${host}/`, {
      method: "HEAD",
      redirect: "manual",
      signal: controller.signal,
      headers: { "user-agent": "FRIDAY-Doctor" },
    });
    try {
      await res.body?.cancel?.();
    } catch {
      /* a HEAD answer has no body to drop */
    }
    const status = Number(res.status) || 0;
    return { state: status > 0 && status < 500 ? "up" : "down", ms: now() - started, status };
  } catch (error) {
    return {
      state: "down",
      ms: now() - started,
      error: String((error && error.message) || error).slice(0, 80),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Every distinct host at once. Returns `{ host: { state, ms } }`. */
async function probeHosts(hosts, deps = {}) {
  const unique = [...new Set((hosts || []).filter(Boolean))];
  const answers = await Promise.all(unique.map((host) => probeHost(host, deps)));
  return Object.fromEntries(unique.map((host, index) => [host, answers[index]]));
}

const MEMO = new Map();

function readCache(file, now) {
  if (!file) return {};
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const fresh = {};
    for (const [host, entry] of Object.entries(data || {})) {
      if (entry && typeof entry.at === "number" && now - entry.at < CACHE_TTL_MS)
        fresh[host] = entry;
    }
    return fresh;
  } catch {
    return {};
  }
}

/**
 * Reachability of every host, synchronously (the check scripts build their rows in one pass): one child process probes
 * all the hosts that are not cached yet, in parallel. The cache lives in memory and, when `FRIDAY_REACH_CACHE` names a
 * file (Doctor sets it for the run), in that file, so the steps of one Doctor run probe each host once.
 * Returns `{ host: { state: "up" | "down" | "unchecked", ms, reason? } }`.
 */
function reachSync(
  hosts,
  { env = process.env, run = spawnSync, now = Date.now, memo = MEMO } = {},
) {
  const unique = [...new Set((hosts || []).filter(Boolean))];
  const out = {};
  if (!reachEnabled(env)) {
    for (const host of unique) out[host] = { state: "unchecked", reason: unchecked(env) };
    return out;
  }
  const file = String(env.FRIDAY_REACH_CACHE || "");
  const shared = readCache(file, now());
  const todo = [];
  for (const host of unique) {
    const hit =
      memo.get(host) && now() - memo.get(host).at < CACHE_TTL_MS ? memo.get(host) : shared[host];
    if (hit) out[host] = { state: hit.state, ms: hit.ms };
    else todo.push(host);
  }
  if (!todo.length) return out;
  let probed = null;
  try {
    const result = run(process.execPath, [__filename, "--probe", ...todo], {
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS * 2 + 3000,
      windowsHide: true,
      shell: false,
      env,
    });
    if (result && !result.error && result.status === 0) {
      const line = String(result.stdout || "")
        .split(/\r?\n/)
        .reverse()
        .find((text) => text.startsWith("{"));
      probed = line ? JSON.parse(line) : null;
    }
  } catch {
    probed = null;
  }
  const stamp = now();
  const keep = { ...shared };
  for (const host of todo) {
    const answer = probed && probed[host];
    if (!answer || (answer.state !== "up" && answer.state !== "down")) {
      out[host] = { state: "unchecked", reason: "the probe did not run" };
      continue;
    }
    out[host] = { state: answer.state, ms: answer.ms };
    memo.set(host, { state: answer.state, ms: answer.ms, at: stamp });
    keep[host] = { state: answer.state, ms: answer.ms, at: stamp };
  }
  if (file) {
    try {
      fs.writeFileSync(file, JSON.stringify(keep));
    } catch {
      /* the cache is an optimisation only */
    }
  }
  return out;
}

/**
 * The detail text of a row: every source host in order with what answers now. For a missing item whose first source is
 * down while another is up it says so. Returns "" when the item has no host.
 */
function sourcesLine(hosts, reach = {}, { missing = false } = {}) {
  if (!hosts || !hosts.length) return "";
  const stateOf = (host) => reach[host]?.state || "unchecked";
  const checked = hosts.some((host) => stateOf(host) !== "unchecked");
  const body = hosts
    .map((host) => (stateOf(host) === "unchecked" ? host : `${host} (${stateOf(host)})`))
    .join(" > ");
  if (!checked) {
    const why = reach[hosts[0]]?.reason;
    return `sources: ${body} (not checked${why ? `: ${why}` : ""})`;
  }
  const first = hosts[0];
  const up = hosts.slice(1).find((host) => stateOf(host) === "up");
  const parts = [`sources: ${body}`];
  if (stateOf(first) === "down" && up) {
    parts.push(
      missing
        ? `the first source ${first} is down now; ${up} answers, so setup falls back to it`
        : `the first source ${first} is down now; ${up} answers as the fallback`,
    );
  } else if (missing && hosts.every((host) => stateOf(host) === "down")) {
    parts.push(
      "no source answers now (offline or blocked), so it cannot be fetched until one does",
    );
  }
  return parts.join("; ");
}

/* -------------------------------------------------------------------------------------------------- tesseract */

/** The language codes `tesseract --list-langs` prints (a header line, then one code per line). */
function parseTesseractLangs(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const header = lines.findIndex((line) => /list of available languages/i.test(line));
  const codes = (header >= 0 ? lines.slice(header + 1) : lines).filter((line) =>
    /^[A-Za-z][A-Za-z0-9_]*$/.test(line),
  );
  return [...new Set(codes)];
}

/** English is required; Hindi is a language pack (setup installs it, a missing one is a note, never a failure). */
function tesseractLanguages(text) {
  const langs = parseTesseractLangs(text);
  return {
    langs,
    listed: langs.length > 0,
    eng: langs.includes("eng"),
    hin: langs.includes("hin"),
  };
}

/* ------------------------------------------------------------------------------------------------ onnxruntime */

const ORT_PROBE = [
  "import importlib.metadata as m, json",
  "out = {}",
  "for n in ('onnxruntime', 'onnxruntime-gpu', 'onnxruntime-directml'):",
  "    try:",
  "        out[n] = m.version(n)",
  "    except Exception:",
  "        pass",
  "try:",
  "    import onnxruntime as o",
  "    out['providers'] = list(o.get_available_providers())",
  "except Exception as e:",
  "    out['error'] = str(e)[:100]",
  "print('ORT_JSON ' + json.dumps(out))",
].join("\n");

/** `{ flavour: "cpu" | "gpu" | "directml" | "none", version, providers, wheels, error }` from the probe's output. */
function parseOrtProbe(stdout) {
  const line = String(stdout || "")
    .split(/\r?\n/)
    .reverse()
    .find((text) => text.startsWith("ORT_JSON "));
  if (!line) return null;
  let data;
  try {
    data = JSON.parse(line.slice("ORT_JSON ".length));
  } catch {
    return null;
  }
  const wheels = ["onnxruntime-gpu", "onnxruntime-directml", "onnxruntime"].filter(
    (name) => data[name],
  );
  const first = wheels[0];
  const flavour =
    first === "onnxruntime-gpu"
      ? "gpu"
      : first === "onnxruntime-directml"
        ? "directml"
        : first
          ? "cpu"
          : "none";
  return {
    flavour,
    version: first ? String(data[first]) : "",
    providers: Array.isArray(data.providers) ? data.providers.map(String) : [],
    wheels,
    error: data.error ? String(data.error) : "",
  };
}

function probeOrt(python, { run = spawnSync } = {}) {
  if (!python) return null;
  try {
    const result = run(python, ["-c", ORT_PROBE], {
      encoding: "utf8",
      timeout: 60000,
      windowsHide: true,
      shell: false,
    });
    return result && !result.error && result.status === 0 ? parseOrtProbe(result.stdout) : null;
  } catch {
    return null;
  }
}

/**
 * The info row for the installed onnxruntime flavour against the plan (`required` row `onnxruntime`:
 * `variant` is what setup installs now, `recommended` the build this PC's hardware suits).
 */
function ortRow(probe, planRow) {
  const installNow = planRow?.variant || "";
  const recommended = planRow?.recommended || installNow;
  const want = planRow
    ? `setup installs the ${installNow || "cpu"} build; this PC's plan recommends ${recommended || "cpu"}`
    : "this PC's plan could not be read, so no flavour is recommended";
  if (!probe) return { found: "could not be checked (no Python runtime)", want, note: "" };
  if (probe.flavour === "none")
    return {
      found: probe.error ? `not importable (${probe.error})` : "not installed",
      want,
      note: "",
    };
  const found = `${probe.flavour} ${probe.version}${probe.providers.length ? ` (${probe.providers.join(", ")})` : ""}`;
  let note = "";
  if (probe.wheels.length > 1)
    note = `${probe.wheels.length} onnxruntime wheels are installed together (${probe.wheels.join(", ")}); keep only one`;
  else if (planRow && recommended && probe.flavour !== recommended)
    note = `the ${recommended} build is recommended for this PC; it is offered in the Install Manager (a swap with a hash check and a rollback)`;
  else if (planRow) note = "matches this PC's recommendation";
  return { found, want, note };
}

/* ------------------------------------------------------------------------------------------------ python modules */

const MODULE_PROBE = [
  "import importlib.util as u, json, sys",
  "def has(name):",
  "    try:",
  "        return u.find_spec(name) is not None",
  "    except Exception:",
  "        return False",
  "print('PYMODS ' + json.dumps({name: has(name) for name in sys.argv[1:]}))",
].join("\n");

/** The interpreter FRIDAY uses: FRIDAY_PYTHON when it exists, else the live venv's python when that file is there. */
function venvPython(env = process.env, { exists = fs.existsSync } = {}) {
  const named = require("./explicit-python.cjs").explicitPython(env.FRIDAY_PYTHON);
  if (named) return named;
  try {
    const found = require("./python-runtime.cjs").resolveVenvPython() || "";
    return found && exists(found) ? found : "";
  } catch {
    return "";
  }
}

/**
 * Which modules exist in the FRIDAY venv, without importing any of them. `{ module: true | false }`, or null when no
 * Python runs (a caller then says "not checked", never "missing").
 */
function probeModules(python, modules, { run = spawnSync } = {}) {
  const names = [...new Set((modules || []).filter(Boolean))];
  if (!python || !names.length) return null;
  try {
    const result = run(python, ["-c", MODULE_PROBE, ...names], {
      encoding: "utf8",
      timeout: 60000,
      windowsHide: true,
      shell: false,
    });
    if (!result || result.error || result.status !== 0) return null;
    const line = String(result.stdout || "")
      .split(/\r?\n/)
      .reverse()
      .find((text) => text.startsWith("PYMODS "));
    return line ? JSON.parse(line.slice("PYMODS ".length)) : null;
  } catch {
    return null;
  }
}

module.exports = {
  HUGGING_FACE,
  PYPI_HOSTS,
  WINGET_HOST,
  sourceHost,
  sourceHosts,
  jobHosts,
  toolHosts,
  reachEnabled,
  probeHost,
  probeHosts,
  reachSync,
  sourcesLine,
  parseTesseractLangs,
  tesseractLanguages,
  parseOrtProbe,
  probeOrt,
  ortRow,
  probeModules,
  venvPython,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === "--probe") {
    probeHosts(args.slice(1)).then((answers) => {
      console.log(JSON.stringify(answers));
    });
  } else {
    console.error("usage: node scripts/doctor-probes.cjs --probe host [host ...]");
    process.exitCode = 2;
  }
}
