import { useCallback, useEffect, useState } from "react";
import { GitPullRequest, History, Loader2, RefreshCw, RotateCcw, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Panel, StatusPill } from "@/components/friday/ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  devAvailable,
  devCommit,
  devHistory,
  devMergedPullRequests,
  devOpenPullRequest,
  devPublish,
  devRestoreCommit,
  devRestorePreview,
  devRevertCommit,
  devValidate,
  safetyPullRequestBody,
  type CommitDetail,
  type HistoryCommit,
  type MergedPull,
  type RestorePreview,
  type SafetyResult,
} from "@/lib/friday/dev-workflow";

/**
 * Manual Revert Center — two independent safety actions that do NOT depend on
 * a recovery branch (that stays a separate, passive backup):
 *
 *   1. Revert a commit or merged PR — `git revert` on a new branch off main.
 *   2. Restore main's content to a historical commit — the historical tree is
 *      committed forward on a new branch; no history is rewritten or deleted.
 *
 * Both end in a pull request. Nothing is ever auto-merged, reset or force-pushed.
 */

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString() : "");

export function RevertCenter() {
  const desktop = devAvailable();
  const [mode, setMode] = useState<"revert" | "restore">("revert");
  const [commits, setCommits] = useState<HistoryCommit[]>([]);
  const [base, setBase] = useState("main");
  const [baseSha, setBaseSha] = useState("");
  const [pulls, setPulls] = useState<MergedPull[]>([]);
  const [sha, setSha] = useState("");
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<SafetyResult | null>(null);
  const [validation, setValidation] = useState("");

  const refresh = useCallback(async () => {
    const log = await devHistory(60);
    if (log.ok) {
      setCommits(log.commits ?? []);
      setBase(log.base ?? "main");
      setBaseSha(log.baseSha ?? "");
    }
    const merged = await devMergedPullRequests();
    if (merged.ok) setPulls(merged.pulls ?? []);
  }, []);

  useEffect(() => {
    if (desktop) void refresh();
  }, [desktop, refresh]);

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

  const inspect = (next: string) =>
    run("inspect", async () => {
      setSha(next);
      setPrepared(null);
      setValidation("");
      if (mode === "revert") {
        const result = await devCommit(next);
        setPreview(null);
        setDetail(result);
        if (!result.ok) toast.error(result.error ?? "Could not read that commit.");
      } else {
        const result = await devRestorePreview(next);
        setDetail(null);
        setPreview(result);
        if (!result.ok) toast.error(result.error ?? "Could not preview that restore.");
      }
    });

  const prepare = () =>
    run("prepare", async () => {
      const result =
        mode === "revert"
          ? await devRevertCommit(sha, detail?.commit?.subject)
          : await devRestoreCommit(sha);
      if (!result.ok) {
        toast.error(result.error ?? "Could not prepare the branch.");
        return;
      }
      setPrepared(result);
      toast.success(`Prepared ${result.branch} off ${result.base} — validating next.`);
    });

  const validate = () =>
    run("validate", async () => {
      const result = await devValidate();
      const summary = result.ok
        ? result.summary || "All checks passed."
        : result.summary || result.error || "Validation failed.";
      setValidation(summary);
      if (result.ok) toast.success(summary);
      else toast.error(summary);
    });

  const openPr = () =>
    run("pr", async () => {
      if (!prepared?.branch) return;
      const push = await devPublish(prepared.title || prepared.branch);
      if (!push.ok) {
        toast.error(push.error ?? "Push failed.");
        return;
      }
      const pr = await devOpenPullRequest({
        branch: prepared.branch,
        title: prepared.title || prepared.branch,
        body: safetyPullRequestBody(prepared, validation),
      });
      if (!pr.ok) {
        toast.error(pr.error ?? "Could not open the pull request.");
        return;
      }
      toast.success(`Pull request #${pr.number} is open — merge it yourself when you're ready.`);
    });

  if (!desktop) {
    return (
      <Panel title="Manual Revert Center" hint="desktop only">
        <p className="text-xs text-muted-foreground">
          Reverting a commit or restoring main to an older state needs the FRIDAY desktop app.
        </p>
      </Panel>
    );
  }

  const ready = Boolean(sha) && (mode === "revert" ? detail?.ok : preview?.ok);

  return (
    <Panel
      title="Manual Revert Center"
      hint={`${base}${baseSha ? ` · ${baseSha.slice(0, 8)}` : ""}`}
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={mode === "revert" ? "default" : "outline"}
            onClick={() => {
              setMode("revert");
              setDetail(null);
              setPreview(null);
              setPrepared(null);
            }}
          >
            <Undo2 className="size-3.5" /> Revert commit / PR
          </Button>
          <Button
            size="sm"
            variant={mode === "restore" ? "default" : "outline"}
            onClick={() => {
              setMode("restore");
              setDetail(null);
              setPreview(null);
              setPrepared(null);
            }}
          >
            <RotateCcw className="size-3.5" /> Restore main to a commit
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void refresh()}>
            <RefreshCw className="size-3.5" /> Refresh
          </Button>
          <StatusPill label="no recovery branch needed" tone="muted" />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={sha}
            onChange={(event) => setSha(event.target.value.trim())}
            placeholder="commit SHA"
            className="h-8 w-56 font-mono text-[11px]"
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!sha || busy === "inspect"}
            onClick={() => void inspect(sha)}
          >
            {busy === "inspect" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <History className="size-3.5" />
            )}
            Inspect
          </Button>
        </div>

        <div className="grid gap-2 md:grid-cols-2">
          <div className="rounded-sm border border-primary/20 bg-surface p-2">
            <p className="label-xs mb-1 text-primary/70">Commits on {base}</p>
            <div className="max-h-52 space-y-1 overflow-auto">
              {commits.map((commit) => (
                <button
                  key={commit.sha}
                  type="button"
                  onClick={() => void inspect(commit.sha)}
                  className={`block w-full rounded-sm px-1.5 py-1 text-left font-mono text-[10px] hover:bg-primary/10 ${
                    sha === commit.sha ? "bg-primary/15 text-primary" : "text-muted-foreground"
                  }`}
                >
                  {commit.short} · {commit.subject.slice(0, 60)}
                  <span className="block opacity-70">
                    {commit.author} · {when(commit.date)}
                    {commit.merge ? " · merge" : ""}
                  </span>
                </button>
              ))}
              {!commits.length ? (
                <p className="font-mono text-[10px] text-muted-foreground">No commits read yet.</p>
              ) : null}
            </div>
          </div>

          <div className="rounded-sm border border-primary/20 bg-surface p-2">
            <p className="label-xs mb-1 text-primary/70">Merged pull requests</p>
            <div className="max-h-52 space-y-1 overflow-auto">
              {pulls.map((pr) => (
                <button
                  key={pr.number}
                  type="button"
                  onClick={() => void inspect(pr.sha)}
                  className={`block w-full rounded-sm px-1.5 py-1 text-left font-mono text-[10px] hover:bg-primary/10 ${
                    sha === pr.sha ? "bg-primary/15 text-primary" : "text-muted-foreground"
                  }`}
                >
                  #{pr.number} {pr.title.slice(0, 56)}
                  <span className="block opacity-70">
                    {pr.author} · merged {when(pr.mergedAt)} · {pr.short}
                  </span>
                </button>
              ))}
              {!pulls.length ? (
                <p className="font-mono text-[10px] text-muted-foreground">
                  No merged pull requests found.
                </p>
              ) : null}
            </div>
          </div>
        </div>

        {mode === "revert" && detail?.ok && detail.commit ? (
          <div className="space-y-2 rounded-sm border border-primary/20 bg-surface p-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="label-xs">
                {detail.commit.short}
              </Badge>
              <span className="font-mono text-[11px] text-muted-foreground">
                {detail.commit.author} · {when(detail.commit.date)} · {detail.files?.length ?? 0}{" "}
                file(s)
              </span>
            </div>
            <p className="text-xs">{detail.commit.subject}</p>
            <div className="max-h-32 space-y-0.5 overflow-auto">
              {detail.files?.map((file) => (
                <p key={file.path} className="font-mono text-[10px] text-muted-foreground">
                  {file.state} {file.path}
                </p>
              ))}
            </div>
            <details>
              <summary className="cursor-pointer font-mono text-[11px] text-muted-foreground">
                Diff
              </summary>
              <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-muted-foreground">
                {detail.diff}
              </pre>
            </details>
          </div>
        ) : null}

        {mode === "restore" && preview?.ok ? (
          <div className="space-y-2 rounded-sm border border-primary/20 bg-surface p-2">
            <p className="font-mono text-[11px] text-muted-foreground">
              {preview.base} is at {preview.currentShort} → restoring content of{" "}
              {preview.targetShort}
            </p>
            <p className="font-mono text-[11px] text-muted-foreground">
              {preview.commitsBetween?.length ?? 0} commit(s) in between (kept in history) ·{" "}
              {preview.files?.length ?? 0} file(s) change
            </p>
            <div className="max-h-32 space-y-0.5 overflow-auto">
              {preview.files?.map((file) => (
                <p key={file.path} className="font-mono text-[10px] text-muted-foreground">
                  {file.state} {file.path}
                </p>
              ))}
            </div>
            <details>
              <summary className="cursor-pointer font-mono text-[11px] text-muted-foreground">
                Commits that will be superseded ({preview.commitsBetween?.length ?? 0})
              </summary>
              <div className="mt-1 max-h-40 space-y-0.5 overflow-auto">
                {preview.commitsBetween?.map((commit) => (
                  <p key={commit.sha} className="font-mono text-[10px] text-muted-foreground">
                    {commit.short} · {commit.subject}
                  </p>
                ))}
              </div>
            </details>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={!ready || busy === "prepare"} onClick={() => void prepare()}>
            {busy === "prepare" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : mode === "revert" ? (
              <Undo2 className="size-3.5" />
            ) : (
              <RotateCcw className="size-3.5" />
            )}
            {mode === "revert" ? "Create revert branch" : "Create restore branch"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!prepared || busy === "validate"}
            onClick={() => void validate()}
          >
            {busy === "validate" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            Run validation
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!prepared || busy === "pr"}
            onClick={() => void openPr()}
          >
            {busy === "pr" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <GitPullRequest className="size-3.5" />
            )}
            Push &amp; open PR to {base}
          </Button>
          {prepared ? <StatusPill label={`branch: ${prepared.branch}`} tone="primary" /> : null}
          {validation ? <StatusPill label={validation.slice(0, 60)} tone="accent" /> : null}
        </div>

        <p className="text-xs text-muted-foreground">
          Both actions branch off current {base}, keep the full Git history and always end in a pull
          request you merge yourself. FRIDAY never auto-merges, resets or force-pushes, and neither
          action needs a recovery branch to exist.
        </p>
      </div>
    </Panel>
  );
}
