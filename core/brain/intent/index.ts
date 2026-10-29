/**
 * FRIDAY · core/brain/intent
 *
 * Classifies what the user actually wants before any model is contacted, so
 * small talk never spins up a planner, an agent or a local model.
 */
import type { FridayModule, ModuleContext } from "../../types";
import { bus } from "../../event-bus";

export type IntentKind =
  "chat" | "question" | "command" | "file" | "system" | "code" | "workflow" | "memory";

export interface Intent {
  kind: IntentKind;
  confidence: number;
  /** True when the request will touch the machine and therefore needs consent. */
  actionable: boolean;
  /** Raw entities pulled out of the text: paths, apps, urls. */
  entities: { paths: string[]; urls: string[]; apps: string[] };
  text: string;
}

const RULES: Array<{ kind: IntentKind; pattern: RegExp; weight: number }> = [
  {
    kind: "file",
    pattern: /\b(open|read|write|create|delete|rename|move|copy)\b.*\b(file|folder|dir|path)\b/i,
    weight: 0.9,
  },
  {
    kind: "system",
    pattern:
      /\b(cpu|gpu|ram|vram|process|service|shutdown|restart|task manager|registry|network)\b/i,
    weight: 0.8,
  },
  {
    kind: "code",
    pattern: /\b(refactor|debug|compile|build|typescript|python|function|stack trace|error)\b/i,
    weight: 0.75,
  },
  {
    kind: "workflow",
    pattern: /\b(workflow|automate|schedule|every (day|hour|morning)|pipeline)\b/i,
    weight: 0.8,
  },
  { kind: "memory", pattern: /\b(remember|forget|recall|what did i|note that)\b/i, weight: 0.85 },
  {
    kind: "command",
    pattern: /\b(run|execute|launch|start|stop|install|uninstall|powershell|cmd)\b/i,
    weight: 0.7,
  },
  {
    kind: "question",
    pattern: /^(who|what|when|where|why|how|is|are|can|does|do)\b|\?\s*$/i,
    weight: 0.6,
  },
];

const ACTIONABLE: IntentKind[] = ["command", "file", "system", "workflow"];

const PATH_RE = /(?:[a-zA-Z]:\\[^\s"']+|\.{0,2}\/[^\s"']+)/g;
const URL_RE = /https?:\/\/[^\s"']+/g;
const APP_RE = /\b([A-Za-z0-9_.-]+\.exe)\b/g;

export function classifyIntent(text: string): Intent {
  const trimmed = text.trim();
  let best: { kind: IntentKind; confidence: number } = { kind: "chat", confidence: 0.4 };
  for (const rule of RULES) {
    if (rule.pattern.test(trimmed) && rule.weight > best.confidence) {
      best = { kind: rule.kind, confidence: rule.weight };
    }
  }
  const intent: Intent = {
    kind: best.kind,
    confidence: best.confidence,
    actionable: ACTIONABLE.includes(best.kind),
    entities: {
      paths: trimmed.match(PATH_RE) ?? [],
      urls: trimmed.match(URL_RE) ?? [],
      apps: trimmed.match(APP_RE) ?? [],
    },
    text: trimmed,
  };
  bus.emit("intent:classified", intent);
  return intent;
}

export type IntentModule = FridayModule;

export const intentModule: IntentModule = {
  id: "core/brain/intent",
  init(_ctx: ModuleContext) {},
};

export default intentModule;
