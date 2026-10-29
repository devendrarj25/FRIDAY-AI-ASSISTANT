/**
 * FRIDAY · Hub development bridge.
 *
 * Friday Hub is repo control: inspect the source, review a change set handed
 * over by Import & Build, validate it, branch, push and open a pull request.
 * It deliberately does not update, release or install anything — those live in
 * `github-updates.ts` (update) and the release controls (official release).
 */

export type ChangeSetStatus = "queued" | "branched" | "pushed" | "pr-open" | "done";

export interface DevChangeSet {
  id: string;
  title: string;
  summary: string;
  origin: string;
  kind: string;
  files: string[];
  fileCount: number;
  problems: string[];
  tested: boolean;
  testSummary: string;
  stagedPath: string | null;
  status: ChangeSetStatus;
  branch: string | null;
  pullRequest: { number?: number; url?: string } | null;
  createdAt: number;
  updatedAt: number;
}

export interface DevWorkspace {
  ok: boolean;
  repo: boolean;
  dir?: string | null;
  branch?: string;
  onProtectedBranch?: boolean;
  defaultBranch?: string;
  connectedRepo?: string | null;
  hasToken?: boolean;
  hubId?: string;
  hubRole?: "self" | "linked";
  hubLabel?: string;
  changes?: Array<{ state: string; path: string }>;
  dirty?: number;
  diffStat?: string;
  commits?: string[];
  branches?: string[];
  changeSets?: DevChangeSet[];
  message?: string;
}

export interface ValidationStep {
  id: string;
  label: string;
  state: "running" | "passed" | "failed" | "skipped";
  detail?: string;
}

export interface PullRequestInfo {
  number: number;
  title: string;
  branch: string;
  base: string;
  url: string;
  draft: boolean;
  mergeable: string | null;
  sha: string;
  checks: { total: number; passed: number; failed: number; pending: number };
}

interface DevBridge {
  devWorkspace?: () => Promise<DevWorkspace>;
  devDiff?: (
    file?: string | null,
  ) => Promise<{ ok: boolean; diff?: string; error?: string; empty?: boolean }>;
  devValidate?: (payload?: { steps?: string[] }) => Promise<{
    ok: boolean;
    error?: string;
    summary?: string;
    results?: ValidationStep[];
  }>;
  devBranch?: (payload: { name: string; kind?: string }) => Promise<{
    ok: boolean;
    branch?: string;
    created?: boolean;
    error?: string;
  }>;
  devPublish?: (payload: { message?: string; confirm: boolean }) => Promise<{
    ok: boolean;
    branch?: string;
    sha?: string;
    repo?: string;
    error?: string;
    protectedBranch?: boolean;
  }>;
  devOpenPullRequest?: (payload: {
    branch: string;
    title?: string;
    body?: string;
    confirm: boolean;
  }) => Promise<{
    ok: boolean;
    number?: number;
    url?: string;
    existing?: boolean;
    error?: string;
  }>;
  devPullRequests?: () => Promise<{ ok: boolean; pulls?: PullRequestInfo[]; error?: string }>;
  devChangeSets?: () => Promise<{ ok: boolean; changeSets?: DevChangeSet[] }>;
  devQueueChangeSet?: (entry: Partial<DevChangeSet>) => Promise<{
    ok: boolean;
    changeSet?: DevChangeSet;
    error?: string;
  }>;
  devUpdateChangeSet?: (
    id: string,
    patch: Partial<DevChangeSet>,
  ) => Promise<{ ok: boolean; changeSet?: DevChangeSet; error?: string }>;
  devRemoveChangeSet?: (id: string) => Promise<{ ok: boolean; changeSets?: DevChangeSet[] }>;
  devCheckoutBranch?: (payload: { name: string }) => Promise<{
    ok: boolean;
    branch?: string;
    error?: string;
    onProtectedBranch?: boolean;
  }>;
  devListFiles?: () => Promise<{ ok: boolean; files?: string[]; error?: string }>;
  devReadFile?: (file: string) => Promise<{
    ok: boolean;
    file?: string;
    content?: string;
    error?: string;
  }>;
  devWriteFile?: (payload: {
    file: string;
    content: string;
    confirm: boolean;
  }) => Promise<{ ok: boolean; file?: string; error?: string }>;
  devCommitFiles?: (payload: { message?: string; confirm: boolean }) => Promise<{
    ok: boolean;
    sha?: string;
    error?: string;
    protectedBranch?: boolean;
  }>;
  onDevValidateProgress?: (fn: (step: ValidationStep) => void) => (() => void) | void;
}

const DESKTOP_ONLY = "This action needs the FRIDAY desktop app.";

const bridge = (): DevBridge | undefined =>
  typeof window === "undefined" ? undefined : (window as unknown as { friday?: DevBridge }).friday;

/** True when the Hub can really drive git — used to disable, never to fake. */
export const devAvailable = () => Boolean(bridge()?.devWorkspace);

export const devWorkspace = async (): Promise<DevWorkspace> =>
  (await bridge()?.devWorkspace?.()) ?? { ok: false, repo: false, message: DESKTOP_ONLY };

export const devDiff = async (file?: string | null) =>
  (await bridge()?.devDiff?.(file ?? null)) ?? { ok: false, error: DESKTOP_ONLY };

export const devValidate = async (steps?: string[]) =>
  (await bridge()?.devValidate?.(steps ? { steps } : {})) ?? { ok: false, error: DESKTOP_ONLY };

export const devBranch = async (name: string, kind?: string) =>
  (await bridge()?.devBranch?.({ name, ...(kind ? { kind } : {}) })) ?? {
    ok: false,
    error: DESKTOP_ONLY,
  };

export const devPublish = async (message: string) =>
  (await bridge()?.devPublish?.({ message, confirm: true })) ?? { ok: false, error: DESKTOP_ONLY };

export const devOpenPullRequest = async (payload: {
  branch: string;
  title?: string;
  body?: string;
}) =>
  (await bridge()?.devOpenPullRequest?.({ ...payload, confirm: true })) ?? {
    ok: false,
    error: DESKTOP_ONLY,
  };

export const devPullRequests = async () =>
  (await bridge()?.devPullRequests?.()) ?? { ok: false, error: DESKTOP_ONLY };

export const devChangeSets = async () => (await bridge()?.devChangeSets?.()) ?? { ok: false };

export const devQueueChangeSet = async (entry: Partial<DevChangeSet>) =>
  (await bridge()?.devQueueChangeSet?.(entry)) ?? { ok: false, error: DESKTOP_ONLY };

export const devUpdateChangeSet = async (id: string, patch: Partial<DevChangeSet>) =>
  (await bridge()?.devUpdateChangeSet?.(id, patch)) ?? { ok: false, error: DESKTOP_ONLY };

export const devRemoveChangeSet = async (id: string) =>
  (await bridge()?.devRemoveChangeSet?.(id)) ?? { ok: false };

export const onDevValidateProgress = (fn: (step: ValidationStep) => void) =>
  bridge()?.onDevValidateProgress?.(fn);

export const devCheckoutBranch = async (name: string) =>
  (await bridge()?.devCheckoutBranch?.({ name })) ?? { ok: false, error: DESKTOP_ONLY };

export const devListFiles = async () =>
  (await bridge()?.devListFiles?.()) ?? { ok: false, error: DESKTOP_ONLY };

export const devReadFile = async (file: string) =>
  (await bridge()?.devReadFile?.(file)) ?? { ok: false, error: DESKTOP_ONLY };

export const devWriteFile = async (file: string, content: string) =>
  (await bridge()?.devWriteFile?.({ file, content, confirm: true })) ?? {
    ok: false,
    error: DESKTOP_ONLY,
  };

export const devCommitFiles = async (message: string) =>
  (await bridge()?.devCommitFiles?.({ message, confirm: true })) ?? {
    ok: false,
    error: DESKTOP_ONLY,
  };

/** The pull-request body Hub writes — the change set, stated plainly. */
export function pullRequestBody(changeSet: DevChangeSet | null, validation?: string): string {
  if (!changeSet)
    return `Prepared by FRIDAY Hub.${validation ? `\n\nValidation: ${validation}` : ""}`;
  const lines = [
    changeSet.summary || changeSet.title,
    "",
    `Origin: ${changeSet.origin}`,
    `Files: ${changeSet.fileCount}`,
  ];
  if (changeSet.files.length) {
    lines.push("", ...changeSet.files.slice(0, 40).map((file) => `- ${file}`));
    if (changeSet.files.length > 40) lines.push(`- …and ${changeSet.files.length - 40} more`);
  }
  if (changeSet.problems.length) {
    lines.push("", "Problems addressed:", ...changeSet.problems.slice(0, 20).map((p) => `- ${p}`));
  }
  if (validation) lines.push("", `Validation: ${validation}`);
  lines.push("", "Prepared by FRIDAY Hub. Merging this into main is what makes it releasable.");
  return lines.join("\n");
}

// ------------------------------------------------------- manual revert center --
// Two independent manual safety actions. Neither needs a recovery branch: both
// branch off current main, make one ordinary commit and leave a pull request.

export interface HistoryCommit {
  sha: string;
  short: string;
  author: string;
  date: string;
  subject: string;
  merge?: boolean;
}

export interface MergedPull {
  number: number;
  title: string;
  branch: string;
  base: string;
  url: string;
  author: string;
  mergedAt: string;
  sha: string;
  short: string;
}

export interface FileChange {
  state: string;
  path: string;
}

export interface CommitDetail {
  ok: boolean;
  error?: string;
  commit?: HistoryCommit & { email: string; body: string; parents: string[] };
  files?: FileChange[];
  diff?: string;
}

export interface RestorePreview {
  ok: boolean;
  error?: string;
  base?: string;
  currentSha?: string;
  currentShort?: string;
  targetSha?: string;
  targetShort?: string;
  commitsBetween?: HistoryCommit[];
  files?: FileChange[];
}

export interface SafetyResult {
  ok: boolean;
  error?: string;
  action?: "revert" | "restore";
  branch?: string;
  base?: string;
  sha?: string;
  title?: string;
  reverted?: HistoryCommit;
  preview?: RestorePreview;
}

interface SafetyBridge {
  devHistory?: (payload?: { limit?: number }) => Promise<{
    ok: boolean;
    error?: string;
    base?: string;
    baseSha?: string;
    commits?: HistoryCommit[];
  }>;
  devMergedPullRequests?: () => Promise<{ ok: boolean; error?: string; pulls?: MergedPull[] }>;
  devCommit?: (sha: string) => Promise<CommitDetail>;
  devRestorePreview?: (sha: string) => Promise<RestorePreview>;
  devRevertCommit?: (payload: {
    sha: string;
    confirm: boolean;
    label?: string;
  }) => Promise<SafetyResult>;
  devRestoreCommit?: (payload: { sha: string; confirm: boolean }) => Promise<SafetyResult>;
}

const safety = (): SafetyBridge | undefined =>
  typeof window === "undefined"
    ? undefined
    : (window as unknown as { friday?: SafetyBridge }).friday;

export const devHistory = async (limit = 40) =>
  (await safety()?.devHistory?.({ limit })) ?? { ok: false, error: DESKTOP_ONLY };

export const devMergedPullRequests = async () =>
  (await safety()?.devMergedPullRequests?.()) ?? { ok: false, error: DESKTOP_ONLY };

export const devCommit = async (sha: string) =>
  (await safety()?.devCommit?.(sha)) ?? { ok: false, error: DESKTOP_ONLY };

export const devRestorePreview = async (sha: string) =>
  (await safety()?.devRestorePreview?.(sha)) ?? { ok: false, error: DESKTOP_ONLY };

export const devRevertCommit = async (sha: string, label?: string) =>
  (await safety()?.devRevertCommit?.({ sha, confirm: true, ...(label ? { label } : {}) })) ?? {
    ok: false,
    error: DESKTOP_ONLY,
  };

export const devRestoreCommit = async (sha: string) =>
  (await safety()?.devRestoreCommit?.({ sha, confirm: true })) ?? {
    ok: false,
    error: DESKTOP_ONLY,
  };

/** The pull-request body for a revert or restore branch. */
export function safetyPullRequestBody(result: SafetyResult, validation?: string): string {
  const lines: string[] = [];
  if (result.action === "revert" && result.reverted) {
    lines.push(
      `Reverts \`${result.reverted.short}\` — ${result.reverted.subject}`,
      "",
      `Author: ${result.reverted.author}`,
      `Date: ${result.reverted.date}`,
      "",
      `Applied with \`git revert\` on a new branch off ${result.base}. No reset, no force-push.`,
    );
  } else if (result.preview) {
    const p = result.preview;
    lines.push(
      `Restores repository content to \`${p.targetShort}\`.`,
      "",
      `${p.base} was at \`${p.currentShort}\`; ${p.commitsBetween?.length ?? 0} commit(s) sit between them and all of them stay in the history.`,
      `${p.files?.length ?? 0} file(s) change.`,
    );
    if (p.files?.length) {
      lines.push("", ...p.files.slice(0, 40).map((f) => `- ${f.state} ${f.path}`));
      if (p.files.length > 40) lines.push(`- …and ${p.files.length - 40} more`);
    }
  }
  if (validation) lines.push("", `Validation: ${validation}`);
  lines.push("", "Prepared by FRIDAY Revert Center. Merge manually after review.");
  return lines.join("\n");
}
