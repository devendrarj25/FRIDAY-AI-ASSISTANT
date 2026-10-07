import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  CircleSlash,
  Download,
  FilePlus2,
  FolderInput,
  FolderOpen,
  Play,
  Boxes,
  RefreshCw,
  RotateCcw,
  Save,
  Send,
  Square,
  Trash2,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { AppShell, Panel } from "@/components/friday/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { brain } from "@/lib/friday/brain-engine";
import { useBrain } from "@/lib/friday/use-brain";
import {
  formatSandboxExtra,
  publishSandboxSession,
  registerSandboxAsk,
  registerSandboxRunner,
} from "@/lib/friday/sandbox-awareness";
import { summarizeSandboxOutput } from "@/lib/friday/sandbox-command";
import {
  SANDBOX_PRESETS,
  SANDBOX_TEMPLATES,
  applyApproved,
  cancelRun,
  createProject,
  deleteFile,
  detectRuntime,
  diffToSource,
  execCommand,
  importFolder,
  installEngine,
  startEngineService,
  installRuntime,
  launchEngineSession,
  listEngines,
  listFiles,
  loadSummary,
  onApplyProgress,
  onOutput,
  onRuntimeEvent,
  planChecks,
  readFile,
  readLog,
  removeProject,
  reveal,
  rollbackApply,
  sandboxAvailable,
  setProjectEngine,
  writeFile,
  type SandboxChange,
  type SandboxEngineReport,
  type SandboxFile,
  type SandboxProject,
  type SandboxRuntime,
  type SandboxSummary,
} from "@/lib/friday/sandbox-lab";

export const Route = createFileRoute("/sandbox")({
  head: () => ({
    meta: [
      { title: "Sandbox — FRIDAY" },
      {
        name: "description",
        content:
          "An isolated local development and testing runtime: real files, dependency installs, commands, builds, tests and an approval-gated apply into the FRIDAY source.",
      },
      { property: "og:title", content: "Sandbox — FRIDAY" },
      {
        property: "og:description",
        content: "Isolated development, testing and approval-gated upgrades.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: SandboxPage,
});

const time = (at?: number) => (at ? new Date(at).toLocaleString() : "—");

function SandboxPage() {
  const desktop = sandboxAvailable();
  const brainState = useBrain();
  const [ask, setAsk] = useState("");
  const [summary, setSummary] = useState<SandboxSummary | null>(null);
  const [runtime, setRuntime] = useState<SandboxRuntime>({ ok: false, tools: [] });
  const [runtimeBusy, setRuntimeBusy] = useState<string | null>(null);
  const [runtimeLine, setRuntimeLine] = useState("");

  const [activeId, setActiveId] = useState<string | null>(null);
  const [files, setFiles] = useState<SandboxFile[]>([]);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [newName, setNewName] = useState("");
  const [template, setTemplate] = useState<string>("node");

  const [engines, setEngines] = useState<SandboxEngineReport>({
    ok: false,
    engines: [],
    usable: [],
  });
  const [engineBusy, setEngineBusy] = useState<string | null>(null);

  const [command, setCommand] = useState("npm test");
  const [output, setOutput] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [log, setLog] = useState("");

  const [changes, setChanges] = useState<SandboxChange[] | null>(null);
  const [approved, setApproved] = useState<Set<string>>(new Set());
  const [applyStep, setApplyStep] = useState("");
  const [applying, setApplying] = useState(false);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const consoleRef = useRef<HTMLPreElement | null>(null);

  const project = useMemo(
    () => summary?.projects.find((p) => p.id === activeId) ?? null,
    [summary, activeId],
  );

  const refresh = useCallback(async () => {
    const next = await loadSummary();
    setSummary(next);
    setActiveId((current) => current ?? next.projects[0]?.id ?? null);
    return next;
  }, []);

  useEffect(() => {
    void refresh();
    void detectRuntime().then(setRuntime);
    void listEngines().then(setEngines);
  }, [refresh]);

  useEffect(
    () => onRuntimeEvent((event) => setRuntimeLine(`${event.phase}: ${event.line ?? ""}`.trim())),
    [],
  );
  useEffect(() => onApplyProgress((event) => setApplyStep(event.step)), []);

  useEffect(
    () =>
      onOutput((event) => {
        if (event.projectId !== activeId) return;
        if (event.phase === "start") setOutput(`$ ${event.command}\n`);
        else if (event.phase === "output")
          setOutput((text) => (text + (event.line ?? "")).slice(-120000));
        else if (event.phase === "done") {
          setOutput((text) => `${text}\n[exit ${event.code ?? "?"} · ${event.ms ?? 0}ms]\n`);
          setRunId(null);
        }
      }),
    [activeId],
  );

  useEffect(() => {
    const el = consoleRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output]);

  const loadTree = useCallback(async (id: string) => {
    const result = await listFiles(id);
    setFiles(result.files ?? []);
  }, []);

  useEffect(() => {
    if (!activeId) return;
    setOpenFile(null);
    setContent("");
    setDirty(false);
    setChanges(null);
    setOutput("");
    void loadTree(activeId);
    void readLog(activeId).then(setLog);
  }, [activeId, loadTree]);

  useEffect(() => {
    registerSandboxAsk((prompt) => {
      const result = brain.send(prompt, { extra: formatSandboxExtra() });
      if (!result.accepted) toast.error(result.message || "FRIDAY is busy.");
    });
    registerSandboxRunner(async (line, options) => {
      const id = options.projectId || activeId;
      if (!id) return { ok: false, error: "Open a sandbox project first." };
      const runKey = `run-${Date.now().toString(36)}`;
      setRunId(runKey);
      const result = await execCommand({ id, command: line, runId: runKey });
      setRunId(null);
      void readLog(id).then(setLog);
      void loadTree(id);
      void refresh();
      return result;
    });
    return () => {
      registerSandboxAsk(null);
      registerSandboxRunner(async () => ({
        ok: false,
        skipped: true,
        error: "sandbox page closed",
      }));
    };
  }, [activeId, loadTree, refresh]);

  useEffect(() => {
    publishSandboxSession({
      projectId: project?.id ?? null,
      projectName: project?.name ?? null,
      engine: project?.engine ?? engines.selected?.id ?? null,
      template: project?.template ?? null,
      dir: project?.dir ?? null,
      running: Boolean(runId),
      lastCommand: command || null,
      desktop,
      output,
      lastErrors: summarizeSandboxOutput(output),
    });
  }, [project, engines.selected?.id, runId, command, desktop, output]);

  /* ---------------------------------------------------------- actions */

  const onCreate = async () => {
    if (!newName.trim()) {
      toast.error("Give the sandbox project a name.");
      return;
    }
    const result = await createProject(newName.trim(), template);
    if (!result.ok) {
      toast.error(result.error ?? "Could not create the project.");
      return;
    }
    setNewName("");
    const next = await refresh();
    setActiveId(result.project?.id ?? next.projects[0]?.id ?? null);
    toast.success("Sandbox project created.");
  };

  const onOpenFile = async (file: string) => {
    if (!activeId) return;
    const result = await readFile(activeId, file);
    if (!result.ok) {
      toast.error(result.error ?? "Could not read that file.");
      return;
    }
    setOpenFile(file);
    setContent(result.content ?? "");
    setDirty(false);
  };

  const onSave = async () => {
    if (!activeId || !openFile) return;
    const result = await writeFile(activeId, openFile, content);
    if (!result.ok) {
      toast.error(result.error ?? "Could not save.");
      return;
    }
    setDirty(false);
    void loadTree(activeId);
    toast.success(`Saved ${openFile}`);
  };

  const onNewFile = async () => {
    if (!activeId) return;
    const name = window.prompt("New file path inside the sandbox project", "src/new-file.ts");
    if (!name) return;
    const result = await writeFile(activeId, name, "");
    if (!result.ok) {
      toast.error(result.error ?? "Could not create the file.");
      return;
    }
    await loadTree(activeId);
    void onOpenFile(name);
  };

  const onDelete = async (file: string) => {
    if (!activeId) return;
    if (!window.confirm(`Delete ${file} from the sandbox project?`)) return;
    await deleteFile(activeId, file);
    if (openFile === file) {
      setOpenFile(null);
      setContent("");
    }
    void loadTree(activeId);
  };

  const onRun = async (line?: string) => {
    if (!activeId) {
      toast.error("Open a sandbox project first.");
      return;
    }
    const cmd = (line ?? command).trim();
    if (!cmd) return;
    const id = `run-${Date.now().toString(36)}`;
    setRunId(id);
    setOutput(`$ ${cmd}\n`);
    const result = await execCommand({ id: activeId, command: cmd, runId: id });
    setRunId(null);
    if (!result.ok && result.error) setOutput((text) => `${text}\n${result.error}`);
    void readLog(activeId).then(setLog);
    void loadTree(activeId);
    void refresh();
  };

  const onStop = async () => {
    if (!runId) return;
    await cancelRun(runId);
    setRunId(null);
  };

  const onRunChecks = async () => {
    if (!activeId) {
      toast.error("Open a sandbox project first.");
      return;
    }
    const planned = await planChecks(activeId);
    if (!planned.ok) {
      toast.error(planned.error ?? "Could not plan checks.");
      return;
    }
    if (!planned.checks.length) {
      toast.error("No check targets in this project yet.");
      return;
    }
    for (const check of planned.checks) {
      setCommand(check.command);
      await onRun(check.command);
    }
  };

  const askFriday = () => {
    const text = ask.trim();
    if (!text || brainState.activeRunId) return;
    setAsk("");
    const prompt = /sandbox/i.test(text) ? text : `${text} in the sandbox`;
    brain.send(prompt, { extra: formatSandboxExtra() });
  };

  const onDiff = async () => {
    if (!activeId) return;
    const result = await diffToSource(activeId);
    if (!result.ok) {
      toast.error(result.error ?? "Could not compare with the FRIDAY source.");
      return;
    }
    setChanges(result.changes ?? []);
    setApproved(new Set());
    setPreviewPath(result.changes?.[0]?.path ?? null);
  };

  const onApply = async () => {
    if (!activeId || !changes) return;
    const files = [...approved];
    if (!files.length) {
      toast.error("Approve at least one change first.");
      return;
    }
    if (
      !window.confirm(
        `Apply ${files.length} approved file(s) into the real FRIDAY source and run the full regression pass?`,
      )
    )
      return;
    setApplying(true);
    setApplyStep("Applying approved changes");
    const reviewed = Object.fromEntries(changes.map((c) => [c.path, c.sourceHash]));
    const result = await applyApproved(activeId, files, `sandbox ${activeId}`, reviewed);
    setApplying(false);
    setApplyStep("");
    if (result.ok) {
      toast.success("Applied and verified — regression passed.");
      setChanges(null);
      setApproved(new Set());
    } else {
      toast.error(
        result.rolledBack
          ? "Regression failed — the changes were rolled back."
          : (result.error ?? "Apply failed."),
      );
    }
    void refresh();
  };

  const onRollback = async (applyId: string) => {
    const result = await rollbackApply(applyId);
    if (result.ok) toast.success(`Rolled back ${result.restored?.length ?? 0} file(s).`);
    else toast.error(result.error ?? "Rollback failed.");
    void refresh();
  };

  const onInstall = async (id: string) => {
    setRuntimeBusy(id);
    const result = await installRuntime(id);
    setRuntimeBusy(null);
    setRuntime(await detectRuntime());
    if (result.ok) toast.success(`${id} is installed and verified.`);
    else toast.error(result.error ?? `${id} could not be installed.`);
  };

  const onInstallEngine = async (id: string) => {
    const engine = engines.engines.find((e) => e.id === id);
    if (engine?.needsElevation) {
      // Requirement: never elevate silently — say what will happen and why first.
      if (
        !window.confirm(
          `${engine.label} enables a Windows feature, which Windows only allows with Administrator approval.\n\nFRIDAY will now run just this one install command elevated — Windows will show you its UAC prompt. FRIDAY itself keeps running as a normal app; nothing else gets admin rights.\n\nContinue and show the UAC prompt?`,
        )
      )
        return;
      toast.info("Approve the Windows UAC prompt to let FRIDAY enable this feature.");
    }
    setEngineBusy(id);
    const result = await installEngine(id);
    setEngines(await listEngines());
    setEngineBusy(null);
    if (result.ok)
      toast.success(
        result.restartRequired
          ? `${id} installed — restart Windows to finish enabling it.`
          : `${id} is installed and verified.`,
      );
    else if (result.declined)
      toast.error(
        result.error ??
          "Admin permission declined — enable manually via Windows Features, or approve the prompt to let FRIDAY do it.",
      );
    else toast.error(result.error ?? `${id} could not be installed.`);
  };

  // "Installed but not running" is repairable — really start the daemon.
  const onStartEngine = async (id: string) => {
    setEngineBusy(id);
    toast.info(`Starting ${id}… this can take up to a minute.`);
    const result = await startEngineService(id);
    setEngines(await listEngines());
    setEngineBusy(null);
    if (result.ok) toast.success(result.detail ?? `${id} is running.`);
    else toast.error(result.error ?? `${id} could not be started.`);
  };

  const onPickEngine = async (id: string) => {
    if (!activeId) {
      toast.error("Open a sandbox project first.");
      return;
    }
    const result = await setProjectEngine(activeId, id);
    if (!result.ok) {
      toast.error(result.error ?? "Could not switch the isolation engine.");
      return;
    }
    toast.success(`${project?.name ?? activeId} now runs under ${id}.`);
    void refresh();
  };

  const onLaunchEngine = async (id: string) => {
    const result = await launchEngineSession(id, project?.dir);
    if (result.ok) toast.success(result.detail ?? "Session started.");
    else toast.error(result.error ?? "Could not start the session.");
  };

  const preview = changes?.find((c) => c.path === previewPath) ?? null;

  return (
    <AppShell title="Sandbox" subtitle="Isolated development · testing · approval-gated upgrades">
      <div className="space-y-4">
        {!desktop ? (
          <Panel title="Desktop only">
            <p className="text-sm text-muted-foreground">
              The sandbox runs real commands and real installs, so it is only available in the
              FRIDAY Windows app.
            </p>
          </Panel>
        ) : null}

        {/* -------------------------------------------------- runtime */}
        <Panel
          title="Runtime"
          hint={summary?.base ?? "sandbox root"}
          actions={
            <Button size="sm" variant="ghost" onClick={() => void detectRuntime().then(setRuntime)}>
              <RefreshCw className="size-3.5" /> Detect
            </Button>
          }
        >
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {runtime.tools.map((tool) => (
              <div key={tool.id} className="hud-tile rounded-md px-3 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="label-xs text-primary">{tool.label}</span>
                  {tool.ok ? (
                    <CheckCircle2 className="size-3.5 text-success" />
                  ) : (
                    <XCircle className="size-3.5 text-destructive" />
                  )}
                </div>
                <p
                  className="mt-1 truncate font-mono text-[11px] text-muted-foreground"
                  title={tool.path ?? ""}
                >
                  {tool.detail}
                </p>
                {!tool.ok ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2 w-full"
                    disabled={runtimeBusy === tool.id}
                    onClick={() => void onInstall(tool.id)}
                  >
                    <Download className="size-3.5" />
                    {runtimeBusy === tool.id ? "Installing…" : `Install from ${tool.source}`}
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
          {runtimeLine ? (
            <p className="mt-2 font-mono text-[11px] text-muted-foreground">{runtimeLine}</p>
          ) : null}
          <p className="mt-2 text-xs text-muted-foreground">
            FRIDAY source: <span className="font-mono">{summary?.sourceRoot ?? "not located"}</span>
          </p>
        </Panel>

        {/* ------------------------------------------------- isolation */}
        <Panel
          title="Isolation engines"
          hint={
            project
              ? `${project.name} → ${project.engine ?? "process"}`
              : `${engines.engines.filter((e) => e.installed).length}/${engines.engines.length} available`
          }
          actions={
            <Button size="sm" variant="ghost" onClick={() => void listEngines().then(setEngines)}>
              <RefreshCw className="size-3.5" /> Detect
            </Button>
          }
        >
          <p className="mb-2 text-xs text-muted-foreground">
            Every sandbox command runs inside the engine its project selects — containers, a Linux
            kernel (WSL), namespaces, permissioned runtimes or a guarded process. Missing engines
            and runtimes install from their open-source sources and are verified by running them.
            FRIDAY uses this same lab in Auto Mode for checks and tests.
          </p>
          {engines.selected ? (
            <p className="mb-2 font-mono text-[10px] text-muted-foreground">
              Active engine: {engines.selected.label} ({engines.selected.id})
              {engines.selected.isolated ? " · isolated" : " · not OS-isolated"}
              {engines.selected.detail ? ` · ${engines.selected.detail}` : ""}
              {engines.selected.cached ? " · cached" : ""}
            </p>
          ) : null}
          {engines.selected?.warning ? (
            <p className="mb-2 font-mono text-[10px] text-muted-foreground">
              {engines.selected.warning}
            </p>
          ) : null}
          {engines.edition?.platform === "win32" && !engines.edition.windowsSandboxEligible ? (
            <p className="mb-2 font-mono text-[10px] text-muted-foreground">
              Windows Sandbox excluded
              {engines.edition.home
                ? " — this PC is Windows Home (Microsoft restriction)."
                : " — this Windows edition cannot run it."}
            </p>
          ) : null}
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {engines.engines.map((engine) => {
              const activeIdForProject =
                project?.engine && project.engine !== "auto"
                  ? project.engine
                  : (engines.selected?.id ?? "process");
              const selected = activeIdForProject === engine.id;
              return (
                <div
                  key={engine.id}
                  className={cn(
                    "hud-tile rounded-md px-3 py-2.5",
                    selected && "ring-1 ring-primary/50",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="label-xs text-primary">{engine.label}</span>
                    {engine.ready ? (
                      <CheckCircle2 className="size-3.5 text-success" />
                    ) : engine.installed ? (
                      <CircleSlash className="size-3.5 text-warning" />
                    ) : (
                      <XCircle className="size-3.5 text-destructive" />
                    )}
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">{engine.summary}</p>
                  <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
                    {engine.kind} · {engine.isolation}
                    {engine.version ? ` · ${engine.version}` : ""}
                    {engine.detail ? ` · ${engine.detail}` : ""}
                  </p>
                  {engine.awaitingRestart ? (
                    <p className="mt-1 text-[11px] font-medium text-warning">
                      Restart Windows to finish enabling this engine.
                    </p>
                  ) : null}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {engine.eligible === false ? null : engine.installed &&
                      !engine.ready &&
                      engine.canStartService ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={engineBusy === engine.id}
                        onClick={() => void onStartEngine(engine.id)}
                      >
                        <Play className="size-3.5" />
                        {engineBusy === engine.id ? "Starting…" : "Start service"}
                      </Button>
                    ) : null}
                    {engine.eligible === false || engine.installed ? null : (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={engineBusy === engine.id || engine.awaitingRestart}
                        onClick={() => void onInstallEngine(engine.id)}
                      >
                        <Download className="size-3.5" />
                        {engineBusy === engine.id
                          ? "Installing…"
                          : engine.awaitingRestart
                            ? "Restart Windows"
                            : `Install · ${engine.sources[0] ?? "source"}`}
                      </Button>
                    )}
                    {engine.eligible === false || !engine.installed ? null : engine.launchOnly ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void onLaunchEngine(engine.id)}
                      >
                        <Play className="size-3.5" /> Launch session
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant={selected ? "default" : "outline"}
                        disabled={!engine.ready || !activeId}
                        onClick={() => void onPickEngine(engine.id)}
                      >
                        <Boxes className="size-3.5" /> {selected ? "In use" : "Use for project"}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
            {!engines.engines.length ? (
              <p className="text-xs text-muted-foreground">
                Engine detection runs in the FRIDAY desktop app.
              </p>
            ) : null}
          </div>
        </Panel>

        {/* ------------------------------------------------- projects */}
        <Panel title="Sandbox projects" hint={`${summary?.projects.length ?? 0} project(s)`}>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New sandbox project name"
              className="h-8 w-56"
            />
            <select
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              className="h-8 rounded-sm border border-primary/20 bg-background px-2 text-xs"
            >
              {SANDBOX_TEMPLATES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
            <Button size="sm" onClick={() => void onCreate()}>
              <FilePlus2 className="size-3.5" /> Create
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void refresh()}>
              <RefreshCw className="size-3.5" /> Refresh
            </Button>
          </div>

          <div className="mt-3 space-y-1.5">
            {(summary?.projects ?? []).map((p: SandboxProject) => (
              <div
                key={p.id}
                className={cn(
                  "flex items-center justify-between gap-3 rounded-sm border px-3 py-2 text-xs",
                  p.id === activeId ? "border-primary/50 bg-primary/5" : "border-primary/15",
                )}
              >
                <button className="min-w-0 flex-1 text-left" onClick={() => setActiveId(p.id)}>
                  <span className="font-medium text-foreground">{p.name}</span>
                  <span className="ml-2 font-mono text-[11px] text-muted-foreground">
                    {p.template}
                  </span>
                  <p className="truncate font-mono text-[11px] text-muted-foreground">{p.dir}</p>
                </button>
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                  {time(p.updatedAt)}
                </span>
                <Button size="sm" variant="ghost" onClick={() => void reveal(p.dir)}>
                  <FolderOpen className="size-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    if (!window.confirm(`Delete the sandbox project "${p.name}" and its files?`))
                      return;
                    await removeProject(p.id);
                    setActiveId(null);
                    void refresh();
                  }}
                >
                  <Trash2 className="size-3.5 text-destructive" />
                </Button>
              </div>
            ))}
            {!summary?.projects.length ? (
              <p className="text-xs text-muted-foreground">
                No sandbox project yet — create one above.
              </p>
            ) : null}
          </div>
        </Panel>

        {project ? (
          <>
            {/* ------------------------------------------ files + editor */}
            <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
              <Panel
                title="Files"
                hint={`${files.filter((f) => !f.dir).length} file(s)`}
                actions={
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => void onNewFile()}>
                      <FilePlus2 className="size-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        const result = await importFolder(project.id);
                        if (result.ok) {
                          toast.success(`Imported ${result.files ?? 0} file(s).`);
                          void loadTree(project.id);
                        } else if (!result.cancelled) toast.error(result.error ?? "Import failed.");
                      }}
                    >
                      <FolderInput className="size-3.5" />
                    </Button>
                  </div>
                }
              >
                <div className="max-h-80 overflow-auto font-mono text-[11px]">
                  {files.map((f) => (
                    <div key={f.path} className="group flex items-center gap-1">
                      <button
                        disabled={f.dir}
                        onClick={() => void onOpenFile(f.path)}
                        className={cn(
                          "flex-1 truncate rounded-sm px-1.5 py-0.5 text-left",
                          f.dir ? "text-primary/70" : "text-muted-foreground hover:bg-primary/10",
                          openFile === f.path && "bg-primary/10 text-foreground",
                        )}
                        title={f.path}
                      >
                        {f.dir ? `${f.path}/` : f.path}
                      </button>
                      {!f.dir ? (
                        <button
                          className="opacity-0 transition-opacity group-hover:opacity-100"
                          onClick={() => void onDelete(f.path)}
                        >
                          <Trash2 className="size-3 text-destructive" />
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              </Panel>

              <Panel
                title="Editor"
                hint={openFile ?? "no file open"}
                actions={
                  <Button
                    size="sm"
                    variant={dirty ? "default" : "ghost"}
                    disabled={!openFile}
                    onClick={() => void onSave()}
                  >
                    <Save className="size-3.5" /> Save
                  </Button>
                }
              >
                <Textarea
                  value={content}
                  spellCheck={false}
                  onChange={(e) => {
                    setContent(e.target.value);
                    setDirty(true);
                  }}
                  placeholder="Open a file to edit it inside the sandbox."
                  className="h-72 resize-none font-mono text-xs"
                />
              </Panel>
            </div>

            {/* ----------------------------------------------- run + logs */}
            <Panel
              title="Run"
              hint={project.dir}
              actions={
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={Boolean(runId)}
                    onClick={() => void onRunChecks()}
                  >
                    <Play className="size-3.5" /> Run checks
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={Boolean(brainState.activeRunId)}
                    onClick={() => {
                      const errors = summarizeSandboxOutput(output);
                      const prompt = errors
                        ? `find the errors in the sandbox\n${errors}`
                        : "find the errors in the sandbox";
                      const result = brain.send(prompt, { extra: formatSandboxExtra() });
                      if (!result.accepted) toast.error(result.message || "FRIDAY is busy.");
                    }}
                  >
                    Ask about errors
                  </Button>
                  {runId ? (
                    <Button size="sm" variant="ghost" onClick={() => void onStop()}>
                      <Square className="size-3.5" /> Stop
                    </Button>
                  ) : null}
                </div>
              }
            >
              <div className="flex flex-wrap gap-1.5">
                {SANDBOX_PRESETS.map((preset) => (
                  <Button
                    key={preset.id}
                    size="sm"
                    variant="outline"
                    disabled={Boolean(runId)}
                    onClick={() => {
                      setCommand(preset.command);
                      void onRun(preset.command);
                    }}
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
              <div className="mt-2 flex gap-2">
                <Input
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void onRun();
                  }}
                  placeholder="Command to run inside the sandbox project"
                  className="h-8 font-mono text-xs"
                />
                <Button size="sm" disabled={Boolean(runId)} onClick={() => void onRun()}>
                  <Play className="size-3.5" /> Run
                </Button>
              </div>
              <pre
                ref={consoleRef}
                className="mt-3 max-h-72 overflow-auto rounded-sm bg-background p-3 font-mono text-[11px] leading-relaxed text-muted-foreground"
              >
                {output || "Output from the isolated run appears here."}
              </pre>
              {summarizeSandboxOutput(output) ? (
                <pre className="mt-2 max-h-32 overflow-auto rounded-sm bg-background p-3 font-mono text-[11px] leading-relaxed text-destructive">
                  {summarizeSandboxOutput(output)}
                </pre>
              ) : null}
            </Panel>

            <Panel
              title="Ask FRIDAY"
              hint={brainState.activeRunId ? "thinking" : "same brain as Chat / Auto Mode"}
            >
              <p className="mb-2 text-xs text-muted-foreground">
                FRIDAY can see this sandbox (project, engine, last command, live buffer, error
                lines). Ask what failed, or tell her to run checks. Auto Mode runs tests herself;
                installs and apply-to-source still wait for you.
              </p>
              <div className="mb-3 max-h-48 space-y-2 overflow-auto text-sm">
                {brainState.messages.slice(-8).length ? (
                  brainState.messages.slice(-8).map((line) => (
                    <p key={line.id} className="whitespace-pre-wrap">
                      <span className="mr-2 text-[10px] uppercase tracking-widest text-muted-foreground">
                        {line.role === "user" ? "You" : "FRIDAY"}
                      </span>
                      {line.text}
                    </p>
                  ))
                ) : (
                  <p className="text-xs text-muted-foreground">
                    No chat yet this session. Type below, or ask her to run tests in the sandbox.
                  </p>
                )}
              </div>
              <div className="flex gap-2">
                <Input
                  value={ask}
                  onChange={(e) => setAsk(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      askFriday();
                    }
                  }}
                  placeholder="Why did that fail? · run the tests in the sandbox"
                  className="h-8 text-sm"
                  disabled={Boolean(brainState.activeRunId)}
                />
                <Button
                  size="sm"
                  disabled={!ask.trim() || Boolean(brainState.activeRunId)}
                  onClick={askFriday}
                >
                  Ask
                </Button>
              </div>
            </Panel>

            <Panel
              title="Logs"
              hint="persisted per project"
              actions={
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void readLog(project.id).then(setLog)}
                >
                  <RefreshCw className="size-3.5" /> Reload
                </Button>
              }
            >
              <pre className="max-h-56 overflow-auto rounded-sm bg-background p-3 font-mono text-[11px] text-muted-foreground">
                {log || "No sandbox log yet."}
              </pre>
            </Panel>

            {/* -------------------------------------- proposed changes */}
            <Panel
              title="Proposed changes → FRIDAY source"
              hint={summary?.sourceRoot ?? ""}
              actions={
                <div className="flex gap-1.5">
                  <Button size="sm" variant="ghost" onClick={() => void onDiff()}>
                    <RefreshCw className="size-3.5" /> Compare
                  </Button>
                  <Button
                    size="sm"
                    disabled={applying || !changes?.length}
                    onClick={() => void onApply()}
                  >
                    <Send className="size-3.5" /> Approve &amp; apply
                  </Button>
                </div>
              }
            >
              {applying ? (
                <p className="mb-2 font-mono text-[11px] text-primary">{applyStep}</p>
              ) : null}
              {changes === null ? (
                <p className="text-xs text-muted-foreground">
                  Compare this sandbox project against the real FRIDAY source to see the exact
                  changes. Nothing is written until you approve it here.
                </p>
              ) : changes.length === 0 ? (
                <p className="text-xs text-success">
                  No differences — the sandbox matches the FRIDAY source.
                </p>
              ) : (
                <div className="grid gap-3 lg:grid-cols-[320px_1fr]">
                  <div className="max-h-72 space-y-1 overflow-auto">
                    {changes.map((change) => (
                      <div key={change.path} className="flex items-center gap-2 text-[11px]">
                        <input
                          type="checkbox"
                          checked={approved.has(change.path)}
                          onChange={(e) => {
                            const next = new Set(approved);
                            if (e.target.checked) next.add(change.path);
                            else next.delete(change.path);
                            setApproved(next);
                          }}
                        />
                        <button
                          className={cn(
                            "min-w-0 flex-1 truncate rounded-sm px-1.5 py-0.5 text-left font-mono",
                            previewPath === change.path
                              ? "bg-primary/10 text-foreground"
                              : "text-muted-foreground",
                          )}
                          onClick={() => setPreviewPath(change.path)}
                          title={change.path}
                        >
                          {change.path}
                        </button>
                        <span
                          className={change.status === "added" ? "text-success" : "text-warning"}
                        >
                          {change.status}
                        </span>
                      </div>
                    ))}
                    <div className="flex gap-2 pt-1">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setApproved(new Set(changes.map((c) => c.path)))}
                      >
                        Select all
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setApproved(new Set())}>
                        <CircleSlash className="size-3.5" /> Clear
                      </Button>
                    </div>
                  </div>
                  <pre className="max-h-72 overflow-auto rounded-sm bg-background p-3 font-mono text-[11px] text-muted-foreground">
                    {preview
                      ? preview.preview
                      : "Select a file to preview the exact proposed content."}
                  </pre>
                </div>
              )}
            </Panel>
          </>
        ) : null}

        {/* -------------------------------------------- applies + history */}
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="Applied upgrades" hint="rollback restores the exact previous files">
            <div className="space-y-1.5">
              {(summary?.applies ?? []).map((entry) => (
                <div
                  key={entry.applyId}
                  className="flex items-center justify-between gap-2 rounded-sm border border-primary/15 px-2.5 py-1.5 text-[11px]"
                >
                  <div className="min-w-0">
                    <p className="truncate font-mono text-foreground">{entry.applyId}</p>
                    <p className="truncate text-muted-foreground">
                      {entry.files?.length ?? 0} file(s) · {time(entry.at)}
                    </p>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => void onRollback(entry.applyId)}>
                    <RotateCcw className="size-3.5" /> Rollback
                  </Button>
                </div>
              ))}
              {!summary?.applies.length ? (
                <p className="text-xs text-muted-foreground">Nothing applied yet.</p>
              ) : null}
            </div>
          </Panel>

          <Panel title="Sandbox history" hint="persisted across restarts">
            <div className="max-h-64 space-y-1 overflow-auto font-mono text-[11px]">
              {(summary?.history ?? []).map((entry, index) => (
                <p key={`${entry.at}-${index}`} className="truncate text-muted-foreground">
                  <span className="text-primary">{entry.kind}</span> · {entry.projectId ?? "—"} ·{" "}
                  {entry.detail ?? ""} {entry.ok === false ? "· failed" : ""}
                </p>
              ))}
              {!summary?.history.length ? (
                <p className="text-muted-foreground">No sandbox activity yet.</p>
              ) : null}
            </div>
          </Panel>
        </div>
      </div>
    </AppShell>
  );
}
