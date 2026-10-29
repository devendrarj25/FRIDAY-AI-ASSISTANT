/**
 * FRIDAY · local LoRA / QLoRA fine-tuning service
 *
 * Runs kernel/finetune_lora.py on this PC with FRIDAY's own experience data as
 * the training set. Nothing leaves the machine: the dataset is written under
 * <FRIDAY_ROOT>/database/finetune, the adapter lands in
 * <FRIDAY_ROOT>/models/adapters/<id>, and every run is recorded so an older
 * adapter can be re-activated if a newer one turns out worse.
 *
 * The renderer never starts a run on its own — the caller must have passed the
 * owner's approval gate first (see src/lib/friday/self/finetune.ts).
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const paths = require("./friday-paths.cjs");
const { resolvePython } = require("./python.cjs");

const HISTORY_FILE = () => path.join(paths.ensureDir("database"), "finetune.json");
const JOBS_DIR = () => {
  const dir = path.join(paths.ensureDir("database"), "finetune");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const ADAPTERS_DIR = () => {
  const dir = path.join(paths.ensureDir("models"), "adapters");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

let ctx = { send: () => {}, log: () => {}, projectRoot: null };
let active = null; // { id, child, run }

const emit = (channel, payload) => {
  try {
    ctx.send(channel, payload);
  } catch {
    /* window closed */
  }
};

function readHistory() {
  try {
    const raw = fs.readFileSync(HISTORY_FILE(), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.runs) ? parsed : { runs: [], activeAdapter: null };
  } catch {
    return { runs: [], activeAdapter: null };
  }
}

function writeHistory(state) {
  try {
    fs.writeFileSync(HISTORY_FILE(), JSON.stringify(state, null, 2));
  } catch (error) {
    ctx.log?.(`finetune history write failed: ${error.message}`);
  }
}

function record(run) {
  const state = readHistory();
  const index = state.runs.findIndex((r) => r.id === run.id);
  if (index >= 0) state.runs[index] = run;
  else state.runs.unshift(run);
  state.runs = state.runs.slice(0, 40);
  writeHistory(state);
  emit("finetune:run", run);
  return run;
}

/** The training script, in a packaged install or a source checkout. */
function scriptPath() {
  const packaged = path.join(process.resourcesPath || "", "kernel", "finetune_lora.py");
  if (fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, "..", "kernel", "finetune_lora.py");
}

/** Are the local training libraries actually installed in FRIDAY's Python? */
async function probe() {
  const python = await resolvePython(ctx.projectRoot);
  if (!python?.exe) {
    return {
      ready: false,
      python: null,
      missing: ["python"],
      detail: "FRIDAY's Python runtime was not found. Run Setup & Doctor to repair it.",
    };
  }
  const code =
    "import json,importlib.util as u;" +
    "print(json.dumps({m:(u.find_spec(m) is not None) for m in " +
    "['torch','transformers','datasets','peft','bitsandbytes']}))";
  const found = await new Promise((resolve) => {
    const child = spawn(python.exe, [...(python.prefix || []), "-c", code], {
      windowsHide: true,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", () => resolve(null));
    child.on("close", () => {
      try {
        resolve(JSON.parse(out.trim().split("\n").pop() || "{}"));
      } catch {
        resolve(null);
      }
    });
  });
  if (!found) {
    return {
      ready: false,
      python: python.exe,
      missing: ["torch", "transformers", "datasets", "peft"],
      detail: "Could not check the training libraries.",
    };
  }
  // bitsandbytes is optional: without it FRIDAY trains plain LoRA instead of
  // 4-bit QLoRA, which still works, just slower and heavier on memory.
  const required = ["torch", "transformers", "datasets", "peft"];
  const missing = required.filter((m) => !found[m]);
  return {
    ready: missing.length === 0,
    python: python.exe,
    missing,
    quantised: Boolean(found.bitsandbytes),
    detail: missing.length
      ? `Install ${missing.join(", ")} from Install Manager to train locally.`
      : found.bitsandbytes
        ? "Ready — QLoRA (4-bit) available."
        : "Ready — LoRA available (install BitsAndBytes for 4-bit QLoRA).",
  };
}

/** Write the JSONL dataset for one run and return its path. */
function writeDataset(id, examples) {
  const file = path.join(JOBS_DIR(), `${id}.jsonl`);
  const lines = (examples || [])
    .filter((row) => row && row.prompt && row.response)
    .map((row) => JSON.stringify({ prompt: String(row.prompt), response: String(row.response) }));
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return { file, count: lines.length };
}

/**
 * Start a training run. `examples` come from the experience store — verified
 * successes only — and the caller must already have the owner's approval.
 */
async function start(options = {}) {
  if (active) return { ok: false, error: "A fine-tuning run is already in progress." };
  const readiness = await probe();
  if (!readiness.ready) return { ok: false, error: readiness.detail, missing: readiness.missing };
  if (!options.base) return { ok: false, error: "No base model was selected." };

  const id = `ft-${Date.now().toString(36)}`;
  const { file: dataset, count } = writeDataset(id, options.examples);
  if (count < 8) {
    return {
      ok: false,
      error: `Only ${count} verified example(s) available — not enough to train on yet.`,
    };
  }

  const output = path.join(ADAPTERS_DIR(), id);
  fs.mkdirSync(output, { recursive: true });
  const job = {
    id,
    base: String(options.base),
    dataset,
    output,
    epochs: Number(options.epochs) || 2,
    learningRate: Number(options.learningRate) || 2e-4,
    rank: Number(options.rank) || 16,
    quantised: options.quantised !== false && readiness.quantised !== false,
  };
  const jobFile = path.join(JOBS_DIR(), `${id}.json`);
  fs.writeFileSync(jobFile, JSON.stringify(job, null, 2));

  const python = await resolvePython(ctx.projectRoot);
  const run = {
    id,
    base: job.base,
    examples: count,
    startedAt: Date.now(),
    endedAt: null,
    state: "running",
    progress: 0,
    detail: "Starting the local trainer",
    output,
    loss: null,
    error: null,
  };
  record(run);

  const child = spawn(python.exe, [...(python.prefix || []), scriptPath(), "--config", jobFile], {
    windowsHide: true,
    env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1" },
  });
  active = { id, child, run };

  let tail = "";
  child.stdout.on("data", (chunk) => {
    tail += chunk.toString();
    const lines = tail.split("\n");
    tail = lines.pop() || "";
    for (const line of lines) {
      let event = null;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.stage === "training" && event.total) {
        run.progress = Math.min(0.99, Number(event.step) / Number(event.total));
        run.detail = `Training — step ${event.step}/${event.total}${event.loss ? ` · loss ${Number(event.loss).toFixed(3)}` : ""}`;
      } else if (event.stage === "failed") {
        run.error = String(event.error || "training failed");
      } else if (event.stage === "done") {
        run.loss = Number(event.loss) || null;
      } else if (event.detail) {
        run.detail = String(event.detail);
      }
      record(run);
    }
  });
  child.stderr.on("data", (chunk) => ctx.log?.(`finetune: ${chunk.toString().trim()}`));

  child.on("close", (code) => {
    active = null;
    run.endedAt = Date.now();
    run.progress = 1;
    if (code === 0 && !run.error) {
      run.state = "done";
      run.detail = `Adapter ready at ${output}`;
    } else {
      run.state = "failed";
      run.error = run.error || `The trainer exited with code ${code}.`;
      run.detail = run.error;
    }
    record(run);
  });

  return { ok: true, run };
}

function cancel() {
  if (!active) return { ok: false, error: "Nothing is training right now." };
  try {
    active.child.kill();
  } catch {
    /* already gone */
  }
  return { ok: true };
}

/** Every adapter FRIDAY has trained, newest first. */
function listAdapters() {
  const dir = ADAPTERS_DIR();
  const state = readHistory();
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isDirectory());
  } catch {
    names = [];
  }
  const adapters = names
    .map((name) => {
      let meta = {};
      try {
        meta = JSON.parse(fs.readFileSync(path.join(dir, name, "friday-adapter.json"), "utf8"));
      } catch {
        meta = {};
      }
      return {
        id: name,
        dir: path.join(dir, name),
        base: meta.base ?? null,
        examples: meta.examples ?? null,
        loss: meta.loss ?? null,
        finishedAt: meta.finishedAt ? meta.finishedAt * 1000 : null,
        active: state.activeAdapter === name,
      };
    })
    .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
  return { ok: true, adapters, activeAdapter: state.activeAdapter ?? null };
}

/**
 * Activate (or clear) the adapter FRIDAY uses. Kept as a pointer, so going
 * back to the previous adapter — or to the plain base model — is one call.
 */
function activate(id) {
  const state = readHistory();
  if (id && !fs.existsSync(path.join(ADAPTERS_DIR(), id))) {
    return { ok: false, error: `Adapter ${id} is not on disk.` };
  }
  state.activeAdapter = id || null;
  writeHistory(state);
  emit("finetune:active", { activeAdapter: state.activeAdapter });
  return { ok: true, activeAdapter: state.activeAdapter };
}

function remove(id) {
  const dir = path.join(ADAPTERS_DIR(), String(id || ""));
  if (!id || !fs.existsSync(dir)) return { ok: false, error: "That adapter no longer exists." };
  fs.rmSync(dir, { recursive: true, force: true });
  const state = readHistory();
  if (state.activeAdapter === id) state.activeAdapter = null;
  writeHistory(state);
  return { ok: true };
}

const snapshot = () => {
  const state = readHistory();
  return {
    runs: state.runs,
    activeAdapter: state.activeAdapter ?? null,
    busy: Boolean(active),
  };
};

function init(options = {}) {
  ctx = { ...ctx, ...options };
  return snapshot();
}

module.exports = { init, probe, start, cancel, listAdapters, activate, remove, snapshot };
