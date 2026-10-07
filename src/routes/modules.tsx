import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { FolderPlus, Loader2, Search } from "lucide-react";
import { AppShell, Panel } from "@/components/friday/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { FilterTabs, HudPanel } from "@/components/friday/ui";
import { modules as sampleModules } from "@/lib/friday/mock";
import { useCapabilities, type CapabilityItem } from "@/lib/friday/capability-trees";
import { hub } from "@/lib/friday/hub-engine";
import { CapabilityMarket } from "@/components/friday/CapabilityMarket";
import { CapabilityImport } from "@/components/friday/CapabilityImport";
import { uninstallPack } from "@/lib/friday/marketplace";
import { forgeModule, invokeModulePack } from "@/lib/friday/brain/module-forge";
import { toast } from "sonner";

export const Route = createFileRoute("/modules")({
  head: () => ({
    meta: [
      { title: "Modules — FRIDAY" },
      {
        name: "description",
        content:
          "Manifest-based plugins that extend FRIDAY with new skills, each declaring the permissions it needs before it loads.",
      },
      { property: "og:title", content: "Modules — FRIDAY" },
      {
        property: "og:description",
        content: "Manifest-driven plugin system for the local AI kernel.",
      },
    ],
  }),
  component: ModulesPage,
});

type ModuleRow = {
  id: string;
  key: string;
  name: string;
  version: string;
  description: string;
  category: string;
  permissions: string[];
  entry: string;
  enabled: boolean;
  origin: "app" | "workspace" | "";
  uiPage: string;
  uiIcon: string;
  toggleable: boolean;
};

const DESKTOP_ONLY = "This change needs the FRIDAY desktop app.";

function listField(values: string[]): string {
  return values.length ? values.join(", ") : "—";
}

function ModulesPage() {
  const [category, setCategory] = useState("all");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState<"forge" | "test" | null>(null);
  const [forgeGoal, setForgeGoal] = useState("");
  const [forgeLog, setForgeLog] = useState("");
  const { supported, items, toggle, refresh } = useCapabilities("modules");

  const modules = useMemo<ModuleRow[]>(() => {
    if (!supported)
      return sampleModules.map((mod) => ({
        id: "",
        key: mod.name,
        name: mod.name,
        version: mod.version,
        description: mod.description,
        category: "preview",
        permissions: mod.permissions,
        entry: mod.entry,
        enabled: mod.enabled,
        origin: "",
        uiPage: "",
        uiIcon: "",
        toggleable: false,
      }));
    return items.map((item: CapabilityItem) => ({
      id: item.id,
      key: item.id,
      name: item.name,
      version: item.version ?? "0.0.0",
      description: item.description || `${item.segment} module`,
      category: item.category || item.segment,
      permissions: item.permissions,
      entry: item.entry ?? item.path,
      enabled: item.enabled,
      origin: item.origin,
      uiPage: item.uiPage || "",
      uiIcon: item.uiIcon || "",
      toggleable: true,
    }));
  }, [supported, items]);

  const categories = useMemo(() => {
    const found = [...new Set(modules.map((row) => row.category).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b),
    );
    return found;
  }, [modules]);

  const rows = modules.filter((row) => {
    if (category !== "all" && row.category !== category) return false;
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return (
      row.name.toLowerCase().includes(needle) ||
      row.category.toLowerCase().includes(needle) ||
      row.description.toLowerCase().includes(needle)
    );
  });

  const openRow = openId
    ? (rows.find((row) => row.key === openId) ?? modules.find((row) => row.key === openId))
    : null;

  const loadFromFolder = async () => {
    const resource = await hub.inspectFolder();
    if (!resource) {
      toast.error("No folder imported.");
      return;
    }
    toast.success(`Inspected ${resource.name} — approve it in Friday Hub to install.`);
    await refresh();
  };

  const onToggle = async (row: ModuleRow, next: boolean) => {
    if (!supported || !row.id) {
      toast.error(DESKTOP_ONLY);
      return;
    }
    const ok = await toggle(row.id, next);
    if (!ok) toast.error("Could not update the capability index.");
  };

  const onRemove = async (row: ModuleRow) => {
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
        if (openId === row.key) setOpenId(null);
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
      const run = await forgeModule(forgeGoal.trim(), {
        onProgress: (current) =>
          setForgeLog(
            current.log.map((line) => `${line.ok ? "ok" : "fail"} — ${line.text}`).join("\n"),
          ),
      });
      setForgeLog(run.log.map((line) => `${line.ok ? "ok" : "fail"} — ${line.text}`).join("\n"));
      if (run.stage === "done") {
        toast.success(`Installed ${run.moduleId}. Enable it after you review the sandbox result.`);
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
      toast.error(supported ? "Open Details on a module to test it." : DESKTOP_ONLY);
      return;
    }
    setImportBusy("test");
    try {
      const result = await invokeModulePack(
        openRow.id,
        { prompt: ".", folder: "." },
        { allowDisabled: true },
      );
      if (result?.ok) {
        const preview =
          typeof result.value === "string"
            ? result.value.slice(0, 400)
            : JSON.stringify(result.value)?.slice(0, 400);
        setForgeLog(preview || "(no output)");
        toast.success(
          `${openRow.name} ran${"ms" in result && result.ms ? ` in ${result.ms}ms` : ""}.`,
        );
      } else {
        const error = String(result?.error || "Module test failed.");
        setForgeLog(error);
        toast.error(error);
      }
    } finally {
      setImportBusy(null);
    }
  };

  return (
    <AppShell
      title="Modules"
      subtitle="Manifest-based plugins loaded by the kernel at startup"
      actions={
        <div className="flex gap-2">
          <CapabilityMarket
            tree="modules"
            installedIds={items.map((item) => item.id)}
            onChanged={refresh}
          />
          <CapabilityImport
            tree="modules"
            installedIds={items.map((item) => item.id)}
            onChanged={refresh}
          />
          <Button size="sm" variant="outline" onClick={() => void loadFromFolder()}>
            <FolderPlus className="size-4" />
            Load from folder
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-col gap-2">
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
                label: `${key} (${modules.filter((row) => row.category === key).length})`,
              })),
            ]}
          />
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          {rows.length ? (
            rows.map((mod) => (
              <Panel key={mod.key} title={mod.name} hint={`v${mod.version}`}>
                <p className="text-sm text-muted-foreground">{mod.description}</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {mod.permissions.map((p) => (
                    <Badge key={p} variant="outline" className="font-mono text-[11px]">
                      {p}
                    </Badge>
                  ))}
                </div>
                {openId === mod.key ? (
                  <div className="mt-3 space-y-1 border-t border-border pt-3 font-mono text-[11px]">
                    <p>
                      <span className="text-muted-foreground">Category — </span>
                      {mod.category || "—"}
                    </p>
                    <p>
                      <span className="text-muted-foreground">Entry — </span>
                      {mod.entry || "—"}
                    </p>
                    <p>
                      <span className="text-muted-foreground">UI page — </span>
                      {mod.uiPage || "—"}
                    </p>
                    <p>
                      <span className="text-muted-foreground">UI icon — </span>
                      {mod.uiIcon || "—"}
                    </p>
                    <p>
                      <span className="text-muted-foreground">Permissions — </span>
                      {listField(mod.permissions)}
                    </p>
                    <p className="text-muted-foreground">
                      Declared UI is shown here. Full dynamic per-module routes are a future step —
                      this page does not invent a second router.
                    </p>
                  </div>
                ) : null}
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
                  <p className="truncate font-mono text-[11px] text-muted-foreground">
                    {mod.entry}
                  </p>
                  <span className="flex items-center gap-1">
                    <Switch
                      checked={mod.enabled}
                      onCheckedChange={(next) => void onToggle(mod, next)}
                      disabled={!mod.toggleable || Boolean(busyId)}
                      aria-label={`Enable ${mod.name}`}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-[11px]"
                      disabled={!mod.id && supported}
                      onClick={() => setOpenId((current) => (current === mod.key ? null : mod.key))}
                    >
                      {openId === mod.key ? "Hide" : "Details"}
                    </Button>
                    <Button
                      size="sm"
                      variant={confirmId === mod.id ? "destructive" : "outline"}
                      className="h-7 px-2 text-[11px]"
                      disabled={!mod.id || Boolean(busyId)}
                      onClick={() => void onRemove(mod)}
                    >
                      {confirmId === mod.id ? "Confirm remove" : "Remove"}
                    </Button>
                    {confirmId === mod.id ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => setConfirmId(null)}
                      >
                        Cancel
                      </Button>
                    ) : null}
                  </span>
                </div>
              </Panel>
            ))
          ) : (
            <p className="py-6 text-center text-xs text-muted-foreground md:col-span-2">
              {modules.length
                ? "No modules match this filter."
                : supported
                  ? "No modules installed yet — load a folder or install from the marketplace."
                  : "Installed modules appear here in the desktop app."}
            </p>
          )}
        </div>

        <HudPanel title="Create and test" hint="sandbox then owner approval">
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Input
                value={forgeGoal}
                onChange={(event) => setForgeGoal(event.target.value)}
                placeholder="Describe a new module FRIDAY should write…"
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
                Forge drafts a module, sandbox-verifies it, then waits for your install approval.
                Test selected runs the selected pack's run() (disabled packs allowed).
              </p>
            )}
          </div>
        </HudPanel>
      </div>
    </AppShell>
  );
}
