/**
 * FRIDAY · Settings → Updates (GitHub source)
 *
 * Connect FRIDAY to her own repository — public or private — so she can check
 * for changes, download them and apply them through the same backed-up,
 * rollback-able pipelines already in electron/updater.cjs and github-sync.cjs.
 * This page is read-only toward GitHub (check / download / install). Push,
 * commit, PR, branch and file-edit stay on Friday Hub.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  GitBranch,
  Download,
  RefreshCw,
  PlugZap,
  History,
  PackageCheck,
  ShieldCheck,
  FlaskConical,
  RotateCcw,
  RotateCw,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { HudPanel, StatusPill, ToggleRow } from "@/components/friday/ui";
import {
  DEFAULT_GITHUB_CONFIG,
  connectionLabel,
  githubBridgeAvailable,
  githubCheck,
  githubConfig,
  githubConnection,
  githubDownloadInstaller,
  githubInstallUpdate,
  githubInstallerBundles,
  githubRollback,
  onGithubUpdateHealth,
  onGithubDownloadProgress,
  releaseInstaller,
  githubSetConfig,
  githubTest,
  githubUpdateNow,
  onGithubConnection,
  onGithubUpdate,
  type GithubAsset,
  type GithubCheck,
  type GithubConfig,
  type GithubConnection,
  type GithubTest,
  type InstallerBundle,
  type UpdateDownloadProgress,
} from "@/lib/friday/github-updates";
import {
  applyUpdate as applyCheckedUpdate,
  checkForUpdates,
  onUpdateProgress,
  restartApp,
  rollbackUpdate as rollbackPackUpdate,
  type UpdateInfo,
} from "@/lib/friday/desktop";
import { APP_VERSION_LABEL } from "@/lib/friday/version";

type PipelineState =
  "idle" | "checking" | "downloading" | "installing" | "ready-to-restart" | "failed";

const when = (ms?: number | null) =>
  ms
    ? new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : "never";

const tokenIsRequired = (message?: string) => {
  const text = String(message || "").toLowerCase();
  return (
    text.includes("token") ||
    text.includes("private") ||
    text.includes("rate limit") ||
    text.includes("api rate") ||
    text.includes("403") ||
    text.includes("401")
  );
};

const pipelineTone = (state: PipelineState): "muted" | "accent" | "primary" | "warning" =>
  state === "failed"
    ? "warning"
    : state === "ready-to-restart" || state === "installing" || state === "downloading"
      ? "accent"
      : state === "checking"
        ? "primary"
        : "muted";

export function GithubUpdates() {
  const desktop = githubBridgeAvailable();
  const applyingRef = useRef(false);
  const [config, setConfig] = useState<GithubConfig>(DEFAULT_GITHUB_CONFIG);
  const [token, setToken] = useState("");
  const [changingToken, setChangingToken] = useState(false);
  const [check, setCheck] = useState<GithubCheck | null>(null);
  const [unified, setUnified] = useState<UpdateInfo[]>([]);
  const [unifiedAt, setUnifiedAt] = useState(0);
  const [bundles, setBundles] = useState<InstallerBundle[]>([]);
  const [bundleError, setBundleError] = useState<string | null>(null);
  const [connection, setConnection] = useState<GithubTest | null>(null);
  const [session, setSession] = useState<GithubConnection>({ state: "unknown" });
  const [busy, setBusy] = useState<string | null>(null);
  const [pipeline, setPipeline] = useState<PipelineState>("idle");
  const [packRollback, setPackRollback] = useState<{ backup: string; target: string } | null>(null);
  // Download/install feedback: live progress, the error that stopped it, and
  // the exact build so "Retry" repeats the same attempt rather than guessing.
  const [progress, setProgress] = useState<UpdateDownloadProgress | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [lastBuild, setLastBuild] = useState<{
    version?: string | undefined;
    testBuild?: boolean;
    assets?: GithubAsset[];
    channelSwitch?: boolean;
  } | null>(null);

  const reload = useCallback(async () => setConfig(await githubConfig()), []);

  // The credential is stored once and restored by the main process at startup;
  // the UI only ever reads the resulting session state.
  const refreshSession = useCallback(async (verify = false) => {
    setSession(await githubConnection(verify));
  }, []);

  useEffect(() => {
    void reload();
    void refreshSession();
  }, [reload, refreshSession]);

  useEffect(() => onGithubUpdate((next) => setCheck(next)), []);
  useEffect(() => onGithubConnection((next) => setSession(next)), []);
  useEffect(
    () =>
      onGithubDownloadProgress((next) => {
        setProgress(next);
        if (!applyingRef.current) return;
        const phase = String(next.phase || "");
        if (/download/i.test(phase)) setPipeline("downloading");
        if (/backup|install|verif/i.test(phase)) setPipeline("installing");
      }),
    [],
  );
  useEffect(
    () =>
      onUpdateProgress((next) => {
        setProgress({
          phase: next.phase,
          ...(typeof next.percent === "number" ? { percent: next.percent } : {}),
          ...(typeof next.received === "number" ? { received: next.received } : {}),
          ...(typeof next.total === "number" ? { total: next.total } : {}),
        });
        if (!applyingRef.current) return;
        const phase = String(next.phase || "");
        if (/download/i.test(phase)) setPipeline("downloading");
        if (/backup|install|verif/i.test(phase)) setPipeline("installing");
      }),
    [],
  );

  // A launch that followed an update reports whether the new version came up.
  // When it did not, the pre-update backup can be restored from right here.
  useEffect(
    () =>
      onGithubUpdateHealth((health) => {
        if (health.state === "updated") {
          toast.success(`Updated to v${health.version} — FRIDAY started healthy.`);
          return;
        }
        if (health.state !== "failed") return;
        setPipeline("failed");
        setInstallError(health.message || "The last update did not start.");
        toast.error(health.message || "The last update did not start.", {
          duration: 30000,
          action: {
            label: "Roll back",
            onClick: () => {
              void (async () => {
                const result = await githubRollback(health.backup ?? null);
                toast[result.ok ? "success" : "error"](
                  result.ok
                    ? "Your FRIDAY data was restored from the pre-update backup."
                    : result.error || "The rollback could not be completed.",
                );
                if (result.ok) {
                  setPipeline("idle");
                  setInstallError(null);
                }
              })();
            },
          },
        });
      }),
    [],
  );

  const patch = async (next: Partial<GithubConfig> & { token?: string | null }) => {
    const result = await githubSetConfig(next);
    if (!result.ok) {
      toast.error(result.error || "Could not save the update source.");
      return false;
    }
    await reload();
    await refreshSession();
    return true;
  };

  const persistSource = async () => {
    const next: Partial<GithubConfig> & { token?: string | null } = {
      repo: config.repo,
      branch: config.branch,
    };
    if (token.trim()) next.token = token.trim();
    const saved = await patch(next);
    if (saved && token.trim()) {
      setToken("");
      setChangingToken(false);
    }
    return saved;
  };

  const completeAppInstall = (
    started: Awaited<ReturnType<typeof githubInstallUpdate>>,
    extras?: { channelSwitch?: boolean },
  ) => {
    applyingRef.current = false;
    if (extras?.channelSwitch) void reload();
    if (started.launched) {
      setPipeline("installing");
      setProgress({ phase: "Installing", percent: 100 });
      toast.success("Verified and backed up — FRIDAY will close and reopen updated.");
      return;
    }
    if (started.staged) {
      setPipeline("idle");
      setProgress({ phase: "Installer staged", percent: 100 });
      toast.success(
        "Installer verified and staged. On Windows FRIDAY closes, the new EXE installs, then FRIDAY reopens on that version.",
      );
      return;
    }
    setPipeline("idle");
    toast.success("Verified and backed up — restart FRIDAY if it does not reopen on its own.");
  };

  const run = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    try {
      await fn();
    } catch (error) {
      toast.error(String((error as Error)?.message || error));
    } finally {
      setBusy(null);
    }
  };

  /**
   * Download → verify checksum → back up FRIDAY's data → install. The same
   * routine serves the current channel and an explicit Stable ⇄ Test switch;
   * only application files are replaced, FRIDAY_ROOT is never touched.
   */
  const installBuild = async (build: {
    version?: string | undefined;
    testBuild?: boolean;
    assets?: GithubAsset[];
    channelSwitch?: boolean;
  }) => {
    applyingRef.current = true;
    setLastBuild(build);
    setInstallError(null);
    setPipeline("downloading");
    const fail = (message: string, description?: string) => {
      applyingRef.current = false;
      setPipeline("failed");
      setInstallError(message);
      setProgress(null);
      toast.error(message, description ? { description } : undefined);
    };
    const asset = releaseInstaller({ assets: build.assets ?? [] } as GithubCheck);
    if (!asset) {
      fail("This release publishes no Windows EXE.");
      return;
    }
    setProgress({ phase: "Starting download", percent: 0 });
    const got = await githubDownloadInstaller({ ...asset, testBuild: Boolean(build.testBuild) });
    if (!got.ok || !got.file) {
      fail(got.error || "The installer could not be downloaded.");
      return;
    }
    setPipeline("installing");
    const started = await githubInstallUpdate({
      file: got.file,
      version: build.version,
      sha256: got.sha256 ?? null,
      acceptUnverified: false,
      testBuild: Boolean(build.testBuild),
      acceptTest: Boolean(build.testBuild),
      acceptChannelSwitch: Boolean(build.channelSwitch),
    });
    if (!started.ok && started.channelMismatch) {
      fail(started.error || "This build belongs to another update channel.");
      return;
    }
    if (!started.ok && started.unverified) {
      fail(
        "This release publishes no checksum — it was not installed.",
        "Re-run Build & Release from Friday Hub so the update manifest is published.",
      );
      return;
    }
    if (!started.ok) {
      fail(started.error || "The installer could not be started.", got.file);
      return;
    }
    completeAppInstall(started, { channelSwitch: Boolean(build.channelSwitch) });
  };

  const applyUnified = async (update: UpdateInfo) => {
    applyingRef.current = true;
    setInstallError(null);
    setPackRollback(null);
    setPipeline("downloading");
    const result = await applyCheckedUpdate(update);
    if (!result.ok) {
      applyingRef.current = false;
      setPipeline("failed");
      setInstallError(result.error || "The update could not be applied.");
      if (result.backup && result.target) {
        setPackRollback({ backup: result.backup, target: result.target });
      }
      toast.error(result.error || "The update could not be applied.");
      return;
    }
    if (update.kind === "application" || result.requiresApproval || result.manual) {
      if (!result.file) {
        applyingRef.current = false;
        setPipeline("failed");
        setInstallError(result.error || "The installer was not downloaded.");
        toast.error(result.error || "The installer was not downloaded.");
        return;
      }
      setPipeline("installing");
      const started = await githubInstallUpdate({
        file: result.file,
        version: update.available,
        sha256: result.sha256 ?? null,
        acceptUnverified: false,
        testBuild: Boolean(update.testBuild),
        acceptTest: Boolean(update.testBuild),
      });
      if (!started.ok) {
        applyingRef.current = false;
        setPipeline("failed");
        setInstallError(started.error || "The installer could not be started.");
        toast.error(started.error || "The installer could not be started.");
        return;
      }
      completeAppInstall(started);
      return;
    }
    applyingRef.current = false;
    if (result.backup && result.target) {
      setPackRollback({ backup: result.backup, target: result.target });
    }
    if (result.restartRequired) {
      setPipeline("ready-to-restart");
      toast.success("Update applied — restart FRIDAY to finish.");
      return;
    }
    setPipeline("idle");
    toast.success(`Updated ${update.name} to ${update.available}.`);
  };

  const showTokenField =
    changingToken ||
    (!config.hasToken &&
      Boolean(
        connection?.private ||
        tokenIsRequired(connection?.error) ||
        session.state === "reauth-required" ||
        tokenIsRequired(session.message),
      ));

  const sessionTone: "muted" | "accent" | "primary" | "warning" =
    session.state === "connected"
      ? "primary"
      : session.state === "auth-failed" || session.state === "reauth-required"
        ? "warning"
        : session.state === "offline"
          ? "accent"
          : "muted";

  return (
    <div className="space-y-4">
      <HudPanel
        title="Update source — GitHub repository"
        hint="FRIDAY pulls her own source from this repo and applies it in place. The token is entered once, encrypted into this workspace and reloaded on every startup. Hub uses the same connection for its own write-side work."
        actions={
          <div className="flex flex-wrap gap-2">
            <StatusPill
              label={desktop ? connectionLabel(session.state) : "desktop only"}
              tone={desktop ? sessionTone : "muted"}
            />
            <StatusPill label={pipeline} tone={pipelineTone(pipeline)} />
          </div>
        }
      >
        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1 text-xs text-muted-foreground">
            Repository URL
            <Input
              value={config.repo}
              placeholder="https://github.com/devendrarj25/FRIDAY-AI-ASSISTANT"
              onChange={(e) => setConfig({ ...config, repo: e.target.value })}
              onBlur={() => void patch({ repo: config.repo })}
            />
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            Branch
            <Input
              value={config.branch}
              placeholder="main"
              onChange={(e) => setConfig({ ...config, branch: e.target.value })}
              onBlur={() => void patch({ branch: config.branch })}
            />
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            Access token{" "}
            {config.hasToken
              ? "(stored, encrypted — never shown again)"
              : "(needed for private repos or GitHub rate limits)"}
            {config.hasToken && !changingToken ? (
              <p className="rounded-md border border-border/60 bg-background/40 px-3 py-2 text-xs text-foreground">
                Token stored · hasToken: true
              </p>
            ) : showTokenField ? (
              <Input
                type="password"
                value={token}
                placeholder="ghp_…"
                onChange={(e) => setToken(e.target.value)}
              />
            ) : (
              <p className="rounded-md border border-border/60 bg-background/40 px-3 py-2 text-xs">
                Left blank for a public repository unless a check needs a token.
              </p>
            )}
          </label>
          <div className="flex items-end gap-2">
            {showTokenField ? (
              <Button
                variant="outline"
                disabled={!token || busy !== null}
                onClick={() =>
                  void run("token", async () => {
                    await patch({ token });
                    setToken("");
                    setChangingToken(false);
                    toast.success("Token encrypted into this workspace's credential store.");
                  })
                }
              >
                Save token
              </Button>
            ) : config.hasToken ? (
              <Button
                variant="outline"
                disabled={busy !== null}
                onClick={() => {
                  setChangingToken(true);
                  setToken("");
                }}
              >
                Change token
              </Button>
            ) : (
              <Button
                variant="outline"
                disabled={busy !== null}
                onClick={() => setChangingToken(true)}
              >
                Add token
              </Button>
            )}
            {config.hasToken ? (
              <Button
                variant="ghost"
                disabled={busy !== null}
                onClick={() =>
                  void run("token-clear", async () => {
                    await patch({ token: null });
                    setChangingToken(false);
                    setToken("");
                  })
                }
              >
                Clear
              </Button>
            ) : null}
            {changingToken ? (
              <Button
                variant="ghost"
                disabled={busy !== null}
                onClick={() => {
                  setChangingToken(false);
                  setToken("");
                }}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={!desktop || busy !== null}
            onClick={() =>
              void run("test", async () => {
                if (!(await persistSource())) return;
                // persistSource already wrote the typed URL/token; test the
                // stored config so a pasted github.com URL is not sent raw.
                const result = await githubTest();
                setConnection(result);
                await refreshSession(true);

                if (result.ok) {
                  toast.success(
                    `Connected to ${result.repo}${result.private ? " (private)" : ""} · default ${result.defaultBranch}`,
                  );
                  if (result.warning) toast.warning(result.warning);
                } else toast.error(result.error || "Connection failed.");
              })
            }
          >
            <PlugZap className="size-4" /> Test connection
          </Button>
          <Button
            variant="outline"
            disabled={!desktop || busy !== null}
            onClick={() =>
              void run("check", async () => {
                if (!(await persistSource())) return;
                setPipeline("checking");
                const [result, listed, listedBundles] = await Promise.all([
                  githubCheck(),
                  checkForUpdates(),
                  githubInstallerBundles({ updateChannel: config.updateChannel }),
                ]);
                setCheck(result);
                setUnified(listed);
                setUnifiedAt(Date.now());
                if (listedBundles.ok) {
                  setBundleError(null);
                  setBundles(listedBundles.bundles ?? []);
                } else {
                  setBundles([]);
                  setBundleError(listedBundles.error || "The release list could not be read.");
                }
                await reload();
                setPipeline("idle");
                if (!result.ok) {
                  if (tokenIsRequired(result.error)) {
                    setConnection({ ok: false, error: result.error || "Check failed." });
                  }
                  toast.error(result.error || "Check failed.");
                } else if (result.updateAvailable)
                  toast[result.testBuild ? "warning" : "success"](
                    `${result.testBuild ? "TEST build" : "Update"} available · ${result.shortRef}`,
                  );
                else if (listed.length)
                  toast.success(
                    `${listed.length} update${listed.length === 1 ? "" : "s"} in the unified list.`,
                  );
                else
                  toast.info(
                    result.testBuild
                      ? "No newer test build is published."
                      : "FRIDAY is already up to date.",
                  );
              })
            }
          >
            <RefreshCw className={busy === "check" ? "size-4 animate-spin" : "size-4"} /> Check for
            updates
          </Button>
          {/* Source "Download & apply" is a DEVELOPER action. An installed
              FRIDAY updates only through a verified release installer. */}
          {check?.packaged ? null : (
            <Button
              disabled={!desktop || busy !== null || !check?.updateAvailable}
              onClick={() =>
                void run("update", async () => {
                  const result = await githubUpdateNow(check?.ref);
                  if (!result.ok) {
                    toast.error(result.error || "Update failed — nothing was changed.");
                    return;
                  }
                  setCheck(null);
                  await reload();
                  toast.success(
                    `Updated ${result.applied} file(s)${result.restartRequired ? " — restart FRIDAY to load them" : ""}`,
                  );
                })
              }
            >
              <Download className="size-4" /> Download & apply
            </Button>
          )}

          {releaseInstaller(check) && check?.updateAvailable ? (
            <Button
              variant="outline"
              disabled={!desktop || busy !== null}
              onClick={() =>
                void run("installer", async () => {
                  await installBuild({
                    version: check?.version,
                    testBuild: Boolean(check?.testBuild),
                    assets: check?.assets ?? [],
                  });
                })
              }
            >
              <PackageCheck className={busy === "installer" ? "size-4 animate-pulse" : "size-4"} />{" "}
              {check?.testBuild ? "Install TEST build" : "Install new EXE"}
            </Button>
          ) : null}

          {pipeline === "ready-to-restart" ? (
            <Button
              disabled={!desktop || busy !== null}
              onClick={() =>
                void run("restart", async () => {
                  await restartApp("update-applied");
                })
              }
            >
              <RotateCw className="size-4" /> Restart now to finish updating
            </Button>
          ) : null}

          {pipeline === "failed" && packRollback ? (
            <Button
              variant="outline"
              disabled={!desktop || busy !== null}
              onClick={() =>
                void run("pack-rollback", async () => {
                  const result = await rollbackPackUpdate(packRollback);
                  if (!result.ok) {
                    toast.error(result.error || "The rollback could not be completed.");
                    return;
                  }
                  setPackRollback(null);
                  setInstallError(null);
                  setPipeline("idle");
                  toast.success("The previous pack was restored from the update backup.");
                })
              }
            >
              <RotateCcw className="size-4" /> Revert
            </Button>
          ) : null}
        </div>

        {progress || installError ? (
          <div className="mt-3 rounded-md border border-border/60 bg-background/40 p-3 text-xs">
            {installError ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-warning">{installError}</span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!desktop || busy !== null || !lastBuild}
                  onClick={() =>
                    void run("retry-install", async () => {
                      if (lastBuild) await installBuild(lastBuild);
                    })
                  }
                >
                  <RefreshCw className="size-4" /> Retry
                </Button>
              </div>
            ) : (
              <>
                <p className="text-foreground">
                  {progress?.phase}
                  {typeof progress?.percent === "number" ? ` · ${progress.percent}%` : ""}
                  {progress?.total
                    ? ` · ${Math.round((progress.received ?? 0) / 1048576)} / ${Math.round(
                        progress.total / 1048576,
                      )} MB`
                    : ""}
                </p>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border/60">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{ width: `${Math.max(2, progress?.percent ?? 2)}%` }}
                  />
                </div>
              </>
            )}
          </div>
        ) : null}

        {connection ? (
          <div className="mt-3 rounded-md border border-border/60 p-3 text-xs">
            {connection.ok ? (
              <div className="space-y-1">
                <p className="text-foreground">
                  {connection.repo} · {connection.private ? "private" : "public"} · default branch{" "}
                  {connection.defaultBranch}
                </p>
                <div className="flex flex-wrap gap-2">
                  <StatusPill
                    label={connection.authenticated ? "token: stored" : "token: none"}
                    tone={connection.authenticated ? "primary" : "muted"}
                  />
                  <StatusPill
                    label={connection.private ? "visibility: private" : "visibility: public"}
                    tone={connection.private ? "warning" : "primary"}
                  />
                </div>
                {connection.warning ? (
                  <p className="text-muted-foreground">{connection.warning}</p>
                ) : null}
              </div>
            ) : (
              <p className="text-muted-foreground">{connection.error || "Connection failed."}</p>
            )}
          </div>
        ) : null}

        <div className="mt-3 space-y-1 text-xs text-muted-foreground">
          {desktop && session.message ? (
            <p>
              Session: {connectionLabel(session.state)} — {session.message}
            </p>
          ) : null}
          <p>Installed version: {APP_VERSION_LABEL}</p>
          <p>
            Latest on this channel:{" "}
            {check?.ok && check.version
              ? `v${check.version}${check.updateAvailable ? " — update available" : " — up to date"}`
              : "not checked yet"}
          </p>
          <p>Installed ref: {config.appliedRef ? config.appliedRef.slice(0, 12) : "unknown"}</p>
          <p>Last check: {when(config.lastCheck)}</p>
          <p>Token stored: {config.hasToken ? "true" : "false"}</p>
        </div>
      </HudPanel>

      {/* Update channel — stable is the default and the only official source. */}
      <HudPanel
        title="Update channel"
        hint="Stable installs official GitHub Releases only. Test shows test builds instead — they are never installed automatically, never downgrade FRIDAY and never become official releases."
        actions={
          <StatusPill
            label={config.updateChannel === "test" ? "TEST" : "STABLE"}
            tone={config.updateChannel === "test" ? "warning" : "primary"}
          />
        }
      >
        <div className="flex flex-wrap gap-2">
          <Button
            variant={config.updateChannel === "test" ? "outline" : "default"}
            disabled={busy !== null}
            onClick={() =>
              void run("channel-stable", async () => {
                if (config.updateChannel === "stable") return;
                await patch({ updateChannel: "stable" });
                // Leaving TEST hides every test build again.
                setCheck(null);
                setUnified([]);
                setBundles([]);
                toast.success("Stable channel — official GitHub Releases only.");
              })
            }
          >
            <ShieldCheck className="size-4" /> Stable
          </Button>
          <Button
            variant={config.updateChannel === "test" ? "default" : "outline"}
            disabled={busy !== null}
            onClick={() =>
              void run("channel-test", async () => {
                if (config.updateChannel === "test") return;
                await patch({ updateChannel: "test" });
                setCheck(null);
                setUnified([]);
                setBundles([]);
                toast.warning("Test channel — test builds only. Nothing installs on its own.");
              })
            }
          >
            <FlaskConical className="size-4" /> Include test builds
          </Button>
        </div>
        <div className="mt-2 space-y-1 text-xs text-muted-foreground">
          <p>
            Installed test build:{" "}
            {config.testAppliedRef ? config.testAppliedRef.slice(0, 16) : "none"}
          </p>
          {config.updateChannel === "test" ? (
            <p className="text-warning">
              TEST channel active — official releases are hidden and publishing a release is blocked
              until you switch back to Stable.
            </p>
          ) : null}
        </div>
      </HudPanel>

      {unifiedAt ? (
        <HudPanel
          title={unified.length ? "Available updates" : "No pending updates"}
          hint="One list from checkAllUpdates: the application plus plugins, modules, workflows and themes that publish a real update feed. Channel filtering is github-sync.isTestRelease, not a second rule."
        >
          {unified.length ? (
            <ul className="space-y-3">
              {unified.map((item) => (
                <li
                  key={`${item.kind}-${item.id}-${item.available}`}
                  className="rounded-md border border-border/60 p-3 text-xs"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm text-foreground">
                        {item.name}{" "}
                        <span className="text-muted-foreground">
                          · {item.kind} · {item.current || "unknown"} → {item.available}
                        </span>
                      </p>
                      <div className="mt-1 flex flex-wrap gap-2">
                        <StatusPill
                          label={
                            item.testBuild ? "TEST" : item.channel === "test" ? "TEST" : "STABLE"
                          }
                          tone={item.testBuild || item.channel === "test" ? "warning" : "primary"}
                        />
                        {item.managedByReleaseChannel ? (
                          <StatusPill label="release installer" tone="accent" />
                        ) : null}
                      </div>
                      {item.notes ? (
                        <p className="mt-2 whitespace-pre-wrap text-muted-foreground">
                          {item.notes}
                        </p>
                      ) : null}
                    </div>
                    <Button
                      size="sm"
                      disabled={!desktop || busy !== null}
                      onClick={() =>
                        void run(`apply-${item.kind}-${item.id}`, () => applyUnified(item))
                      }
                    >
                      <Download className="size-4" /> Download
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">
              Last unified check found no newer application, plugin, module, workflow or theme.
            </p>
          )}
        </HudPanel>
      ) : null}

      {check?.ok ? (
        <HudPanel
          title={`${check.testBuild ? "TEST BUILD · " : ""}${check.updateAvailable ? "Update available" : "Up to date"}`}
          hint={`${check.testBuild ? "Test build" : check.channel === "release" ? "Release" : "Commit"} ${check.shortRef ?? ""} · ${check.author || "unknown"} · ${when(check.at)}`}
          actions={check.testBuild ? <StatusPill label="TEST" tone="warning" /> : null}
        >
          <p className="whitespace-pre-wrap text-sm text-foreground">{check.title}</p>
          {check.notes ? (
            <div className="mt-2 max-h-72 overflow-auto rounded-md border border-border/60 bg-background/40 p-3">
              <p className="mb-1 text-[11px] uppercase tracking-wide text-accent">What's new</p>
              <p className="whitespace-pre-wrap text-xs text-muted-foreground">{check.notes}</p>
            </div>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">
              This build published no release notes.
            </p>
          )}
          <p className="mt-2 text-[11px] text-muted-foreground">
            {check.verified
              ? "Checksum published — the download is verified before it is allowed to install."
              : "No checksum manifest was published with this build."}{" "}
            Your FRIDAY_ROOT (chats, memory, settings, credentials, models, runtimes and voices) is
            preserved and reused.
          </p>
          {check.changedFiles?.length ? (
            <ul className="mt-2 max-h-48 space-y-1 overflow-auto font-mono text-[11px] text-muted-foreground">
              {check.changedFiles.slice(0, 200).map((file) => (
                <li key={file.path}>
                  <span className="text-accent">{file.state}</span> {file.path}
                </li>
              ))}
            </ul>
          ) : null}
        </HudPanel>
      ) : null}

      {check?.otherChannel ? (
        <HudPanel
          title={`Also published: ${check.otherChannel.label} ${check.otherChannel.version}`}
          hint="This build lives on the other update channel. Installing it is an explicit switch — it is never downloaded or installed on its own."
          actions={
            <StatusPill
              label={check.otherChannel.testBuild ? "TEST" : "STABLE"}
              tone={check.otherChannel.testBuild ? "warning" : "primary"}
            />
          }
        >
          <p className="text-sm text-foreground">{check.otherChannel.title}</p>
          {check.otherChannel.notes ? (
            <div className="mt-2 max-h-56 overflow-auto rounded-md border border-border/60 bg-background/40 p-3">
              <p className="mb-1 text-[11px] uppercase tracking-wide text-accent">What's new</p>
              <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                {check.otherChannel.notes}
              </p>
            </div>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              disabled={!desktop || busy !== null || !check.otherChannel.assets?.length}
              onClick={() =>
                void run("cross-install", async () => {
                  const other = check.otherChannel!;
                  await installBuild({
                    version: other.version,
                    testBuild: other.testBuild,
                    assets: other.assets,
                    channelSwitch: true,
                  });
                })
              }
            >
              <PackageCheck className="size-4" />{" "}
              {check.otherChannel.testBuild
                ? "Switch to this TEST build"
                : "Return to this Stable release"}
            </Button>
            <span className="text-[11px] text-muted-foreground">
              Switches this install to the {check.otherChannel.testBuild ? "Test" : "Stable"}{" "}
              channel and keeps every FRIDAY file, model and setting in place.
            </span>
          </div>
        </HudPanel>
      ) : null}

      <HudPanel
        title="Download full installer"
        hint="Fetches the actual Windows Setup EXE from the GitHub release for this channel — for a fresh install or to share the file. Separate from the in-place update path above; this does not run the installer."
      >
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={!desktop || busy !== null}
            onClick={() =>
              void run("bundles", async () => {
                const listed = await githubInstallerBundles({
                  updateChannel: config.updateChannel,
                });
                if (!listed.ok) {
                  setBundles([]);
                  setBundleError(listed.error || "The release list could not be read.");
                  toast.error(listed.error || "The release list could not be read.");
                  return;
                }
                setBundleError(null);
                setBundles(listed.bundles ?? []);
                if (!(listed.bundles ?? []).length) {
                  toast.info(
                    config.updateChannel === "test"
                      ? "No test-build installer is published on this channel."
                      : "No stable installer is published on this channel.",
                  );
                }
              })
            }
          >
            <PackageCheck className="size-4" /> List installers on this channel
          </Button>
        </div>
        {bundleError ? <p className="mt-2 text-xs text-warning">{bundleError}</p> : null}
        {bundles.length ? (
          <ul className="mt-3 space-y-2">
            {bundles.map((bundle) => (
              <li
                key={bundle.tag}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 p-3 text-xs"
              >
                <div className="min-w-0">
                  <p className="text-sm text-foreground">
                    {bundle.name}{" "}
                    <span className="text-muted-foreground">· {bundle.installer.name}</span>
                  </p>
                  <div className="mt-1 flex flex-wrap gap-2">
                    <StatusPill
                      label={bundle.testBuild ? "TEST" : "STABLE"}
                      tone={bundle.testBuild ? "warning" : "primary"}
                    />
                    <span className="text-muted-foreground">
                      {bundle.version}
                      {bundle.installer.bytes
                        ? ` · ${Math.round(bundle.installer.bytes / 1048576)} MB`
                        : ""}
                    </span>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!desktop || busy !== null}
                  onClick={() =>
                    void run(`bundle-${bundle.tag}`, async () => {
                      applyingRef.current = true;
                      setPipeline("downloading");
                      setInstallError(null);
                      const got = await githubDownloadInstaller({
                        ...bundle.installer,
                        testBuild: bundle.testBuild,
                      });
                      applyingRef.current = false;
                      if (!got.ok || !got.file) {
                        setPipeline("failed");
                        setInstallError(got.error || "The installer could not be downloaded.");
                        toast.error(got.error || "The installer could not be downloaded.");
                        return;
                      }
                      setPipeline("idle");
                      toast.success(`Saved ${bundle.installer.name}`, { description: got.file });
                    })
                  }
                >
                  <Download className="size-4" /> Download full installer
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </HudPanel>

      <HudPanel
        title="Automatic updates"
        hint="FRIDAY checks in the background and asks before touching anything, unless you let her apply updates on her own."
      >
        <ToggleRow
          label="Check this repository automatically"
          hint={`Every ${config.intervalHours} hour(s)`}
          on={config.autoCheck}
          onToggle={() => void patch({ autoCheck: !config.autoCheck })}
        />
        <ToggleRow
          label="Let FRIDAY apply updates herself"
          hint="Still backs up and can roll back — she reports what changed."
          on={config.autoApply}
          onToggle={() => void patch({ autoApply: !config.autoApply })}
        />
        <label className="mt-2 block space-y-1 text-xs text-muted-foreground">
          Check interval (hours)
          <Input
            type="number"
            min={1}
            max={168}
            value={config.intervalHours}
            onChange={(e) => setConfig({ ...config, intervalHours: Number(e.target.value) || 6 })}
            onBlur={() => void patch({ intervalHours: config.intervalHours })}
          />
        </label>
      </HudPanel>

      <HudPanel title="Update history" hint="Every applied update keeps a backup for rollback.">
        {config.history.length ? (
          <ul className="space-y-2 text-xs">
            {config.history.map((entry) => (
              <li key={`${entry.ref}-${entry.at}`} className="flex items-start gap-2">
                <History className="mt-0.5 size-3.5 text-accent" />
                <div className="min-w-0">
                  <p className="font-mono text-foreground">{entry.ref?.slice(0, 12)}</p>
                  <p className="text-muted-foreground">
                    {when(entry.at)} · {entry.applied} file(s) ·{" "}
                    {entry.areas?.join(", ") || "no areas"}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">
            No GitHub update has been applied yet. Manual ZIP and folder imports stay available in
            Import &amp; Build.
          </p>
        )}
      </HudPanel>

      <HudPanel
        title="Other ways to update"
        hint="Every route ends in the same backed-up importer."
      >
        <ul className="space-y-1.5 text-xs text-muted-foreground">
          <li className="flex gap-2">
            <GitBranch className="mt-0.5 size-3.5 text-accent" /> Import &amp; Build — upload a ZIP,
            a folder, loose files or a Git archive URL, review the diff, then apply.
          </li>
          <li className="flex gap-2">
            <GitBranch className="mt-0.5 size-3.5 text-accent" /> Import &amp; Build → Build — after
            applying, rebuild the Windows EXE and install it over the current one; your workspace,
            downloads and data stay untouched.
          </li>
          <li className="flex gap-2">
            <GitBranch className="mt-0.5 size-3.5 text-accent" /> Self-management — FRIDAY scans her
            own tree, decides hot-reload / restart / rebuild and asks before applying.
          </li>
        </ul>
      </HudPanel>
    </div>
  );
}

export default GithubUpdates;
