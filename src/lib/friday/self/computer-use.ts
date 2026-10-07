/**
 * FRIDAY · desktop work, one loop.
 *
 * Chat, Auto mode and Flow Studio call `runComputerUse`. The task graph is
 * the durable record. A fake desktop proves the loop with no real screen.
 * Screen text, files and tool output stay data. A credential, payment,
 * captcha or secure-desktop prompt is handed to the owner.
 */

import type { ApprovalLevel } from "./autonomy";
import { kernelApi } from "../kernel-api";
import {
  budgetBlock,
  idempotencyKey,
  mintIdentity,
  retryBackoffMs,
  type EvidenceReceipt,
  type TaskBudget,
} from "./run-receipt";

export type PerceptionSource = "uia" | "ocr" | "vision" | "none";

export type DeskControl = {
  id: string;
  role: "button" | "edit" | "text" | "password" | "payment" | "captcha" | "uac";
  name: string;
  value: string;
  bounds: { x: number; y: number; w: number; h: number };
  pressed?: boolean;
};

export type DeskWindow = {
  id: string;
  title: string;
  monitor: number;
  dpi: number;
  crashed: boolean;
  /** How this window is seen. Controls win over pixels. */
  sight: "uia" | "ocr" | "vision";
  controls: DeskControl[];
};

export type DeskState = {
  monitors: { id: number; dpi: number; x: number; y: number; w: number; h: number }[];
  windows: DeskWindow[];
  focusedId: string | null;
  clipboard: string;
  files: Record<string, string>;
  generation: number;
  applied: string[];
  /** Writes currently inside act(), so a test can see they do not overlap. */
  writesInFlight: number;
  maxWritesInFlight: number;
  readsInFlight: number;
  maxReadsInFlight: number;
};

export type Perception = {
  source: PerceptionSource;
  confidence: number;
  freshAt: number;
  generation: number;
  untrusted: true;
  dpi: number;
  monitor: number;
  windows: { id: string; title: string; controls: DeskControl[] }[];
  text: string;
};

export type DesktopAction = {
  kind:
    | "launch"
    | "focus"
    | "click"
    | "type"
    | "hotkey"
    | "scroll"
    | "drag"
    | "clipboard-read"
    | "clipboard-write"
    | "file-read"
    | "file-write"
    | "close";
  target: string;
  payload: string;
  tool: string;
  readOnly: boolean;
  undoHint: string;
  postcondition: string;
};

export type ActOutcome = {
  ok: boolean;
  detail: string;
  handoff?: "credential" | "payment" | "captcha" | "uac";
  undo?: () => void;
};

export type DesktopPort = {
  state: DeskState;
  perceive: (at: number) => Promise<Perception>;
  act: (action: DesktopAction, at: number) => Promise<ActOutcome>;
};

export type DesktopReport = {
  ok: boolean;
  needsOwner: boolean;
  summary: string;
  lines: string[];
  evidence: EvidenceReceipt[];
  stoppedReason: string;
  audit: { at: number; action: string; result: string }[];
  undo: () => boolean;
};

export type DesktopRunInput = {
  request: string;
  level: ApprovalLevel;
  halted: boolean;
  source: "chat" | "auto" | "flow" | "task";
  desktop?: DesktopPort;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  approve?: (question: string) => boolean | Promise<boolean>;
  budget?: TaskBudget;
  signal?: AbortSignal;
  /** Resume payload from a previous report's evidence plus the same desktop. */
  appliedKeys?: string[];
};

const DEFAULT_BUDGET: TaskBudget = { timeMs: 120_000, maxSteps: 8, spend: 0, tokens: 0 };

const HANDOFF_ROLE = new Set(["password", "payment", "captcha", "uac"]);

const INJECTION =
  /\b(ignore (all |any |previous |your )?instructions|system prompt|you must (now )?click|type the password|disregard the owner)\b/i;

const DESKTOP_ASK =
  /(?:^|\n)\s*(?:please\s+)?(launch|focus|click|type|press|scroll|drag|copy|paste|close)\b|\b(on (my|the) desktop|on (my|the) screen)\b/i;

export function desktopAsk(text: string): boolean {
  return DESKTOP_ASK.test(String(text || ""));
}

/** Owner words become a short plan. Screen text is never an input here. */
export function planDesktop(request: string): { actions: DesktopAction[]; confidence: number } {
  const clauses = String(request || "")
    .split(/\n+|\s+\bthen\b\s+/i)
    .map((part) => part.replace(/^\s*\d+[.)]\s*/, "").trim())
    .filter(Boolean);
  const actions: DesktopAction[] = [];
  for (const clause of clauses) {
    const action = clauseToAction(clause);
    if (!action) return { actions: [], confidence: 0 };
    actions.push(action);
  }
  if (!actions.length) return { actions: [], confidence: 0 };
  return { actions, confidence: 0.9 };
}

function taken(match: RegExpExecArray, index: number): string {
  return match[index] ?? "";
}

function clauseToAction(clause: string): DesktopAction | null {
  const text = clause.trim();
  let match = /^launch\s+(.+)$/i.exec(text);
  if (match)
    return action(
      "launch",
      taken(match, 1),
      "",
      "app.launch",
      false,
      "close the window",
      "the window is open",
    );
  match = /^focus\s+(.+)$/i.exec(text);
  if (match)
    return action(
      "focus",
      taken(match, 1),
      "",
      "app.focus",
      false,
      "focus returns to the previous window",
      "the window is focused",
    );
  match = /^click\s+(.+)$/i.exec(text);
  if (match)
    return action(
      "click",
      taken(match, 1),
      "",
      "input.click",
      false,
      "a click cannot be undone",
      "the control is pressed",
    );
  match = /^type\s+(.+?)\s+into\s+(.+)$/i.exec(text);
  if (match)
    return action(
      "type",
      taken(match, 2),
      taken(match, 1),
      "input.type",
      false,
      "restore the previous text",
      "the field holds the typed text",
    );
  match = /^press\s+(.+)$/i.exec(text);
  if (match)
    return action(
      "hotkey",
      taken(match, 1),
      taken(match, 1),
      "input.hotkey",
      false,
      "a hotkey cannot be undone",
      "the shortcut was sent",
    );
  match = /^scroll\s+(.+)$/i.exec(text);
  if (match)
    return action(
      "scroll",
      taken(match, 1),
      taken(match, 1),
      "input.scroll",
      false,
      "scroll back",
      "the view scrolled",
    );
  match = /^drag\s+(.+?)\s+to\s+(.+)$/i.exec(text);
  if (match)
    return action(
      "drag",
      taken(match, 1),
      taken(match, 2),
      "input.drag",
      false,
      "drag back",
      "the control moved",
    );
  match = /^copy\s+(.+)$/i.exec(text);
  if (match)
    return action(
      "clipboard-write",
      "clipboard",
      taken(match, 1),
      "clipboard.write",
      false,
      "restore the clipboard",
      "the clipboard holds the text",
    );
  match = /^paste$/i.exec(text);
  if (match)
    return action(
      "clipboard-read",
      "clipboard",
      "",
      "clipboard.read",
      true,
      "clipboard read does not change the desktop",
      "the clipboard was read",
    );
  match = /^read file\s+(.+)$/i.exec(text);
  if (match)
    return action(
      "file-read",
      taken(match, 1),
      "",
      "fs.read",
      true,
      "a read does not change the file",
      "the file was read",
    );
  match = /^write file\s+(\S+)\s+(.+)$/i.exec(text);
  if (match)
    return action(
      "file-write",
      taken(match, 1),
      taken(match, 2),
      "fs.write",
      false,
      "restore the previous file text",
      "the file holds the new text",
    );
  match = /^close\s+(.+)$/i.exec(text);
  if (match)
    return action(
      "close",
      taken(match, 1),
      "",
      "app.close",
      false,
      "the window may not reopen",
      "the window is closed",
    );
  return null;
}

function action(
  kind: DesktopAction["kind"],
  target: string,
  payload: string,
  tool: string,
  readOnly: boolean,
  undoHint: string,
  postcondition: string,
): DesktopAction {
  return {
    kind,
    target: target.trim(),
    payload: payload.trim(),
    tool,
    readOnly,
    undoHint,
    postcondition,
  };
}

export function createFakeDesktop(seed?: Partial<DeskState>): DesktopPort {
  const state: DeskState = {
    monitors: seed?.monitors ?? [{ id: 1, dpi: 144, x: 0, y: 0, w: 1920, h: 1080 }],
    windows: seed?.windows ? seed.windows.map(cloneWindow) : [],
    focusedId: seed?.focusedId ?? null,
    clipboard: seed?.clipboard ?? "",
    files: { ...(seed?.files ?? {}) },
    generation: seed?.generation ?? 1,
    applied: [...(seed?.applied ?? [])],
    writesInFlight: 0,
    maxWritesInFlight: 0,
    readsInFlight: 0,
    maxReadsInFlight: 0,
  };

  const perceive = async (at: number): Promise<Perception> => {
    state.readsInFlight += 1;
    state.maxReadsInFlight = Math.max(state.maxReadsInFlight, state.readsInFlight);
    await Promise.resolve();
    state.readsInFlight = Math.max(0, state.readsInFlight - 1);
    const focused =
      state.windows.find((window) => window.id === state.focusedId) ?? state.windows[0];
    const sight = focused?.sight ?? "vision";
    const source: PerceptionSource = !focused ? "none" : sight === "uia" ? "uia" : sight;
    const confidence =
      source === "uia" ? 0.92 : source === "ocr" ? 0.62 : source === "vision" ? 0.41 : 0;
    const text = (focused?.controls ?? [])
      .map((control) => `${control.name} ${control.value}`.trim())
      .join("\n");
    return {
      source,
      confidence,
      freshAt: at,
      generation: state.generation,
      untrusted: true,
      dpi: focused?.dpi ?? state.monitors[0]?.dpi ?? 96,
      monitor: focused?.monitor ?? 1,
      windows: state.windows
        .filter((window) => !window.crashed)
        .map((window) => ({
          id: window.id,
          title: window.title,
          controls: window.controls.map((control) => ({
            ...control,
            bounds: { ...control.bounds },
          })),
        })),
      text,
    };
  };

  const act = async (step: DesktopAction, _at: number): Promise<ActOutcome> => {
    const key = idempotencyKey(step.kind, step.target, step.payload);
    if (!step.readOnly) {
      state.writesInFlight += 1;
      state.maxWritesInFlight = Math.max(state.maxWritesInFlight, state.writesInFlight);
      await Promise.resolve();
    }
    try {
      if (
        state.applied.includes(key) &&
        step.kind !== "clipboard-read" &&
        step.kind !== "file-read"
      ) {
        return { ok: true, detail: "already applied" };
      }
      if (step.kind === "launch") return launch(state, step);
      if (step.kind === "focus") return focus(state, step);
      if (step.kind === "click") return click(state, step, key);
      if (step.kind === "type") return typeInto(state, step, key);
      if (step.kind === "hotkey" || step.kind === "scroll" || step.kind === "drag") {
        state.applied.push(key);
        return { ok: true, detail: `${step.kind} sent` };
      }
      if (step.kind === "clipboard-write") {
        const previous = state.clipboard;
        state.clipboard = step.payload;
        state.applied.push(key);
        return { ok: true, detail: "clipboard set", undo: () => (state.clipboard = previous) };
      }
      if (step.kind === "clipboard-read") return { ok: true, detail: state.clipboard };
      if (step.kind === "file-read") {
        if (!(step.target in state.files)) return { ok: false, detail: "file missing" };
        return { ok: true, detail: state.files[step.target] ?? "" };
      }
      if (step.kind === "file-write") {
        const previous = state.files[step.target];
        state.files[step.target] = step.payload;
        state.applied.push(key);
        return {
          ok: true,
          detail: "file written",
          undo: () => {
            if (previous === undefined) delete state.files[step.target];
            else state.files[step.target] = previous;
          },
        };
      }
      if (step.kind === "close") return close(state, step, key);
      return { ok: false, detail: "unknown action" };
    } finally {
      if (!step.readOnly) state.writesInFlight = Math.max(0, state.writesInFlight - 1);
    }
  };

  return { state, perceive, act };
}

function cloneWindow(window: DeskWindow): DeskWindow {
  return {
    ...window,
    controls: window.controls.map((control) => ({ ...control, bounds: { ...control.bounds } })),
  };
}

function launch(state: DeskState, step: DesktopAction): ActOutcome {
  const title = step.target;
  if (state.windows.some((window) => window.title === title && window.crashed)) {
    return { ok: false, detail: `${title} crashed` };
  }
  let window = state.windows.find((item) => item.title.toLowerCase() === title.toLowerCase());
  if (!window) {
    window = {
      id: `win-${state.windows.length + 1}`,
      title,
      monitor: 1,
      dpi: state.monitors[0]?.dpi ?? 96,
      crashed: false,
      sight: "uia",
      controls: [],
    };
    state.windows.push(window);
  }
  state.focusedId = window.id;
  state.generation += 1;
  state.applied.push(idempotencyKey(step.kind, step.target, step.payload));
  return { ok: true, detail: `launched ${title}` };
}

function focus(state: DeskState, step: DesktopAction): ActOutcome {
  const window = state.windows.find((item) =>
    item.title.toLowerCase().includes(step.target.toLowerCase()),
  );
  if (!window || window.crashed) return { ok: false, detail: "window missing" };
  state.focusedId = window.id;
  state.generation += 1;
  return { ok: true, detail: `focused ${window.title}` };
}

function controlOf(
  state: DeskState,
  name: string,
): { window: DeskWindow; control: DeskControl } | null {
  const window = state.windows.find((item) => item.id === state.focusedId) ?? state.windows[0];
  if (!window) return null;
  const control = window.controls.find((item) => item.name.toLowerCase() === name.toLowerCase());
  if (!control) return null;
  return { window, control };
}

function click(state: DeskState, step: DesktopAction, key: string): ActOutcome {
  const found = controlOf(state, step.target);
  if (!found) return { ok: false, detail: "control missing" };
  if (found.window.crashed) return { ok: false, detail: `${found.window.title} crashed` };
  if (HANDOFF_ROLE.has(found.control.role) || /user account control/i.test(found.window.title)) {
    return {
      ok: false,
      detail: `${found.control.name} needs the owner`,
      handoff: handoffKind(found.control.role),
    };
  }
  found.control.pressed = true;
  state.generation += 1;
  state.applied.push(key);
  return { ok: true, detail: `clicked ${found.control.name}` };
}

function typeInto(state: DeskState, step: DesktopAction, key: string): ActOutcome {
  const found = controlOf(state, step.target);
  if (!found) return { ok: false, detail: "field missing" };
  if (HANDOFF_ROLE.has(found.control.role)) {
    return {
      ok: false,
      detail: `${found.control.name} needs the owner`,
      handoff: handoffKind(found.control.role),
    };
  }
  const previous = found.control.value;
  found.control.value = step.payload;
  state.generation += 1;
  state.applied.push(key);
  return {
    ok: true,
    detail: `typed into ${found.control.name}`,
    undo: () => {
      found.control.value = previous;
    },
  };
}

function close(state: DeskState, step: DesktopAction, key: string): ActOutcome {
  const index = state.windows.findIndex((item) =>
    item.title.toLowerCase().includes(step.target.toLowerCase()),
  );
  if (index < 0) return { ok: false, detail: "window missing" };
  const [removed] = state.windows.splice(index, 1);
  if (state.focusedId === removed?.id) state.focusedId = state.windows[0]?.id ?? null;
  state.generation += 1;
  state.applied.push(key);
  return { ok: true, detail: `closed ${removed?.title ?? step.target}` };
}

function handoffKind(role: string): "credential" | "payment" | "captcha" | "uac" {
  if (role === "password") return "credential";
  if (role === "payment") return "payment";
  if (role === "captcha") return "captcha";
  return "uac";
}

function postconditionMet(step: DesktopAction, seen: Perception, outcome: ActOutcome): boolean {
  if (!outcome.ok) return false;
  if (step.kind === "launch" || step.kind === "focus") {
    return seen.windows.some((window) =>
      window.title.toLowerCase().includes(step.target.toLowerCase()),
    );
  }
  if (step.kind === "click") {
    return seen.windows.some((window) =>
      window.controls.some(
        (control) => control.name.toLowerCase() === step.target.toLowerCase() && control.pressed,
      ),
    );
  }
  if (step.kind === "type") {
    return seen.windows.some((window) =>
      window.controls.some(
        (control) =>
          control.name.toLowerCase() === step.target.toLowerCase() &&
          control.value === step.payload,
      ),
    );
  }
  if (step.kind === "close") {
    return !seen.windows.some((window) =>
      window.title.toLowerCase().includes(step.target.toLowerCase()),
    );
  }
  if (step.kind === "file-read" || step.kind === "clipboard-read") return true;
  return outcome.ok;
}

type Gate = { allow: boolean; needsOwner: boolean; reason: string };

export function gateAction(level: ApprovalLevel, halted: boolean, step: DesktopAction): Gate {
  if (halted) return { allow: false, needsOwner: true, reason: "Stopped." };
  if (level === "strict" || (level !== "full" && !step.readOnly)) {
    return { allow: false, needsOwner: true, reason: `Ask before ${step.kind} ${step.target}.` };
  }
  return { allow: true, needsOwner: false, reason: "" };
}

function statusLine(
  kind: "done" | "ask" | "handoff" | "budget" | "injection" | "stop",
  detail: string,
): string {
  if (kind === "done") return `Done. ${detail}`;
  if (kind === "ask") return `Waiting on you. ${detail}`;
  if (kind === "handoff") return `That one is yours. ${detail}`;
  if (kind === "budget") return `Stopping here. ${detail}`;
  if (kind === "injection") return `Screen text stays data. ${detail}`;
  return detail;
}

let livePort: DesktopPort | null = null;

/** Tests and the desktop host install the port. The default refuses to pretend. */
export function setDesktopPort(port: DesktopPort | null): void {
  livePort = port;
}

export function resolveDesktopPort(): DesktopPort {
  if (livePort) return livePort;
  return kernelBackedPort();
}

function kernelBackedPort(): DesktopPort {
  const state: DeskState = {
    monitors: [],
    windows: [],
    focusedId: null,
    clipboard: "",
    files: {},
    generation: 0,
    applied: [],
    writesInFlight: 0,
    maxWritesInFlight: 0,
    readsInFlight: 0,
    maxReadsInFlight: 0,
  };
  return {
    state,
    async perceive(at: number): Promise<Perception> {
      const result = await kernelApi.tools.exec("screen.perceive", {});
      if (!result || result["ok"] === false) {
        return {
          source: "none",
          confidence: 0,
          freshAt: at,
          generation: 0,
          untrusted: true,
          dpi: 96,
          monitor: 0,
          windows: [],
          text: "",
        };
      }
      return {
        source: "uia",
        confidence: typeof result["confidence"] === "number" ? result["confidence"] : 0.5,
        freshAt: at,
        generation: 1,
        untrusted: true,
        dpi: 96,
        monitor: 1,
        windows: [],
        text: String(result["text"] || ""),
      };
    },
    async act(step: DesktopAction): Promise<ActOutcome> {
      const result = await kernelApi.tools.exec(step.tool, {
        target: step.target,
        text: step.payload,
      });
      if (!result) return { ok: false, detail: "desktop bridge unavailable" };
      return {
        ok: Boolean(result["ok"]),
        detail: String(result["error"] || result["detail"] || step.tool),
      };
    },
  };
}

type StepResult = { acted: ActOutcome; after: Perception };

/**
 * Plan, act, verify, replan once, report.
 * Read-only steps in a row run together. Writes wait for the previous write.
 */
export async function runComputerUse(input: DesktopRunInput): Promise<DesktopReport> {
  const now = input.now ?? (() => 0);
  const sleep = input.sleep ?? (async () => undefined);
  const desktop = input.desktop ?? resolveDesktopPort();
  const budget = input.budget ?? DEFAULT_BUDGET;
  const started = now();
  const lines: string[] = [];
  const evidence: EvidenceReceipt[] = [];
  const audit: DesktopReport["audit"] = [];
  const undos: Array<() => void> = [];
  const planned = planDesktop(input.request);
  const taskId = "desk";

  const finish = (
    ok: boolean,
    needsOwner: boolean,
    summary: string,
    stoppedReason: string,
  ): DesktopReport => ({
    ok,
    needsOwner,
    summary,
    lines,
    evidence,
    stoppedReason,
    audit,
    undo: () => {
      const last = undos.pop();
      if (!last) return false;
      last();
      return true;
    },
  });

  if (input.halted) {
    lines.push(statusLine("stop", "Stop everything is on."));
    return finish(false, true, lines[0] ?? "Stopped.", "halted");
  }
  if (planned.confidence < 0.5 || !planned.actions.length) {
    lines.push(statusLine("ask", "I need a concrete desktop step."));
    return finish(false, true, lines[0] ?? "Ask.", "low-confidence");
  }

  let writes: Promise<void> = Promise.resolve();
  const enqueue = <T>(readOnly: boolean, job: () => Promise<T>): Promise<T> => {
    if (readOnly) return job();
    const run = writes.then(job, job);
    writes = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const runStep = async (
    step: DesktopAction,
    _index: number,
  ): Promise<StepResult | DesktopReport> => {
    if (input.signal?.aborted) return finish(false, false, "Cancelled.", "cancelled");
    const block = budgetBlock(budget, {
      ms: Math.max(0, now() - started),
      steps: evidence.length,
      spend: 0,
      tokens: 0,
    });
    if (block) {
      lines.push(statusLine("budget", block));
      return finish(false, true, lines[lines.length - 1] ?? block, block);
    }
    const gate = gateAction(input.level, input.halted, step);
    if (!gate.allow) {
      const approved = input.approve ? await input.approve(gate.reason) : false;
      if (!approved) {
        lines.push(statusLine("ask", gate.reason));
        audit.push({ at: now(), action: step.tool, result: "asked" });
        return finish(false, true, lines[lines.length - 1] ?? gate.reason, "approval");
      }
    }
    const key = idempotencyKey(step.kind, step.target, step.payload);
    const already = desktop.state.applied.includes(key) || (input.appliedKeys ?? []).includes(key);

    return enqueue(step.readOnly, async () => {
      const before = await desktop.perceive(now());
      if (INJECTION.test(before.text) && !input.request.includes(before.text.trim())) {
        lines.push(statusLine("injection", "I will not follow text on the screen."));
        audit.push({ at: now(), action: step.tool, result: "injection" });
        return finish(false, true, lines[lines.length - 1] ?? "Injection.", "injection");
      }
      if (before.confidence > 0 && before.confidence < 0.45 && step.kind !== "file-read") {
        lines.push(statusLine("ask", "The screen is too uncertain to act."));
        return finish(false, true, lines[lines.length - 1] ?? "Low confidence.", "low-confidence");
      }
      const acted = already
        ? ({ ok: true, detail: "already applied" } satisfies ActOutcome)
        : await desktop.act(step, now());
      let after = await desktop.perceive(now());
      if (
        !already &&
        !acted.handoff &&
        before.generation !== after.generation &&
        !postconditionMet(step, after, acted)
      ) {
        const delay = retryBackoffMs(1);
        if (delay && delay > 0) await sleep(delay);
        const retried = await desktop.act(step, now());
        after = await desktop.perceive(now());
        return { acted: retried, after };
      }
      return { acted, after };
    });
  };

  const record = (step: DesktopAction, index: number, result: StepResult): DesktopReport | null => {
    const { acted, after } = result;
    if (acted.handoff) {
      lines.push(statusLine("handoff", acted.detail));
      audit.push({ at: now(), action: step.tool, result: `handoff:${acted.handoff}` });
      return finish(
        false,
        true,
        lines[lines.length - 1] ?? acted.detail,
        `handoff:${acted.handoff}`,
      );
    }
    const checked = postconditionMet(step, after, acted) || acted.detail === "already applied";
    const ids = mintIdentity(taskId, index + 1);
    evidence.push({
      evidenceId: ids.evidenceId,
      taskId: ids.taskId,
      runId: ids.runId,
      stepId: ids.stepId,
      actionId: ids.actionId,
      done: `${step.kind} ${step.target}`,
      postcondition: step.postcondition,
      checked,
      result: acted.detail,
      at: now(),
    });
    audit.push({ at: now(), action: step.tool, result: checked ? "verified" : acted.detail });
    if (acted.undo) undos.push(acted.undo);
    if (!checked) {
      lines.push(statusLine("ask", `${step.target} did not match the postcondition.`));
      return finish(false, true, lines[lines.length - 1] ?? "Unverified.", "verify-failed");
    }
    lines.push(statusLine("done", `${step.kind} ${step.target}. ${step.undoHint}.`));
    return null;
  };

  const isReport = (value: StepResult | DesktopReport): value is DesktopReport =>
    "stoppedReason" in value && "evidence" in value;

  let index = 0;
  while (index < planned.actions.length) {
    const step = planned.actions[index]!;
    if (step.readOnly) {
      const batch: DesktopAction[] = [];
      while (index < planned.actions.length && planned.actions[index]?.readOnly) {
        batch.push(planned.actions[index]!);
        index += 1;
      }
      const results = await Promise.all(
        batch.map((item, offset) => runStep(item, index - batch.length + offset)),
      );
      for (let offset = 0; offset < results.length; offset += 1) {
        const value = results[offset]!;
        if (isReport(value)) return value;
        const stopped = record(batch[offset]!, index - batch.length + offset, value);
        if (stopped) return stopped;
      }
      continue;
    }
    const value = await runStep(step, index);
    if (isReport(value)) return value;
    const stopped = record(step, index, value);
    if (stopped) return stopped;
    index += 1;
  }

  return finish(true, false, lines[lines.length - 1] ?? "Done.", "");
}
