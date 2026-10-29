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
