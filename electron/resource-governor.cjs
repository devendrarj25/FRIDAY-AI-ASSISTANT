/**
 * The one resource governor: how FRIDAY keeps the app and the PC responsive whatever the hardware.
 *
 *  1. Leases      Heavy consumers (local language model, speech worker, image, video and music jobs, embeddings)
 *                 ask for video memory and RAM before they load. A request is granted only when the free memory,
 *                 minus headroom the desktop needs, allows it; otherwise it shrinks to a smaller option, pauses
 *                 lower-priority work, waits in a bounded queue, or is refused with a reason. Priority:
 *                 voice > chat > background > prefetch. A holder that stops beating loses its lease.
 *  2. Job caps    Downloads, installs, generations and model loads run through small bounded queues with
 *                 cancellation tokens, so a burst of requests waits instead of piling onto the PC.
 *  3. Pressure    Free RAM and video memory read on the shared tick (no timer of its own) are classed ok, high or
 *                 critical with the same rule as kernel/stt.py. High unloads idle optional models and holds
 *                 background work; critical also refuses new heavy leases. Battery, battery saver and a thermal
 *                 speed limit prefer smaller models and defer background work.
 *  4. Lag         When the main process event loop is blocked, background leases and jobs pause. Voice never does.
 *
 * Pure apart from the injected readers, actions and clock, so every rule is tested without Electron. It owns no
 * timer: main.cjs calls `tick()` and `onLag()` from the timers that already run (loop-lag windows).
 */
"use strict";

const RANK = { voice: 0, chat: 1, background: 2, prefetch: 3 };
const PRIORITIES = Object.keys(RANK);

const HEAVY_MB = 1024;
const RAM_HEADROOM_MB = 1536;
const VRAM_HEADROOM_MIN_MB = 512;
const VRAM_HEADROOM_SHARE = 0.1;
// Same rule as kernel/stt.py: [share of total, floor MB, ceiling MB].
const PRESSURE_HIGH = [0.15, 2048, 3072];
const PRESSURE_CRITICAL = [0.07, 1024, 1536];

const DEFAULT_CAPS = { download: 2, install: 1, generation: 1, modelLoad: 1 };
const DEFAULT_MAX_QUEUE = { download: 32, install: 8, generation: 8, modelLoad: 4 };
const ACTION_RING = 24;
const ACTIONS_SHOWN = 12;
const UNLOAD_RETRY_MS = 15_000;
/** A voice request waits at most this long for the governor's decision (the voice budget is 800 ms end to end). */
const VOICE_BOUND_MS = 300;
/** One pressure action (unload models, close the speech worker) may take this long before the tick stops waiting. */
const ACTION_TIMEOUT_MS = 20_000;
/** The video-memory read (nvidia-smi) may take this long before the tick uses the last reading. */
const PROBE_TIMEOUT_MS = 4_000;
const LEVEL_ORDER = { ok: 0, high: 1, critical: 2 };

const mb = (n) => (Number.isFinite(Number(n)) ? Math.max(0, Number(n)) : 0);
const pressureLine = (total, [share, floor, ceiling]) =>
  Math.min(ceiling, Math.max(floor, total * share));

/** ok, high or critical from free memory, with the kernel/stt.py thresholds. */
function memoryLevel(freeMb, totalMb) {
  if (!Number.isFinite(freeMb) || !Number.isFinite(totalMb) || totalMb <= 0) return "ok";
  if (freeMb < pressureLine(totalMb, PRESSURE_CRITICAL)) return "critical";
  if (freeMb < pressureLine(totalMb, PRESSURE_HIGH)) return "high";
  return "ok";
}

/** Video memory the desktop compositor keeps: at least 0.5 GB or 10 percent of the card. */
function vramHeadroomMb(totalMb) {
  const total = Number(totalMb);
  const share = Number.isFinite(total) && total > 0 ? Math.round(total * VRAM_HEADROOM_SHARE) : 0;
  return Math.max(VRAM_HEADROOM_MIN_MB, share);
}

function vramLevel(freeMb, totalMb) {
  if (!Number.isFinite(freeMb) || !Number.isFinite(totalMb) || totalMb <= 0) return "ok";
  const head = vramHeadroomMb(totalMb);
  if (freeMb < head) return "critical";
  if (freeMb < head * 2) return "high";
  return "ok";
}

const worse = (a, b) => (LEVEL_ORDER[a] >= LEVEL_ORDER[b] ? a : b);

/**
 * Which resident models nobody has used for `minIdleMs`. A resident model is idle when the engine's own
 * "expires at" stamp has not moved since it was first seen: any use moves it. Needs two looks, so a model that
 * is answering right now is never taken for idle.
 */
function createIdleTracker({ now = () => Date.now(), minIdleMs = 45_000 } = {}) {
  const seen = new Map();
  return {
    observe(models = []) {
      const t = now();
      const idle = [];
      const present = new Set();
      for (const model of models) {
        const id = String(model?.id || "");
        if (!id) continue;
        present.add(id);
        const stamp = String(model.expiresAt ?? "");
        const before = seen.get(id);
        if (!before || before.stamp !== stamp) {
          seen.set(id, { stamp, since: t });
        } else if (t - before.since >= minIdleMs) {
          idle.push(id);
        }
      }
      for (const id of [...seen.keys()]) if (!present.has(id)) seen.delete(id);
      return idle;
    },
  };
}

/**
 * The Ollama tags a chat turn is using right now. A chat lease's owner is `chat:<tag>` (electron/main.cjs
 * leaseLocalModel), while Ollama lists resident models by tag, so the owner is read down to the tag before the two
 * are compared; comparing the raw owner never matched.
 */
function busyModelTags(owners = []) {
  const tags = new Set();
  for (const owner of owners) {
    const text = String(owner || "");
    if (text.startsWith("chat:") && text.length > 5) tags.add(text.slice(5));
  }
  return tags;
}

/**
 * Unload the Ollama models nothing has used since the last look, except the ones a chat turn holds. Resolves true
 * (something was unloaded), "pending" (ask again soon) or false (Ollama is not answering, or nothing is resident).
 */
async function unloadIdleOllama({ ollamaRunning, ollamaUnload, tracker, busyOwners = [] }) {
  const running = await ollamaRunning();
  if (!running?.ok || !running.models?.length) return false;
  const busy = busyModelTags(busyOwners);
  const idle = tracker.observe(running.models.filter((m) => !busy.has(m.id)));
  for (const id of idle) await ollamaUnload(id);
  return idle.length > 0 ? true : "pending";
}

/** One cancellation token: a signal for fetch and workers plus a flag. */
function createCancelToken() {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    get cancelled() {
      return controller.signal.aborted;
    },
    cancel(reason = "cancelled") {
      if (!controller.signal.aborted) controller.abort(new Error(String(reason)));
    },
  };
}

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function safely(fn, ...args) {
  if (typeof fn !== "function") return undefined;
  try {
    return await fn(...args);
  } catch {
    return undefined;
  }
}

function createResourceGovernor({
  now = () => Date.now(),
  log = () => {},
  readMemory = () => null,
  readVram = () => null,
  refreshVram = null,
  getFacts = () => null,
  getPower = () => ({ onBattery: false, saver: false, speedLimit: 100 }),
  actions = {},
  notify = () => {},
  caps = {},
  maxQueue = {},
  maxLeaseQueue = 16,
  leaseTtlMs = 45_000,
  settleMs = 30_000,
  queueTimeoutMs = 120_000,
  calmTicks = 2,
  lagPauseMs = 250,
  lagCalmWindows = 2,
  unloadEveryMs = 60_000,
  vramProbeEveryTicks = 6,
  voiceBoundMs = VOICE_BOUND_MS,
  actionTimeoutMs = ACTION_TIMEOUT_MS,
  probeTimeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  const capOf = { ...DEFAULT_CAPS, ...caps };
  const queueOf = { ...DEFAULT_MAX_QUEUE, ...maxQueue };

  const leases = new Map();
  const queue = [];
  let adjustments = [];
  let seq = 0;
  let chain = Promise.resolve();

  let memLevelNow = "ok";
  let vramLevelNow = "ok";
  let level = "ok";
  let calm = 0;
  let lastUnloadAt = -Infinity;
  let notice = null;
  let tickCount = 0;
  // Slow pressure work (the video-memory probe, unloading models) runs outside `serial`, each action once at a time.
  let probing = false;
  let unloading = false;
  const actionRunning = new Set();

  let lag = { p99Ms: 0, maxMs: 0, paused: false, calm: 0 };
  let stress = "none";
  const history = [];

  const jobs = Object.fromEntries(
    Object.keys(capOf).map((cls) => [cls, { running: 0, queue: [] }]),
  );

  const record = (kind, detail) => {
    history.push({ at: now(), kind, detail: String(detail || "").slice(0, 200) });
    if (history.length > ACTION_RING) history.shift();
    log(`resource governor: ${kind}${detail ? ` - ${detail}` : ""}`);
  };

  /** Run work one at a time so two requests can never be decided against the same free memory. */
  const serial = (fn) => {
    const next = chain.then(fn, fn);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  // ---------------------------------------------------------------- reads
  function safeFacts() {
    try {
      return getFacts() || null;
    } catch {
      return null;
    }
  }

  function readings() {
    const facts = safeFacts();
    let ram = null;
    try {
      ram = readMemory();
    } catch {
      ram = null;
    }
    if (!ram && facts && Number(facts.ramGb) > 0 && Number.isFinite(Number(facts.ramFreeGb))) {
      ram = { freeMb: facts.ramFreeGb * 1024, totalMb: facts.ramGb * 1024 };
    }
    let vram = null;
    try {
      vram = readVram();
    } catch {
      vram = null;
    }
    if (!vram && facts && Number(facts.vramGb) > 0 && Number.isFinite(Number(facts.vramFreeGb))) {
      vram = { freeMb: facts.vramFreeGb * 1024, totalMb: facts.vramGb * 1024 };
    }
    return { ram, vram };
  }

  function liveAdjustments() {
    const t = now();
    adjustments = adjustments.filter((a) => a.until > t);
    return adjustments;
  }

  /** Free memory as the next grant should see it: the OS reading, less grants it has not shown yet. */
  function freeNow(extra = { vramMb: 0, ramMb: 0 }) {
    const { ram, vram } = readings();
    const adj = liveAdjustments();
    const sum = (key) => adj.reduce((total, a) => total + a[key], 0);
    return {
      ramMb: ram ? Number(ram.freeMb) - sum("ramMb") + extra.ramMb : null,
      vramMb: vram ? Number(vram.freeMb) - sum("vramMb") + extra.vramMb : null,
      vramTotalMb: vram ? Number(vram.totalMb) : null,
    };
  }

  const fits = (option, free) => {
    const ramOk =
      option.ramMb <= 0 || free.ramMb === null || free.ramMb - RAM_HEADROOM_MB >= option.ramMb;
    const vramOk =
      option.vramMb <= 0 ||
      free.vramMb === null ||
      free.vramMb - vramHeadroomMb(free.vramTotalMb) >= option.vramMb;
    return ramOk && vramOk;
  };

  const isHeavy = (option) => Math.max(option.vramMb, option.ramMb) >= HEAVY_MB;
  const sizeOf = (option) => option.vramMb + option.ramMb;

  // ---------------------------------------------------------------- holds
  /** Why work of a rank may not start or keep running right now (null: free to run). */
  function holdFor(rank, cls = null) {
    if (rank <= RANK.voice) return null;
    if (lag.paused && rank >= RANK.background) return "lag";
    // A download or an install does not hold memory, so pressure holds only the jobs that load or generate.
    const loads = cls === null || cls === "generation" || cls === "modelLoad";
    if (loads && level !== "ok" && rank >= RANK.background) return "pressure";
    if (loads && cls !== null && level === "critical") return "pressure";
    if (stress !== "none" && rank >= RANK.prefetch) return "power";
    if ((stress === "saver" || stress === "thermal") && rank >= RANK.background) return "power";
    return null;
  }

  const holdNames = () => [
    ...new Set([RANK.chat, RANK.background, RANK.prefetch].map((r) => holdFor(r)).filter(Boolean)),
  ];

  async function applyHolds() {
    for (const lease of [...leases.values()]) {
      const held = holdFor(lease.rank);
      if (held && lease.state === "active" && typeof lease.onPause === "function") {
        lease.state = "paused";
        lease.pausedFor = held;
        await safely(lease.onPause, held);
        record("lease-paused", `${lease.owner} (${held})`);
      } else if (!held && lease.state === "paused") {
        lease.state = "active";
        lease.pausedFor = null;
        lease.beatAt = now();
        await safely(lease.onResume);
        record("lease-resumed", lease.owner);
      }
    }
  }

  // ---------------------------------------------------------------- leases
  function normalise(req) {
    const given = Array.isArray(req.options) && req.options.length ? req.options : null;
    const list = (given || [{ vramMb: req.vramMb, ramMb: req.ramMb, hint: req.hint ?? null }]).map(
      (o, index) => ({
        vramMb: mb(o.vramMb),
        ramMb: mb(o.ramMb),
        hint: o.hint ?? null,
        index,
      }),
    );
    return list;
  }

  function orderedOptions(req, rank) {
    const list = normalise(req);
    const small = rank > RANK.voice && stress !== "none";
    list.sort((a, b) => (small ? sizeOf(a) - sizeOf(b) : sizeOf(b) - sizeOf(a)));
    return level === "critical" && rank > RANK.voice ? list.filter((o) => !isHeavy(o)) : list;
  }

  /** The first option that fits, with the leases that must pause to make room. null: nowhere. */
  function place(req, rank, allowPreempt) {
    const options = orderedOptions(req, rank);
    const free = freeNow();
    for (const option of options) {
      if (fits(option, free)) return { option, victims: [], shrunk: option.index !== 0 };
    }
    if (!allowPreempt) return null;
    const pool = [...leases.values()]
      .filter(
        (l) =>
          (l.state === "active" || l.state === "paused") &&
          l.rank > rank &&
          (typeof l.onPause === "function" || l.preempt === "cancel") &&
          (l.preempt !== "cancel" || typeof l.onCancel === "function"),
      )
      .sort((a, b) => b.rank - a.rank || b.grantedAt - a.grantedAt);
    for (const option of options) {
      const victims = [];
      const credit = { vramMb: 0, ramMb: 0 };
      for (const lease of pool) {
        const shortV = option.vramMb > 0 && !fits({ ...option, ramMb: 0 }, freeNow(credit));
        const shortR = option.ramMb > 0 && !fits({ ...option, vramMb: 0 }, freeNow(credit));
        if (!shortV && !shortR) break;
        if ((shortV && lease.vramMb > 0) || (shortR && lease.ramMb > 0)) {
          victims.push(lease);
          credit.vramMb += lease.vramMb;
          credit.ramMb += lease.ramMb;
        }
      }
      if (victims.length && fits(option, freeNow(credit))) {
        return { option, victims, shrunk: option.index !== 0 };
      }
    }
    return null;
  }

  function handleOf(lease) {
    return {
      get id() {
        return lease.id;
      },
      get owner() {
        return lease.owner;
      },
      get state() {
        return lease.state;
      },
      hint: lease.hint,
      shrunk: lease.shrunk,
      vramMb: lease.vramMb,
      ramMb: lease.ramMb,
      heartbeat: () => beat(lease.id),
      loaded: () => settle(lease.id),
      release: () => release(lease.id),
    };
  }

  function grant(req, rank, chosen) {
    const id = `lease-${(seq += 1)}`;
    const t = now();
    const lease = {
      id,
      owner: String(req.owner || "unknown").slice(0, 80),
      kind: String(req.kind || "other").slice(0, 24),
      priority: PRIORITIES[rank],
      rank,
      vramMb: chosen.option.vramMb,
      ramMb: chosen.option.ramMb,
      hint: chosen.option.hint,
      shrunk: chosen.shrunk,
      state: "active",
      grantedAt: t,
      beatAt: t,
      ttlMs: Number(req.ttlMs) > 0 ? Number(req.ttlMs) : leaseTtlMs,
      onPause: req.onPause,
      onResume: req.onResume,
      onCancel: req.onCancel,
      alive: req.alive,
      preempt: req.preempt === "cancel" ? "cancel" : "pause",
      handle: null,
    };
    lease.handle = handleOf(lease);
    leases.set(id, lease);
    if (lease.vramMb > 0 || lease.ramMb > 0) {
      adjustments.push({ id, vramMb: lease.vramMb, ramMb: lease.ramMb, until: t + settleMs });
    }
    return lease;
  }

  async function preempt(victims) {
    for (const victim of victims) {
      const credit = {
        id: `credit-${victim.id}`,
        vramMb: -victim.vramMb,
        ramMb: -victim.ramMb,
        until: now() + settleMs,
      };
      if (victim.preempt === "cancel") {
        await safely(victim.onCancel);
        victim.state = "cancelled";
        leases.delete(victim.id);
        record("lease-cancelled", `${victim.owner} (made room for a higher priority)`);
      } else {
        if (victim.state === "active") await safely(victim.onPause, "preempt");
        victim.state = "suspended";
        queue.push({ resume: victim, rank: victim.rank, seq: (seq += 1), at: now() });
        record("lease-paused", `${victim.owner} (made room for a higher priority)`);
      }
      adjustments.push(credit);
    }
  }

  function enqueue(req, rank, reason) {
    let settle = () => {};
    const wait = new Promise((resolve) => {
      settle = resolve;
    });
    const entry = { req, rank, seq: (seq += 1), at: now(), settle, reason };
    queue.push(entry);
    const cancel = () => {
      const index = queue.indexOf(entry);
      if (index >= 0) {
        queue.splice(index, 1);
        settle({ state: "cancelled" });
      }
    };
    if (req.signal) {
      if (req.signal.aborted) cancel();
      else req.signal.addEventListener("abort", cancel, { once: true });
    }
    return { state: "queued", reason, wait, cancel };
  }

  /** Ask for memory. Resolves granted (with a lease), queued (with a promise) or refused (with a reason). */
  function acquire(req = {}) {
    const work = serial(() => acquireNow(req));
    if ((RANK[req.priority] ?? RANK.background) > RANK.voice) return work;
    // Voice always loads: a decision that is not made inside the bound answers "none" (load as if ungoverned), and a
    // lease that lands afterwards is handed back, since nobody holds it.
    let timer = null;
    const bound = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), voiceBoundMs);
      timer.unref?.();
    });
    return Promise.race([work, bound]).then((answer) => {
      clearTimeout(timer);
      if (answer) return answer;
      record("lease-bypassed", `${req.owner}: the governor was busy, voice loads without a lease`);
      work.then(
        (late) => {
          if (late?.state === "granted") late.lease?.release?.();
          else if (late?.state === "queued") late.cancel?.();
        },
        () => {},
      );
      return { state: "none", reason: "voice-bound" };
    });
  }

  async function acquireNow(req) {
    expireLeases();
    const rank = RANK[req.priority] ?? RANK.background;
    const options = orderedOptions(req, rank);
    if (!options.length) {
      record("lease-refused", `${req.owner}: memory critical`);
      return { state: "refused", reason: "memory-critical" };
    }
    const held = holdFor(rank);
    if (!held) {
      const chosen = place(req, rank, true);
      if (chosen) {
        await preempt(chosen.victims);
        return { state: "granted", lease: grant(req, rank, chosen).handle };
      }
    }
    if (req.queue === false) {
      record("lease-refused", `${req.owner}: ${held ? `deferred by ${held}` : "no room"}`);
      return { state: "refused", reason: held ? `deferred-${held}` : "no-room" };
    }
    // A paused lease waiting to resume is not a new request: it never counts against a voice request.
    const waiting = rank <= RANK.voice ? queue.filter((e) => !e.resume).length : queue.length;
    if (waiting >= maxLeaseQueue) {
      record("lease-refused", `${req.owner}: queue full`);
      return { state: "refused", reason: "queue-full" };
    }
    return enqueue(req, rank, held ? `deferred: ${held}` : "waiting for memory");
  }

  function beat(id) {
    const lease = leases.get(id);
    if (!lease) return false;
    lease.beatAt = now();
    return true;
  }

  function settle(id) {
    adjustments = adjustments.filter((a) => a.id !== id);
  }

  function release(id) {
    const lease = leases.get(id);
    if (!lease) return;
    leases.delete(id);
    lease.state = lease.state === "expired" ? "expired" : "released";
    settle(id);
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      if (queue[i].resume === lease) queue.splice(i, 1);
    }
    serial(drain).catch((error) => record("drain-failed", String(error?.message || error)));
  }

  function expireLeases() {
    const t = now();
    for (const lease of [...leases.values()]) {
      // A lease the governor paused cannot beat (its holder was told to stop), so only a live one goes silent.
      const silent = lease.state === "active" && t - lease.beatAt > lease.ttlMs;
      let gone = false;
      try {
        gone = typeof lease.alive === "function" && lease.alive() === false;
      } catch {
        gone = false;
      }
      if (silent || gone) {
        leases.delete(lease.id);
        lease.state = "expired";
        settle(lease.id);
        for (let i = queue.length - 1; i >= 0; i -= 1) {
          if (queue[i].resume === lease) queue.splice(i, 1);
        }
        record("lease-expired", `${lease.owner} (${gone ? "holder gone" : "no heartbeat"})`);
      }
    }
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      const entry = queue[i];
      if (!entry.resume && t - entry.at > queueTimeoutMs) {
        queue.splice(i, 1);
        entry.settle({ state: "expired" });
        record("lease-expired", `${entry.req.owner} (waited too long)`);
      }
    }
  }

  /** Hand freed memory to the queue, best priority first, oldest first. Stops at the first one that cannot go. */
  async function drain() {
    queue.sort((a, b) => a.rank - b.rank || a.seq - b.seq);
    for (const entry of [...queue]) {
      if (!queue.includes(entry)) continue;
      if (entry.resume) {
        const lease = entry.resume;
        if (holdFor(lease.rank)) continue;
        const free = freeNow();
        if (!fits({ vramMb: lease.vramMb, ramMb: lease.ramMb }, free)) break;
        queue.splice(queue.indexOf(entry), 1);
        lease.state = "active";
        lease.beatAt = now();
        await safely(lease.onResume);
        adjustments.push({
          id: lease.id,
          vramMb: lease.vramMb,
          ramMb: lease.ramMb,
          until: now() + settleMs,
        });
        record("lease-resumed", lease.owner);
        continue;
      }
      if (holdFor(entry.rank)) continue;
      const chosen = place(entry.req, entry.rank, true);
      if (!chosen) {
        if (orderedOptions(entry.req, entry.rank).length === 0) {
          queue.splice(queue.indexOf(entry), 1);
          entry.settle({ state: "refused", reason: "memory-critical" });
          continue;
        }
        break;
      }
      queue.splice(queue.indexOf(entry), 1);
      await preempt(chosen.victims);
      entry.settle({ state: "granted", lease: grant(entry.req, entry.rank, chosen).handle });
    }
  }

  // ---------------------------------------------------------------- jobs
  const startable = (cls, entry) => !holdFor(entry.rank, cls);

  function pump(cls) {
    const lane = jobs[cls];
    lane.queue.sort((a, b) => a.rank - b.rank || a.seq - b.seq);
    while (lane.running < capOf[cls]) {
      const index = lane.queue.findIndex((entry) => startable(cls, entry));
      if (index < 0) return;
      const [entry] = lane.queue.splice(index, 1);
      lane.running += 1;
      Promise.resolve()
        .then(() => entry.fn({ signal: entry.signal }))
        .then(entry.resolve, entry.reject)
        .finally(() => {
          lane.running -= 1;
          pump(cls);
        });
    }
  }

  const pumpAll = () => Object.keys(jobs).forEach(pump);

  /** Run `fn` inside the class cap. Waits in a bounded queue; rejects QUEUE_FULL or CANCELLED. */
  function run(cls, fn, { priority = "background", signal = null } = {}) {
    const lane = jobs[cls];
    if (!lane) return Promise.reject(new TypeError(`unknown job class ${String(cls)}`));
    if (signal?.aborted) return Promise.reject(coded("CANCELLED", "cancelled before it started"));
    if (lane.queue.length >= queueOf[cls]) {
      record("job-refused", `${cls} queue is full`);
      return Promise.reject(coded("QUEUE_FULL", `too many ${cls} jobs are waiting`));
    }
    return new Promise((resolve, reject) => {
      const entry = {
        fn,
        resolve,
        reject,
        signal: signal || undefined,
        rank: RANK[priority] ?? RANK.background,
        seq: (seq += 1),
      };
      lane.queue.push(entry);
      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            const index = lane.queue.indexOf(entry);
            if (index >= 0) {
              lane.queue.splice(index, 1);
              reject(coded("CANCELLED", "cancelled while waiting"));
            }
          },
          { once: true },
        );
      }
      pump(cls);
    });
  }

  // ---------------------------------------------------------------- pressure and power
  function powerStress() {
    let power = null;
    try {
      power = getPower();
    } catch {
      power = null;
    }
    if (!power) return "none";
    if (Number(power.speedLimit) < 100) return "thermal";
    if (power.saver === true) return "saver";
    if (power.onBattery === true) return "battery";
    return "none";
  }

  /** Wait for `run` at most `ms`; the work itself is never abandoned, only waited for. Resolves true when it ended. */
  async function within(run, ms) {
    let timer = null;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
      timer.unref?.();
    });
    const ended = await Promise.race([run.then(() => true), late]);
    clearTimeout(timer);
    return ended;
  }

  /** Unload idle models and speech. Runs outside `serial`; each action has its own deadline and runs one at a time. */
  async function unloadIdle(why) {
    lastUnloadAt = now();
    const held = [...leases.values()].filter((l) => l.state === "active" || l.state === "paused");
    const busy = {
      busyOwners: held.map((l) => l.owner),
      busyKinds: [...new Set(held.map((l) => l.kind))],
    };
    const parts = [];
    for (const [name, fn] of [
      ["models", actions.unloadIdleModels],
      ["speech", actions.unloadSpeech],
    ]) {
      if (typeof fn !== "function") continue;
      if (actionRunning.has(name)) {
        parts.push(`${name}:busy`);
        continue;
      }
      actionRunning.add(name);
      let outcome = { ok: false, value: undefined };
      const run = Promise.resolve()
        .then(() => fn(busy))
        .then(
          (value) => {
            outcome = { ok: true, value };
          },
          (error) => {
            record("unload-failed", `${name}: ${String(error?.message || error)}`);
          },
        )
        .finally(() => actionRunning.delete(name));
      if (!(await within(run, actionTimeoutMs))) {
        record("unload-slow", `${name} did not finish in ${Math.round(actionTimeoutMs / 1000)} s`);
        parts.push(`${name}:slow`);
        continue;
      }
      if (!outcome.ok) continue;
      const result = outcome.value;
      // "pending": the action wants one more look before it frees anything, so ask again soon, not in a minute.
      if (result === "pending") lastUnloadAt = now() - unloadEveryMs + UNLOAD_RETRY_MS;
      parts.push(
        `${name}:${result === "pending" ? "waiting" : result === false ? "kept" : "freed"}`,
      );
    }
    record("unload-idle", `${why}; ${parts.join(" ") || "nothing to free"}`);
  }

  /** Read the card again, bounded and one at a time; a probe that hangs only means the old reading is used. */
  async function probeVram() {
    if (probing || typeof refreshVram !== "function") return;
    probing = true;
    const run = safely(refreshVram).finally(() => {
      probing = false;
    });
    if (!(await within(run, probeTimeoutMs))) record("probe-slow", "the video memory read is slow");
  }

  /**
   * One pressure reading. The bookkeeping (levels, notices, holds, the queue) runs in `serial`; the slow parts, the
   * card probe and unloading models, run outside it so a voice request never waits behind nvidia-smi or Ollama.
   */
  async function tick() {
    tickCount += 1;
    const knownCard = Boolean(readings().vram) || Number(safeFacts()?.vramGb) > 0;
    const wantsVram =
      [...leases.values(), ...queue.map((e) => e.req || {})].some((l) => mb(l.vramMb) > 0) ||
      (knownCard && tickCount % vramProbeEveryTicks === 1);
    if (wantsVram) await probeVram();
    let unloadWhy = null;
    await serial(async () => {
      expireLeases();
      const { ram, vram } = readings();
      memLevelNow = ram ? memoryLevel(Number(ram.freeMb), Number(ram.totalMb)) : "ok";
      vramLevelNow = vram ? vramLevel(Number(vram.freeMb), Number(vram.totalMb)) : "ok";
      const wanted = worse(memLevelNow, vramLevelNow);
      const before = level;
      if (LEVEL_ORDER[wanted] > LEVEL_ORDER[level]) {
        level = wanted;
        calm = 0;
      } else if (LEVEL_ORDER[wanted] < LEVEL_ORDER[level]) {
        calm += 1;
        if (calm >= calmTicks) {
          level = wanted;
          calm = 0;
        }
      } else {
        calm = 0;
      }
      stress = powerStress();
      if (level !== before) record("pressure", `${before} -> ${level}`);
      if (level === "critical" && before !== "critical") {
        notice = "Memory is very low: FRIDAY is holding new heavy work until it frees up.";
        try {
          notify(notice);
        } catch {
          /* the line is a courtesy */
        }
      } else if (level === "ok") {
        notice = null;
      }
      if (level !== "ok" && !unloading && now() - lastUnloadAt >= unloadEveryMs) {
        unloading = true;
        lastUnloadAt = now();
        unloadWhy = level;
      }
    });
    if (unloadWhy) {
      try {
        await unloadIdle(unloadWhy);
      } finally {
        unloading = false;
      }
    }
    await serial(async () => {
      await applyHolds();
      await drain();
      pumpAll();
    });
  }

  /** One window of main-process event loop delay (electron/loop-lag.cjs). */
  function onLag(window = {}) {
    return serial(async () => {
      const p99 = Number(window.p99Ms);
      const max = Number(window.maxMs);
      if (!Number.isFinite(p99) || p99 < 0) return;
      lag.p99Ms = Math.round(p99);
      lag.maxMs = Number.isFinite(max) ? Math.round(max) : 0;
      if (p99 >= lagPauseMs) {
        lag.calm = 0;
        if (!lag.paused) {
          lag.paused = true;
          record(
            "lag-pause",
            `event loop p99 ${lag.p99Ms} ms, longest ${lag.maxMs} ms: background work paused`,
          );
        }
      } else if (lag.paused) {
        lag.calm += 1;
        if (lag.calm >= lagCalmWindows) {
          lag.paused = false;
          lag.calm = 0;
          record("lag-resume", `event loop p99 ${lag.p99Ms} ms: background work resumed`);
        }
      }
      await applyHolds();
      pumpAll();
    });
  }

  // ---------------------------------------------------------------- status
  function status() {
    const t = now();
    const { ram, vram } = readings();
    return {
      ok: true,
      at: t,
      level,
      notice,
      memory: ram
        ? {
            freeMb: Math.round(Number(ram.freeMb)),
            totalMb: Math.round(Number(ram.totalMb)),
            level: memLevelNow,
          }
        : null,
      vram: vram
        ? {
            freeMb: Math.round(Number(vram.freeMb)),
            totalMb: Math.round(Number(vram.totalMb)),
            level: vramLevelNow,
          }
        : null,
      lag: { p99Ms: lag.p99Ms, maxMs: lag.maxMs, paused: lag.paused },
      power: { stress, preferSmall: stress !== "none" },
      holds: holdNames(),
      leases: [...leases.values()].map((l) => ({
        id: l.id,
        owner: l.owner,
        kind: l.kind,
        priority: l.priority,
        state: l.state,
        vramMb: l.vramMb,
        ramMb: l.ramMb,
        ageMs: t - l.grantedAt,
      })),
      queued: queue.map((e) =>
        e.resume
          ? { owner: e.resume.owner, priority: PRIORITIES[e.rank], resume: true }
          : {
              owner: String(e.req.owner || "unknown"),
              priority: PRIORITIES[e.rank],
              reason: e.reason,
            },
      ),
      jobs: Object.fromEntries(
        Object.entries(jobs).map(([cls, lane]) => [
          cls,
          {
            running: lane.running,
            queued: lane.queue.length,
            cap: capOf[cls],
            maxQueue: queueOf[cls],
            saturated: lane.queue.length >= queueOf[cls],
          },
        ]),
      ),
      actions: history.slice(-ACTIONS_SHOWN),
    };
  }

  /** A row for the diagnostics list from outside (a window that hung, a process that went away). */
  const note = (kind, detail) => record(String(kind || "note").slice(0, 40), detail);

  return {
    acquire,
    run,
    note,
    tick,
    onLag,
    status,
    level: () => level,
    allowsPrefetch: () => level === "ok" && !holdFor(RANK.prefetch),
    whenIdle: () => chain,
  };
}

module.exports = {
  createResourceGovernor,
  createCancelToken,
  createIdleTracker,
  busyModelTags,
  unloadIdleOllama,
  memoryLevel,
  vramLevel,
  vramHeadroomMb,
  RAM_HEADROOM_MB,
  RANK,
  DEFAULT_CAPS,
  DEFAULT_MAX_QUEUE,
  VOICE_BOUND_MS,
};
