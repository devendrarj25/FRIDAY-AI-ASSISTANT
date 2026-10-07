import { createFileRoute } from "@tanstack/react-router";
import {
  Boxes,
  Bug,
  CheckCircle2,
  Download,
  FolderUp,
  HardDriveDownload,
  Loader2,
  Package,
  RotateCcw,
  Rocket,
  Trash2,
  Upload,
  Wand2,
  X,
  ClipboardPaste,
  Link2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/friday/AppShell";
import {
  DataTable,
  FilterTabs,
  HudPanel,
  MetricBar,
  StatTile,
  StatusPill,
  ToggleRow,
  toneForStatus,
} from "@/components/friday/ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  formatBytes,
  imports,
  type BuildRootInfo,
  type FactoryArtifact,
} from "@/lib/friday/import-engine";
import { useImports } from "@/lib/friday/use-imports";
import { ImportChat } from "@/components/friday/ImportChat";
import { upgrades } from "@/lib/friday/upgrade-engine";
import { useUpgrades } from "@/lib/friday/use-upgrades";
import { useAppVersion } from "@/lib/friday/version";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/import")({
  head: () => ({
    meta: [
      { title: "Import, Upgrade & Build — FRIDAY Console" },
      {
        name: "description",
        content:
          "Upload files and folders, clone public GitHub repositories as intake, let FRIDAY recognise the code, place it locally, test and debug it, then package a ZIP or Windows EXE. FRIDAY's own GitHub repo is not edited here — that is Friday Hub.",
      },
      { property: "og:title", content: "Import, Upgrade & Build — FRIDAY Console" },
      {
        property: "og:description",
        content:
          "Self-upgrade pipeline: recognise, place, test, debug, apply locally, then build EXE / ZIP. No GitHub push from this page.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ImportPage,
});

const TARGETS = [
  "Workspace",
  "Skills",
  "Plugins",
  "Modules",
  "Agents",
  "Workflows",
  "Models",
  "Tools",
  "Memory",
  "n8n",
];

const OPEN_SOURCE = [
  { name: "ollama/ollama", note: "Local model runtime" },
  { name: "n8n-io/n8n", note: "Automation engine" },
  { name: "chroma-core/chroma", note: "Vector memory" },
  { name: "electron/electron", note: "Desktop shell" },
  { name: "ggml-org/llama.cpp", note: "GGUF inference" },
  { name: "open-webui/open-webui", note: "Chat UI reference" },
];

const TABS = [
  { key: "import", label: "Import" },
  { key: "upgrade", label: "Self-upgrade" },
  { key: "build", label: "Build & package" },
  { key: "sources", label: "Sources" },
];

const STAGE_TONE = {
  pending: "muted",
  running: "warning",
  done: "accent",
  failed: "destructive",
  skipped: "muted",
} as const;

function ImportPage() {
  const { items, builds, busy, activity } = useImports();
  const { runs, running } = useUpgrades();
  const [tab, setTab] = useState("import");
  const [target, setTarget] = useState("Workspace");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [selected, setSelected] = useState<string>("");
  const [autoFix, setAutoFix] = useState(true);
  const [runTests, setRunTests] = useState(true);
  const [keepBackup, setKeepBackup] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const appVersion = useAppVersion();
  const [version, setVersion] = useState(appVersion.version);
  useEffect(() => {
    setVersion(appVersion.version);
  }, [appVersion.version]);
  const fileRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);
  // Real builds need the FRIDAY *source* project; an installed EXE has to be
  // pointed at it once. Checked lazily so opening the page never blocks.
  const [buildRoot, setBuildRoot] = useState<BuildRootInfo | null>(null);
  const [identity, setIdentity] = useState<"friday" | "other">("friday");
  const [productName, setProductName] = useState("FRIDAY");
  const [productVersion, setProductVersion] = useState(appVersion.version);
  const [buildKind, setBuildKind] = useState<"exe" | "portable" | "zip">("exe");
  const [otherItemId, setOtherItemId] = useState("");
  const [otherRoot, setOtherRoot] = useState("");
  const [otherWarnings, setOtherWarnings] = useState<string[]>([]);
  const [kept, setKept] = useState<FactoryArtifact[]>([]);
  useEffect(() => {
    void imports.buildRoot().then((info) => setBuildRoot(info));
  }, []);
  useEffect(() => {
    if (tab !== "build") return;
    let alive = true;
    void imports.listKept().then((list) => alive && setKept(list));
    return () => {
      alive = false;
    };
  }, [tab, builds]);

  const chooseBuildRoot = async () => {
    const picked = await imports.pickBuildRoot();
    if (picked.cancelled) return;
    if (!picked.ok) {
      toast.error("Not a FRIDAY source project", { description: picked.error });
      return;
    }
    setBuildRoot(picked);
    toast.success("Build source set", { description: picked.root ?? "" });
  };

  const chooseOtherSource = async () => {
    const picked = await imports.pickFactorySource();
    if (picked.cancelled) return;
    if (!picked.ok) {
      toast.error("Could not use that folder", { description: picked.error });
      return;
    }
    if (picked.friday) {
      toast.error("That is FRIDAY's own source", {
        description: "Switch this artifact to FRIDAY. Other builds never drive FRIDAY's packager.",
      });
      return;
    }
    setOtherRoot(picked.root ?? "");
    setOtherItemId("");
    setProductName(picked.name || productName);
    if (picked.version) setProductVersion(picked.version);
    setOtherWarnings(picked.warnings ?? []);
    toast.success("Other project selected", { description: picked.root ?? "" });
  };

  const queuePackage = () => {
    const isFriday = identity === "friday";
    const name = isFriday ? "FRIDAY" : productName.trim() || "app";
    const ver = isFriday ? appVersion.version : productVersion.trim() || "0.0.1";
    const item = items.find((i) => i.id === otherItemId);
    if (!isFriday && !otherRoot && !item?.scanId) {
      toast.error("Choose a folder or an imported source to package.");
      return;
    }
    const label = `${name} v${ver} ${buildKind}`;
    imports.build(buildKind, label, {
      identity,
      name,
      version: ver,
      ...(isFriday || !otherRoot ? {} : { sourceDir: otherRoot }),
      ...(isFriday || !item?.scanId ? {} : { scanId: item.scanId }),
    });
    toast.success(`Queued ${label}`);
    setTab("build");
  };

  const refreshKept = () => {
    void imports.listKept().then(setKept);
  };

  const buildable = buildRoot?.ok && buildRoot.ready !== false;

  const activeRun = useMemo(() => runs.find((r) => r.id === selected) ?? runs[0], [runs, selected]);
  const pickItem = items.find((i) => i.id === selected) ?? items[0];

  const takeFiles = async (list: FileList | File[], source: "upload" | "folder" = "upload") => {
    const item = await imports.importFiles(list, target, source);
    if (!item) return;
    if (item.status === "error") {
      toast.error("Import failed", { description: item.message || item.name });
      return;
    }
    toast.success(`Imported ${item.name}`, {
      description: item.message || `${item.fileCount} files recognised`,
    });
  };

  const clone = async (value: string) => {
    if (!value.trim()) return;
    try {
      const item = await imports.importUrl(value.trim(), target, token.trim() || undefined);
      if (!item) {
        toast.error("Import failed", { description: "Nothing was recognised." });
        return;
      }
      toast.success(`Imported ${item.name}`, {
        description: `${item.fileCount} files recognised`,
      });
      setUrl("");
    } catch (err) {
      toast.error("Import failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  };

  const pasteClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      const item = await imports.importClipboard(text, target);
      if (!item) {
        toast.error("Clipboard import failed", { description: "Nothing to paste." });
        return;
      }
      toast.success(`Pasted ${item.name}`, { description: item.message || "classified" });
    } catch (err) {
      toast.error("Clipboard import failed", {
        description: err instanceof Error ? err.message : "Could not read the clipboard",
      });
    }
  };

  const startUpgrade = () => {
    if (!pickItem) {
      toast.error("Import something first");
      return;
    }
    const id = upgrades.start(pickItem, { autoFix, runTests, bumpVersion: version });
    setSelected(id);
    setTab("upgrade");
    toast.success("Upgrade pipeline started", { description: `${pickItem.name} → v${version}` });
  };

  const totalFiles = items.reduce((n, i) => n + i.fileCount, 0);
  const totalBytes = items.reduce((n, i) => n + i.bytes, 0);

  return (
    <AppShell
      title="Import, Upgrade & Build"
      subtitle="Bring anything in locally — FRIDAY recognises it, places it, tests it, then packages EXE / ZIP. Friday Hub owns FRIDAY's GitHub repo."
      actions={
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              imports.build("zip", `FRIDAY v${appVersion.version} source ZIP`, {
                identity: "friday",
              })
            }
          >
            <Package className="size-4" /> ZIP
          </Button>
          <Button
            size="sm"
            onClick={() =>
              imports.build("exe", `FRIDAY v${appVersion.version} Windows installer`, {
                identity: "friday",
              })
            }
          >
            <HardDriveDownload className="size-4" /> Build EXE
          </Button>
        </div>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatTile
          label="Imports"
          value={items.length}
          state="sources tracked"
          icon={<Boxes className="size-4" />}
        />
        <StatTile
          label="Files"
          value={totalFiles}
          state="indexed"
          icon={<FolderUp className="size-4" />}
        />
        <StatTile
          label="Size"
          value={formatBytes(totalBytes)}
          state="on disk"
          icon={<Download className="size-4" />}
        />
        <StatTile
          label="Upgrades"
          value={runs.filter((r) => r.status === "applied").length}
          state={`${runs.filter((r) => r.status === "ready").length} awaiting approval`}
          tone="magenta"
          icon={<Rocket className="size-4" />}
        />
        <StatTile
          label="Builds"
          value={builds.filter((b) => b.status === "done").length}
          state={`${builds.filter((b) => b.status === "running").length} running`}
          icon={<Package className="size-4" />}
        />
      </div>

      <div className="mt-4">
        <FilterTabs tabs={TABS} value={tab} onChange={setTab} />
      </div>

      {activity.length ? (
        <HudPanel
          className="mt-4"
          title="What happened here"
          hint="owner and FRIDAY — same functions"
        >
          <ul className="max-h-32 space-y-1 overflow-auto">
            {activity.slice(0, 8).map((line, i) => (
              <li key={`${line.at}-${i}`} className="font-mono text-[11px] text-muted-foreground">
                <span className="text-primary">{line.actor}</span> · {line.text}
              </li>
            ))}
          </ul>
        </HudPanel>
      ) : (
        <HudPanel
          className="mt-4"
          title="What happened here"
          hint="owner and FRIDAY — same functions"
        >
          <p className="font-mono text-[11px] text-muted-foreground">
            Nothing yet. Buttons and the page chat both log here so you can watch FRIDAY work.
          </p>
        </HudPanel>
      )}

      {tab === "import" ? (
        <div
          className="mt-4"
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const files = e.dataTransfer.files;
            if (files?.length) void takeFiles(files, "upload");
          }}
        >
          {dragOver ? (
            <p className="mb-2 font-mono text-[11px] text-primary">
              Drop files, zips or a folder — each item uses the same classify pipeline
            </p>
          ) : null}
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <HudPanel
              title="New import"
              hint="files · folders · url · clipboard · github · open source"
            >
              <p className="label-xs text-muted-foreground">Import target</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {TARGETS.map((t) => (
                  <Button
                    key={t}
                    size="sm"
                    variant={target === t ? "default" : "outline"}
                    onClick={() => setTarget(t)}
                  >
                    {t}
                  </Button>
                ))}
              </div>

              <input
                ref={fileRef}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  const list = e.target.files;
                  e.target.value = "";
                  if (list?.length) void takeFiles(list, "upload");
                }}
              />
              <input
                ref={dirRef}
                type="file"
                multiple
                hidden
                // @ts-expect-error non-standard, supported in Chromium/Electron
                webkitdirectory=""
                directory=""
                onChange={(e) => {
                  const list = e.target.files;
                  e.target.value = "";
                  if (list?.length) void takeFiles(list, "folder");
                }}
              />

              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    // Desktop: the native picker avoids reading a whole tree
                    // through the browser File API.
                    void imports.importPickedZip(target).then((item) => {
                      if (!item) fileRef.current?.click();
                      else if (item !== "cancelled") {
                        if (item.status === "error") {
                          toast.error("Import failed", { description: item.message || item.name });
                        } else {
                          toast.success(`Imported ${item.name}`, {
                            description: item.message || `${item.fileCount} files recognised`,
                          });
                        }
                      }
                    });
                  }}
                >
                  <Upload className="size-4" /> Upload files or .zip
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    void imports.importPickedFolder(target).then((item) => {
                      if (!item) dirRef.current?.click();
                      else if (item !== "cancelled") {
                        if (item.status === "error") {
                          toast.error("Import failed", { description: item.message || item.name });
                        } else {
                          toast.success(`Imported ${item.name}`, {
                            description: item.message || `${item.fileCount} files recognised`,
                          });
                        }
                      }
                    });
                  }}
                >
                  <FolderUp className="size-4" /> Upload whole folder
                </Button>
                <Button variant="outline" onClick={() => void pasteClipboard()} disabled={busy}>
                  <ClipboardPaste className="size-4" /> Paste clipboard
                </Button>
              </div>

              <p className="label-xs mt-4 text-muted-foreground">GitHub, zip, or file URL</p>
              <div className="mt-2 flex gap-2">
                <Input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void clone(url)}
                  placeholder="https://github.com/owner/repo · owner/repo · https://…/file.zip"
                  className="border-primary/25 bg-surface font-mono text-xs"
                />
                <Button onClick={() => void clone(url)} disabled={busy || !url.trim()}>
                  {busy ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Link2 className="size-4" />
                  )}
                  Import
                </Button>
              </div>
              <Input
                value={token}
                onChange={(e) => setToken(e.target.value)}
                type="password"
                placeholder="Optional GitHub token — needed for private repos"
                className="mt-2 border-primary/25 bg-surface font-mono text-xs"
              />

              <p className="label-xs mt-4 text-muted-foreground">Popular open source</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {OPEN_SOURCE.map((r) => (
                  <button
                    key={r.name}
                    type="button"
                    onClick={() => void clone(r.name)}
                    title={r.note}
                    className="rounded-sm border border-primary/25 bg-surface px-2 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:border-primary/60 hover:text-primary"
                  >
                    {r.name}
                  </button>
                ))}
              </div>
            </HudPanel>

            <HudPanel title="Upgrade options" hint="applied to the next run">
              <ToggleRow
                label="Auto-debug and fix issues"
                hint="lint, type and dependency fixes are applied in the sandbox copy"
                on={autoFix}
                onToggle={() => setAutoFix((v) => !v)}
              />
              <ToggleRow
                label="Run tests before applying"
                hint="vitest + kernel smoke tests"
                on={runTests}
                onToggle={() => setRunTests((v) => !v)}
              />
              <ToggleRow
                label="Keep rollback snapshot"
                hint="previous version is archived so you can revert"
                on={keepBackup}
                onToggle={() => setKeepBackup((v) => !v)}
              />
              <label className="label-xs mt-3 block text-muted-foreground" htmlFor="ver">
                Next version
              </label>
              <Input
                id="ver"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                className="mt-1 border-primary/25 bg-surface font-mono text-xs"
              />

              <label className="label-xs mt-3 block text-muted-foreground" htmlFor="src">
                Source to upgrade from
              </label>
              <select
                id="src"
                value={pickItem?.id ?? ""}
                onChange={(e) => setSelected(e.target.value)}
                className="mt-1 w-full rounded-sm border border-primary/25 bg-surface px-2 py-1.5 font-mono text-xs text-foreground"
              >
                {items.length ? (
                  items.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name} · {i.fileCount} files → {i.target}
                    </option>
                  ))
                ) : (
                  <option value="">No imports yet</option>
                )}
              </select>

              <Button
                className="mt-3 w-full"
                disabled={!pickItem || running}
                onClick={startUpgrade}
              >
                {running ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Wand2 className="size-4" />
                )}
                Analyse, test & stage upgrade
              </Button>
            </HudPanel>
          </div>
        </div>
      ) : null}

      {tab === "upgrade" ? (
        <div className="mt-4 space-y-4">
          {runs.length > 1 ? (
            <div className="flex flex-wrap gap-1.5">
              {runs.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setSelected(r.id)}
                  className={cn(
                    "rounded-sm border px-2 py-1 font-mono text-[10px]",
                    activeRun?.id === r.id
                      ? "border-primary/50 bg-primary/15 text-primary"
                      : "border-border text-muted-foreground",
                  )}
                >
                  {r.name} · v{r.version} · {r.status}
                </button>
              ))}
            </div>
          ) : null}

          {activeRun ? (
            <>
              <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
                <HudPanel title="Pipeline" hint={`${activeRun.name} → v${activeRun.version}`}>
                  <ol className="space-y-1.5">
                    {activeRun.stages.map((s) => (
                      <li
                        key={s.id}
                        className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2"
                      >
                        <span
                          className={cn(
                            "mt-1.5 size-2 rounded-full",
                            s.state === "done" && "bg-accent shadow-[0_0_8px_var(--color-accent)]",
                            s.state === "running" && "bg-warning pulse-dot",
                            s.state === "pending" && "bg-muted-foreground/50",
                            s.state === "failed" && "bg-destructive",
                            s.state === "skipped" && "bg-muted-foreground/30",
                          )}
                        />
                        <div className="min-w-0">
                          <p className="text-xs text-foreground">{s.label}</p>
                          <p className="truncate font-mono text-[10px] text-muted-foreground">
                            {s.detail}
                          </p>
                        </div>
                        <StatusPill label={s.state} tone={STAGE_TONE[s.state]} />
                      </li>
                    ))}
                  </ol>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      disabled={activeRun.status !== "ready"}
                      onClick={() => {
                        upgrades.apply(activeRun.id);
                        toast.success(`Upgrade applied — FRIDAY v${activeRun.version}`);
                      }}
                    >
                      <CheckCircle2 className="size-4" /> Apply upgrade
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={activeRun.status !== "applied" || !keepBackup}
                      onClick={() => upgrades.rollback(activeRun.id)}
                    >
                      <RotateCcw className="size-4" /> Roll back
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={activeRun.status !== "applied"}
                      onClick={() =>
                        imports.build("exe", `FRIDAY v${appVersion.version} Windows installer`, {
                          identity: "friday",
                        })
                      }
                    >
                      <HardDriveDownload className="size-4" /> Build EXE of this version
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={activeRun.status !== "applied"}
                      onClick={() =>
                        imports.build("zip", `FRIDAY v${appVersion.version} source ZIP`, {
                          identity: "friday",
                        })
                      }
                    >
                      <Package className="size-4" /> ZIP this version
                    </Button>
                  </div>
                  <p className="mt-2 font-mono text-[11px] text-muted-foreground">
                    Analyse, test and fix stay on this page. FRIDAY's GitHub repository is not
                    pushed or edited here — use Friday Hub for that.
                  </p>
                </HudPanel>

                <div className="space-y-4">
                  <HudPanel
                    title="Recognised languages"
                    hint={`${activeRun.languages.length} kinds`}
                  >
                    {activeRun.languages.map((l) => (
                      <MetricBar
                        key={l.lang}
                        label={`${l.label} · ${l.files} files`}
                        value={l.share}
                        detail={`${l.share}%`}
                      />
                    ))}
                  </HudPanel>

                  <HudPanel
                    title="Issues & auto-fixes"
                    hint={`${activeRun.findings.filter((f) => f.fixed).length}/${activeRun.findings.length} handled`}
                  >
                    <ul className="space-y-2">
                      {activeRun.findings.map((f) => (
                        <li
                          key={f.id}
                          className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2"
                        >
                          <Bug
                            className={cn(
                              "mt-0.5 size-3.5",
                              f.level === "error"
                                ? "text-destructive"
                                : f.level === "warn"
                                  ? "text-warning"
                                  : "text-muted-foreground",
                            )}
                          />
                          <div className="min-w-0">
                            <p className="text-xs text-foreground">{f.message}</p>
                            <p className="truncate font-mono text-[10px] text-muted-foreground">
                              {f.file} — {f.fix}
                            </p>
                          </div>
                          {f.fixed ? (
                            <StatusPill label="fixed" tone="accent" />
                          ) : (
                            <button
                              type="button"
                              onClick={() => upgrades.fix(activeRun.id, f.id)}
                              className="font-mono text-[10px] text-primary hover:underline"
                            >
                              fix now
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </HudPanel>
                </div>
              </div>

              <HudPanel
                title="Placement map"
                hint={`${activeRun.placements.filter((p) => p.kind !== "skip").length} files placed`}
              >
                <DataTable
                  columns={["From", "Into FRIDAY project", "Why", "Kind"]}
                  rows={activeRun.placements.slice(0, 40).map((p) => [
                    <span key="f" className="font-mono text-[11px] text-muted-foreground">
                      {p.from}
                    </span>,
                    <span key="t" className="font-mono text-[11px] text-primary">
                      {p.to}
                    </span>,
                    <span key="r" className="text-xs text-muted-foreground">
                      {p.reason}
                    </span>,
                    <StatusPill
                      key="k"
                      label={p.kind}
                      tone={p.kind === "skip" ? "muted" : "primary"}
                    />,
                  ])}
                />
              </HudPanel>

              <HudPanel title="Upgrade log" hint={`${activeRun.log.length} lines`}>
                <pre className="max-h-56 overflow-auto rounded-sm bg-background p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {activeRun.log.join("\n")}
                </pre>
              </HudPanel>
            </>
          ) : (
            <HudPanel title="Self-upgrade">
              <p className="font-mono text-[11px] text-muted-foreground">
                Import files, a folder or a GitHub repo, then start an upgrade run from the Import
                tab.
              </p>
            </HudPanel>
          )}
        </div>
      ) : null}

      {tab === "build" ? (
        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <HudPanel title="Package locally" hint="FRIDAY EXE · other app · zip · keep">
            <p className="label-xs text-muted-foreground">This artifact is</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Button
                size="sm"
                variant={identity === "friday" ? "default" : "outline"}
                onClick={() => {
                  setIdentity("friday");
                  setProductName("FRIDAY");
                }}
              >
                {"FRIDAY's own app"}
              </Button>
              <Button
                size="sm"
                variant={identity === "other" ? "default" : "outline"}
                onClick={() => {
                  setIdentity("other");
                  if (productName === "FRIDAY") setProductName("");
                }}
              >
                Other app / project
              </Button>
            </div>

            <p className="label-xs mt-3 text-muted-foreground">Name</p>
            <Input
              value={identity === "friday" ? "FRIDAY" : productName}
              disabled={identity === "friday"}
              onChange={(e) => setProductName(e.target.value)}
              placeholder="App name"
              className="mt-1 border-primary/25 bg-surface font-mono text-xs"
            />
            <p className="label-xs mt-3 text-muted-foreground">Version</p>
            <Input
              value={identity === "friday" ? appVersion.version : productVersion}
              disabled={identity === "friday"}
              onChange={(e) => setProductVersion(e.target.value)}
              placeholder="1.0.0"
              className="mt-1 border-primary/25 bg-surface font-mono text-xs"
            />
            {identity === "friday" ? (
              <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                FRIDAY&apos;s public version stays {appVersion.version}{" "}
                (config/friday-version.json). This page does not change it.
              </p>
            ) : null}

            <p className="label-xs mt-3 text-muted-foreground">Kind</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {(
                [
                  ["exe", "Windows EXE installer"],
                  ["portable", "Portable"],
                  ["zip", "ZIP archive"],
                ] as const
              ).map(([key, label]) => (
                <Button
                  key={key}
                  size="sm"
                  variant={buildKind === key ? "default" : "outline"}
                  onClick={() => setBuildKind(key)}
                >
                  {label}
                </Button>
              ))}
            </div>

            {identity === "friday" ? (
              <div className="mt-3 space-y-2 border-t border-border/60 pt-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="label-xs text-primary/70">FRIDAY source project</p>
                  <StatusPill
                    label={buildable ? "ready" : buildRoot ? "not ready" : "checking"}
                    tone={buildable ? "accent" : buildRoot ? "destructive" : "muted"}
                  />
                </div>
                <p className="break-all font-mono text-[11px] text-muted-foreground">
                  {buildRoot?.root ??
                    buildRoot?.error ??
                    "Looking for the FRIDAY source project on this PC…"}
                </p>
                {buildRoot?.missing?.length ? (
                  <p className="font-mono text-[11px] text-destructive">
                    missing: {buildRoot.missing.join(", ")}
                  </p>
                ) : null}
                {buildRoot?.warnings?.length
                  ? buildRoot.warnings.map((w) => (
                      <p key={w} className="font-mono text-[11px] text-muted-foreground">
                        {w}
                      </p>
                    ))
                  : null}
                <Button size="sm" variant="outline" onClick={() => void chooseBuildRoot()}>
                  <FolderUp className="size-4" /> Choose FRIDAY source
                </Button>
                <p className="font-mono text-[11px] text-muted-foreground">
                  FRIDAY EXE / portable still uses scripts\build-windows.cmd. ZIP of other apps
                  never uses that packager.
                </p>
              </div>
            ) : (
              <div className="mt-3 space-y-2 border-t border-border/60 pt-3">
                <p className="label-xs text-primary/70">Other project source</p>
                <select
                  className="w-full rounded-sm border border-border bg-surface px-2 py-1.5 font-mono text-[11px]"
                  value={otherItemId}
                  onChange={(e) => {
                    setOtherItemId(e.target.value);
                    const item = items.find((i) => i.id === e.target.value);
                    if (item) {
                      setProductName(item.name);
                      setOtherRoot("");
                    }
                  }}
                >
                  <option value="">Imported item (optional)</option>
                  {items.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name} · {i.fileCount} files
                    </option>
                  ))}
                </select>
                <p className="break-all font-mono text-[11px] text-muted-foreground">
                  {otherRoot || "Pick a folder on this PC, or choose an imported scan above."}
                </p>
                {otherWarnings.map((w) => (
                  <p key={w} className="font-mono text-[11px] text-muted-foreground">
                    {w}
                  </p>
                ))}
                <Button size="sm" variant="outline" onClick={() => void chooseOtherSource()}>
                  <FolderUp className="size-4" /> Choose other project folder
                </Button>
                <p className="font-mono text-[11px] text-muted-foreground">
                  Other EXE needs Windows plus that project&apos;s own electron-builder.yml. ZIP
                  always works. FRIDAY&apos;s GitHub repo is never the target.
                </p>
              </div>
            )}

            <Button className="mt-3" size="sm" onClick={queuePackage}>
              <HardDriveDownload className="size-4" /> Build{" "}
              {identity === "friday" ? "FRIDAY" : "other"} {buildKind}
            </Button>
          </HudPanel>

          <HudPanel title="Build queue" hint={`${builds.length} jobs`}>
            <ul className="space-y-2">
              {builds.length ? (
                builds.slice(0, 8).map((b) => (
                  <li key={b.id} className="rounded-sm border border-border bg-surface px-2.5 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-xs text-foreground">{b.label}</p>
                      <div className="flex items-center gap-1.5">
                        <StatusPill
                          label={b.status}
                          tone={
                            b.status === "done"
                              ? "accent"
                              : b.status === "error"
                                ? "destructive"
                                : "primary"
                          }
                        />
                        {b.status === "running" ? (
                          <button
                            type="button"
                            onClick={() => imports.cancelBuild(b.id)}
                            className="text-muted-foreground hover:text-destructive"
                            aria-label="Cancel build"
                          >
                            <X className="size-3.5" />
                          </button>
                        ) : null}
                      </div>
                    </div>
                    <MetricBar label={b.step} value={b.progress} detail={`${b.progress}%`} />
                    {b.artifact ? (
                      <>
                        <p className="mt-1 truncate font-mono text-[10px] text-accent">
                          {b.artifact}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              void imports.keepArtifact(b.artifact!).then((r) => {
                                if (r.ok) {
                                  toast.success("Kept in downloads/kept-builds");
                                  refreshKept();
                                } else toast.error(r.error || "Keep failed");
                              })
                            }
                          >
                            Keep
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              void imports.saveArtifact(b.artifact!).then((r) => {
                                if (r.cancelled) return;
                                if (r.ok) toast.success("Copy saved");
                                else toast.error(r.error || "Save failed");
                              })
                            }
                          >
                            Download
                          </Button>
                          {/\.exe$/i.test(b.artifact) ? (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                void imports.installExe(b.artifact!).then((r) => {
                                  if ("pending" in r && r.pending) {
                                    toast.success("Waiting for Self-management approval");
                                  } else if (r.ok) toast.success("Installer launched");
                                  else toast.error(r.error || "Install failed");
                                })
                              }
                            >
                              Install EXE
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                void imports.stageArtifact(b.artifact!).then((r) => {
                                  if (r.ok) {
                                    toast.success("Staged for Install into FRIDAY");
                                    setTab("import");
                                  } else toast.error(r.error || "Could not stage");
                                })
                              }
                            >
                              Install into FRIDAY
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => imports.reveal(b.artifact!)}
                          >
                            Reveal
                          </Button>
                        </div>
                      </>
                    ) : null}
                  </li>
                ))
              ) : (
                <li className="font-mono text-[11px] text-muted-foreground">
                  No builds yet — queue one.
                </li>
              )}
            </ul>
          </HudPanel>

          <HudPanel
            title="Kept artifacts"
            hint={`${kept.length} in downloads/kept-builds`}
            className="lg:col-span-2"
          >
            {kept.length ? (
              <ul className="space-y-2">
                {kept.slice(0, 12).map((file) => (
                  <li
                    key={file.path}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-border bg-surface px-2.5 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-xs text-foreground">{file.name}</p>
                      <p className="truncate font-mono text-[10px] text-muted-foreground">
                        {formatBytes(file.bytes)} · {file.path}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          void imports.saveArtifact(file.path).then((r) => {
                            if (r.cancelled) return;
                            if (r.ok) toast.success("Copy saved");
                            else toast.error(r.error || "Save failed");
                          })
                        }
                      >
                        Download
                      </Button>
                      {/\.exe$/i.test(file.name) ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            void imports.installExe(file.path).then((r) => {
                              if ("pending" in r && r.pending) {
                                toast.success("Waiting for Self-management approval");
                              } else if (r.ok) toast.success("Installer launched");
                              else toast.error(r.error || "Install failed");
                            })
                          }
                        >
                          Install EXE
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            void imports.stageArtifact(file.path).then((r) => {
                              if (r.ok) {
                                toast.success("Staged for Install into FRIDAY");
                                setTab("import");
                              } else toast.error(r.error || "Could not stage");
                            })
                          }
                        >
                          Install into FRIDAY
                        </Button>
                      )}
                      <Button size="sm" variant="outline" onClick={() => imports.reveal(file.path)}>
                        Reveal
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="font-mono text-[11px] text-muted-foreground">
                Nothing kept yet. After a successful build, Keep copies the file into
                downloads/kept-builds so you can download it or install it later.
              </p>
            )}
          </HudPanel>
        </div>
      ) : null}

      {tab === "sources" ? (
        <HudPanel className="mt-4" title="Imported sources" hint={`${items.length} tracked`}>
          {items.length ? (
            <ul className="space-y-2">
              {items.map((i) => (
                <li
                  key={i.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-sm border border-border bg-surface px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-foreground">{i.name}</p>
                    <p className="truncate font-mono text-[10px] text-muted-foreground">
                      {i.origin} · {i.fileCount} files · {formatBytes(i.bytes)}
                      {i.branch ? ` · ${i.branch}` : ""}
                      {i.message ? ` · ${i.message}` : ""}
                    </p>
                    {i.destinations?.length ? (
                      <p className="truncate font-mono text-[10px] text-primary/70">
                        →{" "}
                        {i.destinations
                          .slice(0, 4)
                          .map((d) => `${d.dir} (${d.files})`)
                          .join("  ")}
                      </p>
                    ) : null}
                    {i.verifyMessage ? (
                      <p className="truncate font-mono text-[10px] text-muted-foreground">
                        sandbox · {i.verifyMessage}
                      </p>
                    ) : null}
                    {i.packVerify ? (
                      <p className="truncate font-mono text-[10px] text-muted-foreground">
                        packs · {i.packVerify.ok ? "pass" : "fail"} ·{" "}
                        {i.packVerify.packs
                          .map((p) => `${p.kind}:${p.ok ? "ok" : p.skipped ? "skip" : "fail"}`)
                          .join(" ") || "none"}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {i.kind ?? i.target}
                    </Badge>
                    {i.stack.map((s) => (
                      <Badge key={s} className="font-mono text-[10px]">
                        {s}
                      </Badge>
                    ))}
                    <StatusPill label={i.status} tone={toneForStatus(i.status)} />
                    {imports.archiveUrl(i) ? (
                      <a
                        href={imports.archiveUrl(i) ?? "#"}
                        className="text-muted-foreground hover:text-primary"
                        aria-label="Download archive"
                      >
                        <Download className="size-4" />
                      </a>
                    ) : null}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        const id = upgrades.start(i, { autoFix, runTests, bumpVersion: version });
                        setSelected(id);
                        setTab("upgrade");
                      }}
                    >
                      <Wand2 className="size-4" /> Upgrade
                    </Button>
                    {i.scanId ? (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={i.verified === "pending"}
                          onClick={() => void imports.verify(i.id)}
                        >
                          Verify
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={i.verified === "pending"}
                          onClick={() => void imports.verifyPacks(i.id)}
                        >
                          Verify packs
                        </Button>
                      </>
                    ) : null}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void imports.installNow(i.id).then((r) => {
                          if ("pending" in r && r.pending) {
                            toast.success("Waiting for Self-management approval");
                          } else if (r.ok) {
                            toast.success("Installed — it left this page");
                          } else toast.error(r.error || "Install failed");
                        })
                      }
                    >
                      Install
                    </Button>
                    {i.backup ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void imports.rollback(i.id)}
                      >
                        Rollback
                      </Button>
                    ) : null}

                    <button
                      type="button"
                      onClick={() => imports.remove(i.id)}
                      className="text-muted-foreground hover:text-destructive"
                      aria-label="Remove import"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="font-mono text-[11px] text-muted-foreground">
              Nothing imported yet. Upload files, drop them here, paste a clipboard snippet, or
              import a URL / repository from the Import tab.
            </p>
          )}
        </HudPanel>
      ) : null}

      <ImportChat />
    </AppShell>
  );
}
