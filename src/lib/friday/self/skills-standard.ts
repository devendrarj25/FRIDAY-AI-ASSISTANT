/**
 * FRIDAY · the Agent Skills format (SKILL.md), in and out
 *
 * An Agent Skill is a folder whose required file is `SKILL.md`: front matter with `name` and `description`,
 * then instructions. FRIDAY's learned skills are procedures in her one memory store; this module reads and
 * writes the open format so a skill can move between tools. The format has no security rules of its own, so
 * FRIDAY's are the ones that apply: an imported file is **data** until the owner accepts it and then it only
 * becomes a *candidate* that must pass held-out cases before it is ever used; the same screen as any learned
 * skill refuses orders to the assistant, downloads, secrets and safety switches; a `scripts/` folder is never
 * imported or run. Exporting writes the instructions only.
 */

import type { ProcedureStep } from "./learning-engine";
import { writeSkill, type Skill, type WriteResult } from "./skill-loop";

export type ParsedSkillMd = {
  ok: boolean;
  errors: string[];
  name: string;
  description: string;
  body: string;
  steps: ProcedureStep[];
};

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;
const MAX_FILE = 20_000;

function frontMatter(text: string): { fields: Record<string, string>; body: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^\uFEFF/, ""));
  if (!match) return null;
  const fields: Record<string, string> = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!pair) continue;
    fields[(pair[1] ?? "").toLowerCase()] = (pair[2] ?? "").trim().replace(/^["']|["']$/g, "");
  }
  return { fields, body: match[2] ?? "" };
}

function stepsOf(body: string): ProcedureStep[] {
  const steps: ProcedureStep[] = [];
  for (const line of body.split(/\r?\n/)) {
    const item = /^\s*(?:\d+[.)]|[-*])\s+(.+?)\s*$/.exec(line);
    if (!item) continue;
    const instruction = (item[1] ?? "").replace(/\*\*|__|`/g, "").trim();
    if (instruction.length < 3) continue;
    const title =
      instruction
        .split(/[.:;—-]\s/)[0]
        ?.split(/\s+/)
        .slice(0, 8)
        .join(" ") ?? instruction;
    steps.push({ title: title.slice(0, 120), instruction });
  }
  return steps;
}

export function parseSkillMd(text: string): ParsedSkillMd {
  const raw = String(text ?? "");
  const fail = (errors: string[]): ParsedSkillMd => ({
    ok: false,
    errors,
    name: "",
    description: "",
    body: "",
    steps: [],
  });
  if (!raw.trim()) return fail(["the file is empty"]);
  if (raw.length > MAX_FILE) return fail([`the file is larger than ${MAX_FILE} characters`]);
  const parsed = frontMatter(raw);
  if (!parsed)
    return fail(["no front matter: a SKILL.md starts with --- name and description ---"]);
  const errors: string[] = [];
  const name = parsed.fields["name"] ?? "";
  const description = parsed.fields["description"] ?? "";
  if (!name) errors.push("name is required");
  else if (name.length > MAX_NAME || !NAME.test(name)) {
    errors.push("name must be lowercase letters, digits and single hyphens, up to 64 characters");
  }
  if (!description) errors.push("description is required");
  else if (description.length > MAX_DESCRIPTION) {
    errors.push(`description is longer than ${MAX_DESCRIPTION} characters`);
  }
  const body = parsed.body.replace(/<!--[\s\S]*?-->/g, "").trim();
  const steps = stepsOf(body);
  if (!steps.length) errors.push("the instructions have no list of steps to follow");
  return { ok: errors.length === 0, errors, name, description, body, steps };
}

/**
 * Take an owner-chosen SKILL.md in as a candidate. It is data first: nothing here runs, and nothing becomes
 * active until held-out cases pass (`promoteCandidate`). A skill that fails FRIDAY's screen is refused with
 * the reason.
 */
export function importSkillMd(text: string): {
  parsed: ParsedSkillMd;
  written: WriteResult | null;
} {
  const parsed = parseSkillMd(text);
  if (!parsed.ok) return { parsed, written: null };
  const goal = `${parsed.name.replace(/-/g, " ")}: ${parsed.description}`.slice(0, 200);
  const written = writeSkill({
    goal,
    steps: parsed.steps.slice(0, 12),
    origin: "owner-correction",
    verified: true,
    asCandidate: true,
    source: `skill/standard:${parsed.name}`,
  });
  return { parsed, written };
}

const slug = (goal: string) =>
  goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_NAME) || "skill";

/** A learned skill as a SKILL.md: instructions only, with her bookkeeping in `metadata`. */
export function exportSkillMd(skill: Pick<Skill, "goal" | "steps" | "meta" | "utility">): string {
  const name = slug(skill.goal);
  const description =
    `${skill.goal.replace(/\s+/g, " ").trim()}. Use when the owner asks for this.`.slice(
      0,
      MAX_DESCRIPTION,
    );
  return [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "metadata:",
    `  friday-version: ${skill.meta.version}`,
    `  friday-wins: ${skill.meta.wins}`,
    `  friday-losses: ${skill.meta.losses}`,
    "---",
    "",
    `# ${skill.goal}`,
    "",
    ...skill.steps.map((step, i) => `${i + 1}. ${step.instruction}`),
    "",
  ].join("\n");
}
