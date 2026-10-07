import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Loader2, Plug, RefreshCw, Search } from "lucide-react";
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
import { useCapabilities, type CapabilityItem } from "@/lib/friday/capability-trees";
import { CapabilityMarket } from "@/components/friday/CapabilityMarket";
import { CapabilityImport } from "@/components/friday/CapabilityImport";
import { uninstallPack } from "@/lib/friday/marketplace";
import { dispatchPluginHooks, forgePlugin } from "@/lib/friday/brain/plugin-forge";
import { setPluginEnabled, checkPluginUpdates } from "@/lib/friday/desktop";
import { toast } from "sonner";

export const Route = createFileRoute("/plugins")({
  head: () => ({
    meta: [
      { title: "Plugins — FRIDAY Console" },
      {
        name: "description",
        content:
          "Manage core and custom FRIDAY plugins: versions, load state and available updates, all running locally.",
      },
      { property: "og:title", content: "Plugins — FRIDAY Console" },
      {
        property: "og:description",
        content: "Core and custom plugin registry with update tracking.",
      },
    ],
  }),
  component: PluginsPage,
});

type PluginRow = {
  id: string;
  name: string;
  kind: string;
  category: string;
  version: string;
  status: string;
  latest: string;
  summary: string;
  origin: "app" | "workspace" | "";
  permissions: string[];
  hooks: string[];
  entry: string;
  enabled: boolean;
};

const DESKTOP_ONLY = "This change needs the FRIDAY desktop app.";

function listField(values: string[]): string {
  return values.length ? values.join(", ") : "—";
}

function PluginsPage() {
  const [tab, setTab] = useState("all");
  const [category, setCategory] = useState("all");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState<"forge" | "test" | null>(null);
  const [forgeGoal, setForgeGoal] = useState("");
  const [forgeLog, setForgeLog] = useState("");
  const [pluginLatest, setPluginLatest] = useState<Record<string, string>>({});
  const {
    supported,
    items: pluginPacks,
    refresh: refreshPlugins,
    toggle,
  } = useCapabilities("plugins");

  const listed = useMemo<PluginRow[]>(
    () =>
      supported
        ? pluginPacks.map((item: CapabilityItem) => ({
            id: item.id,
            name: item.name,
            kind: item.category || (item.origin === "app" ? "Core" : "Custom"),
            category: item.category || item.segment || "installed",
            version: item.version ?? "—",
            status: item.enabled ? "Active" : "Inactive",
            latest: pluginLatest[item.id] || "",
            summary: item.summary || item.description || "",
            origin: item.origin,
            permissions: item.permissions || [],
            hooks: item.hooks || [],
            entry: item.entry || "index.cjs",
            enabled: item.enabled,
          }))
        : [],
    [supported, pluginPacks, pluginLatest],
  );

  const categories = useMemo(
    () => [...new Set(listed.map((row) => row.category).filter(Boolean))].sort(),
    [listed],
  );

  const updates = listed.filter((p) => Boolean(p.latest) && p.version !== p.latest);
  const counts = {
    all: listed.length,
    loaded: listed.filter((p) => p.status === "Active" || p.status === "Ready").length,
    active: listed.filter((p) => p.status === "Active").length,
    inactive: listed.filter((p) => p.status === "Inactive").length,
    updates: updates.length,
  };

  const needle = query.trim().toLowerCase();
  const rows = listed.filter((p) => {
    if (tab === "updates") {
      if (!p.latest || p.version === p.latest) return false;
    } else if (tab === "loaded") {
      if (!(p.status === "Active" || p.status === "Ready")) return false;
    } else if (tab !== "all" && p.status.toLowerCase() !== tab) {
      return false;
    }
    if (category !== "all" && p.category !== category) return false;
    if (!needle) return true;
    return `${p.name} ${p.category} ${p.summary} ${p.kind}`.toLowerCase().includes(needle);
  });

  const openRow = listed.find((row) => row.id === openId) || null;

  const onToggle = async (row: PluginRow, next: boolean) => {
    if (!row.id || !supported) {
      toast.error(DESKTOP_ONLY);
      return;
    }
    setBusyId(row.id);
    try {
      const ok = await toggle(row.id, next);
      if (!ok) {
        toast.error("Could not update that plugin.");
        return;
      }
      const runtime = await setPluginEnabled(row.id, next);
      if (!runtime?.ok) toast.error(runtime?.error || "Could not update the plugin runtime.");
    } finally {
      setBusyId(null);
    }
  };

  const onRemove = async (row: PluginRow) => {
    if (!row.id) {
      toast.error(supported ? "Nothing to remove." : DESKTOP_ONLY);
      return;
    }
    if (row.origin === "app") {
      toast.error("Shipped plugins stay in the catalog. Disable them instead of removing.");
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
        await refreshPlugins();
      } else {
        toast.error(result.error || "Could not remove that plugin.");
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
      const run = await forgePlugin(goal, {
        onProgress: (next) => setForgeLog(next.log.map((line) => line.text).join("\n")),
      });
      setForgeLog(run.log.map((line) => line.text).join("\n"));
      if (run.stage === "done") {
        toast.success(`Installed ${run.pluginId} (disabled).`);
        setForgeGoal("");
        await refreshPlugins();
      } else {
        toast.error(run.error || "Plugin forge failed.");
      }
    } finally {
      setImportBusy(null);
    }
  };

  const onTest = async () => {
    if (!openRow?.id) {
      toast.error(supported ? "Open Details on a plugin to test it." : DESKTOP_ONLY);
      return;
    }
    const hook = openRow.hooks[0];
    if (!hook) {
      toast.error("This plugin declares no hooks to test.");
      return;
    }
    setImportBusy("test");
    try {
      const result = await dispatchPluginHooks(
        hook,
        { prompt: "test", source: "plugins-page" },
        { allowDisabled: true, pluginId: openRow.id },
      );
      if (result?.ok) {
        const preview = JSON.stringify(result.fired ?? result)?.slice(0, 400);
        setForgeLog(preview || "(no output)");
        toast.success(`${openRow.name} dispatched ${hook}.`);
      } else {
        const error = String(result?.error || "Plugin test failed.");
        setForgeLog(error);
        toast.error(error);
      }
    } finally {
      setImportBusy(null);
    }
  };

  return (
    <AppShell
      title="Plugins"
      subtitle="Core capability packs and your own custom plugins"
      actions={
        <div className="flex gap-2">
          <CapabilityMarket
            tree="plugins"
            installedIds={pluginPacks.map((item) => item.id)}
            onChanged={refreshPlugins}
          />
          <CapabilityImport
            tree="plugins"
            installedIds={pluginPacks.map((item) => item.id)}
            onChanged={refreshPlugins}
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void (async () => {
                const result = await checkPluginUpdates();
                const next: Record<string, string> = {};
                for (const row of result.plugins ?? []) {
                  if (row.id && row.latest) next[row.id] = row.latest;
                }
                setPluginLatest(next);
                await refreshPlugins();
                toast.info("Re-scanning installed plugins…");
              })();
            }}
          >
            <RefreshCw className="size-4" /> Check updates
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          <StatTile
            icon={<Plug className="size-4" />}
            label="Total"
            value={counts.all}
            state="plugins"
          />
          <StatTile label="Loaded" value={counts.loaded} state="in memory" tone="accent" />
          <StatTile label="Active" value={counts.active} state="enabled" tone="accent" />
          <StatTile label="Inactive" value={counts.inactive} state="disabled" tone="muted" />
          <StatTile label="Updates" value={counts.updates} state="available" tone="warning" />
        </div>

        <div className="relative max-w-md">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search name, category, or summary…"
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
          title="All Plugins"
          hint={`${rows.length} shown`}
          actions={
            <FilterTabs
              value={tab}
              onChange={setTab}
              tabs={[
                { key: "all", label: `All (${counts.all})` },
                { key: "loaded", label: `Loaded (${counts.loaded})` },
                { key: "active", label: `Active (${counts.active})` },
                { key: "inactive", label: `Inactive (${counts.inactive})` },
                { key: "updates", label: `Updates (${counts.updates})` },
              ]}
            />
          }
        >
          <DataTable
            columns={["Plugin Name", "Type", "Version", "Status", "Latest", ""]}
            rows={rows.map((p) => [
              <span key="n" className="flex items-center gap-2 text-foreground">
                <Plug className="size-3.5 text-primary" />
                {p.name}
              </span>,
              <span key="k" className="text-muted-foreground">
                {p.kind}
              </span>,
              <span key="v" className="font-mono text-xs text-foreground">
                {p.version}
              </span>,
              <span key="s" className="flex items-center gap-2">
                {supported && p.id ? (
                  <Switch
                    checked={p.enabled}
                    onCheckedChange={(next) => void onToggle(p, next)}
                    disabled={Boolean(busyId)}
                    aria-label={`Enable ${p.name}`}
                  />
                ) : null}
                <StatusPill label={p.status} tone={toneForStatus(p.status)} />
              </span>,
              <span
                key="l"
                className={
                  p.latest && p.version !== p.latest
                    ? "font-mono text-xs text-warning"
                    : "font-mono text-xs text-muted-foreground"
                }
              >
                {p.latest || "—"}
              </span>,
              <span key="a" className="flex flex-wrap items-center gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-[11px]"
                  disabled={!p.id && supported}
                  onClick={() => setOpenId((current) => (current === p.id ? null : p.id || p.name))}
                >
                  {openId === (p.id || p.name) ? "Hide" : "Details"}
                </Button>
                <Button
                  size="sm"
                  variant={confirmId === p.id ? "destructive" : "outline"}
                  className="h-7 px-2 text-[11px]"
                  disabled={!p.id || Boolean(busyId)}
                  onClick={() => void onRemove(p)}
                >
                  {confirmId === p.id ? "Confirm remove" : "Remove"}
                </Button>
              </span>,
            ])}
          />
        </HudPanel>

        {openRow ? (
          <HudPanel title={`${openRow.name} details`} hint={openRow.id || "preview"}>
            <div className="space-y-1 font-mono text-[11px]">
              <p>
                <span className="text-muted-foreground">Category — </span>
                {openRow.category || "—"}
              </p>
              <p>
                <span className="text-muted-foreground">Entry — </span>
                {openRow.entry || "—"}
              </p>
              <p>
                <span className="text-muted-foreground">Hooks — </span>
                {listField(openRow.hooks)}
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
          </HudPanel>
        ) : null}

        <HudPanel title="Create and test" hint="sandbox then owner approval">
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Input
                value={forgeGoal}
                onChange={(event) => setForgeGoal(event.target.value)}
                placeholder="Describe a new plugin FRIDAY should write…"
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
                Forge drafts a plugin, sandbox-verifies it, then waits for your install approval.
                Test selected dispatches only the selected pack's first declared hook (disabled
                packs allowed).
              </p>
            )}
          </div>
        </HudPanel>
      </div>
    </AppShell>
  );
}
