/**
 * A fake speech child for electron/stt.cjs: the bridge starts its worker through electron/voice-worker.cjs, so a test
 * hands the bridge a fake `spawn` (an event emitter with piped streams that answers one JSON line per request) and
 * a fake `killTree`. No Python, no model, no microphone.
 */
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import { vi } from "vitest";

export type Msg = { id?: number; op?: string; [key: string]: unknown };

export class FakeChild extends EventEmitter {
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
/** Lets the piped streams and the module's promise chains run (real setImmediate, so fake timers may be on). */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await flush();
}

export const STATUS_OK = {
  ok: true,
  dependency: "ready",
  available: true,
  inference: "unverified",
  loadedModels: [],
  idleSec: 1,
};

export type Control = {
  respond: (msg: Msg, child: FakeChild) => Record<string, unknown> | undefined;
};

type SttBridge = { useForTests: (hooks?: Record<string, unknown>) => void };

/** The answers a healthy worker gives: status, load, transcribe and cancel. Anything else is just ok. */
export function healthyReplies(msg: Msg): Record<string, unknown> {
  if (msg.op === "status") return { id: msg.id, ...STATUS_OK };
  if (msg.op === "load") return { id: msg.id, ok: true, loadCount: 1 };
  if (msg.op === "transcribe") return { id: msg.id, ok: true, text: "hello", language: "en" };
  if (msg.op === "cancel") return { id: msg.id, ok: true, cancelled: true };
  return { id: msg.id, ok: true };
}

/** Installs the fakes into the bridge and returns handles to what the bridge did with them. */
export function installFakeWorker(stt?: SttBridge) {
  const bridge = stt ?? (createRequire(import.meta.url)("../../../electron/stt.cjs") as SttBridge);
  const children: FakeChild[] = [];
  const control: Control = { respond: (msg) => healthyReplies(msg) };
  const spawn = vi.fn((..._args: unknown[]) => {
    const child = new FakeChild(5000 + children.length);
    child.onLine = (msg) => {
      const reply = control.respond(msg, child);
      if (reply) child.emitLine(reply);
    };
    children.push(child);
    return child;
  });
  const killTree = vi.fn((child: FakeChild) => child.die(null, "SIGKILL"));
  const probe = JSON.stringify({ ok: true, dependency: "ready", available: true, model: "small" });
  bridge.useForTests({
    spawn,
    killTree,
    python: async () => ["python-test", ["-3"]],
    run: async () => ({ ok: true, stdout: probe, stderr: "" }),
    weights: async (wanted: string) => ({ ok: true, dir: `/weights/${wanted}`, size: wanted }),
  });
  const sent = (op: string) => children.flatMap((c) => c.seen.filter((m) => m.op === op));
  return { children, control, spawn, killTree, sent };
}
