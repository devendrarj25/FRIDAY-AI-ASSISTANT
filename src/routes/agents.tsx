import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Loader2, Plus, Sparkles, Users } from "lucide-react";
import { AppShell } from "@/components/friday/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  DataTable,
  FilterTabs,
  HudPanel,
  Ring,
  StatTile,
  StatusPill,
  toneForStatus,
} from "@/components/friday/ui";
import { useCapabilities, type CapabilityItem } from "@/lib/friday/capability-trees";
import { useLedger } from "@/lib/friday/self/use-self";
import { lastUsedLabel, statsFor, tasksFor } from "@/lib/friday/self/mastery";
import { hub } from "@/lib/friday/hub-engine";
import { CapabilityMarket } from "@/components/friday/CapabilityMarket";
import { CapabilityImport } from "@/components/friday/CapabilityImport";
import { uninstallPack } from "@/lib/friday/marketplace";
import { toast } from "sonner";
import type { TaskRecord } from "@/lib/friday/self/task-ledger";
import { forgeAgent } from "@/lib/friday/brain/agent-forge";
import { planAgent, runAgent } from "@/lib/friday/agent-runtime";

export const Route = createFileRoute("/agents")({
  head: () => ({
    meta: [
      { title: "Agents — FRIDAY Console" },
      {
        name: "description",
        content:
          "FRIDAY's background agents: roles, live task counts and activity levels for coding, research, system and security work.",
      },
      { property: "og:title", content: "Agents — FRIDAY Console" },
      {
        property: "og:description",
        content: "Background agent fleet with roles and live task load.",
      },
    ],
  }),
  component: AgentsPage,
});

type AgentRow = {
  id: string;
  name: string;
  role: string;
  category: string;
  status: string;
  tasks: number;
  activity: "High" | "Medium" | "Low";
  successRate: number;
  failures: number;
  enabled: boolean;
  description: string;
  risk: string;
  permissions: string[];
  inputs: string[];
  approvalPrompt: string;
  lastRunLabel: string;
  lastRunPreview: string;
  origin: "app" | "workspace" | "";
};

const DESKTOP_ONLY = "This change needs the FRIDAY desktop app.";

function listField(values: string[]): string {
  return values.length ? values.join(", ") : "—";
}

function lastRunFrom(
  tasks: TaskRecord[],
  id: string,
  name: string,
): { label: string; preview: string } {
  const mine = tasksFor(tasks, id, name).filter((task) => task.status !== "queued");
  if (!mine.length) return { label: "never", preview: "" };
  const last = [...mine].sort(
    (a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt),
  )[0]!;
  const bits = [`status: ${last.status}`];
  if (last.error) bits.push(`error: ${last.error}`);
  if (last.result != null) {
    try {
      bits.push(JSON.stringify(last.result, null, 2).slice(0, 800));
    } catch {
      bits.push(String(last.result).slice(0, 800));
    }
  }
  return { label: lastUsedLabel(last.endedAt ?? last.startedAt), preview: bits.join("\n") };
}

function AgentsPage() {
  const [tab, setTab] = useState("all");
  const [category, setCategory] = useState("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState<"forge" | "test" | null>(null);
  const [forgeGoal, setForgeGoal] = useState("");
  const [testInput, setTestInput] = useState("");
  const [forgeLog, setForgeLog] = useState("");
  const { supported, items, refresh, toggle } = useCapabilities("agents");
  const { tasks } = useLedger();

  // Real agents come from the agent manifests on disk; their status and load
  // come from the live task ledger, so nothing here is invented. Activity is
  // derived — see src/lib/friday/self/mastery.ts for the exact formula.
  const agents = useMemo<AgentRow[]>(() => {
    if (!supported) return [];
    return items.map((item: CapabilityItem) => {
      const stats = statsFor(tasks, item.id, item.name);
      const last = lastRunFrom(tasks, item.id, item.name);
      return {
        id: item.id,
        name: item.name,
        role: item.description || item.segment,
        category: item.category || item.segment,
        status: !item.enabled ? "Disabled" : stats.running > 0 ? "Active" : "Idle",
        tasks: stats.executions,
        activity: stats.activity,
        successRate: stats.successRate,
        failures: stats.failures,
        enabled: item.enabled,
        description: item.description || "",
        risk: item.risk || "",
        permissions: item.permissions || [],
        inputs: item.inputs || [],
        approvalPrompt: item.approvalPrompt || "",
        lastRunLabel: last.label,
        lastRunPreview: last.preview,
        origin: item.origin,
      };
    });
  }, [supported, items, tasks]);

  const addAgent = async () => {
    const resource = await hub.inspectFolder();
    if (!resource) {
      toast.error("No agent folder imported.");
      return;
    }
    toast.success(`Inspected ${resource.name} — approve it in Friday Hub to activate.`);
    await refresh();
  };

  const onToggle = async (row: AgentRow, next: boolean) => {
    if (!supported || !row.id) {
      toast.error(DESKTOP_ONLY);
      return;
    }
    const ok = await toggle(row.id, next);
    if (!ok) toast.error("Could not update the capability index.");
  };

  const onRemove = async (row: AgentRow) => {
    if (!supported || !row.id) {
      toast.error(DESKTOP_ONLY);
      return;
    }
    if (row.origin === "app") {
      toast.error(
        "Shipped library packs stay in the app folder. Disable them instead of removing.",
      );
      setConfirmId(null);
      return;
    }
    if (confirmId !== row.id) {
      setConfirmId(row.id);
      return;
    }
    setBusyId(row.id);
    try {
      const result = await uninstallPack(row.id);
      if (result?.ok) {
        toast.success(`${row.name} removed.`);
        setConfirmId(null);
        if (openId === row.id) setOpenId(null);
        await refresh();
      } else {
        toast.error(result?.error || "Uninstall failed.");
      }
    } finally {
      setBusyId(null);
    }
  };

  const onForge = async () => {
    if (!forgeGoal.trim()) return;
    setImportBusy("forge");
    setForgeLog("");
    try {
      const run = await forgeAgent(forgeGoal.trim(), {
        onProgress: (current) =>
          setForgeLog(
            current.log.map((line) => `${line.ok ? "ok" : "fail"} — ${line.text}`).join("\n"),
          ),
      });
      setForgeLog(run.log.map((line) => `${line.ok ? "ok" : "fail"} — ${line.text}`).join("\n"));
      if (run.stage === "done") {
        toast.success(`Installed ${run.agentId}. Enable it after you review the sandbox result.`);
        setForgeGoal("");
        await refresh();
      } else if (run.error) {
        toast.error(run.error);
      }
    } finally {
      setImportBusy(null);
    }
  };

  const onTest = async () => {
    if (!openRow?.id) {
      toast.error(supported ? "Open Details on an agent to test it." : DESKTOP_ONLY);
      return;
    }
    setImportBusy("test");
    try {
      let sample: Record<string, unknown> = {};
      if (testInput.trim().startsWith("{")) {
        try {
          sample = JSON.parse(testInput) as Record<string, unknown>;
        } catch {
          sample = { prompt: testInput };
        }
      } else if (testInput.trim()) {
        sample = { prompt: testInput, folder: testInput, path: testInput };
      }
      const planned = await planAgent(openRow.id, sample, { allowDisabled: true });
      if (!planned.ok) {
        toast.error(String(planned.error || "Agent plan failed."));
        setForgeLog(String(planned.error || "Agent plan failed."));
        return;
      }
      const ran = await runAgent(
        openRow.id,
        { ...sample, plan: planned.value, dryRun: true },
        {
          allowDisabled: true,
        },
      );
      const preview = JSON.stringify({ plan: planned.value, run: ran.value }, null, 2)?.slice(
        0,
        800,
      );
      if (ran.ok) {
        toast.success(`${openRow.name} planned then dry-ran${ran.ms ? ` in ${ran.ms}ms` : ""}.`);
        setForgeLog(preview || "(no output)");
      } else {
        toast.error(String(ran.error || "Agent dry-run failed."));
        setForgeLog(preview || String(ran.error || "Agent dry-run failed."));
      }
    } finally {
      setImportBusy(null);
    }
  };

  const counts = {
    all: agents.length,
    active: agents.filter((a) => a.status === "Active").length,
    idle: agents.filter((a) => a.status === "Idle").length,
    high: agents.filter((a) => a.activity === "High").length,
  };

  const categories = useMemo(() => {
    const found = [...new Set(agents.map((a) => a.category).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b),
    );
    return found;
  }, [agents]);

  const rows = agents.filter((a) => {
    if (tab === "high") {
      if (a.activity !== "High") return false;
    } else if (tab !== "all" && a.status.toLowerCase() !== tab) {
      return false;
    }
    if (category !== "all" && a.category !== category) return false;
    return true;
  });

  const openRow = openId
    ? (rows.find((a) => a.id === openId) ?? agents.find((a) => a.id === openId))
    : null;

  const totalTasks = agents.reduce((n, a) => n + a.tasks, 0);
  const totalFailures = agents.reduce((n, a) => n + a.failures, 0);
  // Fleet efficiency = completed runs / all runs across every agent (real).
  const efficiency = totalTasks ? Math.round(((totalTasks - totalFailures) / totalTasks) * 100) : 0;

  return (
    <AppShell
      title="Agents"
      subtitle="Autonomous workers running inside the local kernel"
      actions={
        <div className="flex gap-2">
          <CapabilityMarket
            tree="agents"
            installedIds={items.map((item) => item.id)}
            onChanged={refresh}
          />
          <CapabilityImport
            tree="agents"
            installedIds={items.map((item) => item.id)}
            onChanged={refresh}
          />
          <Button size="sm" onClick={() => void addAgent()}>
            <Plus className="size-4" /> Add Agent
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <HudPanel
          title="All Agents"
          hint={`${rows.length} shown`}
          actions={
            <FilterTabs
              value={tab}
              onChange={setTab}
              tabs={[
                { key: "all", label: `All (${counts.all})` },
                { key: "active", label: `Active (${counts.active})` },
                { key: "idle", label: `Idle (${counts.idle})` },
                { key: "high", label: `High load (${counts.high})` },
              ]}
            />
          }
        >
          <div className="mb-3">
            <FilterTabs
              value={category}
              onChange={setCategory}
              tabs={[
                { key: "all", label: "All categories" },
                ...categories.map((key) => ({
                  key,
                  label: `${key} (${agents.filter((a) => a.category === key).length})`,
                })),
              ]}
            />
          </div>
          {rows.length ? (
            <>
              <DataTable
                pinLast
                columns={[
                  "Agent Name",
                  "Category",
                  "Role",
                  "Status",
                  "Tasks",
                  "Activity",
                  "Actions",
                ]}
                rows={rows.map((a) => [
                  <span key="n" className="flex items-center gap-2 text-foreground">
                    <Users className="size-3.5 text-primary" />
                    {a.name}
                  </span>,
                  <span key="c" className="text-muted-foreground">
                    {a.category || "—"}
                  </span>,
                  <span key="r" className="text-muted-foreground">
                    {a.role}
                  </span>,
                  <StatusPill key="s" label={a.status} tone={toneForStatus(a.status)} />,
                  <span key="t" className="font-mono text-xs text-foreground">
                    {a.tasks}
                  </span>,
                  <StatusPill
                    key="a"
                    label={a.activity}
                    tone={
                      a.activity === "High"
                        ? "accent"
                        : a.activity === "Medium"
                          ? "primary"
                          : "muted"
                    }
                  />,
                  <span key="x" className="flex items-center gap-1">
                    <Switch
                      checked={a.enabled}
                      onCheckedChange={(next) => void onToggle(a, next)}
                      disabled={!a.id || Boolean(busyId)}
                      aria-label={`Enable ${a.name}`}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-[11px]"
                      disabled={!a.id}
                      onClick={() => setOpenId((current) => (current === a.id ? null : a.id))}
                    >
                      {openId === a.id ? "Hide" : "Details"}
                    </Button>
                    <Button
                      size="sm"
                      variant={confirmId === a.id ? "destructive" : "outline"}
                      className="h-7 px-2 text-[11px]"
                      disabled={Boolean(busyId) || !a.id}
                      onClick={() => void onRemove(a)}
                    >
                      {confirmId === a.id ? "Confirm remove" : "Remove"}
                    </Button>
                    {confirmId === a.id ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => setConfirmId(null)}
                      >
                        Cancel
                      </Button>
                    ) : null}
                  </span>,
                ])}
              />
              {openRow ? (
                <div className="mt-3 space-y-2 border-t border-primary/15 pt-3 font-mono text-[11px]">
                  <p className="label-xs text-primary">{openRow.name}</p>
                  <p className="whitespace-pre-wrap">
                    <span className="text-muted-foreground">Description — </span>
                    {openRow.description || "—"}
                  </p>
                  <p>
                    <span className="text-muted-foreground">Risk — </span>
                    {openRow.risk || "—"}
                  </p>
                  <p>
                    <span className="text-muted-foreground">Permissions — </span>
                    {listField(openRow.permissions)}
                  </p>
                  <p>
                    <span className="text-muted-foreground">Inputs — </span>
                    {listField(openRow.inputs)}
                  </p>
                  <p className="whitespace-pre-wrap">
                    <span className="text-muted-foreground">Approval prompt — </span>
                    {openRow.approvalPrompt || "—"}
                  </p>
                  <p>
                    <span className="text-muted-foreground">Last run — </span>
                    {openRow.lastRunLabel}
                  </p>
                  {openRow.lastRunPreview ? (
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-muted-foreground">
                      {openRow.lastRunPreview}
                    </pre>
                  ) : (
                    <p className="text-muted-foreground">No ledger result stored.</p>
                  )}
                </div>
              ) : null}
            </>
          ) : (
            <p className="py-6 text-center text-xs text-muted-foreground">
              {agents.length
                ? "No agents match this filter."
                : "No agents installed yet — add one with “Add Agent”, import a pack, or forge one below."}
            </p>
          )}
        </HudPanel>

        <HudPanel title="Create and test" hint="sandbox then owner approval">
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Input
                value={forgeGoal}
                onChange={(event) => setForgeGoal(event.target.value)}
                placeholder="Describe a new agent FRIDAY should write…"
                className="h-8 min-w-[16rem] flex-1 font-mono text-xs"
                disabled={importBusy !== null}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void onForge();
                }}
              />
              <Button
                size="sm"
                className="h-8"
                disabled={importBusy !== null || !forgeGoal.trim()}
                onClick={() => void onForge()}
              >
                {importBusy === "forge" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Sparkles className="size-3.5" />
                )}
                Forge
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <Input
                value={testInput}
                onChange={(event) => setTestInput(event.target.value)}
                placeholder="Test input (text or JSON) for the selected agent…"
                className="h-8 min-w-[16rem] flex-1 font-mono text-xs"
                disabled={importBusy !== null || !openRow?.id}
              />
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                disabled={importBusy !== null || !openRow?.id}
                onClick={() => void onTest()}
              >
                {importBusy === "test" ? <Loader2 className="size-4 animate-spin" /> : null}
                Test selected
              </Button>
            </div>
            {forgeLog ? (
              <pre className="max-h-32 overflow-auto rounded-sm bg-background p-2 font-mono text-[10px] leading-relaxed">
                {forgeLog}
              </pre>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                Test selected calls plan() then run() with dryRun. Write/exec agents stay unmutated
                until you approve. Forge uses the same agent-forge path as Self-management.
              </p>
            )}
          </div>
        </HudPanel>

        <HudPanel title="Active Agents" hint="fleet efficiency">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="grid flex-1 grid-cols-2 gap-2 sm:grid-cols-4">
              <StatTile label="Total" value={counts.all} state="agents" />
              <StatTile label="Idle" value={counts.idle} state="waiting" tone="muted" />
              <StatTile label="Running" value={counts.active} state="working" tone="accent" />
              <StatTile label="Tasks" value={totalTasks} state="in flight" tone="warning" />
            </div>
            <Ring
              value={efficiency}
              label="Efficiency"
              sub={
                totalTasks === 0
                  ? "no runs yet"
                  : totalFailures === 0
                    ? "no failed runs"
                    : `${totalFailures} failed`
              }
              tone="accent"
              size={110}
            />
          </div>
        </HudPanel>
      </div>
    </AppShell>
  );
}
