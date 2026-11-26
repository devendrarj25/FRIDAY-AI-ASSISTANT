/**
 * electron/voice-worker.cjs: the one lifecycle owner for the Python voice children.
 * Everything runs against a fake child process (EventEmitter plus PassThrough streams) and fake timers. Nothing here
 * starts Python, a microphone or a speaker: real children are unverified until the owner runs them on his PC.
 */
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require_ = createRequire(import.meta.url);
const mod = require_("../../electron/voice-worker.cjs") as {
  createVoiceWorker: (options: Record<string, unknown>) => Worker;
  VoiceWorkerError: new (code: string, message: string) => Error & { code: string };
  STDERR_RING_BYTES: number;
};

type Msg = {
  id: number;
  op?: string;
  ok?: boolean;
  text?: string;
  stream?: boolean;
  [key: string]: unknown;
};
type SpawnOpts = {
  cwd: string;
  env: { PYTHONIOENCODING?: string; PYTHONUTF8?: string; FRIDAY_ROOT?: string };
  windowsHide: boolean;
};
type Status = {
  role: string;
  state: string;
  pid: number | null;
  generation: number;
  busyOp?: string;
  busySinceMs?: number;
  restarts60s: number;
  breakerUntil?: number;
  lastExit?: { code: number | null; signal: string | null; stderrTail: string };
  idleUnloadMs: number;
  threads: number;
};
type RequestOptions = {
  softMs?: number;
  hardMs?: number;
  onStream?: (msg: Msg) => void;
  onSlow?: (info: { op: string; elapsedMs: number; misses: number }) => void;
};
type Worker = {
  ensure: () => Promise<Status>;
  request: (payload: Record<string, unknown>, options?: RequestOptions) => Promise<Msg>;
  status: () => Status;
  stop: () => Promise<void>;
  onExit: (listener: (info: { intentional: boolean; code: number | null }) => void) => () => void;
};

class FakeChild extends EventEmitter {
  pid: number;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  seen: Msg[] = [];
  onLine: (msg: Msg) => void = () => {};
  constructor(pid: number) {
    super();
    this.pid = pid;
    let buf = "";
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        const msg = JSON.parse(line) as Msg;
        this.seen.push(msg);
        this.onLine(msg);
      }
    });
  }
  emitLine(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }
  die(code: number | null, signal: string | null = null): void {
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await flush();
}

type Reply = Record<string, unknown> | Buffer | undefined;
function setup(extra: Record<string, unknown> = {}) {
  const children: FakeChild[] = [];
  const control: {
    respond: (msg: Msg, child: FakeChild) => Reply;
    chunker: (b: Buffer) => Buffer[];
  } = {
    respond: (msg) => ({ id: msg.id, ok: true }),
    chunker: (b) => [b],
  };
  const spawn = vi.fn((_cmd: string, _args: string[], _opts: SpawnOpts) => {
    const child = new FakeChild(4000 + children.length);
    child.onLine = (msg) => {
      const reply = control.respond(msg, child);
      if (!reply) return;
      if (Buffer.isBuffer(reply))
        for (const part of control.chunker(reply)) child.stdout.write(part);
      else child.emitLine(reply);
    };
    children.push(child);
    return child;
  });
  const killTree = vi.fn((child: FakeChild) => child.die(null, "SIGKILL"));
  const worker = mod.createVoiceWorker({
    role: "stt",
    script: "py.exe",
    args: ["-3", "stt.py", "--serve"],
    env: { FRIDAY_ROOT: "C:\\friday" },
    idleUnloadMs: 0,
    spawn,
    killTree,
    ...extra,
  });
  return { worker, children, control, spawn, killTree };
}

/** The adopters' start: a status ping, then a load, before the worker counts as ready. */
const loadInit = async (send: (p: Record<string, unknown>, o?: RequestOptions) => Promise<Msg>) => {
  await send({ op: "status" });
  const loaded = await send({ op: "load" });
  if (!loaded.ok) throw new Error("model did not load");
};

function devanagari(minBytes: number): string {
  const unit = "नमस्ते दुनिया ";
  return unit.repeat(Math.ceil(minBytes / Buffer.byteLength(unit)) + 1);
}
function replyBuffer(id: number, text: string): Buffer {
  return Buffer.from(`${JSON.stringify({ id, ok: true, text })}\n`, "utf8");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("voice worker: start", () => {
  it("starts in the temp folder with UTF-8 forced and the caller's argv", async () => {
    const { worker, spawn } = setup();
    await worker.ensure();
    const [cmd, args, opts] = spawn.mock.calls[0] as [string, string[], SpawnOpts];
    expect(cmd).toBe("py.exe");
    expect(args).toEqual(["-3", "stt.py", "--serve"]);
    expect(opts.cwd).toBe(tmpdir());
    const env = opts.env;
    expect(env.PYTHONIOENCODING).toBe("utf-8");
    expect(env.PYTHONUTF8).toBe("1");
    expect(env.FRIDAY_ROOT).toBe("C:\\friday");
    expect(opts.windowsHide).toBe(true);
  });

  it("ensure is single-flight: concurrent callers share one child and one init", async () => {
    const init = vi.fn(loadInit);
    const { worker, spawn } = setup({ init });
    const all = await Promise.all([
      worker.ensure(),
      worker.ensure(),
      worker.ensure(),
      worker.ensure(),
    ]);
    expect(all.every((view) => view.state === "ready")).toBe(true);
    await worker.ensure();
    expect(init).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("never shows ready before the model says loaded, and never spawns a second child while starting", async () => {
    const harness = setup({ init: loadInit });
    harness.control.respond = (msg) => (msg.op === "load" ? undefined : { id: msg.id, ok: true });
    const first = harness.worker.ensure();
    const second = harness.worker.request({ op: "transcribe" });
    let firstDone = false;
    void first.then(() => {
      firstDone = true;
    });
    await settle();
    expect(harness.worker.status().state).toBe("starting");
    expect(firstDone).toBe(false);
    expect(harness.spawn).toHaveBeenCalledTimes(1);
    const child = harness.children[0] as FakeChild;
    const load = child.seen.find((m) => m.op === "load") as Msg;
    child.emitLine({ id: load.id, ok: true });
    await first;
    expect((await second).ok).toBe(true);
    expect(harness.worker.status().state).toBe("ready");
    expect(harness.spawn).toHaveBeenCalledTimes(1);
  });

  it("a failed load stops the child instead of leaving it alive and forgotten", async () => {
    const harness = setup({ init: loadInit });
    harness.control.respond = (msg) =>
      msg.op === "load" ? { id: msg.id, ok: false } : { id: msg.id, ok: true };
    await expect(harness.worker.ensure()).rejects.toThrow("model did not load");
    expect(harness.killTree).toHaveBeenCalledTimes(1);
    expect(harness.worker.status().state).toBe("cold");
    expect(harness.worker.status().restarts60s).toBe(1);
    harness.control.respond = (msg) => ({ id: msg.id, ok: true });
    await harness.worker.ensure();
    expect(harness.spawn).toHaveBeenCalledTimes(2);
  });

  it("a spawn error (program missing) fails the start with a typed error and no hang", async () => {
    const harness = setup({ init: loadInit });
    harness.control.respond = () => undefined;
    const started = harness.worker.ensure();
    const check = expect(started).rejects.toMatchObject({ code: "exit" });
    await settle();
    (harness.children[0] as FakeChild).emit("error", new Error("spawn ENOENT"));
    await check;
    expect(harness.worker.status().lastExit?.stderrTail).toContain("ENOENT");
  });
});

describe("voice worker: status", () => {
  it("answers at once while an op is busy and never touches the child", async () => {
    const harness = setup();
    await harness.worker.ensure();
    harness.control.respond = () => undefined;
    const slow = harness.worker.request({ op: "transcribe" });
    await settle();
    const child = harness.children[0] as FakeChild;
    const writesBefore = child.seen.length;
    vi.advanceTimersByTime(4000);
    const view = harness.worker.status();
    expect(view.state).toBe("busy");
    expect(view.busyOp).toBe("transcribe");
    expect(view.busySinceMs).toBe(4000);
    expect(view.pid).toBe(child.pid);
    expect(view.generation).toBe(1);
    expect(child.seen.length).toBe(writesBefore);
    expect(harness.killTree).not.toHaveBeenCalled();
    const child2 = harness.children[0] as FakeChild;
    child2.emitLine({ id: (child2.seen.at(-1) as Msg).id, ok: true });
    expect((await slow).ok).toBe(true);
  });

  it("reports cold before the first start and stopped after stop()", async () => {
    const { worker } = setup({ idleUnloadMs: 60000, threads: 4 });
    expect(worker.status()).toMatchObject({
      state: "cold",
      pid: null,
      generation: 0,
      threads: 4,
      idleUnloadMs: 60000,
    });
    await worker.ensure();
    await worker.stop();
    expect(worker.status().state).toBe("stopped");
  });
});

describe("voice worker: soft and hard time", () => {
  it("a soft miss only reports slow: the worker stays and the reply still arrives", async () => {
    const harness = setup();
    await harness.worker.ensure();
    harness.control.respond = () => undefined;
    const onSlow = vi.fn();
    const pending = harness.worker.request({ op: "transcribe" }, { softMs: 100, onSlow });
    await settle();
    await vi.advanceTimersByTimeAsync(450);
    expect(onSlow).toHaveBeenCalled();
    expect(onSlow.mock.calls[0]?.[0]).toMatchObject({ op: "transcribe" });
    expect(harness.killTree).not.toHaveBeenCalled();
    expect(harness.worker.status().state).toBe("busy");
    const child = harness.children[0] as FakeChild;
    child.emitLine({ id: (child.seen.at(-1) as Msg).id, ok: true, text: "late" });
    expect((await pending).text).toBe("late");
  });

  it("the hard deadline kills the tree and rejects every pending request with code deadline", async () => {
    const harness = setup();
    await harness.worker.ensure();
    harness.control.respond = () => undefined;
    const a = harness.worker.request({ op: "transcribe" }, { softMs: 100, hardMs: 500 });
    const b = harness.worker.request({ op: "status" });
    const checks = [
      expect(a).rejects.toMatchObject({ code: "deadline" }),
      expect(b).rejects.toMatchObject({ code: "deadline" }),
    ];
    await settle();
    await vi.advanceTimersByTimeAsync(500);
    await Promise.all(checks);
    expect(harness.killTree).toHaveBeenCalledTimes(1);
    expect(harness.worker.status().state).toBe("cold");
    expect(harness.worker.status().restarts60s).toBe(1);
  });

  it("a stream feed is killed only after two soft misses in a row", async () => {
    const harness = setup();
    await harness.worker.ensure();
    harness.control.respond = () => undefined;
    const onSlow = vi.fn();
    const feed = harness.worker.request(
      { op: "stream-feed" },
      { softMs: 100, onSlow, onStream: () => {} },
    );
    const check = expect(feed).rejects.toMatchObject({ code: "stalled" });
    await settle();
    await vi.advanceTimersByTimeAsync(100);
    expect(onSlow).toHaveBeenCalledTimes(1);
    expect(harness.killTree).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    await check;
    expect(onSlow).toHaveBeenCalledTimes(2);
    expect(harness.killTree).toHaveBeenCalledTimes(1);
  });

  it("a stream line between two soft misses resets the count and the worker lives", async () => {
    const harness = setup();
    await harness.worker.ensure();
    harness.control.respond = () => undefined;
    const lines: string[] = [];
    const feed = harness.worker.request(
      { op: "stream-feed" },
      { softMs: 100, onStream: (m) => lines.push(String(m.text)) },
    );
    await settle();
    const child = harness.children[0] as FakeChild;
    const id = (child.seen.at(-1) as Msg).id;
    await vi.advanceTimersByTimeAsync(100);
    child.emitLine({ id, stream: true, text: "partial" });
    await settle();
    await vi.advanceTimersByTimeAsync(100);
    expect(harness.killTree).not.toHaveBeenCalled();
    expect(lines).toEqual(["partial"]);
    child.emitLine({ id, ok: true, text: "final" });
    expect((await feed).text).toBe("final");
  });
});

describe("voice worker: reading the child", () => {
  it("keeps a 350 KB Devanagari reply whole when it is split across chunks of every alignment", async () => {
    const harness = setup();
    await harness.worker.ensure();
    const text = devanagari(350 * 1024);
    expect(Buffer.byteLength(text)).toBeGreaterThan(350 * 1024);
    const sizes = [1, 2, 3, 4, 5, 4093];
    harness.control.chunker = (buffer) => {
      const parts: Buffer[] = [];
      let at = 0;
      for (let i = 0; at < buffer.length; i += 1) {
        const size = sizes[i % sizes.length] as number;
        parts.push(buffer.subarray(at, at + size));
        at += size;
      }
      return parts;
    };
    harness.control.respond = (msg) => replyBuffer(msg.id, text);
    const reply = await harness.worker.request({ op: "transcribe" });
    expect(reply.text).toBe(text);
    expect(String(reply.text)).not.toContain("\uFFFD");
  });

  it("is whole when the reply is cut at every single byte offset", async () => {
    const harness = setup();
    await harness.worker.ensure();
    const text = "नमस्ते FRIDAY, आप कैसे हैं?";
    const total = replyBuffer(1, text).length;
    for (let cut = 1; cut < total - 1; cut += 1) {
      harness.control.chunker = (buffer) => [buffer.subarray(0, cut), buffer.subarray(cut)];
      harness.control.respond = (msg) => replyBuffer(msg.id, text);
      const reply = await harness.worker.request({ op: "transcribe" });
      expect(reply.text).toBe(text);
    }
  });

  it("is whole when a long reply arrives one byte at a time", async () => {
    const harness = setup();
    await harness.worker.ensure();
    const text = devanagari(12 * 1024);
    harness.control.chunker = (buffer) =>
      Array.from({ length: buffer.length }, (_, i) => buffer.subarray(i, i + 1));
    harness.control.respond = (msg) => replyBuffer(msg.id, text);
    expect((await harness.worker.request({ op: "transcribe" })).text).toBe(text);
  });

  it("buffers partial lines and ignores log lines, other ids and non-objects", async () => {
    const harness = setup();
    await harness.worker.ensure();
    harness.control.respond = () => undefined;
    const pending = harness.worker.request({ op: "transcribe" });
    await settle();
    const child = harness.children[0] as FakeChild;
    const id = (child.seen.at(-1) as Msg).id;
    child.stdout.write("loading model...\n[1,2,3]\n{not json}\n");
    child.stdout.write(`{"id": ${id + 99}, "ok": true}\n{"id": ${id}, `);
    await settle();
    child.stdout.write('"ok": true, "text": "done"}\r\n');
    expect((await pending).text).toBe("done");
  });

  it("gives every request its own increasing id and resolves an ok:false envelope as a reply", async () => {
    const harness = setup();
    await harness.worker.ensure();
    harness.control.respond = (msg) => ({
      id: msg.id,
      ok: false,
      error: { code: "bad", message: "no" },
    });
    const [a, b] = await Promise.all([
      harness.worker.request({ op: "a" }),
      harness.worker.request({ op: "b" }),
    ]);
    expect(a.ok).toBe(false);
    expect(b.id).toBeGreaterThan(a.id);
    const child = harness.children[0] as FakeChild;
    expect(new Set(child.seen.map((m) => m.id)).size).toBe(child.seen.length);
  });

  it("drains a 400 KB stderr flood into a bounded ring and reports its tail on exit", async () => {
    const harness = setup();
    await harness.worker.ensure();
    const child = harness.children[0] as FakeChild;
    for (let i = 0; i < 400; i += 1) child.stderr.write(`err-${i} ${"x".repeat(1000)}\n`);
    await settle();
    expect(child.stderr.readableLength).toBe(0);
    child.die(3);
    const exit = harness.worker.status().lastExit;
    expect(exit?.code).toBe(3);
    expect(exit?.stderrTail.length).toBeLessThanOrEqual(mod.STDERR_RING_BYTES);
    expect(exit?.stderrTail).toContain("err-399");
    expect(exit?.stderrTail).not.toContain("err-0 ");
  });
});

describe("voice worker: exit", () => {
  for (const event of ["exit", "close"] as const) {
    it(`rejects pending requests when only '${event}' is emitted`, async () => {
      const harness = setup();
      await harness.worker.ensure();
      harness.control.respond = () => undefined;
      const pending = harness.worker.request({ op: "transcribe" });
      const check = expect(pending).rejects.toMatchObject({ code: "exit" });
      await settle();
      (harness.children[0] as FakeChild).emit(event, 9, null);
      await check;
      expect(harness.worker.status()).toMatchObject({ state: "cold", lastExit: { code: 9 } });
    });
  }

  it("tells exit listeners whether the stop was on purpose", async () => {
    const harness = setup();
    const seen: Array<{ intentional: boolean; code: number | null }> = [];
    harness.worker.onExit((info) => seen.push(info));
    await harness.worker.ensure();
    (harness.children[0] as FakeChild).die(1);
    await harness.worker.ensure();
    await harness.worker.stop();
    expect(seen.map((s) => s.intentional)).toEqual([false, true]);
  });

  it("stop() rejects pending work, is not a crash, and the next request starts a fresh child", async () => {
    const harness = setup();
    await harness.worker.ensure();
    harness.control.respond = () => undefined;
    const pending = harness.worker.request({ op: "transcribe" });
    const check = expect(pending).rejects.toMatchObject({ code: "stopped" });
    await settle();
    await harness.worker.stop();
    await check;
    expect(harness.worker.status()).toMatchObject({ state: "stopped", restarts60s: 0 });
    harness.control.respond = (msg) => ({ id: msg.id, ok: true });
    await harness.worker.request({ op: "status" });
    expect(harness.spawn).toHaveBeenCalledTimes(2);
    expect(harness.worker.status().generation).toBe(2);
  });
});

describe("voice worker: crash-loop breaker", () => {
  async function crashOnce(harness: ReturnType<typeof setup>): Promise<void> {
    await harness.worker.ensure();
    (harness.children.at(-1) as FakeChild).die(1);
  }

  it("opens after 3 crashes in 60 s, refuses to spawn, then probes once and closes on success", async () => {
    const harness = setup({ init: loadInit });
    await crashOnce(harness);
    await crashOnce(harness);
    expect(harness.worker.status().state).toBe("cold");
    await crashOnce(harness);
    const open = harness.worker.status();
    expect(open.state).toBe("breaker-open");
    expect(open.restarts60s).toBe(3);
    expect(open.breakerUntil).toBe(Date.now() + 300000);
    await expect(harness.worker.ensure()).rejects.toMatchObject({ code: "breaker-open" });
    await expect(harness.worker.request({ op: "status" })).rejects.toMatchObject({
      code: "breaker-open",
    });
    expect(harness.spawn).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(300000);
    await harness.worker.ensure();
    expect(harness.spawn).toHaveBeenCalledTimes(4);
    const closed = harness.worker.status();
    expect(closed.state).toBe("ready");
    expect(closed.restarts60s).toBe(0);
    expect(closed.breakerUntil).toBeUndefined();
  });

  it("a probe that crashes opens the breaker again at once", async () => {
    const harness = setup({ init: loadInit });
    await crashOnce(harness);
    await crashOnce(harness);
    await crashOnce(harness);
    await vi.advanceTimersByTimeAsync(300000);
    harness.control.respond = () => undefined;
    const probe = harness.worker.ensure();
    const check = expect(probe).rejects.toMatchObject({ code: "exit" });
    await settle();
    (harness.children.at(-1) as FakeChild).die(1);
    await check;
    expect(harness.worker.status().state).toBe("breaker-open");
    await expect(harness.worker.ensure()).rejects.toMatchObject({ code: "breaker-open" });
    expect(harness.spawn).toHaveBeenCalledTimes(4);
  });

  it("crashes more than 60 s apart do not trip the breaker", async () => {
    const harness = setup();
    for (let i = 0; i < 4; i += 1) {
      await crashOnce(harness);
      await vi.advanceTimersByTimeAsync(61000);
    }
    expect(harness.worker.status().state).toBe("cold");
    await harness.worker.ensure();
    expect(harness.worker.status().state).toBe("ready");
  });
});

describe("voice worker: idle unload", () => {
  it("stops the child after the quiet spell, then the next request starts a new one", async () => {
    const harness = setup({ idleUnloadMs: 1000 });
    await harness.worker.ensure();
    await vi.advanceTimersByTimeAsync(999);
    expect(harness.killTree).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.killTree).toHaveBeenCalledTimes(1);
    expect(harness.worker.status()).toMatchObject({ state: "cold", restarts60s: 0 });
    await harness.worker.request({ op: "status" });
    expect(harness.spawn).toHaveBeenCalledTimes(2);
  });

  it("never unloads while a request is pending, and re-arms when it finishes", async () => {
    const harness = setup({ idleUnloadMs: 1000 });
    await harness.worker.ensure();
    harness.control.respond = () => undefined;
    const pending = harness.worker.request({ op: "transcribe" });
    await settle();
    await vi.advanceTimersByTimeAsync(5000);
    expect(harness.killTree).not.toHaveBeenCalled();
    const child = harness.children[0] as FakeChild;
    child.emitLine({ id: (child.seen.at(-1) as Msg).id, ok: true });
    await pending;
    await vi.advanceTimersByTimeAsync(1000);
    expect(harness.killTree).toHaveBeenCalledTimes(1);
  });
});

describe("voice worker: errors are typed", () => {
  it("exports a typed error whose code the caller can switch on", () => {
    const error = new mod.VoiceWorkerError("deadline", "late");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("deadline");
  });
});
