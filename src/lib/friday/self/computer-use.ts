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
  enabled?: boolean;
  patterns?: string[];
  selector?: string;
  children?: DeskControl[];
  stale?: boolean;
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
  slow?: boolean;
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
  slowHits: number;
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
  handoff?: "credential" | "payment" | "captcha" | "uac";
  truncated?: boolean;
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

const SECURE_WINDOW = /user account control|secure desktop|windows security|credential dialog/i;

const CLICK_PATTERNS = ["Invoke", "Toggle", "SelectionItem", "ExpandCollapse"] as const;

/** A control pattern wins. The mouse is the fallback. Secrets are never typed. */
export function preferPattern(
  control: { enabled?: boolean; role: string; patterns?: string[] },
  intent: "click" | "type" | "scroll",
): { via: "pattern" | "input" | "handoff" | "disabled"; pattern: string } {
  if (control.enabled === false) return { via: "disabled", pattern: "" };
  if (HANDOFF_ROLE.has(control.role)) return { via: "handoff", pattern: "" };
  const patterns = control.patterns ?? [];
  if (intent === "type") {
    return patterns.includes("Value")
      ? { via: "pattern", pattern: "Value" }
      : { via: "input", pattern: "input.type" };
  }
  if (intent === "scroll") {
    return patterns.includes("Scroll")
      ? { via: "pattern", pattern: "Scroll" }
      : { via: "input", pattern: "input.scroll" };
  }
  const found = CLICK_PATTERNS.find((name) => patterns.includes(name));
  return found ? { via: "pattern", pattern: found } : { via: "input", pattern: "input.click" };
}

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
    slowHits: seed?.slowHits ?? 0,
  };

  const perceive = async (at: number): Promise<Perception> => {
    state.readsInFlight += 1;
    state.maxReadsInFlight = Math.max(state.maxReadsInFlight, state.readsInFlight);
    await Promise.resolve();
    state.readsInFlight = Math.max(0, state.readsInFlight - 1);
    const focused =
      state.windows.find((window) => window.id === state.focusedId) ?? state.windows[0];
    const secure = state.windows.find((window) => SECURE_WINDOW.test(window.title));
    if (secure) {
      const handoff = /security|credential/i.test(secure.title) ? "credential" : "uac";
      return {
        source: "uia",
        confidence: 0.97,
        freshAt: at,
        generation: state.generation,
        untrusted: true,
        dpi: secure.dpi,
        monitor: secure.monitor,
        windows: [],
        text: "",
        handoff,
      };
    }
    const sight = focused?.sight ?? "vision";
    const source: PerceptionSource = !focused ? "none" : sight === "uia" ? "uia" : sight;
    const confidence =
      source === "uia" ? 0.92 : source === "ocr" ? 0.62 : source === "vision" ? 0.41 : 0;
    const text = (focused?.controls ?? []).map((control) => controlText(control)).join("\n");
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
          controls: flattenControls(window.controls),
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

function controlText(control: DeskControl): string {
  if (control.role === "password") return control.name;
  const own = `${control.name} ${control.value}`.trim();
  const nested = (control.children ?? []).map((child) => controlText(child)).join("\n");
  return [own, nested].filter(Boolean).join("\n");
}

function flattenControls(controls: DeskControl[]): DeskControl[] {
  const flat: DeskControl[] = [];
  for (const control of controls) {
    flat.push({
      ...control,
      bounds: { ...control.bounds },
      value: control.role === "password" ? "" : control.value,
    });
    if (control.children?.length) flat.push(...flattenControls(control.children));
  }
  return flat;
}

function cloneControl(control: DeskControl): DeskControl {
  return {
    ...control,
    bounds: { ...control.bounds },
    ...(control.children ? { children: control.children.map(cloneControl) } : {}),
  };
}

function cloneWindow(window: DeskWindow): DeskWindow {
  return {
    ...window,
    controls: window.controls.map(cloneControl),
  };
}

function findNamed(controls: DeskControl[], target: string): DeskControl | null {
  for (const control of controls) {
    const named = control.name.toLowerCase() === target.toLowerCase();
    const selected = control.selector === target;
    if (named || selected) return control;
    const nested = control.children ? findNamed(control.children, target) : null;
    if (nested) return nested;
  }
  return null;
}

function resolveControl(
  state: DeskState,
  target: string,
): { window: DeskWindow; control: DeskControl; problem?: "wrong-window" | "stale" } | null {
  const focused = state.focusedId
    ? state.windows.find((window) => window.id === state.focusedId)
    : state.windows[0];
  if (!focused) return null;
  const direct = findNamed(focused.controls, target);
  if (direct?.stale) return { window: focused, control: direct, problem: "stale" };
  if (direct) return { window: focused, control: direct };
  for (const window of state.windows) {
    if (window.id === focused.id) continue;
    const elsewhere = findNamed(window.controls, target);
    if (elsewhere) return { window, control: elsewhere, problem: "wrong-window" };
  }
  return null;
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

function notePace(state: DeskState, window: DeskWindow): void {
  if (window.slow) state.slowHits += 1;
}

function click(state: DeskState, step: DesktopAction, key: string): ActOutcome {
  const found = resolveControl(state, step.target);
  if (!found) return { ok: false, detail: "control missing" };
  if (found.problem === "wrong-window") return { ok: false, detail: "wrong window" };
  if (found.problem === "stale") return { ok: false, detail: "stale" };
  if (found.window.crashed) return { ok: false, detail: `${found.window.title} crashed` };
  notePace(state, found.window);
  if (HANDOFF_ROLE.has(found.control.role) || /user account control/i.test(found.window.title)) {
    return {
      ok: false,
      detail: `${found.control.name} needs the owner`,
      handoff: handoffKind(found.control.role),
    };
  }
  const choice = preferPattern(found.control, "click");
  if (choice.via === "disabled") return { ok: false, detail: "disabled" };
  if (choice.via === "handoff") {
    return {
      ok: false,
      detail: `${found.control.name} needs the owner`,
      handoff: handoffKind(found.control.role),
    };
  }
  const was = found.control.pressed;
  found.control.pressed = true;
  state.generation += 1;
  state.applied.push(key);
  return {
    ok: true,
    detail: `clicked ${found.control.name} via ${choice.pattern}`,
    undo: () => {
      found.control.pressed = was;
    },
  };
}

function typeInto(state: DeskState, step: DesktopAction, key: string): ActOutcome {
  const found = resolveControl(state, step.target);
  if (!found) return { ok: false, detail: "field missing" };
  if (found.problem === "wrong-window") return { ok: false, detail: "wrong window" };
  if (found.problem === "stale") return { ok: false, detail: "stale" };
  notePace(state, found.window);
  if (HANDOFF_ROLE.has(found.control.role)) {
    return {
      ok: false,
      detail: `${found.control.name} needs the owner`,
      handoff: handoffKind(found.control.role),
    };
  }
  const choice = preferPattern(found.control, "type");
  if (choice.via === "disabled") return { ok: false, detail: "disabled" };
  if (choice.via === "handoff") {
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
    detail: `typed into ${found.control.name} via ${choice.pattern}`,
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

function sourceOf(value: unknown): PerceptionSource {
  if (value === "uia" || value === "ocr" || value === "vision" || value === "none") return value;
  return "uia";
}

function handoffOf(value: unknown): Perception["handoff"] | null {
  if (value === "credential" || value === "payment" || value === "captcha" || value === "uac") {
    return value;
  }
  return null;
}

function windowsOf(value: unknown): Perception["windows"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const window = row as Record<string, unknown>;
    const controls = Array.isArray(window["controls"])
      ? window["controls"].flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const control = item as Record<string, unknown>;
          const bounds = control["bounds"];
          const box =
            bounds && typeof bounds === "object"
              ? (bounds as Record<string, unknown>)
              : { x: 0, y: 0, w: 0, h: 0 };
          const role = String(control["role"] || "text");
          const known = (
            ["button", "edit", "text", "password", "payment", "captcha", "uac"] as const
          ).find((item) => item === role);
          return [
            {
              id: String(control["id"] || control["selector"] || control["name"] || "control"),
              role: known ?? "text",
              name: String(control["name"] || ""),
              value: known === "password" ? "" : String(control["value"] || ""),
              bounds: {
                x: Number(box["x"] || 0),
                y: Number(box["y"] || 0),
                w: Number(box["w"] || 0),
                h: Number(box["h"] || 0),
              },
            },
          ];
        })
      : [];
    return [
      {
        id: String(window["id"] || window["title"] || "window"),
        title: String(window["title"] || ""),
        controls,
      },
    ];
  });
}

function perceptionFromTool(result: Record<string, unknown> | null, at: number): Perception {
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
  const handoff = handoffOf(result["handoff"]);
  const seen: Perception = {
    source: sourceOf(result["source"]),
    confidence: typeof result["confidence"] === "number" ? result["confidence"] : 0.5,
    freshAt: typeof result["freshAt"] === "number" ? result["freshAt"] : at,
    generation: 1,
    untrusted: true,
    dpi: typeof result["dpi"] === "number" ? result["dpi"] : 96,
    monitor: typeof result["monitor"] === "number" ? result["monitor"] : 1,
    windows: handoff ? [] : windowsOf(result["windows"]),
    text: handoff ? "" : String(result["text"] || ""),
  };
  if (handoff) seen.handoff = handoff;
  if (result["truncated"] === true) seen.truncated = true;
  return seen;
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
    slowHits: 0,
  };
  return {
    state,
    async perceive(at: number): Promise<Perception> {
      const result = await kernelApi.tools.exec("screen.perceive", {});
      return perceptionFromTool(result, at);
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
      if (before.handoff) {
        lines.push(statusLine("handoff", "A secure prompt needs the owner."));
        audit.push({ at: now(), action: step.tool, result: `handoff:${before.handoff}` });
        return finish(
          false,
          true,
          lines[lines.length - 1] ?? "Handoff.",
          `handoff:${before.handoff}`,
        );
      }
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
