/**
 * FRIDAY · reference resolver
 *
 * Resolves "option 2", "it", "kal wali problem", "back to the first one"
 * against session state and the existing memory fabric. Does not create a
 * second memory database.
 *
 * Hierarchy (stop at the first confident unique hit; mark ambiguity when
 * two candidates are similarly plausible):
 *   1. explicit entity  2. current task  3. active thread
 *   4. recent decision  5. open loop     6. recent relevant context
 *   7. semantic overlap 8. temporal cue  9. user-specific memory
 */

import { memory, type MemoryItem } from "../self/memory-engine";
import { retrievalTerms, termJaccard } from "./retrieval";
import { listOpenLoops } from "./open-loops";
import {
  extractPresentedOptions,
  getConversationSession,
  lastDecision,
  looksLikeContinueAcrossChats,
  restoreCompactIfContinuing,
  resumeMatchingThread,
  resumePreviousTopic,
  resumeThreadByIndex,
  selectPresentedOption,
  setActiveTopic,
  type PresentedOption,
  type SessionTurn,
} from "./conversation-state";

export type ReferenceKind =
  | "option"
  | "yesterday"
  | "decision"
  | "thread"
  | "task"
  | "open-loop"
  | "continue"
  | "anaphora"
  | "go-back"
  | "revert"
  | "file"
  | "none"
  | "ambiguous";

export type ReferenceHit = {
  kind: ReferenceKind;
  resolved: string;
  confidence: number;
  ambiguous: boolean;
  candidates: string[];
  option?: PresentedOption;
  memory?: MemoryItem;
};

const OPTION_PICK =
  /\b(?:(?:use|pick|choose|take|go with|select|decided (?:to use|on)|go for)\s+)?(?:option|choice|opt\.?)\s*(?:#|no\.?\s*|number\s*)?(\d+|one|two|three|four|five|first|second|third|fourth|fifth|last|[a-e])\b/i;
const ORDINAL_OPTION =
  /\b(?:uska|usko|uski|the)?\s*(first|second|third|fourth|fifth|last|pehla|pehle|dusra|doosra|teesra|tisra|akhiri|aakhri)\s+(?:option|choice|one|wala|wali|wale)\b/i;
const HINDI_ORDINAL =
  /\b(pehla|pehle|dusra|doosra|teesra|tisra|akhiri|aakhri)\b(?:\s*(?:wala|wali|wale|option|choice))?/i;
const YESTERDAY =
  /\b(kal wali(?:\s+(?:baat|problem|issue|cheez))?|wahi jo kal(?:\s+discuss)?(?:\s+kiya tha)?|jo kal(?:\s+discuss)?(?:\s+kiya tha)?|yesterday(?:'s)?\s+(?:talk|discussion|baat|chat|issue|problem)|last time we (?:talked|discussed)|kal ki problem)\b/i;
const CONTINUE = /^(continue|keep going|carry on|aage badho)\b/i;
const CONTINUE_PRIOR =
  /\b(us project ko continue|continue that project|jahan chhoda tha|purani wali baat continue|jo hum kar rahe the|wapas .{0,48}par aao|previous project|last task|jo decision (humne )?liya tha)\b/i;
const GO_BACK =
  /\b(back to the (first|previous)|go back|the earlier (?:one|approach|thread)|pehle wala|jo pehle wala tha|the previous (?:one|version|approach)|the earlier one)\b/i;
const REVERT = /\b(revert that|undo that|use the previous version)\b/i;
const THAT_FILE = /\b(that file|that change|wo file|wo change|woh file|woh feature)\b/i;
const ANAPHORA =
  /\b(it|this|that|these|those|them|the same|same as before|same one|same thing|that one|the other one|usko|uska|uski|wo|wahi|ye|woh|isko|usi|isi|previous one|last task|previous project|wahi bug|same issue)\b/i;
const EXECUTE_CURRENT = /^(bas kar do|just do (it|that)|go ahead|do that|kar do)\b/i;

const WORD_INDEX: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  pehla: 1,
  pehle: 1,
  dusra: 2,
  doosra: 2,
  teesra: 3,
  tisra: 3,
  a: 1,
  b: 2,
  c: 3,
  d: 4,
  e: 5,
};

function toIndex(raw: string, count: number): number {
  const key = raw.toLowerCase();
  if (key === "last" || key === "akhiri" || key === "aakhri") return count;
  if (WORD_INDEX[key]) return WORD_INDEX[key]!;
  const n = Number(key);
  return Number.isFinite(n) ? n : 0;
}

function hit(
  kind: ReferenceKind,
  original: string,
  context: string,
  extra: Partial<ReferenceHit> = {},
): ReferenceHit {
  const confidence = extra.confidence ?? (kind === "none" ? 0 : 0.82);
  const ambiguous = extra.ambiguous ?? (kind === "ambiguous" || confidence < 0.55);
  return {
    kind,
    resolved: context ? `${original}\n(Context: ${context})` : original,
    confidence,
    ambiguous,
    candidates: extra.candidates ?? (context ? [context] : []),
    ...(extra.option ? { option: extra.option } : {}),
    ...(extra.memory ? { memory: extra.memory } : {}),
  };
}

function optionsFrom(history: SessionTurn[]): PresentedOption[] {
  const session = getConversationSession();
  if (session.presentedOptions.length) return session.presentedOptions;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const turn = history[i];
    if (!turn) continue;
    if (turn.role === "assistant" || turn.role === "friday") {
      const listed = extractPresentedOptions(turn.text);
      if (listed.length) return listed;
    }
  }
  return [];
}

function lexical(a: string, b: string): number {
  return termJaccard(retrievalTerms(a), retrievalTerms(b));
}

function recallPriorTalk(query: string): MemoryItem[] {
  const session = getConversationSession();
  const needles = [query, session.activeTopic, session.userGoal, "discussed", "yesterday"].filter(
    (item) => item && item.trim().length >= 3,
  );
  const found: MemoryItem[] = [];
  for (const needle of needles) {
    try {
      const hits = memory.search(needle, { k: 4, context: session.activeTopic || needle });
      for (const item of hits) {
        if (item.tier === "archived" || item.supersededAt || item.text.trim().length < 12) continue;
        if (!found.some((row) => row.id === item.id)) found.push(item);
      }
    } catch {
      /* memory unreadable — resolve honestly without it */
    }
  }
  return found.slice(0, 4);
}

function pickOption(
  original: string,
  options: PresentedOption[],
  rawIndex: string,
): ReferenceHit | null {
  const index = toIndex(rawIndex, options.length);
  const picked = options.find((item) => item.index === index);
  if (!picked) return null;
  const selected = selectPresentedOption(index) ?? { ...picked, status: "selected" as const };
  return hit("option", original, `option ${selected.index} is "${selected.text.slice(0, 240)}"`, {
    option: selected,
    confidence: 0.92,
    ambiguous: false,
    candidates: [selected.text],
  });
}

function explicitEntity(original: string, options: PresentedOption[]): ReferenceHit | null {
  const lower = original.toLowerCase();
  const named = options.filter((item) => lower.includes(item.text.slice(0, 24).toLowerCase()));
  if (named.length === 1) {
    selectPresentedOption(named[0]!.index);
    return hit("option", original, `named option is "${named[0]!.text.slice(0, 240)}"`, {
      option: { ...named[0]!, status: "selected" },
      confidence: 0.9,
    });
  }
  return null;
}

export function resolveSessionReferences(text: string, history: SessionTurn[] = []): ReferenceHit {
  const original = String(text || "").trim();
  const options = optionsFrom(history);
  const session = getConversationSession();
  const decision = lastDecision();
  const loops = (() => {
    try {
      return listOpenLoops();
    } catch {
      return [];
    }
  })();

  const named = explicitEntity(original, options);
  if (named) return named;

  const optionMatch =
    OPTION_PICK.exec(original) || ORDINAL_OPTION.exec(original) || HINDI_ORDINAL.exec(original);
  if (optionMatch && options.length) {
    const picked = pickOption(original, options, String(optionMatch[1] || ""));
    if (picked) return picked;
  }

  if (YESTERDAY.test(original)) {
    const found = recallPriorTalk(original);
    const scored = found
      .filter(
        (item) =>
          item.tier === "episodic" ||
          item.kind === "decision" ||
          item.kind === "episodic" ||
          item.tags.includes("correction"),
      )
      .map((item) => ({
        item,
        score:
          lexical(`${item.title} ${item.text}`, original) + (item.kind === "decision" ? 0.1 : 0),
      }))
      .sort((a, b) => b.score - a.score);
    if (
      scored.length >= 2 &&
      scored[0]!.score >= 0.12 &&
      scored[0]!.score - scored[1]!.score < 0.08 &&
      scored[1]!.score >= 0.12
    ) {
      return hit(
        "ambiguous",
        original,
        "yesterday's talk matches more than one memory — which problem?",
        {
          confidence: 0.4,
          ambiguous: true,
          candidates: scored.slice(0, 2).map((row) => row.item.title),
        },
      );
    }
    if (scored[0] || found[0]) {
      const top = scored[0]?.item ?? found[0]!;
      return hit(
        "yesterday",
        original,
        `earlier discussion was "${top.title}: ${top.text.slice(0, 200)}"`,
        { memory: top, confidence: scored[0] ? 0.8 : 0.62 },
      );
    }
    if (session.activeTopic) {
      return hit(
        "yesterday",
        original,
        `this session's topic was "${session.activeTopic.slice(0, 200)}"`,
        {
          confidence: 0.62,
        },
      );
    }
  }

  if (REVERT.test(original) && decision) {
    return hit("revert", original, `last decided item was "${decision.selected.slice(0, 200)}"`, {
      confidence: 0.78,
    });
  }

  if (CONTINUE_PRIOR.test(original) || looksLikeContinueAcrossChats(original)) {
    restoreCompactIfContinuing(original);
    const current = getConversationSession();
    const resumed = current.threads.some((row) => row.status === "paused")
      ? resumeMatchingThread(original)
      : null;
    const topic = resumed?.topic || current.activeTopic;
    const detail = getConversationSession().userGoal || topic;
    if (detail) {
      return hit("continue", original, `continue this work: ${detail.slice(0, 200)}`, {
        confidence: resumed ? 0.84 : 0.8,
      });
    }
    const found = recallPriorTalk(original).filter(
      (item) =>
        item.source !== "first-run" &&
        (item.kind === "project" || item.kind === "decision" || item.kind === "episodic"),
    );
    if (found.length >= 2 && found[0] && found[1]) {
      const gap =
        lexical(`${found[0].title} ${found[0].text}`, original) -
        lexical(`${found[1].title} ${found[1].text}`, original);
      if (Math.abs(gap) < 0.08) {
        return hit("ambiguous", original, "more than one prior project matches — which one?", {
          confidence: 0.4,
          ambiguous: true,
          candidates: found.slice(0, 2).map((item) => item.title),
        });
      }
    }
    if (found[0]) {
      setActiveTopic(found[0].context || found[0].title);
      return hit(
        "continue",
        original,
        `earlier work was "${found[0].title}: ${found[0].text.slice(0, 200)}"`,
        { memory: found[0], confidence: 0.72 },
      );
    }
    return hit("ambiguous", original, "I don't have a stored project to continue — which one?", {
      confidence: 0.35,
      ambiguous: true,
    });
  }

  if (GO_BACK.test(original)) {
    const wantsFirst = /\bfirst\b|pehla|pehle/i.test(original);
    const correcting = /\b(nahi|no|not that|galat|wo nahi|correction)\b/i.test(original);
    // A correction of a listed choice is an option repair, not a thread jump.
    if (options.length >= 2 && (correcting || !session.previousTopics.length)) {
      const picked = pickOption(original, options, wantsFirst ? "first" : "1");
      if (picked) return picked;
    }
    if (
      wantsFirst &&
      (session.previousTopics.length || session.threads.some((row) => row.status === "paused"))
    ) {
      const resumed = resumeThreadByIndex(1);
      if (resumed) {
        return hit(
          "thread",
          original,
          `resumed the first thread "${resumed.topic.slice(0, 200)}"`,
          {
            confidence: 0.8,
          },
        );
      }
    }
    const prior = resumePreviousTopic();
    if (prior) {
      return hit("go-back", original, `returned to "${prior.slice(0, 200)}"`, { confidence: 0.78 });
    }
  }

  if (THAT_FILE.test(original)) {
    const fileish = [...history].reverse().find((turn) => /[\\/]|\.\w{1,5}\b/.test(turn.text));
    if (fileish) {
      return hit("file", original, `recent file mention was "${fileish.text.slice(0, 200)}"`, {
        confidence: 0.7,
      });
    }
  }

  if (CONTINUE.test(original) || EXECUTE_CURRENT.test(original)) {
    if (decision) {
      return hit(
        "continue",
        original,
        `continue the decided work: ${decision.selected.slice(0, 200)}`,
        { confidence: 0.86 },
      );
    }
    const selected = session.presentedOptions.find((item) => item.status === "selected");
    if (selected) {
      return hit(
        "continue",
        original,
        `continue option ${selected.index}: ${selected.text.slice(0, 200)}`,
        {
          option: selected,
          confidence: 0.84,
        },
      );
    }
    if (session.userGoal) {
      return hit("task", original, `continue the current goal: ${session.userGoal.slice(0, 200)}`, {
        confidence: 0.72,
      });
    }
    if (session.activeTopic) {
      return hit("continue", original, `continue this work: ${session.activeTopic.slice(0, 200)}`, {
        confidence: 0.7,
      });
    }
  }

  if (ANAPHORA.test(original) || /^(implement|fix|do|use)\s+(it|that|this)\b/i.test(original)) {
    const candidates: { label: string; score: number; kind: ReferenceKind }[] = [];
    if (decision) {
      candidates.push({ label: decision.selected, score: 0.9, kind: "decision" });
    }
    const selected = session.presentedOptions.find((item) => item.status === "selected");
    if (selected && selected.text !== decision?.selected) {
      candidates.push({ label: selected.text, score: 0.86, kind: "option" });
    }
    if (session.userGoal) {
      candidates.push({ label: session.userGoal, score: 0.74, kind: "task" });
    }
    const openTask = loops.find((item) => item.kind === "task");
    if (openTask) candidates.push({ label: openTask.text, score: 0.7, kind: "open-loop" });
    if (session.activeTopic) {
      candidates.push({ label: session.activeTopic, score: 0.66, kind: "anaphora" });
    }

    const unique = candidates.filter(
      (row, index, all) => all.findIndex((item) => item.label === row.label) === index,
    );
    unique.sort((a, b) => b.score - a.score);
    if (unique.length >= 2 && unique[0]!.score - unique[1]!.score < 0.08) {
      return hit("ambiguous", original, "it could mean more than one recent item", {
        confidence: 0.42,
        ambiguous: true,
        candidates: unique.slice(0, 2).map((row) => row.label),
      });
    }
    if (unique[0]) {
      const top = unique[0];
      return hit(top.kind, original, `that refers to "${top.label.slice(0, 240)}"`, {
        confidence: top.score,
        ...(selected && top.label === selected.text ? { option: selected } : {}),
      });
    }
  }

  return { kind: "none", resolved: original, confidence: 0.2, ambiguous: false, candidates: [] };
}
