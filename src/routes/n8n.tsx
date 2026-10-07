import { createFileRoute } from "@tanstack/react-router";
import {
  Download,
  FolderUp,
  Loader2,
  Play,
  Plug,
  Power,
  RefreshCw,
  Trash2,
  Upload,
  Workflow as WorkflowIcon,
  Zap,
} from "lucide-react";
import { Github } from "@/components/friday/icons/github";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/friday/AppShell";
import { FilterTabs, HudPanel, StatTile, StatusPill, ToggleRow } from "@/components/friday/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatBytes, imports } from "@/lib/friday/import-engine";
import { useImports } from "@/lib/friday/use-imports";

export const Route = createFileRoute("/n8n")({
  head: () => ({
    meta: [
      { title: "n8n Automation — FRIDAY Console" },
      {
        name: "description",
        content:
          "Connect FRIDAY to a local or self-hosted n8n instance, import workflows from files or GitHub, trigger them from chat and let agents run automations.",
      },
      { property: "og:title", content: "n8n Automation — FRIDAY Console" },
      {
        property: "og:description",
        content: "n8n connection, workflow import from files and GitHub, triggers and agent tools.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: N8nPage,
});

type N8nWorkflow = {
  id: string;
  name: string;
  active: boolean;
  updatedAt?: string;
  source?: "n8n" | "file" | "github" | "template";
  nodes?: number;
};

const KEY = "friday.n8n";
const LOCAL_KEY = "friday.n8n.local";

const TABS = [
  { key: "connect", label: "Connection" },
  { key: "workflows", label: "Workflows" },
  { key: "import", label: "Import" },
  { key: "settings", label: "Settings" },
];

const TEMPLATES: { name: string; note: string; nodes: number }[] = [
  { name: "Daily FRIDAY briefing", note: "Cron → LLM summary → desktop notification", nodes: 4 },
  { name: "Watch folder → index", note: "Local file trigger → memory embed", nodes: 3 },
  { name: "GitHub release → upgrade", note: "Webhook → FRIDAY self-upgrade run", nodes: 5 },
  { name: "Email triage", note: "IMAP → classify → reply draft", nodes: 6 },
];

function N8nPage() {
  const { items } = useImports();
  const [tab, setTab] = useState("connect");
  const [base, setBase] = useState("http://localhost:5678");
  const [key, setKey] = useState("");
  const [webhook, setWebhook] = useState("");
  const [payload, setPayload] = useState("{}");
  const [remote, setRemote] = useState<N8nWorkflow[]>([]);
  const [local, setLocal] = useState<N8nWorkflow[]>([]);
  const [status, setStatus] = useState<"idle" | "connecting" | "online" | "error">("idle");
  const [error, setError] = useState("");
  const [repo, setRepo] = useState("");
  const [exposeTools, setExposeTools] = useState(true);
  const [autoRun, setAutoRun] = useState(false);
  const [autoConnect, setAutoConnect] = useState(true);
  const [logRuns, setLogRuns] = useState(true);
  const [retry, setRetry] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);

  const workflows = [...remote, ...local];
  const n8nImports = items.filter((i) => i.target === "n8n");

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const s = JSON.parse(raw) as { base?: string; key?: string; hook?: string };
        if (s.base) setBase(s.base);
        if (s.hook) setWebhook(s.hook);
        // An API key must never live in browser storage. A key written by an
        // older build is purged here (once) and never read back into the form.
        if (s.key !== undefined)
          localStorage.setItem(KEY, JSON.stringify({ base: s.base, hook: s.hook }));
      }
      const rawLocal = localStorage.getItem(LOCAL_KEY);
      if (rawLocal) setLocal(JSON.parse(rawLocal) as N8nWorkflow[]);
    } catch {
      /* ignore */
    }
  }, []);

  const saveLocal = (next: N8nWorkflow[]) => {
    setLocal(next);
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(next));
    } catch {
      /* quota */
    }
  };

  const connect = async () => {
    setStatus("connecting");
    setError("");
    // Endpoint and webhook are remembered; the API key stays in memory only.
    localStorage.setItem(KEY, JSON.stringify({ base, hook: webhook }));

    try {
      const res = await fetch(`${base.replace(/\/$/, "")}/api/v1/workflows?limit=50`, {
        headers: key ? { "X-N8N-API-KEY": key } : {},
      });
      if (!res.ok) throw new Error(`n8n responded ${res.status}`);
      const json = (await res.json()) as { data?: N8nWorkflow[] };
      setRemote((json.data ?? []).map((w) => ({ ...w, source: "n8n" as const })));
      setStatus("online");
      toast.success("n8n connected", { description: `${json.data?.length ?? 0} workflows found` });
    } catch (err) {
      setStatus("error");
      setError(
        err instanceof Error
          ? `${err.message} — check that n8n is running and that CORS allows this origin`
          : "Connection failed",
      );
      toast.error("Could not reach n8n");
    }
  };

  const trigger = async (url: string) => {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload.trim() || "{}",
      });
      toast[res.ok ? "success" : "error"](
        res.ok ? "Workflow triggered" : `Trigger failed (${res.status})`,
      );
    } catch {
      toast.error("Trigger failed — is the webhook URL reachable?");
    }
  };

  const onFiles = async (list: FileList | null, source: "upload" | "folder") => {
    if (!list?.length) return;
    const item = await imports.importFiles(list, "n8n", source);
    const jsons = Array.from(list).filter((f) => f.name.toLowerCase().endsWith(".json"));
    const parsed: N8nWorkflow[] = [];
    for (const f of jsons) {
      try {
        const text = await f.text();
        const wf = JSON.parse(text) as { name?: string; nodes?: unknown[] };
        parsed.push({
          id: `file-${f.name}-${Date.now().toString(36)}`,
          name: wf.name ?? f.name.replace(/\.json$/i, ""),
          active: false,
          source: "file",
          nodes: Array.isArray(wf.nodes) ? wf.nodes.length : 0,
          updatedAt: new Date().toISOString(),
        });
      } catch {
        /* not a workflow json */
      }
    }
    if (parsed.length) saveLocal([...parsed, ...local]);
    toast.success(`Imported ${item?.fileCount ?? list.length} files`, {
      description: parsed.length
        ? `${parsed.length} workflows recognised`
        : "no workflow JSON detected",
    });
  };

  const cloneRepo = async () => {
    if (!repo.trim()) return;
    try {
      const item = await imports.importGitHub(repo.trim(), "n8n");
      const found = item.files.filter((f) => f.path.toLowerCase().endsWith(".json"));
      const parsed: N8nWorkflow[] = found.slice(0, 25).map((f) => ({
        id: `gh-${f.path}`,
        name:
          f.path
            .split("/")
            .pop()
            ?.replace(/\.json$/i, "") ?? f.path,
        active: false,
        source: "github",
        nodes: 0,
        updatedAt: new Date().toISOString(),
      }));
      if (parsed.length) saveLocal([...parsed, ...local]);
      toast.success(`Cloned ${item.name}`, {
        description: `${parsed.length} workflow files found`,
      });
      setRepo("");
    } catch (err) {
      toast.error("GitHub import failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  };

  const exportAll = () => {
    const blob = new Blob([JSON.stringify(workflows, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "friday-n8n-workflows.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <AppShell
      title="n8n Automation"
      subtitle="Give FRIDAY a full automation engine — local, self-hosted or imported"
      actions={
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={exportAll} disabled={!workflows.length}>
            <Download className="size-4" /> Export
          </Button>
          <Button size="sm" onClick={() => void connect()} disabled={status === "connecting"}>
            {status === "connecting" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            Connect
          </Button>
        </div>
      }
    >
      <div className="grid gap-3 sm:grid-cols-4">
        <StatTile
          label="Connection"
          value={status === "online" ? "Online" : status === "error" ? "Error" : "Idle"}
          state={base}
          tone={status === "online" ? "accent" : status === "error" ? "destructive" : "muted"}
          icon={<Plug className="size-4" />}
        />
        <StatTile
          label="Workflows"
          value={workflows.length}
          state={`${workflows.filter((w) => w.active).length} active`}
          icon={<WorkflowIcon className="size-4" />}
        />
        <StatTile
          label="Imported"
          value={local.length}
          state={`${n8nImports.length} sources`}
          tone="primary"
          icon={<FolderUp className="size-4" />}
        />
        <StatTile
          label="Exposed to agents"
          value={exposeTools ? "Yes" : "No"}
          state="as callable tools"
          tone="magenta"
          icon={<Zap className="size-4" />}
        />
      </div>

      <div className="mt-4">
        <FilterTabs tabs={TABS} value={tab} onChange={setTab} />
      </div>

      {tab === "connect" ? (
        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <HudPanel title="Connection">
            <label className="label-xs text-muted-foreground" htmlFor="n8n-base">
              n8n base URL
            </label>
            <Input
              id="n8n-base"
              value={base}
              onChange={(e) => setBase(e.target.value)}
              className="mt-1 border-primary/25 bg-surface font-mono text-xs"
            />
            <label className="label-xs mt-3 block text-muted-foreground" htmlFor="n8n-key">
              API key (Settings → n8n API) — kept in memory only, never stored
            </label>
            <Input
              id="n8n-key"
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="n8n_api_…"
              className="mt-1 border-primary/25 bg-surface font-mono text-xs"
            />
            {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}

            <label className="label-xs mt-4 block text-muted-foreground" htmlFor="n8n-hook">
              Webhook trigger
            </label>
            <div className="mt-1 flex gap-2">
              <Input
                id="n8n-hook"
                value={webhook}
                onChange={(e) => setWebhook(e.target.value)}
                placeholder="http://localhost:5678/webhook/friday"
                className="border-primary/25 bg-surface font-mono text-xs"
              />
              <Button size="sm" onClick={() => void trigger(webhook)} disabled={!webhook.trim()}>
                <Play className="size-4" /> Run
              </Button>
            </div>
            <label className="label-xs mt-3 block text-muted-foreground" htmlFor="n8n-payload">
              JSON payload sent with every trigger
            </label>
            <Textarea
              id="n8n-payload"
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
              className="mt-1 min-h-20 resize-none border-primary/25 bg-surface font-mono text-xs"
            />
          </HudPanel>

          <HudPanel title="Setup checklist" hint="local n8n in three steps">
            <ol className="space-y-2 font-mono text-[11px] text-muted-foreground">
              <li>
                1 · start n8n locally: <span className="text-primary">npx n8n start</span>
              </li>
              <li>2 · create an API key in n8n Settings → n8n API</li>
              <li>
                3 · allow this origin: <span className="text-primary">N8N_CORS_ALLOW_ORIGIN=*</span>
              </li>
              <li>4 · paste URL + key on the left and press Connect</li>
            </ol>
            <p className="mt-3 text-xs text-muted-foreground">
              FRIDAY stores the URL and key on this machine only. Workflows imported from files or
              GitHub work even when n8n is offline — they run once you connect.
            </p>
          </HudPanel>
        </div>
      ) : null}

      {tab === "workflows" ? (
        <HudPanel
          className="mt-4"
          title="Workflows"
          hint={
            status === "online" ? "live from n8n + imported" : "imported only — connect for live"
          }
        >
          {workflows.length ? (
            <ul className="space-y-2">
              {workflows.map((w) => (
                <li
                  key={w.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-sm border border-border bg-surface px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-foreground">{w.name}</p>
                    <p className="truncate font-mono text-[10px] text-muted-foreground">
                      id {w.id} · {w.source ?? "n8n"}
                      {w.nodes ? ` · ${w.nodes} nodes` : ""}
                      {w.updatedAt ? ` · ${new Date(w.updatedAt).toLocaleString()}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusPill
                      label={w.active ? "active" : "inactive"}
                      tone={w.active ? "accent" : "muted"}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        saveLocal(
                          local.some((l) => l.id === w.id)
                            ? local.map((l) => (l.id === w.id ? { ...l, active: !l.active } : l))
                            : [{ ...w, active: !w.active }, ...local],
                        )
                      }
                    >
                      <Power className="size-4" /> {w.active ? "Disable" : "Enable"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void trigger(
                          `${base.replace(/\/$/, "")}/webhook/${encodeURIComponent(w.id)}`,
                        )
                      }
                    >
                      <Play className="size-4" /> Run
                    </Button>
                    {w.source !== "n8n" ? (
                      <button
                        type="button"
                        onClick={() => saveLocal(local.filter((l) => l.id !== w.id))}
                        className="text-muted-foreground hover:text-destructive"
                        aria-label="Remove workflow"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="font-mono text-[11px] text-muted-foreground">
              No workflows yet — connect to n8n or import workflow JSON from the Import tab.
            </p>
          )}
        </HudPanel>
      ) : null}

      {tab === "import" ? (
        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <HudPanel title="Import workflows" hint="files · folders · github">
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              accept=".json"
              onChange={(e) => void onFiles(e.target.files, "upload")}
            />
            <input
              ref={dirRef}
              type="file"
              multiple
              hidden
              // @ts-expect-error non-standard, supported in Chromium/Electron
              webkitdirectory=""
              directory=""
              onChange={(e) => void onFiles(e.target.files, "folder")}
            />
            <div className="grid gap-2 sm:grid-cols-2">
              <Button variant="outline" onClick={() => fileRef.current?.click()}>
                <Upload className="size-4" /> Upload workflow JSON
              </Button>
              <Button variant="outline" onClick={() => dirRef.current?.click()}>
                <FolderUp className="size-4" /> Upload folder
              </Button>
            </div>

            <p className="label-xs mt-4 text-muted-foreground">GitHub repository with workflows</p>
            <div className="mt-2 flex gap-2">
              <Input
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void cloneRepo()}
                placeholder="owner/repo · https://github.com/owner/repo"
                className="border-primary/25 bg-surface font-mono text-xs"
              />
              <Button onClick={() => void cloneRepo()} disabled={!repo.trim()}>
                <Github className="size-4" /> Clone
              </Button>
            </div>

            <p className="label-xs mt-4 text-muted-foreground">Starter templates</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {TEMPLATES.map((t) => (
                <button
                  key={t.name}
                  type="button"
                  onClick={() =>
                    saveLocal([
                      {
                        id: `tpl-${t.name.replace(/\s+/g, "-").toLowerCase()}`,
                        name: t.name,
                        active: false,
                        source: "template",
                        nodes: t.nodes,
                        updatedAt: new Date().toISOString(),
                      },
                      ...local,
                    ])
                  }
                  className="rounded-sm border border-primary/25 bg-surface px-2.5 py-2 text-left transition-colors hover:border-primary/60"
                >
                  <p className="text-xs text-foreground">{t.name}</p>
                  <p className="font-mono text-[10px] text-muted-foreground">{t.note}</p>
                </button>
              ))}
            </div>
          </HudPanel>

          <HudPanel title="Imported sources" hint={`${n8nImports.length} tracked`}>
            {n8nImports.length ? (
              <ul className="space-y-2">
                {n8nImports.map((i) => (
                  <li key={i.id} className="rounded-sm border border-border bg-surface px-2.5 py-2">
                    <p className="truncate text-xs text-foreground">{i.name}</p>
                    <p className="truncate font-mono text-[10px] text-muted-foreground">
                      {i.origin} · {i.fileCount} files · {formatBytes(i.bytes)}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="font-mono text-[11px] text-muted-foreground">
                Nothing imported into n8n yet.
              </p>
            )}
          </HudPanel>
        </div>
      ) : null}

      {tab === "settings" ? (
        <HudPanel className="mt-4" title="Automation settings">
          <ToggleRow
            label="Expose workflows to FRIDAY agents as tools"
            hint="agents can call any enabled workflow"
            on={exposeTools}
            onToggle={() => setExposeTools((v) => !v)}
          />
          <ToggleRow
            label="Allow agents to run workflows without approval"
            hint="off means every run asks you first"
            on={autoRun}
            onToggle={() => setAutoRun((v) => !v)}
          />
          <ToggleRow
            label="Reconnect to n8n on startup"
            on={autoConnect}
            onToggle={() => setAutoConnect((v) => !v)}
          />
          <ToggleRow
            label="Log every run to Logs"
            on={logRuns}
            onToggle={() => setLogRuns((v) => !v)}
          />
          <ToggleRow
            label="Retry failed runs once"
            hint="with a 30s backoff"
            on={retry}
            onToggle={() => setRetry((v) => !v)}
          />
        </HudPanel>
      ) : null}
    </AppShell>
  );
}
