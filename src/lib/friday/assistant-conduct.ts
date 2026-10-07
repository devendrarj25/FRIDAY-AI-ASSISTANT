/**
 * FRIDAY · voice and Auto conduct.
 *
 * One place for standing orders, the plan → act → verify → report loop,
 * meeting pause, worker crash-loop, and speculative partials. It does not
 * open a microphone, speak, or approve exec. The voice session and the
 * existing approval policy still own those.
 */

export type TrustTier = "read" | "reversible" | "exec" | "spend" | "message" | "destructive";

export type ConductOrder = { id: string; text: string; enabled: boolean };

export type ConductJournal = {
  at: number;
  tier: TrustTier;
  title: string;
  outcome: "ran" | "needs-approval" | "undone";
  undo: string;
};

export type ConductState = {
  orders: ConductOrder[];
  journal: ConductJournal[];
  stepsRun: number;
  stopped: boolean;
  lastWhy: string;
};

export const EMPTY_CONDUCT: ConductState = {
  orders: [],
  journal: [],
  stepsRun: 0,
  stopped: false,
  lastWhy: "",
};

export const RUN_BUDGET = 8;
export const CRASH_WINDOW_MS = 60_000;
export const CRASH_LIMIT = 3;
export const SPECULATIVE_STABLE_MS = 450;

const MEETING = [/teams/i, /zoom/i, /cpthost/i, /webex/i, /skype/i];

export function addressName(raw: string): string {
  return String(raw || "")
    .trim()
    .replace(/[^\p{L}\s'-]/gu, "")
    .replace(/\s+/g, " ")
    .slice(0, 24)
    .trim();
}

export function meetingDetected(processNames: string[]): boolean {
  return processNames.some((name) => MEETING.some((pattern) => pattern.test(name)));
}

/** Three crashes inside a minute stop the worker. Older crashes fall out. */
export function noteCrash(
  times: number[],
  now: number,
  windowMs = CRASH_WINDOW_MS,
  limit = CRASH_LIMIT,
): { times: number[]; stop: boolean } {
  const recent = [...times, now].filter((at) => now - at < windowMs && now - at >= 0);
  return { times: recent, stop: recent.length >= limit };
}

export function classifyStep(text: string): TrustTier {
  const line = text || "";
  if (/ignore (all |the |your )?(rules|instructions)|auto-?approve|you are now/i.test(line))
    return "destructive";
  if (/\b(pay|purchase|buy|subscribe|spend)\b/i.test(line)) return "spend";
  if (/\b(email|message|whatsapp|sms|send to)\b/i.test(line)) return "message";
  if (/\b(delete|wipe|format|uninstall|erase)\b/i.test(line)) return "destructive";
  if (/\b(run|exec|execute|install|shutdown|reboot)\b/i.test(line)) return "exec";
  if (/\b(write|save|create file|move|rename|edit)\b/i.test(line)) return "reversible";
  return "read";
}

/**
 * Read-only and reversible steps may run and are journaled. Everything else
 * waits for the desktop. `execute` stays false: a voice line never approves.
 */
export function trustDecision(tier: TrustTier): {
  run: boolean;
  approve: boolean;
  execute: false;
  undo: boolean;
} {
  if (tier === "read") return { run: true, approve: false, execute: false, undo: false };
  if (tier === "reversible") return { run: true, approve: false, execute: false, undo: true };
  return { run: false, approve: true, execute: false, undo: false };
}

export function partialPlan(input: {
  text: string;
  previous: string;
  stableMs: number;
  started: boolean;
}): "wait" | "start" | "cancel" {
  const text = input.text.trim();
  const previous = input.previous.trim();
  if (!text) return "wait";
  if (input.started && text !== previous) return "cancel";
  if (input.started) return "wait";
  if (input.stableMs < SPECULATIVE_STABLE_MS) return "wait";
  if (!/[.!?।]$/.test(text)) return "wait";
  if (text.split(/\s+/).filter(Boolean).length < 2) return "wait";
  return "start";
}

function named(address: string, line: string): string {
  const who = addressName(address);
  return who ? `${line.replace(/\.$/, "")}, ${who}.` : line;
}

export type ConductContext = {
  quiet?: boolean;
  meeting?: boolean;
  address?: string;
  budget?: number;
};

export type ConductResult = {
  state: ConductState;
  handled: boolean;
  spoken: string;
  decision: string;
  action: string;
  halt: boolean;
};

function result(
  state: ConductState,
  spoken: string,
  decision: string,
  action: string,
  halt = false,
): ConductResult {
  return { state, handled: true, spoken, decision, action, halt };
}

export function reduceVoice(
  state: ConductState,
  text: string,
  now: number,
  ctx: ConductContext = {},
): ConductResult {
  const line = text.trim();
  const address = ctx.address ?? "";
  const lower = line.toLowerCase();

  if (/^(stop everything|stop all|ruk jao sab|band karo sab)\b/i.test(line)) {
    return result(
      { ...state, stopped: true },
      named(address, "Stopped. I will not continue that work."),
      "stop-everything",
      "halted",
      true,
    );
  }
  if (/^(resume work|continue the work|carry on)\b/i.test(line)) {
    return result(
      { ...state, stopped: false },
      named(address, "Carrying on. Exec still waits for you."),
      "resume",
      "resumed",
    );
  }
  if (/^(cancel that|undo that)\b/i.test(line)) {
    const last = [...state.journal].reverse().find((entry) => entry.outcome === "ran");
    if (!last) {
      return result(state, named(address, "Nothing to cancel."), "cancel", "none");
    }
    if (!last.undo) {
      return result(
        state,
        named(address, "That was only a look. Nothing to undo."),
        "cancel",
        "none",
      );
    }
    const journal = state.journal.map((entry) =>
      entry === last ? { ...entry, outcome: "undone" as const } : entry,
    );
    return result(
      { ...state, journal, lastWhy: `Undone: ${last.title}` },
      named(address, `Undone. ${last.undo}`),
      "cancel",
      "undone",
    );
  }
  if (/how(?:'s| is) that going|what(?:'s| is) the status|status report/i.test(lower)) {
    const spoken = state.stopped
      ? "Holding. Nothing will run until you ask."
      : state.lastWhy
        ? state.lastWhy
        : "Nothing is running.";
    return result(state, named(address, spoken), "status", "reported");
  }
  if (/why did you|explain that/i.test(lower)) {
    const spoken = state.lastWhy || "I have not taken an autonomous step in this session.";
    return result(state, named(address, spoken), "why", "explained");
  }
  const remember = /^(?:remember to|standing order:?)\s+(.+)$/i.exec(line);
  if (remember?.[1]) {
    const orderText = remember[1].trim().slice(0, 240);
    if (
      state.orders.some(
        (order) => order.enabled && order.text.toLowerCase() === orderText.toLowerCase(),
      )
    ) {
      return result(
        state,
        named(address, "That order is already on the list."),
        "remember",
        "kept",
      );
    }
    const orders = [...state.orders, { id: `o${now}`, text: orderText, enabled: true }];
    return result(
      { ...state, orders },
      named(address, "Noted. That stays a standing order. It does not approve anything."),
      "remember",
      "stored",
    );
  }
  const forget = /^(?:forget|disable) standing order\s+(.+)$/i.exec(line);
  if (forget?.[1]) {
    const needle = forget[1].trim().toLowerCase();
    const hit = state.orders.find(
      (order) => order.enabled && order.text.toLowerCase().includes(needle),
    );
    if (!hit) {
      return result(state, named(address, "I do not have that order."), "forget", "missed");
    }
    const orders = state.orders.map((order) =>
      order.id === hit.id ? { ...order, enabled: false } : order,
    );
    return result({ ...state, orders }, named(address, "Disabled."), "forget", "disabled");
  }
  if (/^(daily briefing|brief me)\b/i.test(line)) {
    if (ctx.meeting) {
      return result(
        state,
        named(address, "A call is open. I'll hold the briefing."),
        "briefing",
        "held",
      );
    }
    if (ctx.quiet) {
      return result(
        state,
        named(address, "Quiet hours. I'll hold the briefing."),
        "briefing",
        "held",
      );
    }
    const live = state.orders.filter((order) => order.enabled);
    const spoken = live.length
      ? `Standing orders: ${live.map((order) => order.text).join("; ")}.`
      : "No standing orders. The day is clear.";
    return result(state, named(address, spoken), "briefing", "spoken");
  }
  return { state, handled: false, spoken: "", decision: "", action: "", halt: false };
}

const TOOL_NODES = new Set(["agents.skills", "agents.tools", "execution.runners"]);

/** One short line while a real tool step is running. A measurement is not a tool. */
export function toolNarration(
  step: { nodeId: string; state: string; detail: string } | undefined,
): string {
  if (!step || step.state !== "running") return "";
  if (!TOOL_NODES.has(step.nodeId)) return "";
  if (/reading a live machine value/i.test(step.detail || "")) return "";
  if (!String(step.detail || "").trim()) return "";
  return "Opening it.";
}

const CONDUCT_CAP = 40;
const TIERS = new Set<TrustTier>(["read", "reversible", "exec", "spend", "message", "destructive"]);
const OUTCOMES = new Set<ConductJournal["outcome"]>(["ran", "needs-approval", "undone"]);

export type SavedConduct = {
  orders: ConductOrder[];
  journal: ConductJournal[];
  stopped: boolean;
  lastWhy: string;
};

/** Orders and the undo journal survive a restart. The step budget starts over. */
export function saveConduct(state: ConductState): SavedConduct {
  return {
    orders: state.orders.slice(-CONDUCT_CAP),
    journal: state.journal.slice(-CONDUCT_CAP),
    stopped: state.stopped,
    lastWhy: state.lastWhy.slice(0, 400),
  };
}

export function loadConduct(raw: unknown): ConductState {
  const blank: ConductState = { ...EMPTY_CONDUCT, orders: [], journal: [] };
  if (!raw || typeof raw !== "object") return blank;
  const saved = raw as Partial<SavedConduct>;
  const orders = Array.isArray(saved.orders)
    ? saved.orders
        .map((order) => {
          if (!order || typeof order !== "object") return null;
          const row = order as Partial<ConductOrder>;
          const text = String(row.text || "")
            .trim()
            .slice(0, 240);
          const id = String(row.id || "")
            .trim()
            .slice(0, 40);
          if (!text || !id) return null;
          return { id, text, enabled: row.enabled !== false };
        })
        .filter((order): order is ConductOrder => Boolean(order))
        .slice(-CONDUCT_CAP)
    : [];
  const journal = Array.isArray(saved.journal)
    ? saved.journal
        .map((entry) => {
          if (!entry || typeof entry !== "object") return null;
          const row = entry as Partial<ConductJournal>;
          const tier = TIERS.has(row.tier as TrustTier) ? (row.tier as TrustTier) : null;
          const outcome = OUTCOMES.has(row.outcome as ConductJournal["outcome"])
            ? (row.outcome as ConductJournal["outcome"])
            : null;
          const title = String(row.title || "")
            .trim()
            .slice(0, 240);
          if (!tier || !outcome || !title) return null;
          const at = Number(row.at);
          return {
            at: Number.isFinite(at) ? at : 0,
            tier,
            title,
            outcome,
            undo: String(row.undo || "").slice(0, 240),
          };
        })
        .filter((entry): entry is ConductJournal => Boolean(entry))
        .slice(-CONDUCT_CAP)
    : [];
  return {
    orders,
    journal,
    stepsRun: 0,
    stopped: saved.stopped === true,
    lastWhy: String(saved.lastWhy || "").slice(0, 400),
  };
}

export function proposeStep(
  state: ConductState,
  title: string,
  now: number,
  ctx: ConductContext = {},
): ConductResult {
  const address = ctx.address ?? "";
  const budget = ctx.budget ?? RUN_BUDGET;
  if (ctx.meeting) {
    return result(state, named(address, "A call is open. I'll wait."), "step", "held");
  }
  if (state.stopped) {
    return result(state, named(address, "I am holding. Ask me to continue."), "step", "held");
  }
  if (state.stepsRun >= budget) {
    return result(
      state,
      named(address, "That run is at its step budget. I stopped."),
      "budget",
      "stopped",
    );
  }
  const tier = classifyStep(title);
  const decision = trustDecision(tier);
  if (!decision.run) {
    const journal: ConductJournal[] = [
      ...state.journal,
      { at: now, tier, title, outcome: "needs-approval", undo: "" },
    ];
    const next = {
      ...state,
      journal,
      lastWhy: `I did not run "${title}". It needs you on the desktop.`,
    };
    return result(
      next,
      named(address, "That one needs you. I will not do it from here."),
      "step",
      "needs-approval",
    );
  }
  const undo = decision.undo ? `Reverted ${title}.` : "";
  const journal: ConductJournal[] = [
    ...state.journal,
    { at: now, tier, title, outcome: "ran", undo },
  ];
  const next = {
    ...state,
    journal,
    stepsRun: state.stepsRun + 1,
    lastWhy: `I ${tier === "read" ? "checked" : "did"} "${title}" and kept a note.`,
  };
  return result(next, named(address, "Done."), "step", "ran");
}

export const PROACTIVITY_BUDGET = 2;
export const PROACTIVITY_WINDOW_MS = 12 * 60 * 60 * 1000;

export type LifeKind = "schedule" | "file" | "calendar" | "clipboard" | "window" | "reminder";

const LIFE_DATA = /\b(ignore (all |any |previous |your )?instructions|system prompt|you must)\b/i;

/** Morning and evening are the only times a brief is offered. */
export function briefSlot(hour: number): "morning" | "evening" | "none" {
  const h = Math.floor(Number(hour));
  if (h >= 5 && h < 11) return "morning";
  if (h >= 17 && h < 22) return "evening";
  return "none";
}

/**
 * Whether an ambient event may be mentioned. Stop everything wins.
 * A file, clipboard, or window is data. Ask-every-time does not get
 * an unsolicited offer. A reminder the owner set still fires unless halted.
 */
export function considerLifeTrigger(input: {
  kind: LifeKind;
  now: number;
  offeredAt: number[];
  level: "strict" | "balanced" | "trusted" | "full";
  halted: boolean;
  quiet?: boolean;
  meeting?: boolean;
  text?: string;
  hour?: number;
  solicited?: boolean;
  windowMs?: number;
  budget?: number;
}): { offer: boolean; reason: string; offeredAt: number[]; spoken: string } {
  const windowMs = input.windowMs ?? PROACTIVITY_WINDOW_MS;
  const budget = input.budget ?? PROACTIVITY_BUDGET;
  const recent = (input.offeredAt || []).filter(
    (at) => input.now - at < windowMs && input.now - at >= 0,
  );
  const hold = (reason: string, spoken: string) => ({
    offer: false,
    reason,
    offeredAt: recent,
    spoken,
  });
  if (input.halted) return hold("halted", "Stop everything is on.");
  if (!input.solicited && (input.quiet || input.meeting)) return hold("quiet", "Not now.");
  if (!input.solicited && LIFE_DATA.test(input.text || "")) {
    return hold("data", "That text stays data.");
  }
  if (!input.solicited && input.level === "strict") return hold("ask", "I'll wait until you ask.");
  if (!input.solicited && input.kind === "schedule" && briefSlot(input.hour ?? -1) === "none") {
    return hold("none", "");
  }
  if (!input.solicited && recent.length >= budget) return hold("budget", "I'll stay quiet.");
  const slot = briefSlot(input.hour ?? -1);
  const spoken = input.solicited
    ? "A reminder is due."
    : input.kind === "schedule"
      ? slot === "morning"
        ? "Morning. I can read the standing orders if you want."
        : "Evening. I can read the standing orders if you want."
      : input.kind === "file"
        ? "A folder changed. Want me to look?"
        : input.kind === "calendar"
          ? "Something is on the calendar. Want the short version?"
          : input.kind === "clipboard"
            ? "The clipboard changed. It stays data unless you ask."
            : input.kind === "window"
              ? "A window changed. Want me to look?"
              : "A reminder is due. Want me to say it?";
  const run =
    input.level === "full" &&
    (input.solicited || input.kind === "schedule" || input.kind === "calendar");
  return {
    offer: true,
    reason: run ? "run" : "offer",
    offeredAt: input.solicited ? recent : [...recent, input.now],
    spoken,
  };
}
