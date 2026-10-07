/**
 * FRIDAY · autonomous sandbox access.
 *
 * This is the only surface FRIDAY herself uses to experiment: she may create
 * a scratch project, write code, install dependencies, run commands and tests,
 * read logs and prepare a change set. She can never apply anything to the
 * production FRIDAY source from here — applying stays behind the owner's
 * explicit approval in the Sandbox section.
 */
import {
  createProject,
  diffToSource,
  execCommand,
  listEngines,
  listFiles,
  loadSummary,
  readLog,
  sandboxAvailable,
  writeFile,
  type SandboxChange,
} from "@/lib/friday/sandbox-lab";

export type SandboxExperiment = {
  ok: boolean;
  projectId?: string;
  error?: string;
  steps: { step: string; ok: boolean; detail: string }[];
  changes?: SandboxChange[];
};

const SCRATCH = "friday-scratch";

/** Reuse FRIDAY's own scratch project, creating it once. */
export async function ensureScratchProject(
  template = "friday",
): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!sandboxAvailable()) return { ok: false, error: "The sandbox runs in the desktop app." };
  const summary = await loadSummary();
  const existing = summary.projects.find((p) => p.name === SCRATCH && p.exists);
  if (existing) return { ok: true, id: existing.id };
  const created = await createProject(SCRATCH, template);
  return created.ok && created.project
    ? { ok: true, id: created.project.id }
    : { ok: false, error: created.error ?? "Could not create the scratch project." };
}

/**
 * Run one autonomous experiment: optional edits, then commands, then a diff
 * of everything that would be proposed to the owner. Nothing is applied.
 */
export async function experiment({
  edits = {},
  commands = [],
  template = "friday",
}: {
  edits?: Record<string, string>;
  commands?: string[];
  template?: string;
}): Promise<SandboxExperiment> {
  const steps: SandboxExperiment["steps"] = [];
  const scratch = await ensureScratchProject(template);
  if (!scratch.ok || !scratch.id) return { ok: false, error: scratch.error ?? "no sandbox", steps };

  for (const [file, content] of Object.entries(edits)) {
    const result = await writeFile(scratch.id, file, content);
    steps.push({ step: `edit ${file}`, ok: result.ok, detail: result.error ?? "written" });
    if (!result.ok) return { ok: false, projectId: scratch.id, steps, error: result.error ?? "" };
  }

  for (const command of commands) {
    const result = await execCommand({ id: scratch.id, command });
    steps.push({
      step: command,
      ok: Boolean(result.ok),
      detail: (result.output ?? result.error ?? "").slice(-1200),
    });
    if (!result.ok) return { ok: false, projectId: scratch.id, steps };
  }

  const diff = await diffToSource(scratch.id);
  steps.push({
    step: "prepare proposal",
    ok: diff.ok,
    detail: diff.ok
      ? `${diff.changes?.length ?? 0} proposed change(s)`
      : (diff.error ?? "diff failed"),
  });
  return {
    ok: diff.ok && steps.every((s) => s.ok),
    projectId: scratch.id,
    steps,
    ...(diff.changes ? { changes: diff.changes } : {}),
  };
}

/** Read-only snapshot FRIDAY can quote in chat. */
export async function sandboxDigest(): Promise<string> {
  if (!sandboxAvailable()) return "Sandbox: desktop app only.";
  const summary = await loadSummary();
  const lines = [
    `Sandbox root: ${summary.base ?? "unknown"}`,
    `Projects: ${summary.projects.map((p) => p.name).join(", ") || "none"}`,
    `Applied upgrades: ${summary.applies.length}`,
  ];
  const engines = await listEngines();
  if (engines.selected) {
    lines.push(
      `Active engine: ${engines.selected.label} (${engines.selected.id})${
        engines.selected.isolated ? " · isolated" : " · not OS-isolated"
      }`,
    );
    if (engines.selected.warning) lines.push(engines.selected.warning);
  }
  if (engines.edition?.platform === "win32" && !engines.edition.windowsSandboxEligible) {
    lines.push(
      engines.edition.home
        ? "Windows Sandbox excluded: this PC is Windows Home."
        : "Windows Sandbox excluded: this Windows edition cannot run it.",
    );
  }
  const scratch = summary.projects.find((p) => p.name === SCRATCH);
  if (scratch) {
    const files = await listFiles(scratch.id);
    lines.push(`Scratch files: ${files.files?.filter((f) => !f.dir).length ?? 0}`);
    const log = await readLog(scratch.id);
    if (log) lines.push(`Last scratch log: ${log.trim().split("\n").slice(-1)[0]}`);
  }
  try {
    const { formatSandboxExtra, sandboxSnapshot } = await import("./sandbox-awareness");
    const snap = sandboxSnapshot();
    if (snap.projectId || snap.output) lines.push(formatSandboxExtra(800));
  } catch {
    /* renderer session store */
  }
  return lines.join("\n");
}

/** FRIDAY never applies on her own — the owner approves in the Sandbox section. */
export const AUTONOMOUS_APPLY_ALLOWED = false;
