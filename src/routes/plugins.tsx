import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState, useDeferredValue } from "react";
import { FlaskConical, Loader2, Plug, RefreshCw, Search } from "lucide-react";
import { AppShell } from "@/components/friday/AppShell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  DataTable,
  FilterTabs,
  HudPanel,
  StatTile,
  StatusPill,
  toneForStatus,
  EmptyState,
  LoadingState,
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

const PLUGINS_PAGE = 60;

/** When each hook fires, in plain words, so Details can say what a plugin will react to. */
const HOOK_MEANING: Record<string, string> = {
  "on-app-start": "when FRIDAY starts",
  "on-app-quit": "when FRIDAY closes",
  "on-turn-start": "when you send FRIDAY a message",
  "on-turn-complete": "after FRIDAY finishes answering",
  "on-error": "when something fails",
  "on-idle": "when FRIDAY has been idle for a while",
  "on-skill-run": "after a skill runs",
  "on-file-change": "when a watched file changes",
};

const PERMISSION_MEANING: Record<string, string> = {
  "fs.read": "may read files inside your FRIDAY folder",
  "fs.write": "may write files inside your FRIDAY folder",
  "web.access": "may reach the internet",
  "host.require": "may load host modules (needs your approval)",
};

function describeHooks(hooks: string[]): string {
  return hooks.length ? hooks.map((h) => `${h} (${HOOK_MEANING[h] ?? "custom"})`).join("; ") : "—";
}

function describePermissions(permissions: string[]): string {
  return permissions.length
    ? permissions.map((p) => `${p} (${PERMISSION_MEANING[p] ?? "custom"})`).join("; ")
    : "none: it only touches its own data folder";
}

function listField(values: string[]): string {
  return values.length ? values.join(", ") : "—";
}

function PluginsPage() {
  const [tab, setTab] = useState("all");
  const [category, setCategory] = useState("all");
  const [query, setQuery] = useState("");
  // Filtering a long list follows typing at low priority, so the field never lags.
  const deferredQuery = useDeferredValue(query);
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState<"forge" | "test" | null>(null);
  const [source, setSource] = useState("all");
  const [refreshing, setRefreshing] = useState(false);
  const [forgeGoal, setForgeGoal] = useState("");
  const [forgeLog, setForgeLog] = useState("");
  const [pluginLatest, setPluginLatest] = useState<Record<string, string>>({});
  const {
    supported,
    loading,
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
    builtin: listed.filter((p) => p.origin === "app").length,
    installed: listed.filter((p) => p.origin !== "app").length,
    loaded: listed.filter((p) => p.status === "Active" || p.status === "Ready").length,
    active: listed.filter((p) => p.status === "Active").length,
    inactive: listed.filter((p) => p.status === "Inactive").length,
    updates: updates.length,
  };

  const needle = deferredQuery.trim().toLowerCase();
  const rows = listed.filter((p) => {
    if (tab === "updates") {
      if (!p.latest || p.version === p.latest) return false;
    } else if (tab === "loaded") {
      if (!(p.status === "Active" || p.status === "Ready")) return false;
    } else if (tab !== "all" && p.status.toLowerCase() !== tab) {
      return false;
    }
    if (category !== "all" && p.category !== category) return false;
    if (source === "builtin" && p.origin !== "app") return false;
    if (source === "installed" && p.origin === "app") return false;
    if (!needle) return true;
    return `${p.name} ${p.category} ${p.summary} ${p.kind}`.toLowerCase().includes(needle);
  });

  // 78 plugins are listed 60 at a time; a new filter starts again from the first page.
  const filterKey = `${needle}|${category}|${source}|${tab}`;
  const [pageState, setPageState] = useState({ key: filterKey, shown: PLUGINS_PAGE });
  const shown = pageState.key === filterKey ? pageState.shown : PLUGINS_PAGE;
  const setShown = (next: number) => setPageState({ key: filterKey, shown: next });

  const openRow = listed.find((row) => row.id === openId) || null;

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await refreshPlugins();
      toast.success("Plugin list refreshed.");
    } catch {
      toast.error("Could not read the plugin folders.", {
        action: { label: "Retry", onClick: () => void onRefresh() },
      });
    } finally {
      setRefreshing(false);
    }
  };

  const onCheckUpdates = async () => {
    setRefreshing(true);
    try {
      const result = await checkPluginUpdates();
      const next: Record<string, string> = {};
      for (const row of result.plugins ?? []) {
        if (row.id && row.latest) next[row.id] = row.latest;
      }
      setPluginLatest(next);
      await refreshPlugins();
      const newer = Object.entries(next).filter(([id, latest]) => {
        const current = listed.find((p) => p.id === id)?.version;
        return current && current !== latest;
      }).length;
      toast.info(
        newer
          ? `${newer} plugin update(s) available.`
          : "Checked: no plugin has a newer version on its source.",
      );
    } catch {
      toast.error("Could not check for plugin updates.", {
        action: { label: "Retry", onClick: () => void onCheckUpdates() },
      });
    } finally {
      setRefreshing(false);
    }
  };

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

  const testRow = async (row: PluginRow | null) => {
    if (!row?.id) {
      toast.error(supported ? "Open Details on a plugin to test it." : DESKTOP_ONLY);
      return;
    }
    const hook = row.hooks[0];
    if (!hook) {
      toast.error("This plugin declares no hooks to test.");
      return;
    }
    setImportBusy("test");
    try {
      const result = await dispatchPluginHooks(
        hook,
        { prompt: "test", source: "plugins-page" },
        { allowDisabled: true, pluginId: row.id },
      );
      if (result?.ok) {
        const preview = JSON.stringify(result.fired ?? result)?.slice(0, 400);
        setForgeLog(`${row.name} · ${hook}\n${preview || "(no output)"}`);
        toast.success(`${row.name} dispatched ${hook}.`);
      } else {
        const error = String(result?.error || "Plugin test failed.");
        setForgeLog(error);
        toast.error(error);
      }
    } finally {
      setImportBusy(null);
    }
  };

  const onTest = () => testRow(openRow);

  return (
    <AppShell
      title="Plugins"
      subtitle="Small helpers that react to what FRIDAY does — core packs and your own"
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!supported || refreshing}
            onClick={() => onRefresh()}
          >
            {refreshing ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            Refresh
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!supported || refreshing}
            onClick={() => onCheckUpdates()}
          >
            <RefreshCw className="size-4" /> Check updates
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-7">
          <StatTile
            icon={<Plug className="size-4" />}
            label="Total"
            value={counts.all}
            state="plugins"
          />
          <StatTile
            label="Built-in"
            value={counts.builtin}
            state="ships with FRIDAY"
            tone="muted"
          />
          <StatTile label="Installed" value={counts.installed} state="added by you" tone="accent" />
          <StatTile label="Loaded" value={counts.loaded} state="in memory" tone="accent" />
          <StatTile label="Active" value={counts.active} state="enabled" tone="accent" />
          <StatTile label="Inactive" value={counts.inactive} state="disabled" tone="muted" />
          <StatTile label="Updates" value={counts.updates} state="available" tone="warning" />
        </div>

        <HudPanel
          title="Install a plugin"
          hint="every pack is checked and sandbox-tested before it is enabled"
        >
          <div className="space-y-3">
            {!supported ? (
              <p className="text-note text-muted-foreground">
                Installing writes into your FRIDAY folder, so it needs the FRIDAY desktop app.
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <span className="label-xs w-28 shrink-0 text-muted-foreground">Catalogue</span>
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
            </div>
            <p className="text-note text-muted-foreground">
              Install defaults, From GitHub, a file, a zip, a folder or a git repo all end in the
              same sandbox test. A plugin starts disabled; it only runs once it passes and you turn
              it on. A plugin that asks for permissions shows them under Details before you enable
              it.
            </p>
          </div>
        </HudPanel>

        <HudPanel
          title="All Plugins"
          hint={`${rows.length} shown`}
          actions={
            <FilterTabs
              value={tab}
              onChange={setTab}
              tabs={[
                { key: "all", label: `All (${counts.all})` },
                { key: "active", label: `Active (${counts.active})` },
                { key: "inactive", label: `Inactive (${counts.inactive})` },
                { key: "updates", label: `Updates (${counts.updates})` },
              ]}
            />
          }
        >
          <div className="mb-3 space-y-2">
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
              value={source}
              onChange={setSource}
              tabs={[
                { key: "all", label: "Any source" },
                { key: "builtin", label: `Built-in (${counts.builtin})` },
                { key: "installed", label: `Installed (${counts.installed})` },
              ]}
            />
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
          </div>

          {!supported ? (
            <EmptyState
              icon={Plug}
              title="Plugins are listed by the FRIDAY desktop app"
              hint="Open FRIDAY on your PC to see, enable and install plugins."
            />
          ) : loading ? (
            <LoadingState label="Reading your plugin folders…" rows={4} />
          ) : rows.length ? (
            <>
              <DataTable
                pinLast
                columns={["Plugin Name", "Type", "Reacts to", "Version", "Status", "Latest", ""]}
                rows={rows.slice(0, shown).map((p) => [
                  <span key="n" className="flex flex-wrap items-center gap-2 text-foreground">
                    <Plug className="size-3.5 text-primary" />
                    {p.name}
                    <Badge variant="outline" className="text-note">
                      {p.origin === "app" ? "Built-in" : "Installed"}
                    </Badge>
                  </span>,
                  <span key="k" className="text-muted-foreground">
                    {p.kind}
                  </span>,
                  <span key="h" className="font-mono text-xs text-muted-foreground">
                    {p.hooks.length
                      ? `${p.hooks.length} hook${p.hooks.length === 1 ? "" : "s"}`
                      : "—"}
                  </span>,
                  <span key="v" className="font-mono text-xs text-foreground">
                    {p.version}
                  </span>,
                  <span key="s" className="flex items-center gap-2">
                    {p.id ? (
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
                      className="h-7 px-2 text-note"
                      disabled={!p.id}
                      onClick={() =>
                        setOpenId((current) => (current === p.id ? null : p.id || p.name))
                      }
                    >
                      {openId === (p.id || p.name) ? "Hide" : "Details"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-note"
                      disabled={!p.id || !p.hooks.length || importBusy !== null || Boolean(busyId)}
                      title={
                        p.hooks.length
                          ? "Fire this plugin's first hook once, even if it is disabled"
                          : "This plugin declares no hooks to test"
                      }
                      onClick={() => {
                        setOpenId(p.id);
                        void testRow(p);
                      }}
                    >
                      <FlaskConical className="size-3" />
                      Test
                    </Button>
                    <Button
                      size="sm"
                      variant={confirmId === p.id ? "destructive" : "outline"}
                      className="h-7 px-2 text-note"
                      disabled={!p.id || Boolean(busyId) || p.origin === "app"}
                      title={
                        p.origin === "app"
                          ? "Ships with FRIDAY and cannot be removed; turn it off instead"
                          : "Delete this installed plugin from your FRIDAY folder"
                      }
                      onClick={() => onRemove(p)}
                    >
                      {confirmId === p.id ? "Confirm remove" : "Remove"}
                    </Button>
                    {confirmId === p.id ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-note"
                        onClick={() => setConfirmId(null)}
                      >
                        Cancel
                      </Button>
                    ) : null}
                  </span>,
                ])}
              />
              {rows.length > shown ? (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-meta text-muted-foreground">
                  <span>
                    Showing {shown} of {rows.length} plugins
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-note"
                    onClick={() => setShown(shown + PLUGINS_PAGE)}
                  >
                    Show {Math.min(PLUGINS_PAGE, rows.length - shown)} more
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-note"
                    onClick={() => setShown(rows.length)}
                  >
                    Show all
                  </Button>
                </div>
              ) : null}
            </>
          ) : (
            <EmptyState
              icon={Plug}
              title={listed.length ? "No plugin matches these filters" : "No plugins installed yet"}
              hint={
                listed.length
                  ? "Clear the search or pick Any source and All categories."
                  : "Use Install a plugin above, or Install defaults for the starter set."
              }
            />
          )}
        </HudPanel>

        {openRow ? (
          <HudPanel title={`${openRow.name} details`} hint={openRow.id || "preview"}>
            <div className="space-y-1 text-meta">
              <p>
                <span className="text-muted-foreground">What it does — </span>
                {openRow.summary || "—"}
              </p>
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
              <p className="text-note text-muted-foreground">
                {openRow.hooks.length
                  ? `Runs ${describeHooks(openRow.hooks)}.`
                  : "It reacts to no FRIDAY event."}
              </p>
              <p>
                <span className="text-muted-foreground">Permissions — </span>
                {listField(openRow.permissions)}
              </p>
              <p className="text-note text-muted-foreground">
                {describePermissions(openRow.permissions)}
              </p>
              <p>
                <span className="text-muted-foreground">Source — </span>
                {openRow.origin === "app" ? "ships with FRIDAY" : "installed by you"}
                {" · "}
                {openRow.enabled ? "enabled" : "disabled"}
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
                onClick={() => onForge()}
              >
                {importBusy === "forge" ? <Loader2 className="size-4 animate-spin" /> : null}
                Forge
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                disabled={importBusy !== null}
                onClick={() => onTest()}
              >
                {importBusy === "test" ? <Loader2 className="size-4 animate-spin" /> : null}
                Test selected
              </Button>
            </div>
            {forgeLog ? (
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-data text-muted-foreground">
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
