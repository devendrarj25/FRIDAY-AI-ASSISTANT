import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
import {
  Activity,
  Check,
  Loader2,
  Package,
  Play,
  ShieldCheck,
  Trash2,
  Upload,
  FolderOpen,
  FileUp,
} from "lucide-react";
import { Github } from "@/components/friday/icons/github";
import { AppShell, Panel } from "@/components/friday/AppShell";
import { HubWorkbench } from "@/components/friday/HubWorkbench";
import { DevControl } from "@/components/friday/hub/DevControl";
import { HubChat } from "@/components/friday/hub/HubChat";
import { HubRepoActions } from "@/components/friday/hub/HubRepoActions";
import { RepoSwitch } from "@/components/friday/hub/RepoSwitch";
import { ReleaseControls } from "@/components/friday/settings/ReleaseControls";
import { RevertCenter } from "@/components/friday/hub/RevertCenter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { hub, type HubHealth, type HubResource } from "@/lib/friday/hub-engine";
import { useHub } from "@/lib/friday/use-hub";

export const Route = createFileRoute("/hub")({
  head: () => ({
    meta: [
      { title: "Friday Hub — FRIDAY" },
      {
        name: "description",
        content:
          "Clone from GitHub or import a ZIP, folder or file: FRIDAY inspects it, shows the exact install plan, health-tests it and registers it as a real capability.",
      },
      { property: "og:title", content: "Friday Hub — FRIDAY" },
      {
        property: "og:description",
        content: "Approval-gated capability installs wired straight into the Core Brain.",
      },
    ],
  }),
  component: HubPage,
});

const HEALTH_TONE: Record<HubHealth, string> = {
  ready: "text-success",
  testing: "text-primary",
  degraded: "text-warning",
  failed: "text-destructive",
  unknown: "text-muted-foreground",
};

const time = (at: number) =>
  new Date(at).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

function ResourceCard({ resource }: { resource: HubResource }) {
  const [configKey, setConfigKey] = useState("");
  const [configValue, setConfigValue] = useState("");
  const pending = resource.status === "awaiting-approval";
  const busy = resource.status === "installing" || resource.health === "testing";

  return (
    <Panel
      title={resource.name}
      hint={`${resource.source} · ${resource.kind}${resource.version ? ` · v${resource.version}` : ""}`}
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="label-xs">
            {resource.status}
          </Badge>
          <span className={`font-mono text-[11px] ${HEALTH_TONE[resource.health]}`}>
            health: {resource.health}
          </span>
          <span className="font-mono text-[11px] text-muted-foreground">
            permission: {resource.permission}
          </span>
          {resource.restartRequired ? (
            <span className="font-mono text-[11px] text-warning">restart required</span>
          ) : null}
        </div>

        <p className="text-xs text-muted-foreground">{resource.healthMessage}</p>

        {resource.capabilities.length ? (
          <div className="flex flex-wrap gap-1.5">
            {resource.capabilities.map((cap) => (
              <span
                key={cap}
                className="rounded-sm border border-primary/25 bg-primary/8 px-1.5 py-0.5 font-mono text-[10px] text-primary"
              >
                {cap}
              </span>
            ))}
          </div>
        ) : null}

        {resource.dependencies.length ? (
          <p className="font-mono text-[11px] text-muted-foreground">
            dependencies: {resource.dependencies.join(", ")}
          </p>
        ) : null}

        {resource.notes.length ? (
          <ul className="space-y-0.5">
            {resource.notes.map((note) => (
              <li key={note} className="font-mono text-[11px] text-muted-foreground">
                · {note}
              </li>
            ))}
          </ul>
        ) : null}

        {resource.plan.length ? (
          <div className="rounded-sm border border-primary/20 bg-surface p-2">
            <p className="label-xs mb-1 text-primary/70">
              Install plan · {resource.planFiles} file(s)
            </p>
            {resource.plan.map((entry) => (
              <p key={entry.dir} className="font-mono text-[11px] text-muted-foreground">
                {entry.dir} → {entry.files} file(s)
              </p>
            ))}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          {pending ? (
            <Button size="sm" disabled={busy} onClick={() => void hub.approve(resource.id)}>
              {busy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Check className="size-3.5" />
              )}
              Approve &amp; install
            </Button>
          ) : null}
          {resource.status === "installed" ? (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void hub.healthTest(resource.id)}
              >
                <Play className="size-3.5" /> Health test
              </Button>
              <label className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
                <Switch
                  checked={resource.active}
                  onCheckedChange={(checked) => hub.setActive(resource.id, checked)}
                />
                {resource.active ? "active" : "inactive"}
              </label>
              {resource.path ? (
                <Button size="sm" variant="ghost" onClick={() => hub.reveal(resource.id)}>
                  <FolderOpen className="size-3.5" /> Reveal
                </Button>
              ) : null}
            </>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => void hub.remove(resource.id)}>
            <Trash2 className="size-3.5" /> {pending ? "Reject" : "Remove"}
          </Button>
        </div>

        {resource.scanId ? <HubWorkbench resource={resource} /> : null}

        {resource.status === "installed" ? (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={configKey}
              onChange={(event) => setConfigKey(event.target.value)}
              placeholder="setting"
              className="h-8 w-32 font-mono text-[11px]"
            />
            <Input
              value={configValue}
              onChange={(event) => setConfigValue(event.target.value)}
              placeholder="value"
              className="h-8 w-40 font-mono text-[11px]"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!configKey.trim()}
              onClick={() => {
                hub.configure(resource.id, { [configKey.trim()]: configValue });
                setConfigKey("");
                setConfigValue("");
              }}
            >
              Save setting
            </Button>
            {Object.entries(resource.config).map(([key, value]) => (
              <span key={key} className="font-mono text-[11px] text-muted-foreground">
                {key}={value || "—"}
              </span>
            ))}
          </div>
        ) : null}

        <details>
          <summary className="cursor-pointer font-mono text-[11px] text-muted-foreground">
            Activity ({resource.log.length})
          </summary>
          <div className="mt-1 space-y-0.5">
            {resource.log.map((line, index) => (
              <p
                key={`${line.at}-${index}`}
                className="font-mono text-[10px] text-muted-foreground"
              >
                {time(line.at)} · {line.level} · {line.text}
              </p>
            ))}
          </div>
        </details>
      </div>
    </Panel>
  );
}

function HubPage() {
  const state = useHub();
  const [repo, setRepo] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [hubKey, setHubKey] = useState("self");
  const [hubRole, setHubRole] = useState<"self" | "linked">("self");

  const installed = state.resources.filter((r) => r.status === "installed");
  const pending = state.resources.filter((r) => r.status !== "installed");

  return (
    <AppShell
      title="Friday Hub"
      subtitle="Development and repo control, plus capability imports approved, health-tested and handed to the Core Brain"
    >
      <div className="space-y-3">
        <RepoSwitch
          onSelected={(id, role) => {
            setHubKey(id);
            setHubRole(role);
          }}
        />
        <DevControl key={hubKey} />
        {hubRole === "self" ? <ReleaseControls /> : null}
        <HubRepoActions key={`actions-${hubKey}`} />
        <RevertCenter key={`revert-${hubKey}`} />
        <HubChat key={`chat-${hubKey}`} />

        <Panel
          title="Bring in a capability"
          hint={`${installed.length} installed · ${installed.filter((r) => r.active).length} active`}
        >
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={repo}
                onChange={(event) => setRepo(event.target.value)}
                placeholder="https://github.com/owner/repo"
                className="h-9 min-w-[260px] flex-1 font-mono text-xs"
              />
              <Button
                size="sm"
                disabled={state.busy || !repo.trim()}
                onClick={() => {
                  const url = repo.trim();
                  setRepo("");
                  void hub.inspectGithub(url);
                }}
              >
                {state.busy ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Github className="size-3.5" />
                )}
                Clone &amp; inspect
              </Button>
              <Button size="sm" variant="outline" onClick={() => void hub.inspectZip()}>
                <Package className="size-3.5" /> ZIP
              </Button>
              <Button size="sm" variant="outline" onClick={() => void hub.inspectFolder()}>
                <FolderOpen className="size-3.5" /> Folder
              </Button>
              <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
                <FileUp className="size-3.5" /> File
              </Button>
              <input
                ref={fileRef}
                type="file"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void hub.inspectFile(file);
                }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Everything stays staged and isolated until you approve it. FRIDAY identifies what it
              is (model, tool, skill, agent, module, plugin, workflow or runtime), checks
              dependencies and source, installs it into the matching FRIDAY area inside your own
              project folder, then proves it works by running it.
            </p>
            {state.message ? (
              <div className="flex items-center justify-between gap-2 rounded-sm border border-warning/30 bg-warning/10 px-2.5 py-1.5">
                <p className="font-mono text-[11px] text-warning">{state.message}</p>
                <Button size="sm" variant="ghost" onClick={() => hub.clearMessage()}>
                  Dismiss
                </Button>
              </div>
            ) : null}
          </div>
        </Panel>

        {pending.length ? (
          <>
            <p className="label-xs px-1 text-primary/70">
              <ShieldCheck className="mr-1 inline size-3" /> Waiting for your approval
            </p>
            {pending.map((resource) => (
              <ResourceCard key={resource.id} resource={resource} />
            ))}
          </>
        ) : null}

        {installed.length ? (
          <>
            <p className="label-xs px-1 text-primary/70">
              <Activity className="mr-1 inline size-3" /> Registered capabilities
            </p>
            {installed.map((resource) => (
              <ResourceCard key={resource.id} resource={resource} />
            ))}
          </>
        ) : null}

        {!state.resources.length ? (
          <Panel title="Nothing imported yet" hint="hub">
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Upload className="size-3.5" /> Paste a GitHub URL or pick a ZIP, folder or file to
              begin.
            </p>
          </Panel>
        ) : null}
      </div>
    </AppShell>
  );
}
