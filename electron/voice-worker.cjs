/**
 * FRIDAY · voice worker lifecycle
 *
 * One owner for a long-lived Python voice child (the speech-to-text worker and the speech worker both speak the
 * same protocol: one JSON object per line on stdin and stdout, replies matched by `id`). It owns the process, not
 * the protocol of any one op:
 *
 *   · start is single-flight: concurrent callers share one start, and a caller never sees the worker as ready
 *     before its `init` (model status and load) has finished. A failed start or load stops the child.
 *   · the child runs in the temp folder (never the program folder, so update and uninstall are not blocked),
 *     with UTF-8 forced. stdout is decoded as a stream, so a multi-byte character split across chunks is whole.
 *   · stderr is always drained into a bounded ring (the last 8 KB) so a chatty child cannot fill the pipe and stall.
 *   · exit is read from 'exit' as well as 'close'. Every pending request is rejected with a typed error on exit.
 *   · status() answers from a cached view and never waits behind a busy op, so a status check cannot kill a
 *     healthy busy worker.
 *   · a soft timeout means slow, not dead (onSlow fires, the worker stays). A hard deadline kills the whole tree.
 *     A stream feed needs two soft misses in a row, with no stream line between them, before it is killed.
 *   · a crash-loop breaker (3 crashes in 60 s opens it for 5 min, then one probe, closed on a good start) and an
 *     idle unload (the child stops after a quiet spell and the next request restarts it).
 *
 * Replies always resolve (even `ok:false`): the caller reads the envelope. Only transport failures reject, with an
 * Error whose `code` is one of: deadline, stalled, exit, stopped, breaker-open, start-failed, write-failed.
 */
"use strict";

const os = require("node:os");
const { spawn } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");

const STDERR_RING_BYTES = 8192;
/** A line longer than this is dropped (a stuck child printing without a newline must not grow memory for ever). */
const MAX_LINE_CHARS = 32 * 1024 * 1024;
const STOP_GRACE_MS = 2000;
const DEFAULT_BREAKER = { max: 3, windowMs: 60000, coolMs: 300000 };
const DEFAULT_STALL_MISSES = 2;

class VoiceWorkerError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "VoiceWorkerError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

/** The whole-tree stop. Windows uses the shared lifecycle helper (taskkill /T); elsewhere the child is signalled. */
function defaultKillTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === "win32") {
      require("./app-lifecycle.cjs").killProcessTree(child.pid);
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    /* already gone */
  }
}

async function unwrap(value) {
  return typeof value === "function" ? await value() : value;
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * @param {object} options
 * @param {"stt"|"tts"} options.role
 * @param {string|(() => string|Promise<string>)} options.script  The program to launch (the Python executable).
 * @param {string[]|(() => string[]|Promise<string[]>)} options.args  Its argv (interpreter prefix, kernel script, "--serve").
 * @param {object|(() => object|Promise<object>)} [options.env]  Extra environment; UTF-8 is forced after it.
 * @param {string} [options.cwd]  Defaults to the temp folder.
 * @param {number} [options.idleUnloadMs]  0 or missing turns the idle unload off.
 * @param {{max:number, windowMs:number, coolMs:number}} [options.breaker]
 * @param {number} [options.threads]  Shown in status() only.
 * @param {(send: Function, session: {generation:number, pid:number|null}) => Promise<void>} [options.init]
 *   Runs once per start, before the worker counts as ready; `send(payload, {softMs, hardMs})` skips the ready gate.
 *   Throw (or reject) to fail the start: the child is stopped.
 * @param {Function} [options.spawn]  Injectable for tests (same shape as child_process.spawn).
 * @param {(child: object) => void} [options.killTree]  Injectable for tests.
 * @param {() => number} [options.now]
 * @param {(info: object) => void} [options.onExit]
 */
function createVoiceWorker(options) {
  const opts = options || {};
  const role = opts.role === "tts" ? "tts" : "stt";
  const spawnImpl = opts.spawn || spawn;
  const killTree = opts.killTree || defaultKillTree;
  const now = opts.now || (() => Date.now());
  const idleUnloadMs =
    Number.isFinite(opts.idleUnloadMs) && opts.idleUnloadMs > 0 ? opts.idleUnloadMs : 0;
  const breaker = {
    max: positiveInt(opts.breaker?.max, DEFAULT_BREAKER.max),
    windowMs: positiveInt(opts.breaker?.windowMs, DEFAULT_BREAKER.windowMs),
    coolMs: positiveInt(opts.breaker?.coolMs, DEFAULT_BREAKER.coolMs),
  };
  const exitListeners = new Set();
  if (typeof opts.onExit === "function") exitListeners.add(opts.onExit);

  /** "cold" | "starting" | "ready" | "stopped" (breaker-open and busy are derived in view()). */
  let state = "cold";
  let session = null;
  let generation = 0;
  let requestSeq = 0;
  let startPromise = null;
  let activity = 0;
  let idleTimer = null;
  let crashes = [];
  let breakerUntil = 0;
  let halfOpen = false;
  let lastExit = null;

  function pruneCrashes() {
    const cutoff = now() - breaker.windowMs;
    crashes = crashes.filter((at) => at > cutoff);
  }

  function noteCrash() {
    const at = now();
    crashes.push(at);
    pruneCrashes();
    if (halfOpen || crashes.length >= breaker.max) {
      breakerUntil = at + breaker.coolMs;
      halfOpen = false;
    }
  }

  function breakerIsOpen() {
    return breakerUntil > now();
  }

  function oldestPending() {
    if (!session) return null;
    let oldest = null;
    for (const wait of session.pending.values()) {
      if (!oldest || wait.startedAt < oldest.startedAt) oldest = wait;
    }
    return oldest;
  }

  /** The cached view. Reads memory only: it never touches the child and never waits for an op. */
  function status() {
    pruneCrashes();
    const open = breakerIsOpen() && !(session && state === "ready");
    const oldest = state === "ready" ? oldestPending() : null;
    const view = {
      role,
      state: open ? "breaker-open" : oldest ? "busy" : state,
      pid: session?.child?.pid ?? null,
      generation,
      restarts60s: crashes.length,
      idleUnloadMs,
      threads: positiveInt(opts.threads, 0),
    };
    if (oldest) {
      view.busyOp = String(oldest.op);
      view.busySinceMs = Math.max(0, now() - oldest.startedAt);
    }
    if (breakerUntil > now()) view.breakerUntil = breakerUntil;
    if (lastExit) view.lastExit = { ...lastExit };
    return view;
  }

  function clearIdle() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function armIdle() {
    clearIdle();
    if (!idleUnloadMs || state !== "ready" || activity > 0 || !session || session.pending.size > 0)
      return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (state === "ready" && activity === 0 && session && session.pending.size === 0) {
        terminate(session, "idle", false);
        state = "cold";
      }
    }, idleUnloadMs);
    if (typeof idleTimer.unref === "function") idleTimer.unref();
  }

  function settleWait(wait) {
    if (wait.softTimer) clearTimeout(wait.softTimer);
    if (wait.hardTimer) clearTimeout(wait.hardTimer);
    wait.softTimer = null;
    wait.hardTimer = null;
  }

  function rejectAll(target, error) {
    for (const wait of Array.from(target.pending.values())) {
      settleWait(wait);
      try {
        wait.reject(error);
      } catch {
        /* already settled */
      }
    }
    target.pending.clear();
  }

  /** Stops one child on purpose. `counted` records it as a crash (a failed start). */
  function terminate(target, reason, counted) {
    if (!target || target.exited) return;
    if (!target.intentional) {
      target.intentional = true;
      target.reason = reason;
    }
    if (counted) noteCrash();
    rejectAll(target, new VoiceWorkerError("stopped", `Voice worker stopped (${reason}).`));
    killTree(target.child);
  }

  function handleExit(target, code, signal) {
    if (target.exited) return;
    target.exited = true;
    target.stdoutDecoder.end();
    lastExit = { code: code ?? null, signal: signal ?? null, stderrTail: target.stderrTail };
    const crash = !target.intentional;
    if (crash) noteCrash();
    if (session === target) {
      session = null;
      if (state !== "stopped") state = "cold";
    }
    rejectAll(
      target,
      new VoiceWorkerError(
        "exit",
        `Voice worker exited (code ${code ?? "none"}, signal ${signal ?? "none"}).`,
        {
          code: code ?? null,
          signal: signal ?? null,
          stderrTail: target.stderrTail,
        },
      ),
    );
    if (target.stopWaiters) for (const done of target.stopWaiters) done();
    const info = { role, generation: target.generation, intentional: !crash, ...lastExit };
    for (const listener of exitListeners) {
      try {
        listener(info);
      } catch {
        /* a listener must not break the lifecycle */
      }
    }
  }

  function handleLine(target, line) {
    const text = line.trim();
    if (!text || text.charCodeAt(0) !== 123) return; // not a JSON object: a log line, ignored
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object" || msg.id === undefined || msg.id === null) return;
    const wait = target.pending.get(String(msg.id));
    if (!wait) return;
    if (msg.stream) {
      wait.misses = 0;
      armSoft(target, wait);
      if (typeof wait.onStream === "function") {
        try {
          wait.onStream(msg);
        } catch {
          /* a stream consumer must not break the lifecycle */
        }
      }
      return;
    }
    target.pending.delete(String(msg.id));
    settleWait(wait);
    wait.resolve(msg);
    if (target === session) armIdle();
  }

  function onStdout(target, chunk) {
    let rest = typeof chunk === "string" ? chunk : target.stdoutDecoder.write(chunk);
    for (;;) {
      const nl = rest.indexOf("\n");
      if (nl < 0) {
        if (target.skipLine) return;
        target.parts.push(rest);
        target.partLen += rest.length;
        if (target.partLen > MAX_LINE_CHARS) {
          target.parts = [];
          target.partLen = 0;
          target.skipLine = true;
        }
        return;
      }
      const head = rest.slice(0, nl);
      rest = rest.slice(nl + 1);
      if (target.skipLine) {
        target.skipLine = false;
        continue;
      }
      target.parts.push(head);
      const line = target.parts.length === 1 ? head : target.parts.join("");
      target.parts = [];
      target.partLen = 0;
      handleLine(target, line);
    }
  }

  function onStderr(target, chunk) {
    const text = typeof chunk === "string" ? chunk : target.stderrDecoder.write(chunk);
    if (!text) return;
    target.stderrTail =
      text.length >= STDERR_RING_BYTES
        ? text.slice(-STDERR_RING_BYTES)
        : (target.stderrTail + text).slice(-STDERR_RING_BYTES);
  }

  async function start() {
    state = "starting";
    clearIdle();
    if (breakerUntil > 0 && breakerUntil <= now()) halfOpen = true;
    let target;
    try {
      const program = await unwrap(opts.script);
      const argv = (await unwrap(opts.args)) || [];
      const extraEnv = (await unwrap(opts.env)) || {};
      if (!program)
        throw new VoiceWorkerError("start-failed", "No program to start the voice worker.");
      const child = spawnImpl(program, Array.from(argv), {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        // The child and everything it starts must not stand in the program folder (update and uninstall).
        cwd: opts.cwd || os.tmpdir(),
        env: {
          ...process.env,
          ...extraEnv,
          PYTHONIOENCODING: "utf-8",
          PYTHONUTF8: "1",
          PYTHONUNBUFFERED: "1",
        },
      });
      if (!child) throw new VoiceWorkerError("start-failed", "The voice worker did not start.");
      generation += 1;
      target = {
        child,
        generation,
        pending: new Map(),
        parts: [],
        partLen: 0,
        skipLine: false,
        stdoutDecoder: new StringDecoder("utf8"),
        stderrDecoder: new StringDecoder("utf8"),
        stderrTail: "",
        intentional: false,
        exited: false,
        reason: "",
      };
      session = target;
      child.stdout?.on("data", (chunk) => onStdout(target, chunk));
      // Always drained: a child that logs a lot must never fill the pipe and stall.
      child.stderr?.on("data", (chunk) => onStderr(target, chunk));
      child.stdin?.on("error", () => {
        /* the exit event reports a dead child */
      });
      child.on("error", (error) => {
        target.stderrTail = `${target.stderrTail}${error?.message || error}`.slice(
          -STDERR_RING_BYTES,
        );
        handleExit(target, null, null);
      });
      child.on("exit", (code, signal) => handleExit(target, code, signal));
      child.on("close", (code, signal) => handleExit(target, code, signal));
    } catch (error) {
      if (!target) {
        noteCrash();
        state = "cold";
      }
      throw error instanceof VoiceWorkerError
        ? error
        : new VoiceWorkerError(
            "start-failed",
            `Voice worker could not start: ${error?.message || error}`,
          );
    }
    try {
      if (typeof opts.init === "function") {
        await opts.init((payload, requestOptions) => send(target, payload, requestOptions || {}), {
          generation: target.generation,
          pid: target.child.pid ?? null,
        });
      }
      if (target.exited || session !== target || target.intentional) {
        throw new VoiceWorkerError("stopped", "Voice worker stopped while it was starting.");
      }
    } catch (error) {
      // A failed start or load stops the child. It is never left alive and unreferenced (H2).
      terminate(target, "start-failed", !target.exited);
      if (session === target) session = null;
      if (state !== "stopped") state = "cold";
      throw error instanceof VoiceWorkerError
        ? error
        : new VoiceWorkerError(
            "start-failed",
            `Voice worker failed to start: ${error?.message || error}`,
            {
              stderrTail: target.stderrTail,
            },
          );
    }
    state = "ready";
    if (halfOpen) {
      // The one probe worked: the breaker closes and the crash history starts clean.
      crashes = [];
      breakerUntil = 0;
      halfOpen = false;
    }
    armIdle();
    return status();
  }

  /** Starts the worker once and returns the status view. Concurrent callers share the one start. */
  function ensure() {
    if (state === "ready" && session && !session.exited) return Promise.resolve(status());
    if (startPromise) return startPromise;
    if (breakerIsOpen()) {
      return Promise.reject(
        new VoiceWorkerError("breaker-open", "Voice worker is paused after repeated crashes.", {
          breakerUntil,
        }),
      );
    }
    startPromise = start().finally(() => {
      startPromise = null;
    });
    return startPromise;
  }

  function armSoft(target, wait) {
    if (wait.softTimer) clearTimeout(wait.softTimer);
    wait.softTimer = null;
    if (!wait.softMs) return;
    wait.softTimer = setTimeout(() => {
      wait.softTimer = null;
      if (!target.pending.has(wait.key)) return;
      wait.misses += 1;
      if (typeof wait.onSlow === "function") {
        try {
          wait.onSlow({ op: wait.op, elapsedMs: now() - wait.startedAt, misses: wait.misses });
        } catch {
          /* a slow-callback must not break the lifecycle */
        }
      }
      // A stream feed is stalled only after two soft misses in a row with no stream line between them.
      if (typeof wait.onStream === "function" && wait.misses >= wait.stallMisses) {
        kill(
          target,
          new VoiceWorkerError("stalled", `Voice worker stalled on ${wait.op}.`, { op: wait.op }),
        );
        return;
      }
      armSoft(target, wait);
    }, wait.softMs);
    if (typeof wait.softTimer.unref === "function") wait.softTimer.unref();
  }

  /** Hard stop: the whole tree dies and every pending request fails with the typed error. */
  function kill(target, error) {
    if (target.exited) return;
    rejectAll(target, error);
    target.intentional = false;
    killTree(target.child);
    // Do not wait for the exit event to stop trusting this child.
    if (session === target) {
      session = null;
      state = "cold";
    }
  }

  function send(target, payload, requestOptions) {
    return new Promise((resolve, reject) => {
      if (!target || target.exited || target.intentional) {
        reject(new VoiceWorkerError("exit", "Voice worker is not running."));
        return;
      }
      requestSeq += 1;
      const key = String(requestSeq);
      const wait = {
        key,
        op: payload?.op ?? "request",
        startedAt: now(),
        softMs: positiveInt(requestOptions.softMs, 0),
        stallMisses: positiveInt(requestOptions.stallMisses, DEFAULT_STALL_MISSES),
        misses: 0,
        onStream: requestOptions.onStream,
        onSlow: requestOptions.onSlow,
        softTimer: null,
        hardTimer: null,
        resolve,
        reject,
      };
      target.pending.set(key, wait);
      const hardMs = positiveInt(requestOptions.hardMs, 0);
      if (hardMs) {
        wait.hardTimer = setTimeout(() => {
          wait.hardTimer = null;
          if (!target.pending.has(key)) return;
          kill(
            target,
            new VoiceWorkerError("deadline", `Voice worker missed its deadline on ${wait.op}.`, {
              op: wait.op,
            }),
          );
        }, hardMs);
        if (typeof wait.hardTimer.unref === "function") wait.hardTimer.unref();
      }
      armSoft(target, wait);
      try {
        target.child.stdin.write(`${JSON.stringify({ ...payload, id: requestSeq })}\n`);
      } catch (error) {
        target.pending.delete(key);
        settleWait(wait);
        reject(
          new VoiceWorkerError(
            "write-failed",
            `Voice worker did not take the request: ${error?.message || error}`,
          ),
        );
      }
    });
  }

  /**
   * One request, one reply. Starts the worker first when it is cold.
   * `softMs` fires onSlow and keeps the worker; `hardMs` kills it. Stream lines go to onStream and do not finish it.
   */
  async function request(payload, requestOptions) {
    activity += 1;
    clearIdle();
    try {
      if (!(state === "ready" && session && !session.exited)) await ensure();
      const target = session;
      if (!target || target.exited || state !== "ready") {
        throw new VoiceWorkerError("exit", "Voice worker is not running.");
      }
      return await send(target, payload, requestOptions || {});
    } finally {
      activity -= 1;
      if (activity === 0) armIdle();
    }
  }

  /** Stops the child on purpose (not a crash, no breaker count). The next request starts a new one. */
  function stop() {
    clearIdle();
    const target = session;
    state = "stopped";
    session = null;
    if (!target || target.exited) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, STOP_GRACE_MS);
      if (typeof timer.unref === "function") timer.unref();
      target.stopWaiters = [
        () => {
          clearTimeout(timer);
          resolve();
        },
      ];
      terminate(target, "stop", false);
    });
  }

  function onExit(listener) {
    if (typeof listener !== "function") return () => {};
    exitListeners.add(listener);
    return () => exitListeners.delete(listener);
  }

  return { ensure, request, status, stop, onExit };
}

module.exports = { createVoiceWorker, VoiceWorkerError, STDERR_RING_BYTES };
