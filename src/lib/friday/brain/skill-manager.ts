/**
 * FRIDAY · skill manager
 *
 * The owner can already manage skills on the Skills page. This is the same management through chat: "what skills
 * do you have", "disable the secret scan skill", "turn on log triage", "remove the xyz skill", "install skills
 * from https://github.com/owner/repo". It is deliberately narrow: a command must name the word "skill" (or ask
 * for the list), so ordinary conversation never changes anything.
 *
 * Reading is free. Anything that changes the installed set (enable, disable, remove, install) goes through the
 * same owner approval gate as the Skills page (governance), and a request that is still waiting for approval is
 * reported as filed, never as done. Skills that ship with FRIDAY cannot be removed, only switched off.
 */
import { installSkillGit, uninstallPack, type CapabilityVerification } from "../marketplace";
import { listCapabilities, setCapabilityEnabled } from "../capability-trees";
import { governance } from "../self/governance";
import { listSkills, setSkillEnabled } from "./skill-forge";

export type SkillCommand =
  | { kind: "list"; query: string }
  | { kind: "info"; target: string }
  | { kind: "enable" | "disable" | "remove"; target: string }
  | { kind: "install"; url: string };

export type ManagedSkill = {
  /** The id the runtime and the router use (the folder name). */
  id: string;
  name: string;
  category: string;
  enabled: boolean;
  summary: string;
  /** Ships with FRIDAY (app folder) or is a built-in tool; neither can be removed. */
  shipped: boolean;
  /** The capability id (`skills/core/<id>`) the Skills page toggles, when the skill is a folder pack. */
  capabilityId: string | null;
  risk: string;
  /** Other names people use for it: the trigger phrases and the names of the tools inside a merged skill. */
  aliases?: string[] | undefined;
};

export type GateOutcome = { state: "done" | "waiting" | "rejected" | "failed"; detail: string };

export type SkillManagerHost = {
  list(): Promise<ManagedSkill[]>;
  setEnabled(skill: ManagedSkill, enabled: boolean): Promise<{ ok: boolean; error?: string }>;
  remove(skill: ManagedSkill): Promise<{ ok: boolean; error?: string }>;
  installGit(url: string): Promise<{ ok: boolean; error?: string; installed?: string[] }>;
  gate(
    title: string,
    rationale: string,
    risk: "safe" | "review" | "risky",
    evidence: string[],
    apply: () => Promise<{ ok: boolean; detail: string }>,
  ): Promise<GateOutcome>;
};

export type SkillManagementResult = {
  handled: true;
  kind: SkillCommand["kind"];
  ok: boolean;
  /** What FRIDAY should answer from: plain facts, no markup. */
  text: string;
};

const SKILL_WORD = /\bskills?\b/i;

const stripFiller = (text: string) =>
  text
    .replace(/\b(?:please|friday|can you|could you|kindly|zara|na)\b/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:.-]+/, "")
    .trim();

/** Words that name the target: "the secret scan skill" -> "secret scan". */
function cleanTarget(raw: string): string {
  return raw
    .replace(/^(?:the|my|a|an|ye|woh|wo)\s+/i, "")
    .replace(/\s+(?:skill|skills)$/i, "")
    .replace(/^(?:skill|skills)\s+(?:called|named)?\s*/i, "")
    .replace(/["'`.!?]+$/g, "")
    .replace(/^["'`]+/g, "")
    .trim();
}

/**
 * Phrase -> command, or null. English and Hinglish. A mutating command needs a named skill AND the word "skill";
 * the list needs the word "skills" next to a showing or asking word.
 */
export function parseSkillCommand(prompt: string): SkillCommand | null {
  const text = stripFiller(prompt);
  if (!text || text.length > 400) return null;
  const lower = text.toLowerCase();

  const url = text.match(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?\b/i);
  if (
    url &&
    SKILL_WORD.test(lower) &&
    /\b(install|add|import|clone|download|le aao|lagao)\b/.test(lower)
  ) {
    return { kind: "install", url: url[0] };
  }

  // enable / disable / remove, English: "disable the secret scan skill", "turn off skill secret scan"
  const verb =
    "(enable|disable|activate|deactivate|turn on|turn off|switch on|switch off|remove|uninstall|delete)";
  let m = lower.match(new RegExp(`^${verb}\\s+(?:the\\s+|my\\s+)?(.{2,80}?)\\s+skill\\s*[.!]?$`));
  if (!m)
    m = lower.match(
      new RegExp(`^${verb}\\s+(?:the\\s+)?skill\\s+(?:called\\s+|named\\s+)?(.{2,80}?)\\s*[.!]?$`),
    );
  if (m) {
    const word = m[1]!;
    const kind = /^(?:enable|activate|turn on|switch on)$/.test(word)
      ? "enable"
      : /^(?:disable|deactivate|turn off|switch off)$/.test(word)
        ? "disable"
        : "remove";
    const target = cleanTarget(m[2]!);
    return target ? { kind, target } : null;
  }
  // Hinglish: "secret scan skill on karo", "log triage skill band karo", "secret scan skill hatao"
  m = lower.match(
    /^(.{2,80}?)\s+skill\s+(?:ko\s+)?(on|off|chalu|band|shuru|hatao|delete|remove)(?:\s+kar(?:o|do|na)?)?\s*[.!]?$/,
  );
  if (m) {
    const word = m[2]!;
    const kind = /^(?:on|chalu|shuru)$/.test(word)
      ? "enable"
      : /^(?:off|band)$/.test(word)
        ? "disable"
        : "remove";
    const target = cleanTarget(m[1]!);
    return target ? { kind, target } : null;
  }

  // info: "what does the gst calculator skill do", "tell me about the secret scan skill"
  m =
    lower.match(
      /^(?:what does|what is|tell me about|explain|describe|details of|info on)\s+(?:the\s+)?(.{2,80}?)\s+skill(?:\s+do)?\s*[?.!]?$/,
    ) ??
    lower.match(
      /^(.{2,80}?)\s+skill\s+(?:kya karta hai|kya hai|ke bare mein batao|batao)\s*[?.!]?$/,
    );
  if (m) {
    const target = cleanTarget(m[1]!);
    return target ? { kind: "info", target } : null;
  }

  // list
  if (SKILL_WORD.test(lower)) {
    const asks =
      /^(?:list|show|display|give me|show me|tell me)\s+(?:me\s+)?(?:all\s+|my\s+|your\s+|the\s+|installed\s+|active\s+|enabled\s+|available\s+)*(?:\w+\s+)?skills\b/.test(
        lower,
      ) ||
      /\b(?:what|which)\s+(?:\w+\s+)?skills\s+(?:do you have|are installed|are enabled|are active|are available|can you use|have you got)\b/.test(
        lower,
      ) ||
      /\bhow many skills\b/.test(lower) ||
      /\b(?:your|my)\s+skills\s*(?:list)?\s*[?.!]?$/.test(lower) ||
      /\bskills\s+(?:list|dikhao|batao|dikha do|bata do)\b/.test(lower) ||
      /\bkaun\s+kaun\s+se\s+skills?\b/.test(lower) ||
      /\b(?:installed|enabled|active)\s+skills\b/.test(lower);
    if (asks) {
      const query = lower
        .replace(
          /\b(?:list|show|display|give|me|tell|all|my|your|the|installed|active|enabled|available|what|which|skills?|do|you|have|are|can|use|how|many|please|dikhao|batao)\b/g,
          " ",
        )
        .replace(/[?.!,]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return { kind: "list", query };
    }
  }
  return null;
}

type Match = { skill: ManagedSkill } | { candidates: ManagedSkill[] } | { none: true };

/** A skill by id or name: exact first, then a single partial match. */
export function resolveSkill(target: string, skills: ManagedSkill[]): Match {
  const want = target.toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  const norm = (s: string) => s.toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  const exact = skills.filter((s) => norm(s.id) === want || norm(s.name) === want);
  if (exact.length === 1) return { skill: exact[0]! };
  if (exact.length > 1) return { candidates: exact };
  const partial = skills.filter(
    (s) => norm(s.name).includes(want) || norm(s.id).includes(want) || want.includes(norm(s.name)),
  );
  if (partial.length === 1) return { skill: partial[0]! };
  if (partial.length > 1) return { candidates: partial.slice(0, 6) };
  // "the secret scan skill" is a tool inside Content safety scan: its trigger phrases and tool names count.
  const byAlias = skills.filter((s) => (s.aliases ?? []).some((a) => norm(a) === want));
  if (byAlias.length === 1) return { skill: byAlias[0]! };
  if (byAlias.length > 1) return { candidates: byAlias.slice(0, 6) };
  return { none: true };
}

const line = (s: ManagedSkill) => `${s.name} (${s.id})${s.enabled ? "" : " - off"}`;

export function describeCatalog(skills: ManagedSkill[], query = ""): string {
  const needle = query.trim().toLowerCase();
  const pool = needle
    ? skills.filter(
        (s) =>
          `${s.name} ${s.id} ${s.category} ${s.summary}`.toLowerCase().includes(needle) ||
          (needle === "installed" && !s.shipped) ||
          (needle === "enabled" && s.enabled) ||
          (needle === "active" && s.enabled),
      )
    : skills;
  const on = pool.filter((s) => s.enabled);
  const off = pool.filter((s) => !s.enabled);
  const byCategory = new Map<string, ManagedSkill[]>();
  for (const s of on)
    byCategory.set(s.category || "other", [...(byCategory.get(s.category || "other") ?? []), s]);
  const lines = [
    `${skills.length} skill(s) in total: ${skills.filter((s) => s.enabled).length} on, ${skills.filter((s) => !s.enabled).length} off; ${skills.filter((s) => s.shipped).length} ship with FRIDAY, ${skills.filter((s) => !s.shipped).length} were installed.`,
  ];
  if (needle && !pool.length) lines.push(`No skill matches "${query}".`);
  if (needle && pool.length) lines.push(`Matching "${query}": ${pool.length}.`);
  for (const [category, list] of [...byCategory.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    lines.push(
      `${category} (on): ${list
        .slice(0, 14)
        .map((s) => s.name)
        .join(", ")}${list.length > 14 ? `, and ${list.length - 14} more` : ""}`,
    );
  }
  if (off.length)
    lines.push(
      `Off (${off.length}): ${off
        .slice(0, 12)
        .map((s) => s.name)
        .join(
          ", ",
        )}${off.length > 12 ? ", ..." : ""}. Say "enable the <name> skill" to switch one on.`,
    );
  return lines.join("\n");
}

function describeSkill(skill: ManagedSkill): string {
  return `${skill.name} (id ${skill.id}, category ${skill.category || "none"}): ${skill.summary || "no summary"}. It is ${skill.enabled ? "on" : "off"}, ${skill.shipped ? "ships with FRIDAY" : "was installed by the owner"}, risk ${skill.risk}. Say "run the ${skill.name} skill" or describe the task to use it.`;
}

function ambiguous(target: string, candidates: ManagedSkill[]): string {
  return `More than one skill matches "${target}": ${candidates.map(line).join("; ")}. Ask the owner which one.`;
}

export async function manageSkills(
  prompt: string,
  host: SkillManagerHost = defaultHost,
): Promise<SkillManagementResult | null> {
  const command = parseSkillCommand(prompt);
  if (!command) return null;
  const result = (ok: boolean, text: string): SkillManagementResult => ({
    handled: true,
    kind: command.kind,
    ok,
    text,
  });
  const skills = await host.list();

  if (command.kind === "list") return result(true, describeCatalog(skills, command.query));

  if (command.kind === "install") {
    const out = await host.gate(
      `Install skills from ${command.url}`,
      `Clones ${command.url} and installs the skill packs found in it. Each pack is verified and sandbox-tested, and stays off until it passes.`,
      "review",
      [`url:${command.url}`],
      async () => {
        const r = await host.installGit(command.url);
        return {
          ok: r.ok,
          detail: r.ok
            ? `installed ${(r.installed ?? []).join(", ") || "the packs"}`
            : (r.error ?? "install failed"),
        };
      },
    );
    return result(
      out.state === "done" || out.state === "waiting",
      gateText(`Installing skills from ${command.url}`, out),
    );
  }

  const found = resolveSkill(command.target, skills);
  // "what is your best skill" names no skill: a question about the word, not a command, so it is left to chat.
  if ("none" in found && command.kind === "info") return null;
  if ("none" in found)
    return result(
      false,
      `No skill is called "${command.target}". ${describeCatalog(skills).split("\n")[0]}`,
    );
  if ("candidates" in found) return result(false, ambiguous(command.target, found.candidates));
  const skill = found.skill;

  if (command.kind === "info") return result(true, describeSkill(skill));

  if (command.kind === "remove") {
    if (skill.shipped) {
      return result(
        false,
        `${skill.name} ships with FRIDAY, so it cannot be removed. It can be switched off: say "disable the ${skill.name} skill".`,
      );
    }
    const out = await host.gate(
      `Remove skill - ${skill.name}`,
      `Deletes the installed pack ${skill.id} from this workspace. Shipped skills are refused. This cannot be undone from chat.`,
      "risky",
      [`capability:${skill.capabilityId ?? skill.id}`],
      async () => {
        const r = await host.remove(skill);
        return { ok: r.ok, detail: r.ok ? `removed ${skill.id}` : (r.error ?? "remove failed") };
      },
    );
    return result(
      out.state === "done" || out.state === "waiting",
      gateText(`Removing ${skill.name}`, out),
    );
  }

  const enable = command.kind === "enable";
  if (skill.enabled === enable)
    return result(true, `${skill.name} is already ${enable ? "on" : "off"}. Nothing changed.`);
  const out = await host.gate(
    `${enable ? "Enable" : "Disable"} skill - ${skill.name}`,
    enable
      ? `Turns ${skill.name} on in the capability index and the skill runtime. Disabled skills stay listed; they do not auto-run.`
      : `Turns ${skill.name} off in the capability index and the skill runtime.`,
    "review",
    [`capability:${skill.capabilityId ?? skill.id}`],
    async () => {
      const r = await host.setEnabled(skill, enable);
      return {
        ok: r.ok,
        detail: r.ok ? (enable ? "enabled" : "disabled") : (r.error ?? "could not change it"),
      };
    },
  );
  return result(
    out.state === "done" || out.state === "waiting",
    gateText(`${enable ? "Enabling" : "Disabling"} ${skill.name}`, out),
  );
}

function gateText(what: string, out: GateOutcome): string {
  if (out.state === "done") return `${what}: done (${out.detail}).`;
  if (out.state === "waiting")
    return `${what}: the request is filed and waits for the owner's approval in Self-management (${out.detail}). It has NOT been done yet; do not say it is.`;
  if (out.state === "rejected") return `${what}: the owner did not approve it, so nothing changed.`;
  return `${what}: failed (${out.detail}).`;
}

const slug = (id: string) => id.split("/").filter(Boolean).pop() ?? id;

/** The real host: the same registries, IPC and approval gate the Skills page uses. */
export const defaultHost: SkillManagerHost = {
  async list() {
    const [runtime, caps] = await Promise.all([
      listSkills().catch(() => []),
      listCapabilities().catch(() => null),
    ]);
    const byId = new Map<string, ManagedSkill>();
    for (const item of caps?.items ?? []) {
      if (item.tree !== "skills") continue;
      const id = slug(item.id);
      const runtimeSkill = runtime.find((r) => r.id === id);
      byId.set(id, {
        id,
        aliases: (runtimeSkill as { triggers?: string[] } | undefined)?.triggers,
        name: item.name,
        category: item.category || item.segment,
        enabled: item.enabled,
        summary: item.summary || item.description || "",
        shipped: item.origin === "app",
        capabilityId: item.id,
        risk: item.risk || "safe",
      });
    }
    for (const skill of runtime) {
      if (byId.has(skill.id)) continue;
      byId.set(skill.id, {
        id: skill.id,
        aliases: (skill as { triggers?: string[] }).triggers,
        name: skill.name,
        category: skill.category,
        enabled: skill.enabled,
        summary: skill.summary,
        shipped: Boolean(skill.builtin),
        capabilityId: null,
        risk: skill.risk,
      });
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  },
  async setEnabled(skill, enabled) {
    if (!skill.capabilityId)
      return {
        ok: false,
        error: "This is a built-in tool, not a skill pack, so it has no switch here.",
      };
    const toggled = await setCapabilityEnabled(skill.capabilityId, enabled);
    if (!toggled) return { ok: false, error: "Could not update the capability index." };
    const runtime = await setSkillEnabled(skill.id, enabled);
    return runtime.ok
      ? { ok: true }
      : { ok: false, error: runtime.error || "Could not update the skill runtime." };
  },
  async remove(skill) {
    if (!skill.capabilityId) return { ok: false, error: "Nothing to remove." };
    const r = await uninstallPack(skill.capabilityId);
    return r?.ok ? { ok: true } : { ok: false, error: r?.error || "Uninstall failed." };
  },
  async installGit(url) {
    const r = await installSkillGit(url);
    if (!r?.ok) return { ok: false, error: r?.error || "Install failed." };
    const list = (r as { verification?: CapabilityVerification[] }).verification ?? [];
    return { ok: true, installed: list.map((v) => String(v.id ?? "")).filter(Boolean) };
  },
  async gate(title, rationale, risk, evidence, apply) {
    // Submitted without waiting for the owner: a chat turn must not hang on a prompt. A request that settles at
    // once (Full autonomy, or a safe change) is reported as done; one that is still waiting is reported as filed.
    const submitted = governance.submit({
      kind: "install",
      title,
      rationale,
      risk,
      evidence,
      apply,
    });
    submitted.catch(() => undefined);
    const settled = await Promise.race([
      submitted,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2500)),
    ]);
    if (!settled) return { state: "waiting", detail: "it applies when approved" };
    if (settled.stage === "rejected") return { state: "rejected", detail: "not approved" };
    if (settled.stage !== "completed")
      return { state: "failed", detail: settled.error || "the change did not complete" };
    return { state: "done", detail: "applied" };
  },
};

/** The chat turn's entry: handled commands answer from `text`; anything else is left to the normal routers. */
export async function manageSkillsFromPrompt(
  prompt: string,
): Promise<SkillManagementResult | null> {
  try {
    return await manageSkills(prompt);
  } catch (error) {
    return {
      handled: true,
      kind: "list",
      ok: false,
      text: `Skill management failed: ${String((error as Error)?.message ?? error)}`,
    };
  }
}
