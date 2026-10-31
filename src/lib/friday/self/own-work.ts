import { evaluateChange } from "./governance";

export type WorkProposal = {
  allow: "refuse" | "ask" | "stage";
  applied: false;
  merges: false;
  pushesMain: false;
  editsAgents: false;
  reason: string;
  diff: string;
};

const BLOCKED = ["AGENTS.md", "config/friday-version.json"];

export function proposeDiff(input: {
  paths: string[];
  diff: string;
  level: "strict" | "balanced" | "trusted" | "full";
  halted?: boolean;
}): WorkProposal {
  const blocked = input.paths.some((file) =>
    BLOCKED.some((name) => file.replace(/\\/g, "/").endsWith(name) || file.includes(name)),
  );
  const verdict = evaluateChange({
    paths: input.paths,
    level: input.level,
    ...(input.halted === undefined ? {} : { halted: input.halted }),
  });
  const allow = blocked ? "refuse" : verdict.allow;
  return {
    allow,
    applied: false,
    merges: false,
    pushesMain: false,
    editsAgents: false,
    reason: blocked ? "protected" : verdict.reason,
    diff: input.diff.slice(0, 4000),
  };
}

/** The file paths a unified diff names, without duplicates. Nothing is applied or read from disk. */
export function pathsOfDiff(diff: string): string[] {
  const paths = new Set<string>();
  for (const line of String(diff || "").split(/\r?\n/)) {
    const m =
      /^(?:---|\+\+\+) (?:[ab]\/)?(\S+)/.exec(line) ??
      /^(?:rename|copy) (?:from|to) (\S+)/.exec(line);
    const path = m?.[1];
    if (path && path !== "/dev/null") paths.add(path);
  }
  return [...paths];
}

export type DevCheckName = "pytest" | "typecheck" | "lint" | "test-fast";

/**
 * The exact `dev.check` call that would try a proposal on a throwaway copy of HEAD. It is only a request:
 * `dev.check` is an exec-tier kernel tool, so the owner approves each run, and a proposal that touches a
 * protected file never gets a request at all.
 */
export function devCheckRequest(input: {
  paths: string[];
  diff: string;
  level: "strict" | "balanced" | "trusted" | "full";
  halted?: boolean;
  check?: DevCheckName;
}):
  | { ok: false; reason: string }
  | {
      ok: true;
      tool: "dev.check";
      args: { diff: string; check: DevCheckName; baseline: true };
      needsApproval: true;
    } {
  if (!input.diff.trim()) return { ok: false, reason: "nothing to check" };
  const proposal = proposeDiff({
    paths: input.paths,
    diff: input.diff,
    level: input.level,
    ...(input.halted === undefined ? {} : { halted: input.halted }),
  });
  if (proposal.allow === "refuse") return { ok: false, reason: proposal.reason };
  return {
    ok: true,
    tool: "dev.check",
    args: { diff: input.diff, check: input.check ?? "test-fast", baseline: true },
    needsApproval: true,
  };
}

/** What a `dev.check` verdict means for putting a proposal forward. Advice to the owner, never an action. */
export function devCheckAllows(result: { ok?: boolean; verdict?: string }): {
  forward: boolean;
  reason: string;
} {
  if (!result.ok) return { forward: false, reason: "the proposal could not be tried" };
  switch (result.verdict) {
    case "fixed":
      return { forward: true, reason: "the check failed before and passes with the change" };
    case "unchanged-pass":
    case "passes":
      return { forward: true, reason: "the check passes with the change" };
    case "regressed":
      return { forward: false, reason: "the check passed before and fails with the change" };
    case "unchanged-fail":
    case "fails":
      return { forward: false, reason: "the check still fails" };
    default:
      return { forward: false, reason: "no usable verdict" };
  }
}

export function registerSkill(input: {
  name: string;
  testsPass: boolean;
  level: "strict" | "balanced" | "trusted" | "full";
}): {
  registered: false;
  reason: string;
} {
  if (!input.testsPass) return { registered: false, reason: "tests failed" };
  if (input.level === "strict") return { registered: false, reason: "ask" };
  return { registered: false, reason: "waiting for the owner" };
}

const ADVISORIES: Array<{ name: string; note: string }> = [
  { name: "http-cache-semantics", note: "review the lock range before a bump" },
];

export function adviseDependencies(names: string[]): string[] {
  return names
    .map((name) => ADVISORIES.find((row) => row.name === name)?.note)
    .filter((note): note is string => Boolean(note));
}

export function scaffold(kind: "python" | "node" | "cpp" | "java"): { file: string; body: string } {
  if (kind === "python") return { file: "main.py", body: "print('hello')\n" };
  if (kind === "node") return { file: "main.mjs", body: "console.log('hello')\n" };
  if (kind === "cpp")
    return { file: "main.cpp", body: '#include <stdio.h>\nint main(){puts("hello");}\n' };
  return {
    file: "Main.java",
    body: 'class Main { public static void main(String[] args) { System.out.println("hello"); } }\n',
  };
}

export function ciReport(results: Array<{ name: string; ok: boolean }>): {
  status: "PASS" | "BLOCK";
  lines: string[];
} {
  const lines = results.map((row) => `${row.ok ? "PASS" : "BLOCK"} ${row.name}`);
  return { status: lines.some((line) => line.startsWith("BLOCK")) ? "BLOCK" : "PASS", lines };
}

export function developNote(request: string): string {
  if (!request.trim()) return "";
  const proposal = proposeDiff({
    paths: ["src/lib/friday/speech-core.ts"],
    diff: request,
    level: "balanced",
  });
  return proposal.merges || proposal.pushesMain ? "refused" : "review";
}
