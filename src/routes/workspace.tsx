import { createFileRoute } from "@tanstack/react-router";
import { FolderOpen, Radar, RefreshCw, Wrench } from "lucide-react";
import { useMemo, useState } from "react";
import { AppShell, Panel } from "@/components/friday/AppShell";
import { WorkspaceSetup } from "@/components/friday/WorkspaceSetup";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  applyWorkspaceRoot,
  isDesktopApp,
  refreshWorkspaceScan,
  repairWorkspace,
  revealWorkspaceFolder,
  useWorkspaceRootState,
  useWorkspaceScan,
} from "@/lib/friday/desktop";
import { fromScanResult, mockScan, pickWorkspaceRoot } from "@/lib/friday/workspace";

export const Route = createFileRoute("/workspace")({
  head: () => ({
    meta: [
      { title: "Primary Folder — FRIDAY" },
      {
        name: "description",
        content:
          "Pick FRIDAY's primary folder, review the code roots it recognised, and control auto-scan and file watching.",
      },
      { property: "og:title", content: "Primary Folder — FRIDAY" },
      {
        property: "og:description",
        content: "Auto-detected code roots, indexed files and live change watching.",
      },
    ],
  }),
  component: WorkspacePage,
});

function WorkspacePage() {
  const root = useWorkspaceRootState();
  const result = useWorkspaceScan();
  const [busy, setBusy] = useState(false);

  // Real scan on the desktop; the browser preview keeps its illustrative data.
  const scan = useMemo(() => {
    if (result?.exists) return fromScanResult(result);
    if (!root) return null;
    return isDesktopApp() ? null : mockScan(root);
  }, [result, root]);

  if (root === undefined) return null;
  if (root === null) return <WorkspaceSetup />;

  const change = async () => {
    const picked = await pickWorkspaceRoot();
    if (!picked) return;
    setBusy(true);
    try {
      await applyWorkspaceRoot(picked);
    } finally {
      setBusy(false);
    }
  };

  const rescan = async () => {
    setBusy(true);
    try {
      await refreshWorkspaceScan(true);
    } finally {
      setBusy(false);
    }
  };

  const repair = async () => {
    setBusy(true);
    try {
      await repairWorkspace();
      await refreshWorkspaceScan(true);
    } finally {
      setBusy(false);
    }
  };

  const missing = result?.missing ?? [];

  return (
    <AppShell
      title="Primary folder"
      subtitle={root}
      actions={
        <>
          <Button size="sm" variant="outline" onClick={change} disabled={busy}>
            <FolderOpen className="size-4" /> Change folder
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => revealWorkspaceFolder()}
            disabled={busy}
          >
            <FolderOpen className="size-4" /> Open folder
          </Button>
          {missing.length ? (
            <Button size="sm" variant="outline" onClick={repair} disabled={busy}>
              <Wrench className="size-4" /> Create {missing.length} missing
            </Button>
          ) : null}
          <Button size="sm" onClick={rescan} disabled={busy}>
            <RefreshCw className="size-4" /> Rescan now
          </Button>
        </>
      }
    >
      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <Panel title="Recognised folders" hint={`${scan?.detected.length ?? 0} detected`}>
          {!scan ? (
            <p className="font-mono text-[11px] text-muted-foreground">Scanning the workspace…</p>
          ) : (
            <ul className="space-y-2">
              {scan.detected.map((folder) => (
                <li
                  key={folder.path}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-border bg-surface px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate font-mono text-xs text-foreground">{folder.path}</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {folder.stack ?? folder.kind} · {folder.files.toLocaleString()} files
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {folder.kind}
                    </Badge>
                    <Badge
                      variant={folder.indexed ? "default" : "secondary"}
                      className="font-mono text-[10px]"
                    >
                      {folder.indexed ? "indexed" : "skipped"}
                    </Badge>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2"
                      onClick={() => revealWorkspaceFolder(folder.path.split(/[\\/]/).pop())}
                    >
                      Open
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <div className="space-y-4">
          <Panel title="Scan status">
            <dl className="space-y-2 font-mono text-[11px] text-muted-foreground">
              <div className="flex justify-between">
                <dt>last scan</dt>
                <dd>{scan?.scannedAt ?? "—"}</dd>
              </div>
              <div className="flex justify-between">
                <dt>files</dt>
                <dd>{scan?.files.toLocaleString() ?? "—"}</dd>
              </div>
              <div className="flex justify-between">
                <dt>folders</dt>
                <dd>{scan?.folders.toLocaleString() ?? "—"}</dd>
              </div>
              <div className="flex justify-between">
                <dt>missing from layout</dt>
                <dd>{missing.length}</dd>
              </div>
            </dl>
            <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Radar className="size-3.5 text-success" />
              Watching for changes · full re-scan on every app restart
            </p>
          </Panel>

          <Panel title="How detection works">
            <ul className="space-y-1.5 font-mono text-[11px] text-muted-foreground">
              <li>· the canonical FRIDAY layout is mapped, legacy names included</li>
              <li>· node_modules, venv, .git and build output are skipped</li>
              <li>· cache, temp, logs, backups and downloads are not indexed</li>
              <li>· everything else is indexed as code, documents or data</li>
            </ul>
          </Panel>
        </div>
      </div>
    </AppShell>
  );
}
