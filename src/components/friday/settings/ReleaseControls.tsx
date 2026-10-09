/**
 * FRIDAY · Friday Hub → Release / Build
 *
 * The developer-side controls for FRIDAY's own release train. Nothing is built
 * here: "Build & Release" starts the same GitHub Actions workflow
 * (.github/workflows/release.yml) a human runs from the Actions tab, with the
 * owner's stored token. One release system, one versioning rule, one changelog.
 */
import { useCallback, useEffect, useState } from "react";
import { deferEffect } from "@/lib/friday/defer-effect";
import {
  GitCommitHorizontal,
  Rocket,
  GitPullRequest,
  FlaskConical,
  RefreshCw,
  ScanSearch,
  ExternalLink,
  UploadCloud,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { HudPanel, StatusPill } from "@/components/friday/ui";
import { useAppVersion } from "@/lib/friday/version";
import {
  githubAnalyze,
  githubBridgeAvailable,
  githubBuildAndRelease,
  githubPushAndSync,
  githubReleaseRuns,
  githubReleaseStatus,
  githubReleases,
  githubTestBuild,
  type GithubRelease,
  type ReleaseStatus,
  type ReleaseAnalysis,
  type ReleaseRun,
  type ReleaseStage,
  type ReleaseType,
  type SourceSync,
} from "@/lib/friday/github-updates";

const TYPES: { id: ReleaseType; label: string }[] = [
  { id: "auto", label: "auto" },
  { id: "patch", label: "PATCH / FIX" },
  { id: "minor", label: "MINOR / CHANGES" },
  { id: "major", label: "MAJOR / FEATURE" },
  { id: "extreme", label: "EXTREME UPDATE" },
];

const when = (ms?: number | null) =>
  ms ? new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";

const runTone = (run?: ReleaseRun | null): "muted" | "accent" | "primary" | "warning" =>
  !run
    ? "muted"
    : run.status !== "completed"
      ? "accent"
      : run.conclusion === "success"
        ? "primary"
        : "warning";

export function ReleaseControls() {
  const desktop = githubBridgeAvailable();
  const { label } = useAppVersion();
  const [type, setType] = useState<ReleaseType>("auto");
  const [title, setTitle] = useState("");
  const [latest, setLatest] = useState<GithubRelease | null>(null);
  const [analysis, setAnalysis] = useState<ReleaseAnalysis | null>(null);
  const [run, setRun] = useState<ReleaseRun | null>(null);
  // Which stage the two-stage release is actually in, read from GitHub.
  const [status, setStatus] = useState<ReleaseStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Set when a release was refused because this PC holds newer source.
  const [pending, setPending] = useState<SourceSync | null>(null);

  const loadRuns = useCallback(async () => {
    const result = await githubReleaseRuns();
    if (result.ok) setRun(result.runs?.[0] ?? null);
  }, []);

  const loadStatus = useCallback(async () => {
    const result = await githubReleaseStatus();
    if (result.ok) setStatus(result);
    return result;
  }, []);

  const loadReleases = useCallback(async () => {
    const result = await githubReleases();
    if (result.ok) setLatest(result.latest ?? null);
    return result;
  }, []);

  useEffect(() => {
    if (!desktop) return;
    return deferEffect(() => {
      void loadReleases();
      void loadRuns();
      void loadStatus();
    });
  }, [desktop, loadReleases, loadRuns, loadStatus]);

  // While a release is running on GitHub, follow it — then stop polling.
  useEffect(() => {
    if (!desktop || !run || run.status === "completed") return;
    const timer = setInterval(() => {
      void loadRuns();
      void loadReleases();
      void loadStatus();
    }, 20_000);
    return () => clearInterval(timer);
  }, [desktop, run, loadRuns, loadReleases, loadStatus]);

  const act = async (id: string, fn: () => Promise<void>) => {
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
   * Start the one release workflow. A refusal caused by newer local source is
   * shown to the owner instead of being pushed around silently.
   */
  const startRelease = async (stage: ReleaseStage, acknowledge: boolean) => {
    const result = await githubBuildAndRelease({
      stage,
      releaseType: type,
      title: title.trim(),
      acknowledgeLocalChanges: acknowledge,
    });
    if (!result.ok) {
      if (result.localChanges && result.state) setPending(result.state);
      toast.error(result.error || "The release could not be started.");
      void loadStatus();
      return;
    }
    setPending(null);
    toast.success(
      stage === "publish"
        ? "Publishing the merged release on GitHub — EXE, tag and release notes follow."
        : "Preparing the release on GitHub — review and merge the Pull Request it opens.",
    );
    setTimeout(() => {
      void loadRuns();
      void loadStatus();
    }, 4000);
  };

  return (
    <HudPanel
      title="Release / Build"
      hint="Commits never build anything. A new version, changelog, EXE and GitHub Release are created only when a release is started here or from the Actions tab."
      actions={
        <StatusPill
          label={
            run
              ? run.status === "completed"
                ? `last run: ${run.conclusion ?? "unknown"}`
                : `running · ${run.status.replace("_", " ")}`
              : desktop
                ? "idle"
                : "desktop only"
          }
          tone={runTone(run)}
        />
      }
    >
      <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
        <p>
          Current version <span className="text-foreground">{label}</span>
        </p>
        <p>
          Latest GitHub release{" "}
          <span className="text-foreground">{latest ? latest.tag : "none yet"}</span>
        </p>
        <p>
          Published <span className="text-foreground">{when(latest?.at)}</span>
        </p>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Version increment</span>
        {TYPES.map((option) => (
          <Button
            key={option.id}
            size="sm"
            variant={type === option.id ? "default" : "outline"}
            onClick={() => setType(option.id)}
          >
            {option.label}
          </Button>
        ))}
      </div>

      <Input
        className="mt-3"
        value={title}
        placeholder="Release title (optional)"
        onChange={(e) => setTitle(e.target.value)}
      />

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={!desktop || busy !== null}
          onClick={() =>
            void act("check", async () => {
              const result = await loadReleases();
              await loadRuns();
              if (!result.ok) toast.error(result.error || "Could not read releases.");
              else
                toast.success(
                  result.latest
                    ? `Latest release ${result.latest.tag}`
                    : "No releases published yet.",
                );
            })
          }
        >
          <RefreshCw className={busy === "check" ? "size-4 animate-spin" : "size-4"} /> Check GitHub
        </Button>

        <Button
          variant="outline"
          disabled={!desktop || busy !== null}
          onClick={() =>
            void act("analyze", async () => {
              const result = await githubAnalyze(type);
              setAnalysis(result);
              if (!result.ok) toast.error(result.error || "Could not analyse changes.");
              else
                toast.success(
                  `${result.commits ?? 0} change(s) since ${result.previous ?? "the beginning"} → ${result.tag}`,
                );
            })
          }
        >
          <ScanSearch className={busy === "analyze" ? "size-4 animate-pulse" : "size-4"} /> Analyze
          changes
        </Button>

        <Button
          disabled={!desktop || busy !== null}
          onClick={() => void act("release", () => startRelease("prepare", false))}
        >
          <GitPullRequest className="size-4" /> Prepare release PR
        </Button>

        {/* Only offered once the owner has merged the release PR into main. */}
        <Button
          variant={status?.stage === "publish" ? "default" : "outline"}
          disabled={!desktop || busy !== null || status?.stage !== "publish"}
          onClick={() => void act("publish", () => startRelease("publish", true))}
        >
          <Rocket className="size-4" /> Publish merged release
        </Button>

        <Button
          variant="outline"
          disabled={!desktop || busy !== null}
          onClick={() =>
            void act("test", async () => {
              const result = await githubTestBuild({ publish: true });
              if (!result.ok) toast.error(result.error || "The test build could not be started.");
              else toast.success(`Test EXE building from ${result.ref} — no official version.`);
            })
          }
        >
          <FlaskConical className={busy === "test" ? "size-4 animate-pulse" : "size-4"} /> Test EXE
          build
        </Button>

        {run ? (
          <Button variant="ghost" onClick={() => window.open(run.url, "_blank")}>
            <ExternalLink className="size-4" /> Open run
          </Button>
        ) : null}
      </div>

      {/* Stale-source guard: GitHub builds what GitHub holds, so the exact
          difference is shown and the owner decides what happens next. */}
      {pending ? (
        <div className="mt-4 rounded-md border border-warning/60 bg-warning/5 p-3">
          <p className="text-sm text-foreground">
            <TriangleAlert className="mr-1 inline size-4 text-warning" />
            This PC has {pending.dirty ?? 0} uncommitted and {pending.ahead ?? 0} unpushed change(s)
            on {pending.branch || "this branch"}. A release would build GitHub&apos;s source
            {pending.remoteSha ? ` (${pending.remoteSha.slice(0, 7)})` : ""}, not these.
          </p>
          {pending.changes?.length ? (
            <ul className="mt-2 ml-4 max-h-32 list-disc overflow-auto text-xs text-muted-foreground">
              {pending.changes.slice(0, 40).map((change) => (
                <li key={`${change.state}-${change.path}`}>
                  {change.state} {change.path}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={() =>
                void act("push", async () => {
                  const pushed = await githubPushAndSync(
                    `chore: sync before ${analysis?.tag ?? "release"}`,
                  );
                  if (!pushed.ok) {
                    toast.error(pushed.error || "The push failed — nothing was released.");
                    return;
                  }
                  if (!pushed.synced) {
                    toast.error("GitHub has not reported the new commit yet — try again shortly.");
                    return;
                  }
                  toast.success("GitHub is in sync — preparing the release.");
                  setPending(null);
                  await startRelease("prepare", true);
                })
              }
            >
              <UploadCloud className={busy === "push" ? "size-4 animate-pulse" : "size-4"} />{" "}
              Commit, push, then prepare
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => void act("release", () => startRelease("prepare", true))}
            >
              Prepare from GitHub&apos;s current source anyway
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {/* The two-stage truth, straight from GitHub: an unmerged release branch
          can never be published. */}
      {status?.pr ? (
        <div className="mt-4 rounded-md border border-border/60 p-3 text-sm text-foreground">
          <GitPullRequest className="mr-1 inline size-4 text-accent" />
          Release {status.pr.tag} — PR #{status.pr.number} is{" "}
          <span className="text-accent">{status.pr.state}</span>
          {status.pr.released
            ? " and already released."
            : status.pr.merged
              ? " and ready to publish."
              : " — merge it into main before publishing."}{" "}
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={() => window.open(status.pr!.url, "_blank")}
          >
            Open PR
          </button>
        </div>
      ) : null}

      {analysis?.ok ? (
        <div className="mt-4 rounded-md border border-border/60 p-3">
          <p className="text-sm text-foreground">
            <GitCommitHorizontal className="mr-1 inline size-4 text-accent" />
            {analysis.commits ?? 0} change(s) since {analysis.previous ?? "the first commit"} →{" "}
            <span className="text-accent">{analysis.tag}</span> ({analysis.bump})
          </p>
          {analysis.sections?.length ? (
            <div className="mt-2 space-y-2">
              {analysis.sections.map((section) => (
                <div key={section.name}>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    {section.name}
                  </p>
                  <ul className="ml-4 list-disc text-xs text-foreground">
                    {section.items.slice(0, 25).map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">
              No user-visible changes recorded since the last release.
            </p>
          )}
          {analysis.ambiguous?.length ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {analysis.ambiguous.length} change(s) could not be classified, so the version stayed
              on the safe {analysis.bump} increment. Choose minor or major above to raise it
              deliberately.
            </p>
          ) : null}
        </div>
      ) : null}
    </HudPanel>
  );
}

export default ReleaseControls;
