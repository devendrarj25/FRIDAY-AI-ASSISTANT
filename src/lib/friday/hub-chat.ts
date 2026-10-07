/**
 * Friday Hub chat — same Core Brain pipeline as Import & Build (`brain.send`),
 * grounded in the selected repo's live workspace / diff / validate / history.
 * Never invents git output. Never checks whether FRIDAY herself is out of date.
 * Proposed file writes go through `governance.submit({ kind: "code-change" })`.
 */

import { brain } from "@/lib/friday/brain-engine";
import { governance } from "@/lib/friday/self/governance";
import {
  devCommitFiles,
  devDiff,
  devHistory,
  devValidate,
  devWorkspace,
  devWriteFile,
  type DevWorkspace,
  type HistoryCommit,
  type ValidationStep,
} from "@/lib/friday/dev-workflow";

export type HubChatAction = {
  type: "none" | "review" | "validate" | "history" | "diff" | "ask" | "fix";
  file?: string;
};

export type HubChatReply = {
  text: string;
  action: HubChatAction;
  grounded: boolean;
};

export type HubChatSnapshot = {
  workspace: DevWorkspace;
  diff: string;
  validation: { ok: boolean; summary?: string; error?: string; results?: ValidationStep[] };
  history: HistoryCommit[];
};

export function interpretHubPrompt(prompt: string): HubChatAction {
  const lower = prompt.trim().toLowerCase();
  if (!lower) return { type: "none" };
  if (/\b(validat\w*|lint|typecheck|failing tests?)\b/.test(lower)) return { type: "validate" };
  if (/\b(history|commits?|log)\b/.test(lower)) return { type: "history" };
  if (/\b(review|safe to merge|looks safe|find the bug)\b/.test(lower)) {
    return { type: "review" };
  }
  if (/\bdiff\b|\bwhat changed\b|\bthis change\b/.test(lower)) return { type: "diff" };
  if (/\b(fix|apply|write that|commit this)\b/.test(lower)) return { type: "fix" };
  return { type: "ask" };
}

export function describeHubSession(snap: HubChatSnapshot): string {
  const space = snap.workspace;
  const results = (snap.validation.results ?? [])
    .map(
      (step) =>
        `${step.id}:${step.state}${step.detail ? ` (${String(step.detail).slice(0, 200)})` : ""}`,
    )
    .join("; ");
  const commits = (snap.history ?? [])
    .slice(0, 12)
    .map((c) => `${c.short} ${c.subject}`)
    .join("\n  ");
  const changes = (space.changes ?? [])
    .slice(0, 40)
    .map((c) => `${c.state} ${c.path}`)
    .join("\n  ");
  return [
    `Hub session: repo=${space.connectedRepo || "(none)"} role=${space.hubRole || "self"} branch=${space.branch || "(none)"}`,
    `dirty=${space.dirty ?? 0} protected=${space.onProtectedBranch ? "yes" : "no"}`,
    `validation: ${snap.validation.summary || snap.validation.error || "not run"}`,
    results ? `validation steps: ${results}` : null,
    changes ? `working tree:\n  ${changes}` : "working tree: clean",
    snap.diff ? `diff (truncated):\n${snap.diff.slice(0, 12_000)}` : "diff: empty",
    commits ? `recent commits:\n  ${commits}` : "recent commits: none",
  ]
    .filter(Boolean)
    .join("\n");
}

export function parseProposedFiles(text: string): Array<{ file: string; content: string }> {
  const out: Array<{ file: string; content: string }> = [];
  const re = /```(?:[\w.+-]+)?\s*\n(?:(?:file|path)\s*:\s*)?([A-Za-z0-9_./\\-]+)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const file = (match[1] || "").trim().replace(/\\/g, "/");
    if (!file || file.includes("..") || file.startsWith("/")) continue;
    out.push({ file, content: match[2] ?? "" });
  }
  return out.slice(0, 8);
}

async function loadSnapshot(runValidate: boolean): Promise<HubChatSnapshot> {
  const workspace = await devWorkspace();
  const [diffResult, historyResult] = await Promise.all([devDiff(), devHistory(20)]);
  const validation = runValidate
    ? await devValidate()
    : {
        ok: true,
        summary: "Validation not run this turn — ask FRIDAY to validate to run the real checks.",
      };
  return {
    workspace,
    diff: diffResult.ok ? diffResult.diff || "" : diffResult.error || "",
    validation,
    history: historyResult.ok ? (historyResult.commits ?? []) : [],
  };
}

function waitForBrainReply(startedAt: number, timeoutMs = 90_000): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (text: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsub();
      resolve(text);
    };
    const unsub = brain.subscribe(() => {
      const snap = brain.getSnapshot();
      if (snap.activeRunId) return;
      const last = [...snap.messages]
        .reverse()
        .find((m) => m.role === "friday" && m.at >= startedAt);
      if (last?.text?.trim()) finish(last.text.trim());
    });
    const timer = setTimeout(() => {
      finish("Core Brain did not finish this Hub question in time.");
    }, timeoutMs);
    const snap = brain.getSnapshot();
    if (!snap.activeRunId) {
      const last = [...snap.messages]
        .reverse()
        .find((m) => m.role === "friday" && m.at >= startedAt);
      if (last?.text?.trim()) finish(last.text.trim());
    }
  });
}

let pendingFix: Array<{ file: string; content: string }> = [];

export function peekPendingHubFix() {
  return pendingFix.slice();
}

export function clearPendingHubFix() {
  pendingFix = [];
}

async function applyPendingFix(): Promise<string> {
  const files = pendingFix.slice();
  if (!files.length) {
    return "There is no proposed file patch to apply. FRIDAY will not invent one. Edit in the Hub file panel, then commit with confirmation.";
  }
  const item = await governance.submit({
    kind: "code-change",
    title: `Hub proposed edit — ${files.map((f) => f.file).join(", ")}`.slice(0, 120),
    rationale:
      "Apply the file patch FRIDAY proposed from the live Hub diff/validate session. Owner approval is required; nothing is written until then.",
    risk: "review",
    evidence: files.map((f) => f.file),
    dryRun: async () => ({
      ok: true,
      detail: `${files.length} file(s) would be written in the selected Hub checkout.`,
    }),
    apply: async () => {
      for (const file of files) {
        const written = await devWriteFile(file.file, file.content);
        if (!written.ok)
          return { ok: false, detail: written.error || `Could not write ${file.file}` };
      }
      const committed = await devCommitFiles(
        `friday hub: apply reviewed patch (${files.map((f) => f.file).join(", ")})`,
      );
      if (!committed.ok && !committed.protectedBranch) {
        return {
          ok: true,
          detail: `Wrote files; commit skipped: ${committed.error || "not committed"}`,
        };
      }
      if (!committed.ok) return { ok: false, detail: committed.error || "commit refused" };
      return { ok: true, detail: `Wrote and committed ${files.length} file(s).` };
    },
  });
  pendingFix = [];
  if (item.stage === "waiting-approval") {
    return `Proposed ${files.length} file change(s) and waiting for your approval in Self-management. Nothing has been written yet.`;
  }
  return `Governance ${item.stage}: ${item.error || files.map((f) => f.file).join(", ")}`;
}

/**
 * Grounded Hub intents operate the same git/GitHub functions the Hub buttons call.
 * Unknown prose goes to Core Brain with the live session dump in `options.extra`.
 */
export async function handleHubIntent(
  prompt: string,
  snapshot?: HubChatSnapshot,
): Promise<HubChatReply> {
  const text = prompt.trim();
  const intent = interpretHubPrompt(text);
  const snap =
    snapshot ??
    (await loadSnapshot(
      intent.type === "validate" || intent.type === "review" || intent.type === "fix",
    ));

  if (intent.type === "none") {
    return {
      text: "Ask FRIDAY to review the live diff, history, or validation of the selected Hub repo.",
      action: intent,
      grounded: true,
    };
  }

  if (intent.type === "validate") {
    return {
      text: snap.validation.summary || snap.validation.error || "Validation produced no summary.",
      action: intent,
      grounded: true,
    };
  }

  if (intent.type === "history") {
    const lines = (snap.history ?? []).slice(0, 20).map((c) => `${c.short}  ${c.subject}`);
    return {
      text: lines.length ? lines.join("\n") : "No commit history is available for this checkout.",
      action: intent,
      grounded: true,
    };
  }

  if (intent.type === "diff") {
    return {
      text: snap.diff?.trim() ? snap.diff.slice(0, 20_000) : "Working tree has no textual diff.",
      action: intent,
      grounded: true,
    };
  }

  if (intent.type === "review") {
    return {
      text: [
        "Grounded review of the selected Hub repo (live data, not invented):",
        describeHubSession(snap),
        "",
        snap.validation.ok
          ? "Validation did not report a failed step."
          : `Validation is not clean: ${snap.validation.summary || snap.validation.error}`,
        (snap.workspace.dirty ?? 0) > 0
          ? "There are uncommitted files — do not treat this as merge-ready until they are committed, pushed, and reviewed."
          : "Working tree is clean.",
      ].join("\n"),
      action: intent,
      grounded: true,
    };
  }

  if (intent.type === "fix") {
    const parsed = parseProposedFiles(text);
    if (parsed.length) pendingFix = parsed;
    const result = await applyPendingFix();
    return { text: result, action: intent, grounded: true };
  }

  const extra = [
    "You are answering from Friday Hub for the currently selected GitHub repository.",
    "Use ONLY the following live workspace/diff/validate/history. Never invent files, test results, or commits.",
    "Do not check whether FRIDAY herself is out of date — Updates owns that.",
    "Do not confuse this with capability import (Clone from GitHub on this same page).",
    "If you propose a file edit, put it in a fenced block whose first line is the relative path. It will not be written until the owner approves.",
    describeHubSession(snap),
  ].join("\n\n");

  if (typeof window === "undefined") {
    return {
      text: `Core Brain chat needs the desktop session. Grounded Hub state:\n${describeHubSession(snap)}`,
      action: { type: "ask" },
      grounded: true,
    };
  }

  const startedAt = Date.now();
  const result = brain.send(text, { extra });
  if (!result.accepted) {
    return {
      text: result.message || result.reason || "Core Brain did not accept this turn.",
      action: { type: "ask" },
      grounded: true,
    };
  }
  const reply = await waitForBrainReply(startedAt);
  const proposed = parseProposedFiles(reply);
  if (proposed.length) pendingFix = proposed;
  return { text: reply, action: { type: "ask" }, grounded: true };
}
