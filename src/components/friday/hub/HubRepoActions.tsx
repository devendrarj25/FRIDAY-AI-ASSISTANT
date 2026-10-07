import { useCallback, useEffect, useState } from "react";
import { Loader2, Play, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Panel, StatusPill } from "@/components/friday/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  dispatchHubWorkflow,
  hubReposAvailable,
  listHubConnections,
  listHubReleases,
  listHubWorkflows,
  type HubRelease,
  type HubWorkflow,
} from "@/lib/friday/hub-repos";

/**
 * Releases + workflow_dispatch for the Hub-selected repo.
 * FRIDAY's own Official Release train stays in ReleaseControls when self is selected.
 */
export function HubRepoActions() {
  const desktop = hubReposAvailable();
  const [workflows, setWorkflows] = useState<HubWorkflow[]>([]);
  const [releases, setReleases] = useState<HubRelease[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [ref, setRef] = useState("main");
  const [confirmWrite, setConfirmWrite] = useState(false);

  const refresh = useCallback(async () => {
    const [wf, rel, listed] = await Promise.all([
      listHubWorkflows(),
      listHubReleases(),
      listHubConnections(),
    ]);
    const selected =
      (listed.connections ?? []).find((conn) => conn.id === listed.selectedId) ||
      (listed.connections ?? [])[0];
    if (selected?.defaultBranch) setRef(selected.defaultBranch);
    if (wf.ok) {
      const role = selected?.role || "self";
      setWorkflows(
        (wf.workflows ?? []).filter((workflow) => {
          if (role !== "self") return true;
          const file = String(workflow.path || "").replace(/\\/g, "/");
          return !/(^|\/)release\.yml$/i.test(file) && !/(^|\/)test-build\.yml$/i.test(file);
        }),
      );
    } else toast.error(wf.error || "Could not list workflows.");
    if (rel.ok) setReleases(rel.releases ?? []);
    else toast.error(rel.error || "Could not list releases.");
  }, []);

  useEffect(() => {
    if (desktop) void refresh();
  }, [desktop, refresh]);

  if (!desktop) return null;

  return (
    <Panel title="Selected repo · Actions &amp; releases" hint="workflow_dispatch · never silent">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={ref}
            onChange={(event) => setRef(event.target.value)}
            placeholder="ref (branch or tag)"
            className="h-8 w-40 font-mono text-[11px]"
          />
          <label className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              checked={confirmWrite}
              onChange={(event) => setConfirmWrite(event.target.checked)}
            />
            I confirm this dispatch
          </label>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={() =>
              void (async () => {
                setBusy("refresh");
                try {
                  await refresh();
                } finally {
                  setBusy(null);
                }
              })()
            }
          >
            <RefreshCw className={busy === "refresh" ? "size-3.5 animate-spin" : "size-3.5"} />
            Refresh
          </Button>
        </div>

        {workflows.length ? (
          workflows.map((workflow) => (
            <div
              key={workflow.id}
              className="flex flex-wrap items-center gap-2 rounded-sm border border-border/60 p-2"
            >
              <span className="text-xs text-foreground">{workflow.name}</span>
              <span className="font-mono text-[11px] text-muted-foreground">{workflow.path}</span>
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null || !confirmWrite}
                onClick={() =>
                  void (async () => {
                    setBusy(String(workflow.id));
                    try {
                      const result = await dispatchHubWorkflow(workflow.id, ref.trim() || "main");
                      setConfirmWrite(false);
                      if (!result.ok) toast.error(result.error || "Dispatch failed.");
                      else toast.success(`Dispatched ${workflow.name}`);
                    } finally {
                      setBusy(null);
                    }
                  })()
                }
              >
                {busy === String(workflow.id) ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Play className="size-3.5" />
                )}
                Dispatch
              </Button>
            </div>
          ))
        ) : (
          <p className="text-xs text-muted-foreground">
            No active workflows reported for this repository (token may be required).
          </p>
        )}

        <div className="space-y-1">
          {(releases ?? []).slice(0, 8).map((release) => (
            <p key={release.tag} className="font-mono text-[11px] text-muted-foreground">
              {release.tag} · {release.name}
              {release.prerelease ? " · prerelease" : ""}
            </p>
          ))}
          {!releases.length ? <StatusPill label="no releases listed" tone="muted" /> : null}
        </div>
      </div>
    </Panel>
  );
}
