import { useCallback, useEffect, useState } from "react";
import {
  GitBranch,
  GitPullRequest,
  Hammer,
  Loader2,
  RefreshCw,
  Rocket,
  ShieldAlert,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { Panel, StatusPill } from "@/components/friday/ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  devAvailable,
  devBranch,
  devChangeSets,
  devCheckoutBranch,
  devCommitFiles,
  devDiff,
  devListFiles,
  devOpenPullRequest,
  devPublish,
  devPullRequests,
  devReadFile,
  devRemoveChangeSet,
  devUpdateChangeSet,
  devValidate,
  devWorkspace,
  devWriteFile,
  onDevValidateProgress,
  pullRequestBody,
  type DevChangeSet,
  type DevWorkspace,
  type PullRequestInfo,
  type ValidationStep,
} from "@/lib/friday/dev-workflow";
import { githubTestBuild } from "@/lib/friday/github-updates";

/**
 * Friday Hub · development and repository control.
 *
 * Every button here performs one real git or GitHub operation. main is never
 * written to directly: the flow is change set → branch → push → pull request →
 * (your merge) → the existing Official Release flow on Friday Hub.
 */
export function DevControl() {
  const desktop = devAvailable();
  const [space, setSpace] = useState<DevWorkspace | null>(null);
  const [sets, setSets] = useState<DevChangeSet[]>([]);
  const [pulls, setPulls] = useState<PullRequestInfo[]>([]);
  const [steps, setSteps] = useState<ValidationStep[]>([]);
  const [validation, setValidation] = useState<string>("");
  const [diffText, setDiffText] = useState<{ file: string; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const [switchTo, setSwitchTo] = useState("");
  const [filePath, setFilePath] = useState("");
  const [fileText, setFileText] = useState("");
  const [fileList, setFileList] = useState<string[]>([]);
  const [confirmWrite, setConfirmWrite] = useState(false);
  const [validatedOk, setValidatedOk] = useState(false);

  const refresh = useCallback(async () => {
    const next = await devWorkspace();
    setSpace(next);
    setSwitchTo(next.branch || "");
    setSets(next.changeSets ?? (await devChangeSets()).changeSets ?? []);
  }, []);

  useEffect(() => {
    if (!desktop) return;
    void refresh();
  }, [desktop, refresh]);

  useEffect(
    () =>
      onDevValidateProgress((step) =>
        setSteps((prev) => [...prev.filter((s) => s.id !== step.id), step]),
      ),
    [],
  );

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

  const selected = sets.find((item) => item.id === active) ?? null;

  if (!desktop) {
    return (
      <Panel title="Development & repo control" hint="desktop only">
        <p className="text-xs text-muted-foreground">
          Branching, pushing and pull requests need the FRIDAY desktop app — the browser preview has
          no git access.
        </p>
      </Panel>
    );
  }

  return (
    <div className="space-y-3">
      <Panel
        title="Development & repo control"
        hint={
          space?.repo
            ? `${space.hubLabel || space.connectedRepo || "no repo connected"} · ${space.branch}`
            : "no git checkout"
        }
      >
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill
              label={space?.repo ? `branch: ${space.branch}` : "no source checkout"}
              tone={space?.onProtectedBranch ? "warning" : "primary"}
            />
            <StatusPill
              label={`${space?.dirty ?? 0} changed file(s)`}
              tone={space?.dirty ? "accent" : "muted"}
            />
            <StatusPill
              label={space?.hasToken ? "token: stored" : "token: none"}
              tone={space?.hasToken ? "primary" : "muted"}
            />
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => void run("refresh", refresh)}
            >
              <RefreshCw className={busy === "refresh" ? "size-3.5 animate-spin" : "size-3.5"} />
              Refresh
            </Button>
          </div>

          {space?.onProtectedBranch ? (
            <p className="flex items-center gap-2 rounded-sm border border-warning/30 bg-warning/10 px-2.5 py-1.5 font-mono text-[11px] text-warning">
              <ShieldAlert className="size-3.5" /> You are on {space.branch}. FRIDAY will not commit
              here — create a feature branch below; main only changes through a merged pull request.
            </p>
          ) : null}

          {!space?.repo ? (
            <p className="text-xs text-muted-foreground">
              {space?.message ??
                "No git source checkout was found, so only change-set review is available here."}
            </p>
          ) : (
            <>
              <div className="max-h-40 overflow-auto rounded-sm border border-border/60">
                {(space.changes ?? []).length ? (
                  (space.changes ?? []).map((change) => (
                    <button
                      key={change.path}
                      type="button"
                      className="flex w-full items-center gap-2 px-2 py-1 text-left font-mono text-[11px] text-muted-foreground hover:bg-primary/10"
                      onClick={() =>
                        void run("diff", async () => {
                          const result = await devDiff(change.path);
                          setDiffText({
                            file: change.path,
                            text: result.ok
                              ? result.diff || "(no textual diff — binary or new file)"
                              : result.error || "diff failed",
                          });
                        })
                      }
                    >
                      <span className="w-6 text-primary">{change.state || "M"}</span>
                      {change.path}
                    </button>
                  ))
                ) : (
                  <p className="px-2 py-1 font-mono text-[11px] text-muted-foreground">
                    Working tree is clean.
                  </p>
                )}
              </div>

              {diffText ? (
                <div className="rounded-sm border border-primary/20 bg-surface p-2">
                  <div className="mb-1 flex items-center justify-between">
                    <p className="label-xs text-primary/70">{diffText.file}</p>
                    <Button size="sm" variant="ghost" onClick={() => setDiffText(null)}>
                      Close
                    </Button>
                  </div>
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-muted-foreground">
                    {diffText.text}
                  </pre>
                </div>
              ) : null}

              <div className="flex flex-wrap items-center gap-2">
                <select
                  className="h-8 min-w-[160px] border border-border bg-background px-2 font-mono text-[11px]"
                  value={switchTo || space?.branch || ""}
                  onChange={(event) => setSwitchTo(event.target.value)}
                >
                  {(space.branches ?? []).map((branch) => (
                    <option key={branch} value={branch}>
                      {branch}
                    </option>
                  ))}
                </select>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null || !(switchTo || space?.branch)}
                  onClick={() =>
                    void run("checkout", async () => {
                      const result = await devCheckoutBranch(switchTo || space?.branch || "");
                      if (!result.ok) {
                        toast.error(result.error || "Could not switch branch.");
                        return;
                      }
                      setValidatedOk(false);
                      toast.success(`On ${result.branch}`);
                      await refresh();
                    })
                  }
                >
                  <GitBranch className="size-3.5" /> Switch branch
                </Button>
              </div>

              <div className="space-y-2 rounded-sm border border-border/60 p-2">
                <p className="label-xs text-primary/70">Working-tree file</p>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    value={filePath}
                    onChange={(event) => setFilePath(event.target.value)}
                    placeholder="relative/path.txt"
                    className="h-8 min-w-[200px] flex-1 font-mono text-[11px]"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() =>
                      void run("files", async () => {
                        const listed = await devListFiles();
                        if (!listed.ok) {
                          toast.error(listed.error || "Could not list files.");
                          return;
                        }
                        setFileList(listed.files ?? []);
                      })
                    }
                  >
                    List files
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null || !filePath.trim()}
                    onClick={() =>
                      void run("read", async () => {
                        const result = await devReadFile(filePath.trim());
                        if (!result.ok) {
                          toast.error(result.error || "Could not read that file.");
                          return;
                        }
                        setFileText(result.content || "");
                      })
                    }
                  >
                    Load
                  </Button>
                </div>
                {fileList.length ? (
                  <div className="max-h-24 overflow-auto">
                    {fileList.slice(0, 80).map((file) => (
                      <button
                        key={file}
                        type="button"
                        className="block w-full px-1 py-0.5 text-left font-mono text-[10px] text-muted-foreground hover:bg-primary/10"
                        onClick={() =>
                          void run("read", async () => {
                            setFilePath(file);
                            const result = await devReadFile(file);
                            if (!result.ok) {
                              toast.error(result.error || "Could not read that file.");
                              return;
                            }
                            setFileText(result.content || "");
                          })
                        }
                      >
                        {file}
                      </button>
                    ))}
                  </div>
                ) : null}
                <textarea
                  value={fileText}
                  onChange={(event) => setFileText(event.target.value)}
                  className="min-h-24 w-full border border-border bg-background p-2 font-mono text-[11px] text-muted-foreground"
                />
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={confirmWrite}
                      onChange={(event) => setConfirmWrite(event.target.checked)}
                    />
                    I confirm this write
                  </label>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null || !filePath.trim() || !confirmWrite}
                    onClick={() =>
                      void run("write", async () => {
                        const result = await devWriteFile(filePath.trim(), fileText);
                        setConfirmWrite(false);
                        setValidatedOk(false);
                        if (!result.ok) {
                          toast.error(result.error || "Write failed.");
                          return;
                        }
                        toast.success(`Wrote ${result.file}`);
                        await refresh();
                      })
                    }
                  >
                    Save file
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null || Boolean(space?.onProtectedBranch) || !confirmWrite}
                    onClick={() =>
                      void run("commit", async () => {
                        const result = await devCommitFiles(
                          name.trim() || `friday: ${space?.branch}`,
                        );
                        setConfirmWrite(false);
                        setValidatedOk(false);
                        if (!result.ok) {
                          toast.error(result.error || "Commit failed.");
                          return;
                        }
                        toast.success("Committed working tree");
                        await refresh();
                      })
                    }
                  >
                    Commit working tree
                  </Button>
                </div>
              </div>
            </>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() =>
                void run("validate", async () => {
                  setSteps([]);
                  const result = await devValidate();
                  setValidation(result.summary || result.error || "");
                  if (result.results) setSteps(result.results);
                  setValidatedOk(Boolean(result.ok));
                  if (result.ok) toast.success(result.summary || "All checks passed.");
                  else toast.error(result.summary || result.error || "Validation failed.");
                })
              }
            >
              {busy === "validate" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Hammer className="size-3.5" />
              )}
              Validate (audit · typecheck · tests)
            </Button>
            {validation ? (
              <span className="font-mono text-[11px] text-muted-foreground">{validation}</span>
            ) : null}
          </div>

          {steps.length ? (
            <div className="space-y-0.5">
              {steps.map((step) => (
                <p key={step.id} className="font-mono text-[11px] text-muted-foreground">
                  {step.state === "passed" ? "✓" : step.state === "failed" ? "✕" : "·"} {step.label}{" "}
                  — {step.state}
                </p>
              ))}
            </div>
          ) : null}
        </div>
      </Panel>

      <Panel title="Change sets from Import & Build" hint={`${sets.length} queued`}>
        <div className="space-y-2">
          {sets.length ? (
            sets.map((item) => (
              <div
                key={item.id}
                className={`rounded-sm border p-2 ${
                  active === item.id ? "border-primary/50 bg-primary/5" : "border-border/60"
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="label-xs">
                    {item.kind}
                  </Badge>
                  <button
                    type="button"
                    className="text-left text-xs text-foreground"
                    onClick={() => setActive(active === item.id ? null : item.id)}
                  >
                    {item.title}
                  </button>
                  <StatusPill
                    label={item.status}
                    tone={item.status === "queued" ? "muted" : "primary"}
                  />
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {item.fileCount} file(s) · {item.origin}
                    {item.tested ? " · tested" : ""}
                  </span>
                  {item.pullRequest?.url ? (
                    <a
                      className="font-mono text-[11px] text-primary underline"
                      href={item.pullRequest.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      PR #{item.pullRequest.number}
                    </a>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void run("drop", async () => {
                        const result = await devRemoveChangeSet(item.id);
                        setSets(result.changeSets ?? []);
                      })
                    }
                  >
                    <Trash2 className="size-3.5" /> Discard
                  </Button>
                </div>
                {active === item.id ? (
                  <div className="mt-2 space-y-1">
                    <p className="text-xs text-muted-foreground">{item.summary}</p>
                    {item.files.slice(0, 20).map((file) => (
                      <p key={file} className="font-mono text-[10px] text-muted-foreground">
                        · {file}
                      </p>
                    ))}
                    {item.problems.length ? (
                      <p className="font-mono text-[10px] text-warning">
                        problems: {item.problems.slice(0, 5).join(" · ")}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ))
          ) : (
            <p className="text-xs text-muted-foreground">
              Nothing handed over yet. Analyse a project in Import &amp; Build and choose “Send
              change set to Hub”.
            </p>
          )}
        </div>
      </Panel>

      <Panel title="Branch → push → pull request" hint="main is never written to directly">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={selected ? selected.title : "what this change does"}
              className="h-8 min-w-[220px] flex-1 font-mono text-[11px]"
            />
            <Button
              size="sm"
              disabled={busy !== null || !space?.repo || !(name.trim() || selected)}
              onClick={() =>
                void run("branch", async () => {
                  const result = await devBranch(
                    name.trim() || selected?.title || "",
                    selected?.kind,
                  );
                  if (!result.ok) {
                    toast.error(result.error || "Branch could not be created.");
                    return;
                  }
                  if (selected) {
                    await devUpdateChangeSet(selected.id, {
                      branch: result.branch ?? null,
                      status: "branched",
                    });
                  }
                  toast.success(`On ${result.branch}`);
                  await refresh();
                })
              }
            >
              <GitBranch className="size-3.5" /> Create branch
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={
                busy !== null || !space?.repo || Boolean(space?.onProtectedBranch) || !validatedOk
              }
              onClick={() =>
                void run("push", async () => {
                  if (!validatedOk) {
                    toast.error("Validate this checkout before pushing.");
                    return;
                  }
                  const result = await devPublish(
                    name.trim() || selected?.title || `friday: ${space?.branch}`,
                  );
                  if (!result.ok) {
                    toast.error(result.error || "Push failed.");
                    return;
                  }
                  if (selected) {
                    await devUpdateChangeSet(selected.id, {
                      branch: result.branch ?? null,
                      status: "pushed",
                    });
                  }
                  toast.success(`Pushed ${result.branch}`);
                  await refresh();
                })
              }
            >
              <Upload className="size-3.5" /> Commit &amp; push branch
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null || !space?.repo || Boolean(space?.onProtectedBranch)}
              onClick={() =>
                void run("pr", async () => {
                  const branch = space?.branch || "";
                  const result = await devOpenPullRequest({
                    branch,
                    title: selected?.title || name.trim() || branch,
                    body: pullRequestBody(selected, validation),
                  });
                  if (!result.ok) {
                    toast.error(result.error || "Pull request could not be opened.");
                    return;
                  }
                  if (selected) {
                    await devUpdateChangeSet(selected.id, {
                      status: "pr-open",
                      pullRequest: { number: result.number ?? 0, url: result.url ?? "" },
                    });
                  }
                  toast.success(
                    result.existing
                      ? `Pull request #${result.number} already open`
                      : `Opened #${result.number}`,
                  );
                  await refresh();
                })
              }
            >
              <GitPullRequest className="size-3.5" /> Prepare pull request
            </Button>
            {space?.hubRole === "self" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null || !space?.repo || Boolean(space?.onProtectedBranch)}
                onClick={() =>
                  void run("test-build", async () => {
                    const result = await githubTestBuild(
                      space?.branch ? { ref: space.branch } : {},
                    );
                    if (!result.ok) {
                      toast.error(result.error || "Test build could not be started.");
                      return;
                    }
                    toast.success(`Test build started for ${space?.branch}`);
                  })
                }
              >
                <Rocket className="size-3.5" /> Test build this branch
              </Button>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() =>
                void run("pulls", async () => {
                  const result = await devPullRequests();
                  if (!result.ok) {
                    toast.error(result.error || "Could not read pull requests.");
                    return;
                  }
                  setPulls(result.pulls ?? []);
                })
              }
            >
              <RefreshCw className={busy === "pulls" ? "size-3.5 animate-spin" : "size-3.5"} />{" "}
              Check PR status
            </Button>
            <span className="font-mono text-[11px] text-muted-foreground">
              Merging a green PR into main is what makes an Official Release possible — start that
              from Friday Hub Build &amp; Release. Push requires a passing Validate on this
              checkout.
            </span>
          </div>

          {pulls.map((pr) => (
            <div key={pr.number} className="rounded-sm border border-border/60 p-2">
              <div className="flex flex-wrap items-center gap-2">
                <a
                  className="text-xs text-primary underline"
                  href={pr.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  #{pr.number} {pr.title}
                </a>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {pr.branch} → {pr.base}
                </span>
                <StatusPill
                  label={
                    pr.checks.total
                      ? `checks ${pr.checks.passed}/${pr.checks.total}${pr.checks.failed ? ` · ${pr.checks.failed} failed` : ""}${pr.checks.pending ? ` · ${pr.checks.pending} running` : ""}`
                      : "no checks yet"
                  }
                  tone={pr.checks.failed ? "warning" : pr.checks.pending ? "accent" : "primary"}
                />
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
