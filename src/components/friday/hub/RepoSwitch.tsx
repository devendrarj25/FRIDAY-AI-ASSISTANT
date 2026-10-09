import { useCallback, useEffect, useRef, useState } from "react";
import { deferEffect } from "@/lib/friday/defer-effect";
import { GitBranch, Loader2, Plus, RefreshCw, Trash2, Unplug } from "lucide-react";
import { toast } from "sonner";
import { Panel, StatusPill } from "@/components/friday/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  addHubConnection,
  createHubRepository,
  hubReposAvailable,
  listHubConnections,
  packagePushHub,
  pickHubFolder,
  pickHubZip,
  removeHubConnection,
  selectHubConnection,
  testHubConnection,
  type HubConnection,
} from "@/lib/friday/hub-repos";

/**
 * Hub repo switcher — additive. Capability "Clone from GitHub" stays a
 * separate panel on this page. Settings → Updates still owns FRIDAY's
 * self-update check.
 */
export function RepoSwitch({
  onSelected,
}: {
  onSelected?: (id: string, role: "self" | "linked") => void;
}) {
  const desktop = hubReposAvailable();
  const [list, setList] = useState<HubConnection[]>([]);
  const [selectedId, setSelectedId] = useState("self");
  const [busy, setBusy] = useState<string | null>(null);
  const [repo, setRepo] = useState("");
  const [token, setToken] = useState("");
  const [createName, setCreateName] = useState("");
  const [createPrivate, setCreatePrivate] = useState(true);
  const [confirmWrite, setConfirmWrite] = useState(false);
  const onSelectedRef = useRef(onSelected);
  useEffect(() => {
    onSelectedRef.current = onSelected;
  });

  const refresh = useCallback(async () => {
    const next = await listHubConnections();
    if (!next.ok) {
      toast.error(next.error || "Could not read Hub connections.");
      return;
    }
    setList(next.connections ?? []);
    const id = next.selectedId || "self";
    setSelectedId(id);
    const role = (next.connections ?? []).find((c) => c.id === id)?.role || "self";
    onSelectedRef.current?.(id, role);
  }, []);

  useEffect(() => {
    if (!desktop) return;
    return deferEffect(() => void refresh());
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

  if (!desktop) {
    return (
      <Panel title="Connected repositories" hint="desktop only">
        <p className="text-xs text-muted-foreground">
          Multi-repo connect needs the FRIDAY desktop app.
        </p>
      </Panel>
    );
  }

  const selected = list.find((c) => c.id === selectedId) ?? list[0];
  const visibility = selected?.visibility || (selected?.private ? "private" : "unknown");

  const reportCheckout = (result: {
    checkout?: { ok: boolean; empty?: boolean; dir?: string | null; error?: string };
  }) => {
    if (result.checkout && result.checkout.ok === false) {
      toast.error(result.checkout.error || "Could not prepare a local checkout.");
    } else if (result.checkout?.empty) {
      toast.message("This GitHub repository has no commits yet — an empty checkout is ready.");
    }
  };

  return (
    <Panel
      title="Connected repositories"
      hint={selected ? `${selected.label} · ${selected.repo || "not configured"}` : "hub"}
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {list.map((conn) => (
            <Button
              key={conn.id}
              size="sm"
              variant={conn.id === selectedId ? "default" : "outline"}
              disabled={busy !== null}
              onClick={() =>
                void run("select", async () => {
                  const result = await selectHubConnection(conn.id);
                  if (!result.ok) {
                    toast.error(result.error || "Could not select that repository.");
                    return;
                  }
                  reportCheckout(result);
                  await refresh();
                })
              }
            >
              <GitBranch className="size-3.5" />
              {conn.role === "self" ? "FRIDAY (this app)" : conn.label || conn.repo}
            </Button>
          ))}
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

        {selected ? (
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill
              label={selected.role === "self" ? "FRIDAY's own repo" : "linked repo"}
              tone={selected.role === "self" ? "primary" : "accent"}
            />
            <StatusPill
              label={selected.hasToken ? "token: stored" : "token: none"}
              tone={selected.hasToken ? "primary" : "muted"}
            />
            <StatusPill
              label={
                visibility === "private"
                  ? "private"
                  : visibility === "public"
                    ? "public"
                    : "visibility: test"
              }
              tone={
                visibility === "private" ? "warning" : visibility === "public" ? "muted" : "muted"
              }
            />
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() =>
                void run("test", async () => {
                  const result = await testHubConnection(selected.id);
                  if (!result.ok) {
                    toast.error(result.error || "Connection failed.");
                    return;
                  }
                  toast.success(
                    `Reachable: ${result.repo || selected.repo}${result.warning ? ` · ${result.warning}` : ""}`,
                  );
                  await refresh();
                })
              }
            >
              {busy === "test" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Unplug className="size-3.5" />
              )}
              Test connection
            </Button>
            {selected.role !== "self" ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== null}
                onClick={() =>
                  void run("remove", async () => {
                    const result = await removeHubConnection(selected.id);
                    if (!result.ok) {
                      toast.error(result.error || "Could not remove that repository.");
                      return;
                    }
                    await refresh();
                  })
                }
              >
                <Trash2 className="size-3.5" /> Remove from Hub
              </Button>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={repo}
            onChange={(event) => setRepo(event.target.value)}
            placeholder="owner/name or https://github.com/owner/name"
            className="h-8 min-w-[240px] flex-1 font-mono text-[11px]"
          />
          <Input
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="token (optional, private repos)"
            type="password"
            className="h-8 min-w-[180px] font-mono text-[11px]"
          />
          <Button
            size="sm"
            disabled={busy !== null || !repo.trim()}
            onClick={() =>
              void run("add", async () => {
                const result = await addHubConnection({
                  repo: repo.trim(),
                  ...(token.trim() ? { token: token.trim() } : {}),
                });
                setToken("");
                if (!result.ok) {
                  toast.error(result.error || "Could not add that repository.");
                  return;
                }
                setRepo("");
                toast.success(result.reused ? "Already in the Hub list." : "Repository added.");
                reportCheckout(result);
                await refresh();
              })
            }
          >
            <Plus className="size-3.5" /> Add repository
          </Button>
        </div>
        <p className="font-mono text-[11px] text-muted-foreground">
          Extra tokens are encrypted the same way as Settings → Updates. They are never shown again
          once saved. Adding FRIDAY&apos;s own repo selects it; it does not replace the Updates
          token.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={createName}
            onChange={(event) => setCreateName(event.target.value)}
            placeholder="new-repo-name"
            className="h-8 w-48 font-mono text-[11px]"
          />
          <label className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              checked={createPrivate}
              onChange={(event) => setCreatePrivate(event.target.checked)}
            />
            private
          </label>
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
            disabled={busy !== null || !createName.trim() || !confirmWrite}
            onClick={() =>
              void run("create", async () => {
                const result = await createHubRepository({
                  name: createName.trim(),
                  private: createPrivate,
                });
                setConfirmWrite(false);
                if (!result.ok) {
                  toast.error(result.error || "Could not create that repository.");
                  return;
                }
                setCreateName("");
                toast.success(`Created ${result.repo}`);
                reportCheckout(result);
                await refresh();
              })
            }
          >
            <Plus className="size-3.5" /> Create GitHub repository
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null || selected?.role !== "linked" || !confirmWrite}
            onClick={() =>
              void run("zip", async () => {
                const picked = await pickHubZip();
                if (!picked.ok || !picked.file) return;
                const result = await packagePushHub({ zip: picked.file });
                setConfirmWrite(false);
                if (!result.ok) {
                  toast.error(result.error || "Package and push failed.");
                  return;
                }
                toast.success(
                  result.pushed
                    ? `Pushed to ${result.repo}`
                    : result.warning || "Committed locally.",
                );
                await refresh();
              })
            }
          >
            Package zip → push
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null || selected?.role !== "linked" || !confirmWrite}
            onClick={() =>
              void run("folder", async () => {
                const picked = await pickHubFolder();
                if (!picked.ok || !picked.folder) return;
                const result = await packagePushHub({ folder: picked.folder });
                setConfirmWrite(false);
                if (!result.ok) {
                  toast.error(result.error || "Package and push failed.");
                  return;
                }
                toast.success(
                  result.pushed
                    ? `Pushed to ${result.repo}`
                    : result.warning || "Committed locally.",
                );
                await refresh();
              })
            }
          >
            Package folder → push
          </Button>
        </div>
        <p className="font-mono text-[11px] text-muted-foreground">
          Create / package-push need the confirmation box. Package-push only runs on a linked empty
          checkout, never on FRIDAY&apos;s own source.
        </p>
      </div>
    </Panel>
  );
}
