/**
 * FRIDAY · self-maintenance bridge
 *
 * Typed access to the desktop `self:*` channels. Everything here reflects real
 * files, real sandbox runs and real builds; in the browser preview the calls
 * resolve to null so the UI stays usable without pretending anything happened.
 */

export type ImpactVerdict = "hot-reload" | "restart" | "rebuild" | "blocked";

export type ImpactFile = {
  path: string;
  state: "added" | "changed" | "deleted";
  area: string;
  verdict: ImpactVerdict;
};

export type ImpactEntry = {
  id: string;
  at: number;
  verdict: ImpactVerdict;
  areas: string[];
  files: ImpactFile[];
  dependents: string[];
  dependentCount: number;
  entryPoints: string[];
  blockers: { file: string; reason: string }[];
  reasons: string[];
  summary: string;
  state: "pending" | "running" | "applied" | "failed" | "rolled-back" | "blocked" | "needs-install";
};

export type IndexSummary = {
  at: number;
  root: string;
  totals: { files: number; edges: number; broken: number };
  areas: Record<string, number>;
  entryPoints: string[];
  broken: { file: string; specifier: string }[];
  externals: number;
};

export type SelfProgress = {
  id: string;
  stage: string;
  status: "running" | "done" | "failed" | "skipped";
  detail: string;
  at: number;
};

export type ApplyResult = {
  ok: boolean;
  error?: string;
  verdict?: ImpactVerdict;
  artifact?: string | null;
  restartRequired?: boolean;
  rolledBack?: boolean;
  backup?: { dir: string; entries: string[] };
  verification?: {
    ok: boolean;
    checks: { id: string; label: string; ok: boolean; detail: string }[];
  };
  health?: { ok: boolean; detail: string };
};

/** A verify-only sandbox run: the same checks as an apply, nothing written. */
export type VerifyResult = {
  ok: boolean;
  dir?: string | null;
  checks: { id: string; label: string; ok: boolean; detail: string }[];
  error?: string;
};

/** One file of FRIDAY's own project, read through the desktop bridge. */
export type SourceFile = {
  ok: true;
  path: string;
  size: number;
  modifiedAt: number;
  lines: number;
  text: string;
};

export type SourceEntry = {
  name: string;
  path: string;
  kind: "dir" | "file";
  readable: boolean;
};

export type SourceMatch = { path: string; line: number; text: string };

export type SourceFailure = { ok: false; error: string };

type Bridge = {
  selfState?: () => Promise<{ pending: ImpactEntry[]; index: IndexSummary | null; busy: boolean }>;
  selfIndex?: (rebuild?: boolean) => Promise<IndexSummary | null>;
  selfScan?: () => Promise<{ changes: number; assessment: ImpactEntry | null }>;
  selfApply?: (id: string, mode: "auto" | "manual") => Promise<ApplyResult>;
  selfRollback?: (backup: unknown) => Promise<{ ok: boolean; error?: string }>;
  selfVerify?: (areas?: string[]) => Promise<VerifyResult>;
  selfHealth?: () => Promise<{ ok: boolean; detail: string }>;
  selfReadSource?: (relative: string) => Promise<SourceFile | SourceFailure>;
  selfListSource?: (
    relative: string,
  ) => Promise<{ ok: true; path: string; entries: SourceEntry[] } | SourceFailure>;
  selfSearchSource?: (
    query: string,
    options?: { limit?: number; under?: string },
  ) => Promise<
    | { ok: true; query: string; scanned: number; truncated: boolean; matches: SourceMatch[] }
    | SourceFailure
  >;
  onSelfImpact?: (fn: (entry: ImpactEntry) => void) => () => void;
  onSelfIndex?: (fn: (summary: IndexSummary) => void) => () => void;
  onSelfProgress?: (fn: (progress: SelfProgress) => void) => () => void;
};

const bridge = (): Bridge | undefined =>
  typeof window === "undefined" ? undefined : (window.friday as unknown as Bridge | undefined);

export const selfBridgeAvailable = () => Boolean(bridge()?.selfApply);

/** True when FRIDAY can read her own source right now (installed desktop app). */
export const sourceAccessAvailable = () => Boolean(bridge()?.selfReadSource);

export const selfIndex = (rebuild = false) =>
  bridge()?.selfIndex?.(rebuild) ?? Promise.resolve(null);
export const selfScan = () => bridge()?.selfScan?.() ?? Promise.resolve(null);
export const selfState = () => bridge()?.selfState?.() ?? Promise.resolve(null);
export const selfHealth = () => bridge()?.selfHealth?.() ?? Promise.resolve(null);
export const selfRollback = (backup: unknown) =>
  bridge()?.selfRollback?.(backup) ??
  Promise.resolve({ ok: false, error: "Desktop app required." });

/**
 * Run the sandbox checks WITHOUT applying anything, so a self-improvement
 * candidate can be compared against the last known-good baseline before the
 * owner is asked to approve it.
 */
export const selfVerify = (areas: string[] = []): Promise<VerifyResult> =>
  bridge()?.selfVerify?.(areas) ??
  Promise.resolve<VerifyResult>({
    ok: false,
    checks: [],
    error: "Verification runs in the installed FRIDAY desktop app.",
  });

const NO_DESKTOP: SourceFailure = {
  ok: false,
  error: "Reading my own source needs the installed FRIDAY desktop app.",
};

/** Read one file of FRIDAY's own project. Read-only — writes go through selfApply. */
export const readSource = (relative: string): Promise<SourceFile | SourceFailure> =>
  bridge()?.selfReadSource?.(relative) ?? Promise.resolve(NO_DESKTOP);

export const listSource = (relative = "") =>
  bridge()?.selfListSource?.(relative) ?? Promise.resolve(NO_DESKTOP);

export const searchSource = (query: string, options?: { limit?: number; under?: string }) =>
  bridge()?.selfSearchSource?.(query, options) ?? Promise.resolve(NO_DESKTOP);

export const selfApply = (id: string, mode: "auto" | "manual") =>
  bridge()?.selfApply?.(id, mode) ??
  Promise.resolve<ApplyResult>({
    ok: false,
    error: "Self-maintenance runs in the installed FRIDAY desktop app.",
  });

export const onSelfImpact = (fn: (entry: ImpactEntry) => void) => bridge()?.onSelfImpact?.(fn);
export const onSelfIndexUpdate = (fn: (summary: IndexSummary) => void) =>
  bridge()?.onSelfIndex?.(fn);
export const onSelfProgress = (fn: (progress: SelfProgress) => void) =>
  bridge()?.onSelfProgress?.(fn);

/** Plain-language explanation of a verdict, used in proposals and prompts. */
export function explainVerdict(verdict: ImpactVerdict): string {
  switch (verdict) {
    case "hot-reload":
      return "Workspace content only — FRIDAY can load it while running.";
    case "restart":
      return "Runtime code changed — FRIDAY needs a restart to load it.";
    case "rebuild":
      return "Packaged code changed — FRIDAY must rebuild and reinstall herself.";
    default:
      return "The change references something that does not resolve, so it cannot be applied safely.";
  }
}
