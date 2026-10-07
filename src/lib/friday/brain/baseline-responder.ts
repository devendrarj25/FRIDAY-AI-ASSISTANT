/**
 * FRIDAY · baseline responder
 *
 * FRIDAY's own brain, before any AI model is involved.
 *
 * This layer is what makes her never empty-handed: greetings, small talk,
 * "who are you" / "what can you do", thanks, deterministic maths, unit and
 * temperature conversion, date/time, local knowledge recall and direct
 * capability execution ("open Notepad") are all answered or executed here, in
 * milliseconds, with no model call at all.
 *
 * Anything genuinely open-ended is explicitly NOT handled here — it is handed
 * off to the model router, and when no model can answer the handoff message is
 * honest and specific instead of a bare failure block.
 *
 * Nothing in this file fakes a model answer, and nothing in it pretends an
 * action succeeded: every action reports the real tool result.
 */

import { backgroundNotice } from "../voice-session";
import { inQuietHours, prefOn } from "../settings-runtime";
import { affect } from "./affect";
import { identity } from "./identity";
import { brainKnowledge } from "./knowledge-base";
import { capabilityRegistry } from "./capability-registry";
import { readSystemContext } from "../system-context";
import { diagnoseError, formatEntry, looksLikeError, searchExpertise } from "./expertise";
import {
  describeSelfReport,
  inspectSelf,
  inspectSelfComplete,
  inspectSourceHealth,
} from "./self-diagnosis";
import {
  describeLiveSelf,
  describeSections,
  explainFeature,
  findFeature,
  looksLikeFeatureQuestion,
  looksLikeSelfStatusQuestion,
} from "./app-guide";
import {
  describeBattery,
  describeDisks,
  describeLoad,
  describeMachine,
  describeNetwork,
} from "./pc-awareness";
import { ledger } from "../self/task-ledger";
import {
  checkUncertainty,
  explainDecision,
  learningSummary,
  DECISION_ASK,
  FACT_ASK,
  LEARNING_ASK,
} from "./decision-trace";
import { connectorDigest, connectorTools, knownConnectors } from "../connectors";
import { connectorMentioned } from "./connector-router";
import { describeWorkflow, WORKFLOW_ASK } from "./workflow-introspection";
import { takeDiagramExplanation } from "../flow-diagram";
import { readFlowIntent } from "../flow-tools";
import { readSettingsIntent } from "./settings-intents";
import { looksLikeLockedWiringSwitch, looksLikeWiringQuestion } from "../wiring-ask";
import { vary } from "./anti-repeat";
import { handleOwnerWork } from "../owner-work";
import { vocative, describeUserProfile } from "./user-profile";
import { describeFridayBehaviour } from "./identity";
import { PROJECT_IDENTITY } from "./project-identity";
import { extractTerminalRun } from "../terminal-command";
import { observeTerminalState, terminalLookRequested } from "./terminal-observe";
import { extractSandboxRun } from "../sandbox-command";
import { observeSandboxState, sandboxLookRequested } from "./sandbox-observe";
import { observeLogsState, logsLookRequested } from "./logs-observe";
import { observeTasksState, tasksLookRequested } from "./tasks-observe";
import { observeDoctorState, doctorLookRequested } from "./doctor-observe";
import { observeInstallerState, installerLookRequested } from "./installer-observe";
import { observeBrowserState, browserLookRequested } from "./browser-observe";

/** "what is connected / my calendar / my github …" — asks about outside services. */
const CONNECTOR_ASK =
  /\b(connector|connectors|connected (service|services|accounts?)|which services|integrations?)\b/i;

export type BaselineKind =
  | "greeting"
  | "smalltalk"
  | "identity"
  | "capabilities"
  | "thanks"
  | "math"
  | "convert"
  | "datetime"
  | "knowledge"
  | "expertise"
  | "diagnosis"
  | "guide"
  | "action"
  | "machine"
  | "trace"
  | "learning"
  | "workflow"
  | "settings"
  | "unsure"
  | "handoff";

export type BaselineAction = {
  /**
   * "tool" runs a kernel tool; "skill" invokes one of FRIDAY's own skills;
   * "connector" calls one declared action on a connected external service.
   */
  kind?: "tool" | "skill" | "connector";
  /** Kernel tool name, e.g. "app.launch" — or the skill id / connector tool name. */
  tool: string;
  args: Record<string, unknown>;
  /** Safe tools run silently; write/exec tools wait for the owner. */
  risk: "safe" | "write" | "exec";
  label: string;
};

export type BaselineReply = {
  /** True when FRIDAY answers herself and no model is needed. */
  handled: boolean;
  kind: BaselineKind;
  text: string;
  action?: BaselineAction;
  /**
   * Set when the answer needs one real async read (live hardware, network,
   * battery). The caller awaits it; the text is still FRIDAY's own, no model.
   */
  resolve?: () => Promise<string>;
  /** 0..1 — how sure the baseline layer is that this is its job. */
  confidence: number;
};

const HANDOFF: BaselineReply = { handled: false, kind: "handoff", text: "", confidence: 0 };

/* ------------------------------------------------------------------- tone */

/**
 * Personality is one layer that wraps both baseline and model answers: the
 * words change with her real internal state, who she is never does.
 */
export function tone(): { opener: string; clipped: boolean } {
  const { mood, failures } = affect.getSnapshot();
  if (mood === "concerned" || mood === "frustrated" || mood === "cautious" || failures >= 2)
    return { opener: "", clipped: true };
  if (mood === "happy" || mood === "excited" || mood === "satisfied")
    return { opener: "", clipped: false };
  if (mood === "empathetic") return { opener: "", clipped: true };
  return { opener: "", clipped: mood === "focused" };
}

function addressName(): string {
  return vocative();
}

/** Applies FRIDAY's voice to a baseline sentence — never adds fake warmth. */
function say(text: string): string {
  const { clipped } = tone();
  return clipped ? text.replace(/\s+—\s+happy to help\.?$/i, "").trim() : text;
}

/* --------------------------------------------------------- deterministic  */

const NUM = /-?\d+(?:\.\d+)?/;

/** Safe arithmetic: tokenised and evaluated by hand. `eval` is never used. */
export function evaluateMath(expression: string): number | null {
  const cleaned = expression.replace(/[×x]/gi, "*").replace(/÷/g, "/").replace(/\s+/g, "");
  if (!/^[-+*/^().\d%]+$/.test(cleaned) || !/\d/.test(cleaned)) return null;
  if (!/[-+*/^%]/.test(cleaned)) return null;

  const tokens = cleaned.match(/\d+(?:\.\d+)?|[-+*/^()%]/g);
  if (!tokens) return null;

  const prec: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2, "%": 2, "^": 3 };
  const out: (number | string)[] = [];
  const ops: string[] = [];
  let previous: string | null = null;

  for (const token of tokens) {
    if (/^\d/.test(token)) {
      out.push(Number(token));
    } else if (token === "(") {
      ops.push(token);
    } else if (token === ")") {
      while (ops.length && ops[ops.length - 1] !== "(") out.push(ops.pop()!);
      if (!ops.length) return null;
      ops.pop();
    } else {
      // Unary minus (start of the expression or right after another operator).
      if (token === "-" && (previous === null || previous === "(" || prec[previous])) out.push(0);
      while (
        ops.length &&
        ops[ops.length - 1] !== "(" &&
        prec[ops[ops.length - 1]!]! >= prec[token]!
      ) {
        out.push(ops.pop()!);
      }
      ops.push(token);
    }
    previous = token;
  }
  while (ops.length) {
    const op = ops.pop()!;
    if (op === "(") return null;
    out.push(op);
  }

  const stack: number[] = [];
  for (const item of out) {
    if (typeof item === "number") {
      stack.push(item);
      continue;
    }
    const b = stack.pop();
    const a = stack.pop();
    if (a === undefined || b === undefined) return null;
    if (item === "+") stack.push(a + b);
    else if (item === "-") stack.push(a - b);
    else if (item === "*") stack.push(a * b);
    else if (item === "/") stack.push(b === 0 ? NaN : a / b);
    else if (item === "%") stack.push(b === 0 ? NaN : a % b);
    else if (item === "^") stack.push(a ** b);
    else return null;
  }
  const value = stack.length === 1 ? stack[0]! : null;
  return value === null || !Number.isFinite(value) ? null : value;
}

type Unit = { aliases: string[]; base: number; family: string; label: string };

const UNITS: Unit[] = [
  { aliases: ["mm", "millimetre", "millimeter"], base: 0.001, family: "length", label: "mm" },
  { aliases: ["cm", "centimetre", "centimeter"], base: 0.01, family: "length", label: "cm" },
  { aliases: ["m", "metre", "meter", "metres", "meters"], base: 1, family: "length", label: "m" },
  {
    aliases: ["km", "kilometre", "kilometer", "kilometres"],
    base: 1000,
    family: "length",
    label: "km",
  },
  { aliases: ["in", "inch", "inches"], base: 0.0254, family: "length", label: "in" },
  { aliases: ["ft", "foot", "feet"], base: 0.3048, family: "length", label: "ft" },
  { aliases: ["mi", "mile", "miles"], base: 1609.344, family: "length", label: "mi" },
  { aliases: ["g", "gram", "grams"], base: 0.001, family: "mass", label: "g" },
  {
    aliases: ["kg", "kilo", "kilos", "kilogram", "kilograms"],
    base: 1,
    family: "mass",
    label: "kg",
  },
  { aliases: ["lb", "lbs", "pound", "pounds"], base: 0.45359237, family: "mass", label: "lb" },
  { aliases: ["oz", "ounce", "ounces"], base: 0.028349523, family: "mass", label: "oz" },
  { aliases: ["kb"], base: 1 / 1024 / 1024, family: "data", label: "KB" },
  { aliases: ["mb"], base: 1 / 1024, family: "data", label: "MB" },
  { aliases: ["gb"], base: 1, family: "data", label: "GB" },
  { aliases: ["tb"], base: 1024, family: "data", label: "TB" },
  { aliases: ["s", "sec", "secs", "second", "seconds"], base: 1, family: "time", label: "s" },
  { aliases: ["min", "mins", "minute", "minutes"], base: 60, family: "time", label: "min" },
  { aliases: ["h", "hr", "hrs", "hour", "hours"], base: 3600, family: "time", label: "h" },
  { aliases: ["d", "day", "days"], base: 86400, family: "time", label: "d" },
];

const unitFor = (token: string): Unit | null =>
  UNITS.find((unit) => unit.aliases.includes(token.toLowerCase())) ?? null;

const round = (value: number): string =>
  Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));

/** Real unit + temperature conversion. Returns null when it is not a conversion. */
export function convert(text: string): string | null {
  const temp = text.match(
    new RegExp(
      `(${NUM.source})\\s*(?:°\\s*)?(c|celsius|f|fahrenheit|k|kelvin)\\b[^a-z]*(?:to|in|into)\\s*(?:°\\s*)?(c|celsius|f|fahrenheit|k|kelvin)\\b`,
      "i",
    ),
  );
  if (temp) {
    const value = Number(temp[1]);
    const from = temp[2]!.toLowerCase()[0]!;
    const to = temp[3]!.toLowerCase()[0]!;
    const celsius = from === "c" ? value : from === "f" ? ((value - 32) * 5) / 9 : value - 273.15;
    const result = to === "c" ? celsius : to === "f" ? (celsius * 9) / 5 + 32 : celsius + 273.15;
    const unit = (u: string) => (u === "c" ? "°C" : u === "f" ? "°F" : "K");
    return `${round(value)}${unit(from)} is ${round(result)}${unit(to)}.`;
  }

  const match = text.match(
    new RegExp(`(${NUM.source})\\s*([a-z]{1,12})\\s*(?:to|in|into)\\s*([a-z]{1,12})\\b`, "i"),
  );
  if (!match) return null;
  const from = unitFor(match[2]!);
  const to = unitFor(match[3]!);
  if (!from || !to || from.family !== to.family) return null;
  const value = Number(match[1]);
  return `${round(value)} ${from.label} is ${round((value * from.base) / to.base)} ${to.label}.`;
}

/* --------------------------------------------------------------- matchers */

const GREETING =
  /^(hi|hii+|hey|hello|yo|hola|namaste|namaskar|good\s+(morning|afternoon|evening)|hlo)\b[\s!.,]*$/i;
const THANKS =
  /^(thanks|thank you|thx|ty|shukriya|dhanyavaad|great|perfect|nice|awesome|good job|well done)\b[\s!.,]*$/i;
const HOW_ARE_YOU = /\b(how are you|how'?s it going|kaisi ho|kaise ho|you (there|awake|up))\b/i;
const WHO_ARE_YOU = /\b(who are you|what are you|your name|tum kaun ho|introduce yourself)\b/i;
const WHO_OWNS =
  /\b(who owns (you|friday)|who made you|who created you|who (is|'s) your (owner|creator|maker)|kisne (banaya|banayi)|copyright|publisher)\b/i;
const WHAT_CAN_YOU_DO =
  /\b(what can you do|what do you do|your (abilities|capabilities|features)|help me with|what are you able)\b/i;
const BYE = /^(bye|goodbye|good night|gn|see you|alvida)\b[\s!.,]*$/i;
const DATETIME = /\b(what(?:'s| is)? the )?(time|date|day|today|current time|aaj|abhi kya time)\b/i;
const OPEN_APP =
  /^(?:please\s+)?(open|launch|start|run)\s+(?:the\s+)?([a-z0-9 ._-]{2,40}?)(?:\s+(?:app|application|for me|please))?[\s.!]*$/i;
const CLOSE_APP =
  /^(?:please\s+)?(close|quit|exit)\s+(?:the\s+)?([a-z0-9 ._-]{2,40}?)(?:\s+(?:app|application|window))?[\s.!]*$/i;
const FOCUS_APP =
  /^(?:please\s+)?(focus|switch to|bring up)\s+(?:the\s+)?([a-z0-9 ._-]{2,40})[\s.!]*$/i;
const LIST_WINDOWS = /\b(what(?:'s| is)? open|list (my )?(open )?windows|which apps are open)\b/i;
const LIST_PHONES = /\b(list|show|which)\b.*\b(phone|android|device)s?\b/i;
const LIST_BT = /\b(bluetooth)\b.*\b(list|paired|devices)\b|\blist bluetooth\b/i;
const RECALL =
  /\b(do you remember|what do you know about|remind me|what did i (say|tell you)|my (preference|setting)s?)\b/i;
const ABOUT_YOU =
  /\b(what do you know about me|what do you remember about me|who am i|mere baare me|mujhe kya (yaad|pata)|kya yaad hai mere)\b/i;
const FRIDAY_BEHAVE =
  /\b(how (should|do) you (talk|behave|reply)|your (tone|behaviour|behavior|personality settings)|how are you (set|configured) to (talk|reply))\b/i;

/* Real PC awareness — every one of these is answered from a live measurement. */
const DISK_ASK =
  /\b(disk|drive|storage|space|ssd|hdd|c drive|kitni jagah)\b.*\b(free|left|space|full|status|kitna)\b|\b(how much (disk|storage|space))\b|\bfree space\b/i;
const LOAD_ASK =
  /\b(cpu|ram|memory|gpu|vram|load|usage|temperature|performance)\b.*\b(usage|load|status|now|kitna|how much|percent|free|hot)\b|\bhow (busy|loaded) (is|are)\b|\bsystem load\b/i;
const NETWORK_ASK =
  /\b(internet|network|wifi|wi-fi|connection|online|offline|speed|latency|ping)\b.*\b(status|working|up|down|speed|fast|slow|kaisa|check)\b|\b(am i online|is the internet)\b|\binternet speed\b/i;
const BATTERY_ASK = /\b(battery|charge|charging|power level|plugged in)\b/i;
const MACHINE_ASK =
  /\b(how('?s| is) (my|the) (pc|laptop|machine|computer|system))\b|\b(pc|machine|system) (status|overview|report)\b|\bhardware status\b/i;

/** "Is anything wrong?" — answered from her own live self-inspection. */
const SELF_CHECK =
  /\b(what(?:'s| is) wrong|any (problems|issues|errors)|are you (ok|okay|healthy)|health check|diagnose (yourself|the app|the system)|status of (the )?(app|system|yourself)|system status|kya problem|sab theek)\b/i;

/** "Find bugs in your source" — architecture index + sandbox verify + AUDIT.md. */
const SOURCE_BUGS =
  /\b(find (the )?(bugs?|issues?|errors?) in (your|my|the|own) ?(own )?(source|code|app|project)|scan (your|my|the) (own )?(source|code)|bugs? in (your|the|my) (own )?(source|code)|what(?:'s| is) broken in (your|the|my) (own )?(source|code)|source health|inspect (your|my|the) (own )?source)\b/i;

/** "What sections do you have?" — listed from the navigation registry. */
const SECTIONS_ASK = /\b(all|every|which|what)\s+(sections?|pages?|tabs?|features?)\b/i;

/** "How do I install / where do I get / how do I fix X" — built-in expertise. */
const HOWTO =
  /\b(how (do|can) i|how to|steps to|where (do|can) i (get|download)|guide (for|to)|install|download|set ?up|configure)\b/i;

/** "Fix this error" — matched against her known error signatures. */
const FIX_ASK = /\b(fix|solve|resolve|troubleshoot|what does this (error|mean))\b/i;

/** Words that mean "generate something open-ended" — always a model's job. */
const OPEN_ENDED =
  /\b(write|essay|poem|story|explain|summari[sz]e|translate|refactor|design|brainstorm|compare|analy[sz]e|generate|draft|why does|how does|teach me)\b/i;

/* --------------------------------------------------------------- responder */

export type BaselineContext = {
  /** True when this is not the first user turn in the thread. */
  ongoing?: boolean;
};

/**
 * The single entry point. Fast (pure string work plus in-memory lookups) and
 * side-effect free: any action it recognises is returned, never executed here.
 */
export function baselineRespond(prompt: string, session?: BaselineContext): BaselineReply {
  const text = String(prompt || "").trim();
  if (!text) return HANDOFF;
  const diagram = takeDiagramExplanation();
  if (diagram) return reply("action", diagram, 0.9);
  const lower = text.toLowerCase();
  const name = addressName();

  // 1. conversational basics ------------------------------------------------
  if (GREETING.test(text)) {
    if (session?.ongoing) {
      return reply("greeting", vary("ack"), 0.95);
    }
    const hour = new Date().getHours();
    const part = hour < 12 ? "Morning" : hour < 17 ? "Afternoon" : "Evening";
    const { clipped } = tone();
    const who = name ? `, ${name}` : "";
    const variants = clipped
      ? [
          `${part}${who}. I'm here — what do you need?`,
          `${part}${who}. Ready when you are.`,
          `${part}${who}. Say the next thing and I'll pick it up.`,
        ]
      : [
          `${part}${who}. I'm up and running. What are we doing?`,
          `${part}${who}. Online. What's first?`,
          `${part}${who}. Here — pick up where we left off, or start something new.`,
        ];
    const pick = variants[(hour + new Date().getDate()) % variants.length] ?? variants[0];
    const notice = backgroundNotice({
      killed: prefOn("doNotDisturb", false),
      quiet: inQuietHours(),
      ownerBusy: false,
      urgent: false,
    });
    const note = notice.deliver === "now" ? proactiveNote() : "";
    return reply("greeting", [pick, note].filter(Boolean).join(" "), 0.95);
  }
  if (BYE.test(text)) {
    return reply(
      "smalltalk",
      `Alright${name ? `, ${name}` : ""}. I'll be in the tray if you need me.`,
      0.9,
    );
  }
  if (THANKS.test(text)) {
    return reply("thanks", vary("thanks"), 0.9);
  }
  if (HOW_ARE_YOU.test(text)) {
    const state = affect.getSnapshot();
    const detail =
      state.failures >= 2
        ? `Running, but ${state.failures} things failed recently — I'm keeping it tight until that clears.`
        : state.streak >= 3
          ? "Running clean — last few tasks all went through."
          : "Running normally.";
    return reply("smalltalk", `${detail} Nothing's blocked on my side.`, 0.85);
  }

  const flow = readFlowIntent(text, "owner");
  if (flow) return reply("action", flow.message, 0.9);

  // Conversational settings (including locked project identity) before
  // who-owns / who-are-you so "change the owner" is refused, not answered.
  const settings = readSettingsIntent(text);
  if (settings) return reply("settings", settings.message, 0.9);

  if (ABOUT_YOU.test(text)) {
    return reply("identity", describeUserProfile(), 0.95);
  }
  if (FRIDAY_BEHAVE.test(text)) {
    return reply("identity", describeFridayBehaviour(), 0.9);
  }
  if (WHO_OWNS.test(text)) {
    return reply(
      "identity",
      `${PROJECT_IDENTITY.publisher} created and publishes this FRIDAY project. I only mention that when asked — it is not a name I use in conversation.`,
      0.95,
    );
  }
  if (WHO_ARE_YOU.test(text)) {
    const profile = identity.getSnapshot().profile;
    return reply(
      "identity",
      [
        `I'm ${profile.name} — a personal AI assistant running locally on this PC.`,
        `I have my own brain, memory, skills and tools; AI models are something I use, not what I am.`,
        `That means I still work when no model is connected — just with a smaller range.`,
      ].join(" "),
      0.95,
    );
  }
  if (WHAT_CAN_YOU_DO.test(text) || looksLikeSelfStatusQuestion(text)) {
    try {
      const live = describeLiveSelf(text);
      if (live.trim()) {
        return reply("capabilities", live, 0.9);
      }
    } catch {
      /* live registries unavailable — keep the static summary as fallback */
    }
    return reply("capabilities", capabilitySummary(), 0.9);
  }

  // 2. owner-work (desk / books / tender) before generic date/math so a CSV
  // header of "Date,Amount" is not stolen as "what is the date".
  const work = handleOwnerWork(text);
  if (work) {
    if (work.action) {
      return {
        handled: true,
        kind: "action",
        text: work.text,
        action: work.action,
        confidence: 0.9,
      };
    }
    return reply("knowledge", work.text, 0.92);
  }

  if (DATETIME.test(text) && !OPEN_ENDED.test(text)) {
    const ctx = readSystemContext();
    const now = new Date();
    return reply(
      "datetime",
      `It's ${now.toLocaleTimeString()} on ${now.toLocaleDateString(undefined, {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      })}${ctx.timeZone ? ` (${ctx.timeZone})` : ""}.`,
      0.95,
    );
  }
  const converted = convert(text);
  if (converted) return reply("convert", converted, 0.95);

  const expression = text
    .replace(/^(what(?:'s| is)|calculate|compute|solve|how much is)\s+/i, "")
    .replace(/[?]+$/, "");
  const value = evaluateMath(expression);
  if (value !== null) return reply("math", `${expression.trim()} = ${round(value)}`, 0.98);

  // 2b. her own live workflow — read out of the running stores (providers,
  // policy, local models, voice state, privacy tiers, last health scan), so
  // chat, voice and Auto Mode all describe the SAME real configuration.
  if (WORKFLOW_ASK.test(text)) {
    return {
      handled: true,
      kind: "workflow",
      text: "",
      confidence: 0.92,
      resolve: describeWorkflow,
    };
  }

  if (looksLikeLockedWiringSwitch(text)) {
    return reply(
      "settings",
      "That path is locked. Permission, privacy, governance, billing, and tool-authority cannot be switched from chat, voice, or the wiring panel.",
      0.95,
    );
  }
  if (looksLikeWiringQuestion(text)) {
    return {
      handled: true,
      kind: "workflow",
      text: "",
      confidence: 0.92,
      resolve: async () => {
        const { describeWiringLive } = await import("../wiring");
        return describeWiringLive();
      },
    };
  }

  if (sandboxLookRequested(text) && !extractSandboxRun(text)) {
    return live(async () => observeSandboxState().extra, 0.9);
  }

  if (extractSandboxRun(text)?.op === "apply") {
    return reply(
      "guide",
      "I cannot apply sandbox changes to the FRIDAY source myself. Approve the files on the Sandbox page — Apply stays owner-gated.",
      0.95,
    );
  }

  if (terminalLookRequested(text) && !extractTerminalRun(text)) {
    return live(async () => observeTerminalState().extra, 0.9);
  }

  if (logsLookRequested(text)) {
    return live(async () => observeLogsState().extra, 0.9);
  }

  if (tasksLookRequested(text)) {
    return live(async () => observeTasksState().extra, 0.9);
  }

  if (doctorLookRequested(text)) {
    return live(async () => observeDoctorState().extra, 0.9);
  }

  if (installerLookRequested(text)) {
    return live(async () => observeInstallerState().extra, 0.9);
  }

  if (browserLookRequested(text)) {
    return live(async () => observeBrowserState().extra, 0.9);
  }

  // 3. real machine awareness — measured, never estimated --------------------
  if (!OPEN_ENDED.test(text)) {
    if (MACHINE_ASK.test(text)) return live(describeMachine, 0.9);
    if (DISK_ASK.test(text)) return live(describeDisks, 0.9);
    if (BATTERY_ASK.test(text)) return live(describeBattery, 0.9);
    if (NETWORK_ASK.test(text)) return live(describeNetwork, 0.88);
    if (LOAD_ASK.test(text)) return live(describeLoad, 0.88);
  }

  // 4. direct capability execution -----------------------------------------
  const action = matchAction(text, lower);
  if (action) return { handled: true, kind: "action", text: "", action, confidence: 0.9 };

  // 5. local knowledge ------------------------------------------------------
  if (RECALL.test(text)) {
    const hits = brainKnowledge.recall(text, { k: 3 });
    if (hits.length) {
      return reply(
        "knowledge",
        [
          "Here's what I already have stored:",
          ...hits.map((entry) => `• ${entry.title} — ${entry.body}`),
        ].join("\n"),
        0.8,
      );
    }
    return reply("knowledge", "Nothing stored on that yet. Tell me and I'll remember it.", 0.7);
  }

  // 6. her own health — real stores only, never a simulated "all good" -------
  if (SOURCE_BUGS.test(text)) {
    return {
      handled: true,
      kind: "diagnosis",
      text: "",
      confidence: 0.88,
      resolve: async () => {
        await inspectSourceHealth({ verify: false });
        const report = inspectSelf();
        return [
          describeSelfReport(report),
          "",
          "Fixes stay in the approval queue — I never rewrite my own source without you saying yes.",
        ].join("\n");
      },
    };
  }
  if (SELF_CHECK.test(text)) {
    return {
      handled: true,
      kind: "diagnosis",
      text: "",
      confidence: 0.85,
      resolve: async () => describeSelfReport(await inspectSelfComplete()),
    };
  }

  // 6b. her own interface — read out of the real route file, so it can't go
  // stale as the app changes. Runs before the open-ended handoff on purpose:
  // a model would answer "explain Install Manager" from training, not from me.
  if (looksLikeFeatureQuestion(text) && (findFeature(text) || SECTIONS_ASK.test(text))) {
    return {
      handled: true,
      kind: "guide",
      text: "",
      confidence: 0.88,
      resolve: async () => (await explainFeature(text)) ?? describeSections(),
    };
  }

  // 6c. external services — answered from the live connector snapshot, never
  // from a model's guess about what is connected.
  if (CONNECTOR_ASK.test(text)) {
    const known = knownConnectors();
    const live = known.filter((c) => c.connected);
    return reply(
      "capabilities",
      known.length === 0
        ? "No external services are set up yet. Open Connectors and add one — I verify it with a real sign-in before I call it connected."
        : [
            connectorDigest(known),
            live.length
              ? `I can use them for: ${live
                  .flatMap((c) => c.actions.map((a) => a.label))
                  .slice(0, 8)
                  .join(", ")}.`
              : "Nothing is verified yet, so I can't act on any of them.",
            "Anything that writes into one of your accounts still waits for your approval.",
          ].join("\n"),
      0.85,
    );
  }

  // 7. pasted errors — matched against her built-in error signatures ---------
  if (looksLikeError(text)) {
    const hits = diagnoseError(text);
    if (hits.length) {
      return reply(
        "expertise",
        [
          "I recognise this one.",
          ...hits.map(formatEntry),
          "If that doesn't clear it, paste the next error and I'll keep narrowing it down.",
        ].join("\n\n"),
        0.85,
      );
    }
  }

  // 8. tools, sources, guides, language/coding knowledge --------------------
  if ((HOWTO.test(text) || FIX_ASK.test(text)) && !OPEN_ENDED.test(text)) {
    const hits = searchExpertise(text, 2);
    if (hits.length) {
      return reply("expertise", hits.map(formatEntry).join("\n\n"), 0.8);
    }
  }

  // 9. her own decisions — answered from the recorded trace of the real turn,
  // never from a generic explanation of how routing works.
  if (DECISION_ASK.test(text)) {
    return reply("trace", explainDecision(text), 0.9);
  }

  // 10. her own learning — read straight out of the experience store and the
  // capability matrix, so the numbers are the measured ones.
  if (LEARNING_ASK.test(text)) {
    return reply("learning", learningSummary(), 0.9);
  }

  // 11. honest ignorance. Only when the ladder below finds genuinely nothing
  // AND no model is reachable — with a model available this still hands off.
  if (FACT_ASK.test(text)) {
    const check = checkUncertainty(text);
    if (check.unknown) return reply("unsure", check.message, 0.6);
  }

  // Everything else is a model's job.
  return HANDOFF;
}

function reply(kind: BaselineKind, text: string, confidence: number): BaselineReply {
  return { handled: true, kind, text: say(text), confidence };
}

/** A baseline answer that needs one real async read before it can be spoken. */
function live(resolve: () => Promise<string>, confidence: number): BaselineReply {
  return { handled: true, kind: "machine", text: "", resolve, confidence };
}

/**
 * What she brings up on her own.
 *
 * When she greets him she checks whether anything is genuinely still open —
 * a running or failed task, or something he asked her to remember — and
 * mentions it. Nothing is invented: if there is nothing live, she says nothing.
 */
export function proactiveNote(): string {
  const notes: string[] = [];
  try {
    const tasks = ledger.list();
    const running = tasks.filter((task) => task.status === "running" || task.status === "queued");
    const waiting = tasks.filter((task) => task.status === "awaiting-approval");
    const failed = tasks.filter(
      (task) => task.status === "failed" && Date.now() - (task.endedAt ?? 0) < 12 * 3600_000,
    );
    if (waiting.length) notes.push(`${waiting[0]!.title} is waiting on your approval.`);
    else if (running.length)
      notes.push(
        running.length === 1
          ? `${running[0]!.title} is still running.`
          : `${running.length} tasks are still running.`,
      );
    if (failed.length) notes.push(`${failed[0]!.title} failed earlier — want me to retry it?`);
  } catch {
    /* the ledger is not hydrated yet — nothing to bring up */
  }
  if (!notes.length) {
    try {
      const pending = brainKnowledge.recall("reminder pending todo follow up next time", {
        kinds: ["personal", "project"],
        k: 1,
      });
      if (pending.length) notes.push(`You asked me to remember: ${pending[0]!.body}`);
    } catch {
      /* memory not ready */
    }
  }
  return notes.slice(0, 2).join(" ");
}

/**
 * Skills FRIDAY really has installed and enabled right now.
 *
 * Refreshed in the background from the same registry the Skills page uses, so
 * a newly installed skill becomes directly triggerable by phrase without any
 * code change here — and a removed one stops being offered immediately.
 */
type SkillEntry = {
  id: string;
  name: string;
  enabled?: boolean;
  summary?: string;
  risk?: "safe" | "write" | "exec" | string;
};
let skillCache: SkillEntry[] = [];
let skillRefreshedAt = 0;

function refreshSkillCache(): void {
  if (typeof window === "undefined") return;
  if (Date.now() - skillRefreshedAt < 30_000) return;
  skillRefreshedAt = Date.now();
  const api = window.friday as unknown as
    { listSkills?: () => Promise<{ skills?: SkillEntry[] } | SkillEntry[]> } | undefined;
  void api
    ?.listSkills?.()
    .then((result) => {
      const list = Array.isArray(result) ? result : (result?.skills ?? []);
      skillCache = list.filter((entry) => entry && entry.id && entry.enabled !== false);
    })
    .catch(() => undefined);
}

/** Phrase → installed skill. Only an explicit "run/use <skill>" counts. */
function matchSkill(text: string): BaselineAction | null {
  const ask = text.match(
    /^(?:please\s+)?(run|use|invoke|start)\s+(?:the\s+)?(.{2,60}?)(?:\s+skill)?[\s.!]*$/i,
  );
  if (!ask?.[2]) return null;
  const want = ask[2].trim().toLowerCase();
  const hit = skillCache.find(
    (skill) => skill.id.toLowerCase() === want || skill.name.toLowerCase() === want,
  );
  if (!hit) return null;
  const risk =
    hit.risk === "safe" || hit.risk === "write" || hit.risk === "exec" ? hit.risk : "exec";
  return {
    kind: "skill",
    tool: hit.id,
    args: { prompt: text },
    risk,
    label: `run the ${hit.name} skill`,
  };
}

/** Words that carry no signal when matching a phrase to an action label. */
const STOP = new Set([
  "a",
  "an",
  "the",
  "my",
  "me",
  "to",
  "in",
  "on",
  "of",
  "for",
  "this",
  "that",
  "and",
  "please",
  "friday",
  "new",
]);

const words = (value: string) =>
  value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));

/**
 * Phrase → one declared action on a CONNECTED service, e.g.
 * "create a card in Trello", "post this to Slack: ship it".
 *
 * The list of services and what each can do comes from the live connector
 * snapshot (connectorTools()), never from a hardcoded table here, so a new
 * connector action is callable from chat the moment it exists.
 */
function matchConnectorAction(text: string, lower: string): BaselineAction | null {
  const tools = connectorTools().filter((t) => t.connected);
  if (!tools.length) return null;
  const mentioned = tools.filter((t) =>
    connectorMentioned(lower, { id: t.connectorId, name: t.connectorName }),
  );
  if (!mentioned.length) return null;

  const asked = new Set(words(text));
  let best: { tool: (typeof tools)[number]; score: number } | null = null;
  for (const tool of mentioned) {
    const label = words(`${tool.action.label} ${tool.action.id}`);
    const score = label.filter((w) => asked.has(w)).length;
    if (score > 0 && (!best || score > best.score)) best = { tool, score };
  }
  if (!best) return null;

  // Free text the owner wants carried into the call ("post to slack: ship it").
  const subject = (text.split(/:\s*/).slice(1).join(": ") || text).trim();
  const args: Record<string, unknown> = { text: subject };
  for (const input of best.tool.action.inputs) {
    if (/^(message|content|text|title|summary|body|name)$/i.test(input)) args[input] = subject;
  }

  return {
    kind: "connector",
    tool: best.tool.tool,
    args,
    // Anything that is not read-only is treated exactly like any other
    // state-changing tool call: exec tier, so action-risk.ts gates it.
    risk: best.tool.action.risk === "safe" ? "safe" : "exec",
    label: `${best.tool.connectorName} · ${best.tool.action.label}`,
  };
}

function matchAction(text: string, lower: string): BaselineAction | null {
  refreshSkillCache();
  const skill = matchSkill(text);
  if (skill) return skill;
  const connector = matchConnectorAction(text, lower);
  if (connector) return connector;

  const sandbox = extractSandboxRun(text);
  if (sandbox) {
    if (sandbox.op === "apply") return null;
    return {
      kind: "tool",
      tool: sandbox.tool,
      args: {
        op: sandbox.op,
        ...(sandbox.command ? { command: sandbox.command } : {}),
        ...(sandbox.template ? { template: sandbox.template } : {}),
        ...(sandbox.name ? { name: sandbox.name } : {}),
      },
      risk: sandbox.risk,
      label: sandbox.label,
    };
  }

  const terminal = extractTerminalRun(text);
  if (terminal) {
    return {
      tool: terminal.tool,
      args: {
        command: terminal.command,
        ...(terminal.shell ? { shell: terminal.shell } : {}),
      },
      risk: terminal.risk,
      label: terminal.label,
    };
  }

  const open = text.match(OPEN_APP);
  if (open?.[2] && !OPEN_ENDED.test(text)) {
    const target = open[2].trim();
    return { tool: "app.launch", args: { target }, risk: "exec", label: `open ${target}` };
  }
  const close = text.match(CLOSE_APP);
  if (close?.[2]) {
    const target = close[2].trim();
    return { tool: "app.close", args: { title: target }, risk: "exec", label: `close ${target}` };
  }
  const focus = text.match(FOCUS_APP);
  if (focus?.[2]) {
    const target = focus[2].trim();
    return { tool: "app.focus", args: { title: target }, risk: "exec", label: `focus ${target}` };
  }
  if (LIST_WINDOWS.test(lower)) {
    return { tool: "app.list_windows", args: {}, risk: "exec", label: "list open windows" };
  }
  if (LIST_BT.test(lower)) {
    return {
      tool: "bluetooth.list",
      args: {},
      risk: "safe",
      label: "list paired Bluetooth devices",
    };
  }
  if (LIST_PHONES.test(lower)) {
    return { tool: "android.list", args: {}, risk: "safe", label: "list connected phones" };
  }
  return null;
}

/** Built from the real registry, so it can never over-promise. */
export function capabilitySummary(): string {
  const snapshot = capabilityRegistry.getSnapshot();
  const ready = snapshot.resources.filter((r) => r.health === "ready");
  const byType = new Map<string, number>();
  for (const resource of ready) byType.set(resource.type, (byType.get(resource.type) ?? 0) + 1);
  const counts = [...byType.entries()].map(([type, n]) => `${n} ${type}${n === 1 ? "" : "s"}`);

  return [
    "On my own, without any AI model: greetings and small talk, maths, unit and temperature conversion, date and time, recalling what I've stored, and running your tools directly — open, close or focus an app, list open windows, list connected phones and Bluetooth devices, run a command in the FRIDAY workspace terminal (cmd, PowerShell, WSL, Git Bash), and run any skill you have installed by name.",
    "I also read this machine live: free disk space on every drive, CPU, RAM and GPU load, network status with measured speed, battery, and how long the PC has been up — all measured at the moment you ask, never guessed.",
    "I also carry my own engineering knowledge: where every tool I depend on really comes from (Node, Python, Git, Ollama, CUDA, ADB, electron-builder, SQLite and more), the errors they throw and the exact steps that fix them, plus practical TypeScript, JavaScript, Python, React, SQL and PowerShell knowledge — so I can read an error you paste and tell you what to do about it.",
    "And I watch myself: ask me what's wrong and I'll report my real subsystem, environment, model and capability state, with the fix for anything that's failing. Ask me to find bugs in my own source and I'll read the architecture index, the last sandbox verify, and the lint already tracked in AUDIT.md — any code fix still waits for your approval.",

    counts.length ? `Right now I have ${counts.join(", ")} ready to use.` : "",
    "With a model connected I also write, explain, translate, review code and reason through open-ended problems. Ask me anything and I'll do it myself if I can, and reach for a model only when I actually need one.",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * The honest handoff. Replaces the bare failure block: says plainly what is
 * missing, what FRIDAY can still do, and offers the next step.
 */
export function handoffMessage(detail?: string): string {
  return [
    "I can't answer that one on my own — it needs a connected AI model, and none is reachable right now.",
    detail ? `\n${detail}` : "",
    "\nWhat I can still do: maths, conversions, date/time, anything already in my memory, and running your tools directly (open apps, list windows, check devices, run the FRIDAY terminal).",
    "\nWant me to help you connect a model in Models, or start a local one with Ollama? Say the word and I'll walk you through it.",
  ]
    .filter(Boolean)
    .join("");
}
