/**
 * FRIDAY · sandbox-lab command parsing
 *
 * Pure helpers shared by the Sandbox page, Auto Mode, and the baseline brain.
 * They never spawn a process — `electron/sandbox-lab.cjs` `runCommand` is the
 * one executor. Apply-to-source is never returned as a runnable action.
 *
 * Risk for shell lines reuses `classifyCommand` from the workspace terminal
 * so `npm test` stays routine and `npm install` / `docker build` stay exec.
 */

import { classifyCommand, looksLikeShellCommand } from "./terminal-command";

export type SandboxOp = "run" | "create" | "checks" | "apply" | "observe";

export type SandboxRunPlan = {
  op: SandboxOp;
  command?: string;
  template?: string;
  name?: string;
  risk: "safe" | "write" | "exec";
  label: string;
  tool: "sandbox.exec";
};

const QUESTION =
  /^(what|why|how|who|which|when|where|explain|tell|please (tell|explain)|can you|could you|do you)\b/i;

const MENTIONS_TERMINAL = /\b(terminal|cmd\.exe|command prompt|powershell|pwsh|git bash)\b/i;

const MENTIONS_SANDBOX = /\bsandbox\b/i;

const SANDBOX_PREFIX = /^(?:please\s+)?(?:in\s+(?:the\s+)?)?sandbox\s*[:-]\s*(?<cmd>.+)/i;

const RUN_IN_SANDBOX =
  /^(?:please\s+)?(?:run|execute)\s+(?<cmd>.+?)\s+in\s+(?:the\s+)?sandbox\s*$/i;

const EXPLICIT_RUN =
  /^(?:please\s+)?(?:run|execute)\s+(?:this\s+)?(?:command\s+)?(?:in\s+(?:the\s+)?sandbox\s*[:-]?\s*)(?<cmd>.+)/i;

const APPLY =
  /^(?:please\s+)?(?:apply|approve and apply|approve)\s+(?:the\s+)?(?:sandbox\s+)?(?:changes|diff|patch|files)\b/i;

const CHECKS =
  /^(?:please\s+)?(?:run\s+)?(?:the\s+)?(?:sandbox\s+)?(?:checks|check suite|verification|verify)\b/i;

const CREATE =
  /^(?:please\s+)?create\s+(?:a\s+|an\s+)?(?:(?<template>blank|node|python|pytest|go|rust|linux|java|cmake|container|deno|friday)\s+)?sandbox(?:\s+project)?(?:\s+(?:called|named)\s+(?<name>[\w.-]+))?\s*$/i;

const NAMED_TASKS: Array<{ re: RegExp; command: string }> = [
  {
    re: /^(?:please\s+)?(?:run|execute)\s+(?:the\s+)?(?:unit\s+|vitest\s+)?tests?\s+in\s+(?:the\s+)?sandbox\b/i,
    command: "npm test",
  },
  {
    re: /^(?:please\s+)?(?:run\s+)?(?:a\s+)?typecheck\s+in\s+(?:the\s+)?sandbox\b/i,
    command: "npm run typecheck",
  },
  {
    re: /^(?:please\s+)?(?:run\s+)?(?:the\s+)?linters?\s+in\s+(?:the\s+)?sandbox\b/i,
    command: "npm run lint",
  },
  {
    re: /^(?:please\s+)?(?:run\s+)?pytest\s+in\s+(?:the\s+)?sandbox\b/i,
    command: "python -m pytest -q",
  },
  {
    re: /^(?:please\s+)?(?:run\s+)?ruff\s+in\s+(?:the\s+)?sandbox\b/i,
    command: "ruff check .",
  },
  {
    re: /^(?:please\s+)?(?:run\s+)?go test\s+in\s+(?:the\s+)?sandbox\b/i,
    command: "go test ./...",
  },
  {
    re: /^(?:please\s+)?(?:run\s+)?go vet\s+in\s+(?:the\s+)?sandbox\b/i,
    command: "go vet ./...",
  },
  {
    re: /^(?:please\s+)?(?:run\s+)?cargo test\s+in\s+(?:the\s+)?sandbox\b/i,
    command: "cargo test",
  },
  {
    re: /^(?:please\s+)?(?:run\s+)?cargo check\s+in\s+(?:the\s+)?sandbox\b/i,
    command: "cargo check",
  },
  {
    re: /^(?:please\s+)?(?:run\s+)?(?:make test|make checks?)\s+in\s+(?:the\s+)?sandbox\b/i,
    command: "make test",
  },
  {
    re: /^(?:please\s+)?(?:run\s+)?deno test\s+in\s+(?:the\s+)?sandbox\b/i,
    command: "deno test",
  },
  {
    re: /^(?:please\s+)?(?:run\s+)?bun test\s+in\s+(?:the\s+)?sandbox\b/i,
    command: "bun test",
  },
];

function riskOf(command: string): "safe" | "exec" {
  return classifyCommand(command) === "exec" ? "exec" : "safe";
}

function runPlan(command: string): SandboxRunPlan | null {
  const cmd = String(command || "").trim();
  if (!cmd) return null;
  const risk = riskOf(cmd);
  return {
    op: "run",
    command: cmd,
    risk,
    tool: "sandbox.exec",
    label: `run \`${cmd}\` in the FRIDAY sandbox`,
  };
}

/**
 * Chat / Auto Mode phrase → one sandbox-lab operation.
 * Apply-to-source is classified so the brain can refuse it, not execute it.
 */
export function extractSandboxRun(prompt: string): SandboxRunPlan | null {
  const text = String(prompt || "").trim();
  if (!text) return null;
  if (MENTIONS_TERMINAL.test(text) && !MENTIONS_SANDBOX.test(text)) return null;

  if (APPLY.test(text) && MENTIONS_SANDBOX.test(text)) {
    return {
      op: "apply",
      risk: "exec",
      tool: "sandbox.exec",
      label: "apply sandbox changes to the FRIDAY source",
    };
  }

  if ((CHECKS.test(text) && MENTIONS_SANDBOX.test(text)) || /^sandbox checks$/i.test(text)) {
    return {
      op: "checks",
      risk: "safe",
      tool: "sandbox.exec",
      label: "run the sandbox check suite",
    };
  }

  const created = CREATE.exec(text);
  if (created) {
    const template = (created.groups?.["template"] || "node").toLowerCase();
    const name = created.groups?.["name"] || "friday-scratch";
    return {
      op: "create",
      template,
      name,
      risk: "write",
      tool: "sandbox.exec",
      label: `create sandbox project ${name} (${template})`,
    };
  }

  for (const task of NAMED_TASKS) {
    if (task.re.test(text)) return runPlan(task.command);
  }

  const trailing = RUN_IN_SANDBOX.exec(text);
  if (trailing?.groups?.["cmd"]) return runPlan(trailing.groups["cmd"]);

  const explicit = EXPLICIT_RUN.exec(text);
  if (explicit?.groups?.["cmd"]) return runPlan(explicit.groups["cmd"]);

  const prefixed = SANDBOX_PREFIX.exec(text);
  if (prefixed?.groups?.["cmd"]) {
    const cmd = prefixed.groups["cmd"].trim();
    if (/^(checks|check suite|verify)$/i.test(cmd)) {
      return {
        op: "checks",
        risk: "safe",
        tool: "sandbox.exec",
        label: "run the sandbox check suite",
      };
    }
    if (looksLikeShellCommand(cmd) || !QUESTION.test(cmd)) return runPlan(cmd);
  }

  if (
    MENTIONS_SANDBOX.test(text) &&
    looksLikeShellCommand(text.replace(/\s+in\s+(the\s+)?sandbox\s*$/i, ""))
  ) {
    const cmd = text.replace(/\s+in\s+(the\s+)?sandbox\s*$/i, "").trim();
    if (looksLikeShellCommand(cmd)) return runPlan(cmd);
  }

  return null;
}

export function isRoutineSandboxCommand(text: string): boolean {
  const plan = extractSandboxRun(text);
  if (!plan) return false;
  if (plan.op === "apply" || plan.op === "create") return false;
  return plan.risk === "safe";
}

const ERROR_LINE =
  /\b(error|fail(ed|ure)?|traceback|exception|npm err!|elint|ts\d{3,5}|exit code [1-9])/i;

/** Pull the last failing lines from a sandbox buffer. Does not spawn. */
export function summarizeSandboxOutput(text: string, maxLines = 12): string {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  if (!lines.length) return "";
  const hits = lines.filter((line) => ERROR_LINE.test(line));
  if (!hits.length) return "";
  return hits.slice(-maxLines).join("\n");
}

export function sandboxCommandRisk(command: string): "safe" | "exec" {
  return riskOf(command);
}
