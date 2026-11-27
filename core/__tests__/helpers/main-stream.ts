/**
 * Runs the real `streamOnceRaw` of electron/main.cjs (the one chat stream every turn goes through) against a fake
 * kernel socket. The entry point itself cannot be loaded, so the function is cut out by brace counting and built with
 * its collaborators passed in; the privacy firewall, the router and the stall watchdog are the real modules.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../../..");
const require_ = createRequire(resolve(root, "electron/main.cjs"));
const mainSource = readFileSync(resolve(root, "electron/main.cjs"), "utf8").replace(/\r\n/g, "\n");

export function extractFromMain(signature: string): string {
  const start = mainSource.indexOf(signature);
  if (start < 0) throw new Error(`${signature} is not in main.cjs`);
  const open = mainSource.indexOf("{", mainSource.indexOf(")", start));
  let depth = 0;
  for (let at = open; at < mainSource.length; at += 1) {
    if (mainSource[at] === "{") depth += 1;
    else if (mainSource[at] === "}") {
      depth -= 1;
      if (depth === 0) return mainSource.slice(start, at + 1);
    }
  }
  throw new Error(`${signature} is not closed`);
}

export function mainText(): string {
  return mainSource;
}

type Listener = (event: { data?: string }) => void;

export class FakeSocket {
  static all: FakeSocket[] = [];
  listeners = new Map<string, Listener[]>();
  sent: Record<string, unknown>[] = [];
  closed = false;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data?: unknown) {
    for (const fn of this.listeners.get(type) ?? []) {
      fn(
        data === undefined ? {} : { data: typeof data === "string" ? data : JSON.stringify(data) },
      );
    }
  }
  /** The kernel's side of the bridge. */
  ready() {
    this.emit("message", { type: "ready" });
  }
  delta(text: string, extra: Record<string, unknown> = {}) {
    this.emit("message", { type: "chat.delta", data: { delta: text, ...extra } });
  }
  tool(name: string) {
    this.emit("message", { type: "chat.delta", data: { tool: name } });
  }
  result() {
    this.emit("message", { id: 1, type: "result", data: {} });
  }
  /** The `chat.stream` request the main process sent once the kernel said ready. */
  get params(): Record<string, unknown> {
    const call = this.sent.find((row) => row["method"] === "chat.stream");
    return (call?.["params"] ?? {}) as Record<string, unknown>;
  }
}

export type StreamResult = {
  ok?: boolean;
  received?: boolean;
  timedOut?: boolean;
  firstDeltaMiss?: boolean;
  blocked?: boolean;
  error?: string;
  text?: string;
};

export type StreamArgs = {
  requestId?: string;
  request: Record<string, unknown>;
  prompt: string;
  model: Record<string, unknown>;
  coldLoad?: boolean;
  collect?: boolean;
};

export function streamHarness(options: { allowed?: boolean } = {}) {
  FakeSocket.all = [];
  const authorised: { content: string; label: string }[] = [];
  const sent: { channel: string; payload: Record<string, unknown> }[] = [];
  const deps: Record<string, unknown> = {
    authoriseProviderRequest: async (input: { content: string; label: string }) => {
      authorised.push({ content: input.content, label: input.label });
      return options.allowed === false
        ? { allowed: false, message: "blocked", verdict: { billingClass: "free", reason: "no" } }
        : { allowed: true };
    },
    send: (channel: string, payload: Record<string, unknown>) => sent.push({ channel, payload }),
    getWebSocket: () => FakeSocket,
    KERNEL_HOST: "127.0.0.1",
    KERNEL_PORT: 8765,
    BRIDGE_TOKEN: "token-for-tests",
    activeChats: new Map<string, unknown>(),
    createStallWatchdog: require_("./stream-watchdog.cjs").createStallWatchdog,
    firstDeltaDeadlineMs: require_("./stream-watchdog.cjs").firstDeltaDeadlineMs,
    privacyFirewall: require_("./privacy-firewall.cjs"),
    modelRouter: require_("./model-router.cjs"),
    KERNEL_OWNER_TEXT_MAX: 800_000,
    modelRouteMode: () => "auto",
    require: (name: string) => require_(name),
  };
  const names = Object.keys(deps);
  const factory = new Function(
    ...names,
    `${extractFromMain("async function streamOnceRaw({")}\nreturn streamOnceRaw;`,
  );
  const run = factory(...names.map((key) => deps[key])) as (
    args: StreamArgs,
  ) => Promise<StreamResult>;
  return {
    run,
    authorised,
    sent,
    sockets: () => FakeSocket.all,
    socket: () => FakeSocket.all[0] as FakeSocket,
  };
}
