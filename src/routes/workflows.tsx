import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Loader2, Play, Plus, RefreshCw, Search, Workflow as WorkflowIcon } from "lucide-react";
import { AppShell } from "@/components/friday/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  DataTable,
  FilterTabs,
  HudPanel,
  StatTile,
  StatusPill,
  toneForStatus,
} from "@/components/friday/ui";
import { WorkflowEditor, WorkflowFlow } from "@/components/friday/WorkflowFlow";
import { WorkflowVisualBuilder } from "@/routes/workflow-visual";
import { useCapabilities, type CapabilityItem } from "@/lib/friday/capability-trees";
import { CapabilityMarket } from "@/components/friday/CapabilityMarket";
import { CapabilityImport } from "@/components/friday/CapabilityImport";
import { uninstallPack } from "@/lib/friday/marketplace";
import {
  blankWorkflowDraft,
  forgeWorkflow,
  listWorkflowStepCatalog,
  runWorkflowPack,
  saveWorkflowPack,
  type WorkflowDraft,
  type WorkflowStep,
  type WorkflowStepCatalogEntry,
} from "@/lib/friday/brain/workflow-forge";
import { toast } from "sonner";

export const Route = createFileRoute("/workflows")({
  head: () => ({
    meta: [
      { title: "Workflows — FRIDAY Console" },
      {
        name: "description",
        content:
          "Local FRIDAY workflow packs: sequential steps over skills, tools, agents, modules, and connectors, with a block flow diagram per pack.",
      },
      { property: "og:title", content: "Workflows — FRIDAY Console" },
      {
        property: "og:description",
        content: "Catalog workflows with live step diagrams — no fake completed runs.",
      },
    ],
  }),
  component: WorkflowsPage,
});

type WorkflowStepView = {
  id: string;
  label: string;
  kind: string;
  ref: string;
  risk: string;
};

type WorkflowRow = {
  id: string;
  name: string;
  category: string;
  version: string;
  status: string;
  summary: string;
  schedule: string;
  origin: "app" | "workspace" | "";
  permissions: string[];
  steps: WorkflowStepView[];
  risk: string;
  enabled: boolean;
};

const DESKTOP_ONLY = "This change needs the FRIDAY desktop app.";

function listField(values: string[]): string {
  return values.length ? values.join(", ") : "—";
}

function asDraft(row: WorkflowRow): WorkflowDraft {
  return {
    id: row.id,
    name: row.name,
    description: row.summary,
    category: row.category || "saved",
    schedule: row.schedule || "on demand",
    steps: (row.steps.length ? row.steps : blankWorkflowDraft().steps).map((step, index) => ({
      id: step.id || `s${index + 1}`,
      label: step.label,
      kind: (["skill", "tool", "agent", "module", "connector", "note"].includes(step.kind)
        ? step.kind
        : "note") as WorkflowStep["kind"],
      ref: step.ref,
      risk: step.risk === "write" || step.risk === "exec" ? step.risk : "safe",
    })),
    risk: row.risk === "write" || row.risk === "exec" ? row.risk : "safe",
  };
}

function WorkflowsPage() {
  const [pageView, setPageView] = useState("catalog");
  const [tab, setTab] = useState("all");
  const [category, setCategory] = useState("all");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState<"forge" | "test" | "save" | null>(null);
  const [forgeGoal, setForgeGoal] = useState("");
  const [forgeLog, setForgeLog] = useState("");
  const [editor, setEditor] = useState<WorkflowDraft | null>(null);
  const [catalog, setCatalog] = useState<WorkflowStepCatalogEntry[]>([]);
  const [catalogQuery, setCatalogQuery] = useState("");
  const {
    supported,
    items: workflowPacks,
    refresh: refreshWorkflows,
    toggle,
  } = useCapabilities("workflows");

  useEffect(() => {
    void listWorkflowStepCatalog()
      .then((items) => setCatalog(items))
      .catch(() => setCatalog([]));
  }, [supported]);

  const listed = useMemo<WorkflowRow[]>(
    () =>
      supported
        ? workflowPacks.map((item: CapabilityItem) => ({
            id: item.id,
            name: item.name,
            category: item.category || item.segment || "saved",
            version: item.version ?? "—",
            status: item.enabled ? "Enabled" : "Disabled",
            summary: item.summary || item.description || "",
            schedule: item.schedule || "on demand",
            origin: item.origin,
            permissions: item.permissions || [],
            steps: (item.steps || []).map((step, index) => ({
              id: step.id || `s${index + 1}`,
              label: step.label,
              kind: step.kind,
              ref: step.ref,
              risk: step.risk,
            })),
            risk: item.risk,
            enabled: item.enabled,
          }))
        : [],
    [supported, workflowPacks],
  );

  const categories = useMemo(
    () => [...new Set(listed.map((row) => row.category).filter(Boolean))].sort(),
    [listed],
  );

  const counts = {
    all: listed.length,
    enabled: listed.filter((row) => row.enabled || row.status === "Enabled").length,
    disabled: listed.filter((row) => !(row.enabled || row.status === "Enabled")).length,
    long: listed.filter((row) => row.steps.length >= 8).length,
  };

  const needle = query.trim().toLowerCase();
  const rows = listed.filter((row) => {
    if (tab === "enabled") {
      if (!(row.enabled || row.status === "Enabled")) return false;
    } else if (tab === "disabled") {
      if (row.enabled || row.status === "Enabled") return false;
    } else if (tab === "long") {
      if (row.steps.length < 8) return false;
    }
    if (category !== "all" && row.category !== category) return false;
    if (!needle) return true;
    return `${row.name} ${row.category} ${row.summary} ${row.schedule} ${row.steps.map((step) => step.label).join(" ")}`
      .toLowerCase()
      .includes(needle);
  });

  const openRow =
    listed.find((row) => row.id === openId || (!row.id && row.name === openId)) || null;
  const longest = listed.reduce((max, row) => Math.max(max, row.steps.length), 0);

  const onToggle = async (row: WorkflowRow, next: boolean) => {
    if (!row.id || !supported) {
      toast.error(DESKTOP_ONLY);
      return;
    }
    setBusyId(row.id);
    try {
      const ok = await toggle(row.id, next);
      if (!ok) toast.error("Could not update that workflow.");
    } finally {
      setBusyId(null);
    }
  };

  const onRemove = async (row: WorkflowRow) => {
    if (!row.id) {
      toast.error(supported ? "Nothing to remove." : DESKTOP_ONLY);
      return;
    }
    if (row.origin === "app") {
      toast.error("Shipped workflows stay in the catalog. Disable them instead of removing.");
      return;
    }
    if (confirmId !== row.id) {
      setConfirmId(row.id);
      return;
    }
    setBusyId(row.id);
    try {
      const result = await uninstallPack(row.id);
      if (result.ok) {
        toast.success(`Removed ${row.name}.`);
        setConfirmId(null);
        if (openId === row.id) setOpenId(null);
        await refreshWorkflows();
      } else {
        toast.error(result.error || "Could not remove that workflow.");
      }
    } finally {
      setBusyId(null);
    }
  };

  const onForge = async () => {
    const goal = forgeGoal.trim();
    if (!goal) return;
    setImportBusy("forge");
    setForgeLog("");
    try {
      const run = await forgeWorkflow(goal, {
        onProgress: (next) => setForgeLog(next.log.map((line) => line.text).join("\n")),
      });
      setForgeLog(run.log.map((line) => line.text).join("\n"));
      if (run.stage === "done") {
        toast.success(`Installed ${run.workflowId} (disabled).`);
        setForgeGoal("");
        await refreshWorkflows();
      } else {
        toast.error(run.error || "Workflow forge failed.");
      }
    } finally {
      setImportBusy(null);
    }
  };

  const onTest = async (row?: WorkflowRow | null) => {
    const target = row ?? openRow;
    if (!target?.id) {
      toast.error(supported ? "Open Details on a workflow to test it." : DESKTOP_ONLY);
      return;
    }
    setOpenId(target.id);
    setImportBusy("test");
    try {
      const result = await runWorkflowPack(target.id, { allowDisabled: true, dryRun: true });
      const lines = [
        `${result.name} — ${result.steps.length} step(s)`,
        ...result.steps.map(
          (step, index) =>
            `${index + 1}. ${step.ok ? "ok" : "fail"}${step.skipped ? " (dry-run skip)" : ""} — ${step.label}: ${step.detail}`,
        ),
      ];
      setForgeLog(lines.join("\n"));
      if (result.ok) toast.success(`${target.name} dry-ran ${result.steps.length} step(s).`);
      else toast.error(result.error || "Workflow test failed.");
    } finally {
      setImportBusy(null);
    }
  };

  const onNew = () => {
    setEditor(blankWorkflowDraft());
    setOpenId(null);
  };

  const onEdit = (row: WorkflowRow) => {
    setEditor(asDraft(row));
    setOpenId(row.id || row.name);
  };

  const patchEditor = (next: Partial<WorkflowDraft>) => {
    setEditor((current) => (current ? { ...current, ...next } : current));
  };

  const patchStep = (index: number, next: WorkflowStep) => {
    setEditor((current) => {
      if (!current) return current;
      const steps = current.steps.map((step, i) => (i === index ? next : step));
      return { ...current, steps };
    });
  };

  const addStep = () => {
    setEditor((current) => {
      if (!current) return current;
      const n = current.steps.length + 1;
      return {
        ...current,
        steps: [
          ...current.steps,
          {
            id: `s${n}`,
            label: `Local note ${n}`,
            kind: "note",
            ref: `note-${n}`,
            risk: "safe",
          },
        ],
      };
    });
  };

  const removeStep = (index: number) => {
    setEditor((current) => {
      if (!current || current.steps.length <= 1) return current;
      return { ...current, steps: current.steps.filter((_, i) => i !== index) };
    });
  };

  const moveStep = (index: number, direction: -1 | 1) => {
    setEditor((current) => {
      if (!current) return current;
      const next = index + direction;
      if (next < 0 || next >= current.steps.length) return current;
      const steps = [...current.steps];
      const swap = steps[index]!;
      steps[index] = steps[next]!;
      steps[next] = swap;
      return { ...current, steps };
    });
  };

  const onSave = async () => {
    if (!editor) return;
    setImportBusy("save");
    setForgeLog("");
    try {
      const run = await saveWorkflowPack(editor, {
        onProgress: (next) => setForgeLog(next.log.map((line) => line.text).join("\n")),
      });
      setForgeLog(run.log.map((line) => line.text).join("\n"));
      if (run.stage === "done") {
        toast.success(`Saved ${run.workflowId} (disabled).`);
        setEditor(null);
        if (run.workflowId) setOpenId(run.workflowId);
        await refreshWorkflows();
      } else {
        toast.error(run.error || "Could not save that workflow.");
      }
    } finally {
      setImportBusy(null);
    }
  };

  return (
    <AppShell
      title="Workflows"
      subtitle="Repeatable local automations — click Details for the block flow, Edit flow to change it"
      actions={
        <div className="flex gap-2">
          <CapabilityMarket
            tree="workflows"
            installedIds={workflowPacks.map((item) => item.id)}
            onChanged={refreshWorkflows}
          />
          <CapabilityImport
            tree="workflows"
            installedIds={workflowPacks.map((item) => item.id)}
            onChanged={refreshWorkflows}
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void refreshWorkflows();
              toast.info("Re-scanning installed workflows…");
            }}
          >
            <RefreshCw className="size-4" /> Refresh
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatTile
            icon={<WorkflowIcon className="size-4" />}
            label="Total"
            value={counts.all}
            state="packs"
          />
          <StatTile label="Enabled" value={counts.enabled} state="on" tone="accent" />
          <StatTile label="Disabled" value={counts.disabled} state="off" tone="muted" />
          <StatTile label="Longest" value={longest} state="steps" tone="warning" />
        </div>

        <FilterTabs
          value={pageView}
          onChange={setPageView}
          tabs={[
            { key: "catalog", label: "Catalog" },
            { key: "visual", label: "Visual Builder" },
          ]}
        />

        {pageView === "visual" ? (
          <WorkflowVisualBuilder
            packs={listed}
            catalog={catalog}
            selectedId={openId}
            onSelect={setOpenId}
            onSaved={async (id) => {
              if (id) setOpenId(id);
              await refreshWorkflows();
            }}
          />
        ) : null}

        {pageView === "catalog" ? (
          <>
            <div className="relative max-w-md">
              <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search name, category, schedule, or step…"
                className="h-8 pl-8 font-mono text-xs"
              />
            </div>
            <FilterTabs
              value={category}
              onChange={setCategory}
              tabs={[
                { key: "all", label: "All categories" },
                ...categories.map((key) => ({
                  key,
                  label: `${key} (${listed.filter((row) => row.category === key).length})`,
                })),
              ]}
            />

            <HudPanel
              title="All Workflows"
              hint={`${rows.length} shown`}
              actions={
                <FilterTabs
                  value={tab}
                  onChange={setTab}
                  tabs={[
                    { key: "all", label: `All (${counts.all})` },
                    { key: "enabled", label: `Enabled (${counts.enabled})` },
                    { key: "disabled", label: `Disabled (${counts.disabled})` },
                    { key: "long", label: `Long (${counts.long})` },
                  ]}
                />
              }
            >
              <DataTable
                columns={["Workflow Name", "Category", "Steps", "Schedule", "Status", ""]}
                rows={rows.map((row) => [
                  <button
                    key="n"
                    type="button"
                    className="flex items-center gap-2 text-left text-foreground"
                    onClick={() =>
                      setOpenId((current) =>
                        current === (row.id || row.name) ? null : row.id || row.name,
                      )
                    }
                  >
                    <WorkflowIcon className="size-3.5 text-primary" />
                    {row.name}
                  </button>,
                  <span key="k" className="text-muted-foreground">
                    {row.category}
                  </span>,
                  <span key="c" className="font-mono text-xs text-foreground">
                    {row.steps.length || "—"}
                  </span>,
                  <span key="x" className="font-mono text-xs text-primary">
                    {row.schedule}
                  </span>,
                  <span key="s" className="flex items-center gap-2">
                    {supported && row.id ? (
                      <Switch
                        checked={row.enabled}
                        onCheckedChange={(next) => void onToggle(row, next)}
                        disabled={Boolean(busyId)}
                        aria-label={`Enable ${row.name}`}
                      />
                    ) : null}
                    <StatusPill label={row.status} tone={toneForStatus(row.status)} />
                  </span>,
                  <span key="a" className="flex flex-wrap items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-[11px]"
                      disabled={!row.id || importBusy !== null}
                      aria-label={`Test ${row.name}`}
                      onClick={() => void onTest(row)}
                    >
                      <Play className="size-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-[11px]"
                      disabled={!row.id && supported}
                      onClick={() =>
                        setOpenId((current) =>
                          current === (row.id || row.name) ? null : row.id || row.name,
                        )
                      }
                    >
                      {openId === (row.id || row.name) ? "Hide" : "Details"}
                    </Button>
                    <Button
                      size="sm"
                      variant={confirmId === row.id ? "destructive" : "outline"}
                      className="h-7 px-2 text-[11px]"
                      disabled={!row.id || Boolean(busyId)}
                      onClick={() => void onRemove(row)}
                    >
                      {confirmId === row.id ? "Confirm remove" : "Remove"}
                    </Button>
                  </span>,
                ])}
              />
            </HudPanel>

            {openRow ? (
              <HudPanel title={`${openRow.name} details`} hint={openRow.id || "preview"}>
                <div className="space-y-3">
                  <div className="space-y-1 font-mono text-[11px]">
                    <p>
                      <span className="text-muted-foreground">Category — </span>
                      {openRow.category || "—"}
                    </p>
                    <p>
                      <span className="text-muted-foreground">Schedule — </span>
                      {openRow.schedule || "—"}
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
                      <span className="text-muted-foreground">Summary — </span>
                      {openRow.summary || "—"}
                    </p>
                  </div>
                  <WorkflowFlow steps={openRow.steps} description={openRow.summary} />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8"
                    disabled={importBusy !== null}
                    onClick={() => onEdit(openRow)}
                  >
                    Edit flow
                  </Button>
                </div>
              </HudPanel>
            ) : null}

            {editor ? (
              <HudPanel title="Edit flow" hint={editor.id || "new"}>
                <WorkflowEditor
                  name={editor.name}
                  description={editor.description}
                  category={editor.category}
                  schedule={editor.schedule}
                  steps={editor.steps}
                  catalog={catalog}
                  catalogQuery={catalogQuery}
                  busy={importBusy !== null}
                  onName={(value) => patchEditor({ name: value })}
                  onDescription={(value) => patchEditor({ description: value })}
                  onCategory={(value) => patchEditor({ category: value })}
                  onSchedule={(value) => patchEditor({ schedule: value })}
                  onCatalogQuery={setCatalogQuery}
                  onStep={patchStep}
                  onAddStep={addStep}
                  onRemoveStep={removeStep}
                  onMoveStep={moveStep}
                  onSave={() => void onSave()}
                  onCancel={() => setEditor(null)}
                />
              </HudPanel>
            ) : null}

            <HudPanel title="Create and test" hint="sandbox then owner approval">
              <div className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  <Input
                    value={forgeGoal}
                    onChange={(event) => setForgeGoal(event.target.value)}
                    placeholder="Describe a new workflow FRIDAY should write…"
                    className="h-8 min-w-[16rem] flex-1 font-mono text-xs"
                    disabled={importBusy !== null}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void onForge();
                    }}
                  />
                  <Button
                    size="sm"
                    className="h-8"
                    disabled={!forgeGoal.trim() || importBusy !== null}
                    onClick={() => void onForge()}
                  >
                    {importBusy === "forge" ? <Loader2 className="size-4 animate-spin" /> : null}
                    Forge
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8"
                    disabled={importBusy !== null}
                    onClick={onNew}
                  >
                    <Plus className="size-4" /> New workflow
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8"
                    disabled={importBusy !== null}
                    onClick={() => void onTest()}
                  >
                    {importBusy === "test" ? <Loader2 className="size-4 animate-spin" /> : null}
                    Test selected
                  </Button>
                </div>
                {forgeLog ? (
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">
                    {forgeLog}
                  </pre>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Forge drafts a workflow.json with real step refs, sandbox-verifies it, then
                    waits for your install approval. New workflow opens a visual editor (add /
                    reorder / Save). Test selected dry-runs the selected pack&apos;s steps (disabled
                    packs allowed). Chat can run one pack, one after one, or several at once when
                    you name them. n8n stays on its own page — these packs are local FRIDAY
                    workflows.
                  </p>
                )}
              </div>
            </HudPanel>
          </>
        ) : null}
      </div>
    </AppShell>
  );
}
