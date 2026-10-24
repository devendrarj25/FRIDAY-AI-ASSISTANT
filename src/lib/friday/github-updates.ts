/**
 * FRIDAY · GitHub update source (renderer bridge)
 *
 * Thin typed access to the `github:*` desktop channels. In the browser preview
 * every call resolves to a clear "desktop only" result rather than pretending
 * an update happened.
 */

import { memory } from "./self/memory-engine";
import { shouldSnapshotMemory } from "./settings-runtime";

export type GithubChannel = "branch" | "release";

/**
 * Update channel — which published builds this FRIDAY is allowed to see.
 *   stable → official GitHub Releases only (default)
 *   test   → test / pre-release builds only, always labelled TEST
 * The two never mix: each keeps its own installed ref, and switching back to
 * Stable hides every test build again.
 */
export type UpdateChannel = "stable" | "test";

export type GithubConfig = {
  repo: string;
  branch: string;
  channel: GithubChannel;
  updateChannel: UpdateChannel;
  autoCheck: boolean;
  intervalHours: number;
  autoApply: boolean;
  appliedRef: string | null;
  appliedAt: number;
  /** Last TEST build installed — kept apart from the stable installed ref. */
  testAppliedRef: string | null;
  testAppliedAt: number;
  lastCheck: number;
  hasToken: boolean;
  /** A read-only token kept just for updates (Friday Hub's write token is separate). */
  hasUpdateToken?: boolean;
  /** Updates are borrowing the Hub token because no update token is stored. */
  updateTokenShared?: boolean;
  history: {
    ref: string;
    at: number;
    applied: number;
    areas: string[];
    backup: string | null;
    notes?: string;
    channel?: UpdateChannel;
  }[];
};

export type GithubAsset = {
  name: string;
  url: string;
  bytes: number;
  apiUrl?: string | null;
  id?: number | null;
  /** What FRIDAY recognised this file as (installer, portable, manifest, checksums, ...). */
  kind?: string;
  label?: string;
  /** One sentence: what the file is for and what FRIDAY does with it. */
  purpose?: string;
  installable?: boolean;
};

/** One line of "what this release contains", including the full source zip. */
export type GithubFile = {
  name: string;
  bytes: number;
  kind: string;
  label: string;
  purpose: string;
  installable: boolean;
};

/** Checksums published with a release, so a download can be proven genuine. */
export type ReleaseManifest = {
  product: string;
  publisher: string;
  version: string;
  tag: string;
  publishedAt: string;
  notes: string;
  assets: { name: string; bytes: number; sha256: string; kind: string }[];
};

export type GithubCheck = {
  ok: boolean;
  error?: string;
  channel?: GithubChannel;
  updateChannel?: UpdateChannel;
  /** True when this candidate is a TEST build rather than an official release. */
  testBuild?: boolean;
  requiresExplicitInstall?: boolean;
  label?: string;
  ref?: string;
  shortRef?: string;
  version?: string;
  currentVersion?: string | null;
  title?: string;
  notes?: string;
  at?: number;
  author?: string;
  updateAvailable?: boolean;
  appliedRef?: string | null;
  assets?: GithubAsset[];
  manifest?: ReleaseManifest | null;
  verified?: boolean;
  /** Every file this release offers, named for the guide. */
  files?: GithubFile[];
  changedFiles?: { path: string; state: string; changes: number }[];
  /** The newest build published on the OTHER channel, for an explicit switch. */
  otherChannel?: GithubCrossChannel | null;
  /**
   * True when this FRIDAY is an installed/packaged app. Such a build updates
   * only from a verified release installer — the raw source "Download & apply"
   * action is hidden for it.
   */
  packaged?: boolean;
};

/**
 * A build from the channel the installed FRIDAY is not following. It is never
 * offered as "the" update and never installed automatically — the owner has to
 * choose it, which also moves this install to that channel.
 */
export type GithubCrossChannel = {
  ref: string;
  shortRef: string;
  version: string;
  testBuild: boolean;
  updateChannel: UpdateChannel;
  label: string;
  title: string;
  notes: string;
  at: number;
  author: string;
  assets: GithubAsset[];
  manifest: ReleaseManifest | null;
  verified: boolean;
  files?: GithubFile[];
  requiresChannelSwitch: true;
};

/** A release install in flight, and the last version that started up healthy. */
export type UpdateState = {
  ok: boolean;
  version?: string;
  pending?: {
    state: string;
    version?: string;
    from?: string;
    installer?: string;
    backup?: string;
    attempts?: number;
  } | null;
  stable?: { version: string; installer: string | null; at: number } | null;
};

/** Result of the launch health check after an update was installed. */
export type UpdateHealth = {
  ok: boolean;
  state: "stable" | "updated" | "failed" | "no-root";
  version?: string;
  expected?: string;
  running?: string;
  backup?: string | null;
  previousInstaller?: string | null;
  message?: string;
};

/** What a source push would send — development only, never a release. */
export type SourceStatus = {
  ok: boolean;
  repo?: boolean;
  branch?: string;
  changes?: { state: string; path: string }[];
  dirty?: number;
  ahead?: number;
  autoPush?: boolean;
  message?: string;
};

/** Whether GitHub already holds the exact commit this PC has. */
export type SourceSync = SourceStatus & {
  synced?: boolean;
  localSha?: string;
  remoteSha?: string;
  error?: string;
};

/** One published GitHub Release (the official released version). */
export type GithubRelease = {
  tag: string;
  name: string;
  version: string;
  notes: string;
  draft: boolean;
  prerelease: boolean;
  at: number;
  url: string;
  assets: GithubAsset[];
};

/** One GitHub Release that publishes a Windows installer on the current channel. */
export type InstallerBundle = {
  tag: string;
  name: string;
  version: string;
  notes: string;
  at: number;
  url: string;
  testBuild: boolean;
  updateChannel: UpdateChannel;
  installer: GithubAsset;
};

export type ReleaseType = "auto" | "revision" | "patch" | "minor" | "major" | "extreme";

/** The two manual stages of the one official release workflow. */
export type ReleaseStage = "prepare" | "publish";

/** The release Pull Request behind the current stage. */
export type ReleasePullRequest = {
  number: number;
  url: string;
  branch: string;
  version: string;
  tag: string;
  state: string;
  merged: boolean;
  mergeCommit: string;
  released: boolean;
  at: number;
};

export type ReleaseStatus = {
  ok: boolean;
  error?: string;
  stage?: ReleaseStage;
  pr?: ReleasePullRequest | null;
};

/** What a release would produce right now — same engine CI uses. */
export type ReleaseAnalysis = {
  ok: boolean;
  error?: string;
  previous?: string | null;
  branch?: string;
  latest?: GithubRelease | null;
  bump?: ReleaseType;
  version?: string;
  tag?: string;
  commits?: number;
  sections?: { name: string; items: string[] }[];
  /** Commits with no conventional header — listed, never used to bump. */
  ambiguous?: string[];
  /** True when auto resolved to PATCH / FIX from classified commits. */
  safeDefault?: boolean;
  notes?: string;
};

export type ReleaseRun = {
  id: number;
  status: string;
  conclusion: string | null;
  at: number;
  url: string;
  title: string;
};

export type GithubTest = {
  ok: boolean;
  error?: string;
  repo?: string;
  private?: boolean;
  defaultBranch?: string;
  pushedAt?: string;
  authenticated?: boolean;
  /** What the stored token is actually allowed to do on this repository. */
  permissions?: { contents: boolean; actions: boolean; releaseWorkflow: boolean };
  canRelease?: boolean;
  warning?: string;
  /** Which stored token the check used: the update token, the shared Hub token, or none. */
  tokenKind?: "update" | "shared" | "none";
  /** What that token may do: read-only is the safe answer. */
  tokenScope?: "none" | "read-only" | "write-capable";
  latestOfficial?: GithubReleaseSummary | null;
  latestTest?: GithubReleaseSummary | null;
  releasesChecked?: number;
  notes?: string[];
};

export type GithubReleaseSummary = {
  tag: string;
  title: string;
  at: number;
  files: number;
};

/** The persistent GitHub session FRIDAY restores herself on every startup. */
export type GithubConnectionState =
  "unknown" | "not-configured" | "connected" | "auth-failed" | "reauth-required" | "offline";

export type GithubConnection = {
  state: GithubConnectionState;
  repo?: string;
  private?: boolean;
  message?: string;
  canRelease?: boolean;
  hasToken?: boolean;
  at?: number;
};

type Bridge = {
  githubConfig?: () => Promise<GithubConfig>;
  githubSetConfig?: (
    patch: Partial<GithubConfig> & { token?: string | null; updateToken?: string | null },
  ) => Promise<{
    ok: boolean;
    error?: string;
    config?: GithubConfig;
  }>;
  githubTest?: (override?: Record<string, unknown>) => Promise<GithubTest>;
  githubConnection?: (refresh?: boolean) => Promise<GithubConnection>;

  githubCheck?: (override?: Record<string, unknown>) => Promise<GithubCheck>;
  githubPull?: (
    ref?: string | null,
    options?: { contentOnly?: boolean },
  ) => Promise<Record<string, unknown>>;
  githubRecord?: (payload: Record<string, unknown>) => Promise<{ ok: boolean }>;
  githubDownloadInstaller?: (asset?: {
    url?: string | undefined;
    apiUrl?: string | null | undefined;
    id?: number | null | undefined;
    name?: string | undefined;
    bytes?: number | undefined;
    /** The asset belongs to a TEST build — its checksum lives in that release. */
    testBuild?: boolean | undefined;
  }) => Promise<{
    ok: boolean;
    error?: string;
    file?: string;
    bytes?: number;
    sha256?: string;
    verified?: boolean;
    cancelled?: boolean;
    resumable?: boolean;
    reused?: boolean;
  }>;
  githubCancelDownload?: () => Promise<{ ok: boolean; cancelled?: boolean }>;
  githubRunInstaller?: (file: string) => Promise<{ ok: boolean; error?: string }>;
  githubInstallUpdate?: (payload: Record<string, unknown>) => Promise<{
    ok: boolean;
    error?: string;
    unverified?: boolean;
    channelMismatch?: boolean;
    requiresChannelSwitch?: boolean;
    fromChannel?: UpdateChannel;
    toChannel?: UpdateChannel;
    requiresTestConfirmation?: boolean;
    backup?: string;
    launched?: string;
    staged?: boolean;
    verified?: boolean;
  }>;
  githubUpdateState?: () => Promise<UpdateState>;
  githubRollback?: (backup?: string | null) => Promise<{
    ok: boolean;
    error?: string;
    restored?: string[];
    previousInstaller?: string | null;
  }>;
  githubSourceStatus?: () => Promise<SourceStatus>;
  githubSourceSync?: () => Promise<SourceSync>;
  githubPushSource?: (input: Record<string, unknown>) => Promise<{
    ok: boolean;
    error?: string;
    pushed?: boolean;
    message?: string;
  }>;
  githubPushAndSync?: (input: Record<string, unknown>) => Promise<{
    ok: boolean;
    error?: string;
    pushed?: boolean;
    synced?: boolean;
    remoteSha?: string;
    message?: string;
  }>;

  onGithubUpdateHealth?: (fn: (health: UpdateHealth) => void) => (() => void) | void;
  onGithubDownloadProgress?: (
    fn: (progress: UpdateDownloadProgress) => void,
  ) => (() => void) | void;
  githubReleases?: (override?: Record<string, unknown>) => Promise<{
    ok: boolean;
    error?: string;
    releases?: GithubRelease[];
    latest?: GithubRelease | null;
  }>;
  githubInstallerBundles?: (override?: Record<string, unknown>) => Promise<{
    ok: boolean;
    error?: string;
    channel?: UpdateChannel;
    bundles?: InstallerBundle[];
  }>;
  githubAnalyze?: (override?: Record<string, unknown>) => Promise<ReleaseAnalysis>;
  githubDispatchRelease?: (input: Record<string, unknown>) => Promise<{
    ok: boolean;
    error?: string;
    localChanges?: boolean;
    notMerged?: boolean;
    alreadyReleased?: boolean;
    state?: SourceSync;
    stage?: ReleaseStage;
    releaseType?: ReleaseType;
    runsUrl?: string;
  }>;
  githubReleaseStatus?: (override?: Record<string, unknown>) => Promise<ReleaseStatus>;
  githubDispatchTestBuild?: (input: Record<string, unknown>) => Promise<{
    ok: boolean;
    error?: string;
    dispatched?: boolean;
    ref?: string;
    runsUrl?: string;
  }>;

  githubReleaseRuns?: (override?: Record<string, unknown>) => Promise<{
    ok: boolean;
    error?: string;
    runs?: ReleaseRun[];
  }>;
  applyImport?: (scan: unknown) => Promise<Record<string, unknown>>;
  onGithubUpdate?: (fn: (check: GithubCheck) => void) => () => void;
  onGithubConnection?: (fn: (state: GithubConnection) => void) => () => void;
};

const bridge = (): Bridge | undefined =>
  typeof window === "undefined" ? undefined : (window.friday as unknown as Bridge | undefined);

export const githubBridgeAvailable = () => Boolean(bridge()?.githubCheck);

const DESKTOP_ONLY = "GitHub updates run in the installed FRIDAY desktop app.";

export const DEFAULT_GITHUB_CONFIG: GithubConfig = {
  repo: "",
  branch: "main",
  channel: "branch",
  updateChannel: "stable",
  autoCheck: false,
  intervalHours: 6,
  autoApply: false,
  appliedRef: null,
  appliedAt: 0,
  testAppliedRef: null,
  testAppliedAt: 0,
  lastCheck: 0,
  hasToken: false,
  hasUpdateToken: false,
  updateTokenShared: false,
  history: [],
};

export const githubConfig = async (): Promise<GithubConfig> =>
  (await bridge()?.githubConfig?.()) ?? DEFAULT_GITHUB_CONFIG;

export const githubSetConfig = async (
  patch: Partial<GithubConfig> & { token?: string | null; updateToken?: string | null },
) => (await bridge()?.githubSetConfig?.(patch)) ?? { ok: false, error: DESKTOP_ONLY };

export const githubTest = async (override?: Record<string, unknown>): Promise<GithubTest> =>
  (await bridge()?.githubTest?.(override)) ?? { ok: false, error: DESKTOP_ONLY };

export const githubCheck = async (override?: Record<string, unknown>): Promise<GithubCheck> =>
  (await bridge()?.githubCheck?.(override)) ?? { ok: false, error: DESKTOP_ONLY };

export const onGithubUpdate = (fn: (check: GithubCheck) => void) => bridge()?.onGithubUpdate?.(fn);

/**
 * The stored GitHub session. `refresh` re-verifies against GitHub using the
 * encrypted credential; the raw token never reaches this side.
 */
export const githubConnection = async (refresh = false): Promise<GithubConnection> =>
  (await bridge()?.githubConnection?.(refresh)) ?? {
    state: "not-configured",
    message: DESKTOP_ONLY,
  };

export const onGithubConnection = (fn: (state: GithubConnection) => void) =>
  bridge()?.onGithubConnection?.(fn);

/** How the persistent session is shown in Settings → Updates. */
export const connectionLabel = (state?: GithubConnectionState): string =>
  state === "connected"
    ? "CONNECTED"
    : state === "auth-failed"
      ? "AUTH FAILED"
      : state === "reauth-required"
        ? "REAUTH REQUIRED"
        : state === "offline"
          ? "OFFLINE"
          : state === "not-configured"
            ? "not connected"
            : "checking…";

/**
 * Download the ref, review it through the normal importer and — when the owner
 * confirms — apply it with a backup, then remember which ref is installed.
 */
export async function githubUpdateNow(
  ref?: string | null,
  options: { contentOnly?: boolean } = {},
): Promise<{
  ok: boolean;
  error?: string;
  applied?: number;
  restartRequired?: boolean;
  /** Existing files of the owner's data that the update left alone. */
  preserved?: number;
  /** Files that changed which need a dependency refresh on a source checkout. */
  dependencyChanges?: { file: string; command: string }[];
}> {
  const api = bridge();
  if (!api?.githubPull) return { ok: false, error: DESKTOP_ONLY };
  if (shouldSnapshotMemory()) {
    try {
      memory.backup();
    } catch {
      /* snapshot is best-effort — the update still proceeds */
    }
  }
  const scan = (await api.githubPull(ref ?? null, options)) as {
    ok?: boolean;
    error?: string;
    id?: string;
    githubRef?: string;
  };
  if (!scan?.ok) return { ok: false, error: scan?.error || "The update could not be staged." };
  const result = (await api.applyImport?.(scan.id)) as {
    ok?: boolean;
    error?: string;
    applied?: number;
    areas?: string[];
    backup?: string | null;
    restartRequired?: boolean;
    preserved?: number;
    dependencyChanges?: { file: string; command: string }[];
  };
  if (!result?.ok) return { ok: false, error: result?.error || "The update could not be applied." };
  await api.githubRecord?.({
    ref: scan.githubRef,
    applied: result.applied ?? 0,
    areas: result.areas ?? [],
    backup: result.backup ?? null,
    contentOnly: Boolean(options.contentOnly),
  });
  return {
    ok: true,
    applied: result.applied ?? 0,
    restartRequired: Boolean(result.restartRequired),
    preserved: result.preserved ?? 0,
    dependencyChanges: result.dependencyChanges ?? [],
  };
}

/**
 * Pick the Windows installer published with a release.
 * A released FRIDAY-Setup-<version>.exe upgrades the installed app in place:
 * the NSIS installer keeps the selected workspace, settings and data.
 */
export const releaseInstaller = (check?: GithubCheck | null): GithubAsset | null => {
  const score = (name: string) => {
    const n = name.toLowerCase();
    if (!n.endsWith(".exe")) return 0;
    if (n.includes("setup")) return 3;
    if (n.includes("portable")) return 2;
    return 1;
  };
  return (
    (check?.assets ?? [])
      .filter((a) => score(a.name) > 0)
      .sort((a, b) => score(b.name) - score(a.name))[0] ?? null
  );
};

/** Download the release installer; the owner confirms before it runs. */
export const githubDownloadInstaller = async (
  asset?: (GithubAsset & { testBuild?: boolean }) | null,
) =>
  (await bridge()?.githubDownloadInstaller?.({
    url: asset?.url,
    apiUrl: asset?.apiUrl,
    id: asset?.id,
    name: asset?.name,
    bytes: asset?.bytes,
    testBuild: asset?.testBuild,
  })) ?? {
    ok: false,
    error: DESKTOP_ONLY,
  };

/** Stop the installer download in progress; what arrived is kept for the next try. */
export const githubCancelDownload = async () =>
  (await bridge()?.githubCancelDownload?.()) ?? { ok: false, cancelled: false };

/** Launch a downloaded installer and close FRIDAY so the EXE is not locked. */
export const githubRunInstaller = async (file: string) =>
  (await bridge()?.githubRunInstaller?.(file)) ?? { ok: false, error: DESKTOP_ONLY };

// ---- Safe update (verify → backup → install → health check → rollback) ------

/**
 * Install a downloaded release. The desktop side re-checks the checksum, backs
 * up FRIDAY's data and records the attempt before the installer runs, so a
 * failed update can always be rolled back.
 */
export const githubInstallUpdate = async (input: {
  file: string;
  version?: string | undefined;
  sha256?: string | null | undefined;
  acceptUnverified?: boolean | undefined;
  /** This artifact is a TEST build — only installable from the test channel. */
  testBuild?: boolean | undefined;
  /** The owner explicitly confirmed installing a TEST build. */
  acceptTest?: boolean | undefined;
  /**
   * The owner explicitly asked to cross channels (Stable ⇄ Test). Only then may
   * a build from the other channel be installed, and only then may it be a
   * version that is not strictly newer.
   */
  acceptChannelSwitch?: boolean | undefined;
}) => (await bridge()?.githubInstallUpdate?.(input)) ?? { ok: false, error: DESKTOP_ONLY };

/** The pending install (if any) and the last version that started up healthy. */
export const githubUpdateState = async (): Promise<UpdateState> =>
  (await bridge()?.githubUpdateState?.()) ?? { ok: false };

/** Restore the pre-update backup and report the previous stable installer. */
export const githubRollback = async (backup?: string | null) =>
  (await bridge()?.githubRollback?.(backup ?? null)) ?? { ok: false, error: DESKTOP_ONLY };

/** Fires after a launch that followed an update — healthy or failed. */
export const onGithubUpdateHealth = (fn: (health: UpdateHealth) => void) =>
  bridge()?.onGithubUpdateHealth?.(fn);

/** Live bytes of an installer download, so the owner never sees a dead button. */
export interface UpdateDownloadProgress {
  phase: string;
  percent?: number;
  received?: number;
  total?: number;
  /** Smoothed bytes per second, and the time left at that speed (null = unknown). */
  speedBps?: number;
  speedMbps?: number;
  etaSeconds?: number | null;
  attempt?: number;
  attempts?: number;
  state?: string;
}

const sizeText = (bytes: number): string => {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
};

const etaText = (seconds: number): string => {
  if (seconds < 5) return "a few seconds";
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  return `${Math.floor(seconds / 3600)} h ${Math.round((seconds % 3600) / 60)} min`;
};

/** "42 MB of 180 MB · 3.2 MB/s · about 43 s left" — only the parts that are known. */
export function describeTransfer(progress: UpdateDownloadProgress | null | undefined): string {
  if (!progress) return "";
  const parts: string[] = [];
  const received = progress.received ?? 0;
  if (progress.total && progress.total > 0) {
    parts.push(`${sizeText(received)} of ${sizeText(progress.total)}`);
  } else if (received > 0) {
    parts.push(sizeText(received));
  }
  const bps = progress.speedBps ?? (progress.speedMbps ? progress.speedMbps * 1048576 : 0);
  if (bps > 0) parts.push(`${sizeText(bps)}/s`);
  if (typeof progress.etaSeconds === "number" && progress.etaSeconds > 0 && bps > 0) {
    parts.push(`about ${etaText(progress.etaSeconds)} left`);
  }
  return parts.join(" · ");
}

export const onGithubDownloadProgress = (fn: (progress: UpdateDownloadProgress) => void) =>
  bridge()?.onGithubDownloadProgress?.(fn);

// ---- Source push (development only) -----------------------------------------
// A push sends source to the private master repository and nothing else: no
// build, no version change, no release, no effect on installed FRIDAY.

export const githubSourceStatus = async (): Promise<SourceStatus> =>
  (await bridge()?.githubSourceStatus?.()) ?? { ok: false, message: DESKTOP_ONLY };

/** Does GitHub already hold this PC's exact commit? Checked before a release. */
export const githubSourceSync = async (): Promise<SourceSync> =>
  (await bridge()?.githubSourceSync?.()) ?? { ok: false, message: DESKTOP_ONLY };

export const githubPushSource = async (message?: string) =>
  (await bridge()?.githubPushSource?.({ message, confirm: true })) ?? {
    ok: false,
    error: DESKTOP_ONLY,
  };

/** Commit, push and wait until GitHub reports the new commit. */
export const githubPushAndSync = async (message?: string) =>
  (await bridge()?.githubPushAndSync?.({ message, confirm: true })) ?? {
    ok: false,
    error: DESKTOP_ONLY,
  };

// ---- Release control (GitHub Actions) ---------------------------------------
// FRIDAY never builds a release on this PC. "Build & Release" starts the same
// workflow (.github/workflows/release.yml) a human runs from the Actions tab,
// so the version, changelog, EXE and cleanup come from one system only.

/** Published releases, newest first — the official released versions. */
export const githubReleases = async () =>
  (await bridge()?.githubReleases?.()) ?? { ok: false, error: DESKTOP_ONLY };

/**
 * Full installer files for the current update channel (stable or test).
 * Channel split is github-sync.isTestRelease on the desktop side — not a second rule.
 */
export const githubInstallerBundles = async (override?: { updateChannel?: UpdateChannel }) =>
  (await bridge()?.githubInstallerBundles?.(override)) ?? { ok: false, error: DESKTOP_ONLY };

/** Preview what a release would produce right now (version + What's New). */
export const githubAnalyze = async (releaseType: ReleaseType = "auto"): Promise<ReleaseAnalysis> =>
  (await bridge()?.githubAnalyze?.({ releaseType })) ?? { ok: false, error: DESKTOP_ONLY };

/**
 * Ask GitHub to run the release workflow with the owner's credentials.
 * Refused while this PC holds newer source unless `acknowledgeLocalChanges`.
 */
export const githubBuildAndRelease = async (input: {
  stage?: ReleaseStage;
  releaseType?: ReleaseType;
  title?: string;
  notes?: string;
  prerelease?: boolean;
  acknowledgeLocalChanges?: boolean;
}) => (await bridge()?.githubDispatchRelease?.(input)) ?? { ok: false, error: DESKTOP_ONLY };

/**
 * Which release stage is legitimate right now, and the release Pull Request
 * behind it. "prepare" opens the PR; "publish" is only offered once the owner
 * has merged that PR into main.
 */
export const githubReleaseStatus = async (): Promise<ReleaseStatus> =>
  (await bridge()?.githubReleaseStatus?.()) ?? { ok: false, error: DESKTOP_ONLY };

/** Start a branch/PR TEST EXE build — never an official version or release. */
export const githubTestBuild = async (input: { ref?: string; publish?: boolean }) =>
  (await bridge()?.githubDispatchTestBuild?.(input)) ?? { ok: false, error: DESKTOP_ONLY };

/** Live status of the release workflow on GitHub. */
export const githubReleaseRuns = async () =>
  (await bridge()?.githubReleaseRuns?.()) ?? { ok: false, error: DESKTOP_ONLY };
