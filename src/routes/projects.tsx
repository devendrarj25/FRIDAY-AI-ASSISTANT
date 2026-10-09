import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { deferEffect } from "@/lib/friday/defer-effect";
import { Copy, FolderOpen, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/friday/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FilterTabs, HudPanel, StatusPill } from "@/components/friday/ui";
import { brain } from "@/lib/friday/brain-engine";
import { installer } from "@/lib/friday/installer-engine";
import { isDesktopApp, pickProjectFolder, revealWorkspaceFolder } from "@/lib/friday/desktop";
import { library } from "@/lib/friday/library-engine";
import { sendBrowserCommand } from "@/lib/friday/live-browser";
import { kernelApi } from "@/lib/friday/kernel-api";
import { terminalCd, terminalRoot } from "@/lib/friday/terminal";
import {
  PROJECT_ISOLATION_IDS,
  PROJECT_KINDS,
  PROJECT_TABS,
  defaultRuntimesFor,
  fingerprintFromFiles,
  isProjectTextPreview,
  projectWorkspaces,
  unsignedBinaryHonesty,
  type ProjectKind,
  type ProjectWorkspace,
} from "@/lib/friday/project-workspace-engine";
import {
  formatProjectExtra,
  publishProjectWorkspaceSession,
  registerProjectWorkspaceAsk,
} from "@/lib/friday/project-workspace-awareness";

export function activityUpdatedAt(now: () => number = Date.now): number {
  return now();
}

export const Route = createFileRoute("/projects")({
  head: () => ({
    meta: [
      { title: "Projects & Workspaces — FRIDAY" },
      {
        name: "description",
        content:
          "Scoped owner work: instructions, knowledge, sources, Chat and Auto hands-off — same Core Brain, not a second IDE.",
      },
      { property: "og:title", content: "Projects & Workspaces — FRIDAY" },
      {
        property: "og:description",
        content: "Owner project workspaces under FRIDAY_ROOT/projects.",
      },
    ],
  }),
  component: ProjectsPage,
});

function ProjectsPage() {
  const desktop = isDesktopApp();
  const navigate = useNavigate();
  const [items, setItems] = useState<ProjectWorkspace[]>(() => projectWorkspaces.list(true));
  const [activeId, setActiveId] = useState<string | null>(() => projectWorkspaces.activeId());
  const [tab, setTab] = useState<(typeof PROJECT_TABS)[number]>("overview");
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ProjectKind>("mixed");
  const [ask, setAsk] = useState("");
  const [instructions, setInstructions] = useState("");
  const [language, setLanguage] = useState("");
  const [stack, setStack] = useState("");
  const [format, setFormat] = useState("");
  const [modelHint, setModelHint] = useState("");
  const [knowTitle, setKnowTitle] = useState("");
  const [knowText, setKnowText] = useState("");
  const [sourceLabel, setSourceLabel] = useState("");
  const [sourcePath, setSourcePath] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [thread, setThread] = useState(() => brain.getSnapshot().messages.slice(-8));
  const [libItems, setLibItems] = useState(() => library.list());
  const [libPick, setLibPick] = useState("");
  const [preview, setPreview] = useState<{ name: string; content: string; error?: string } | null>(
    null,
  );
  const [detectNote, setDetectNote] = useState("");

  const pull = useCallback(async () => {
    setBusy(true);
    try {
      if (desktop) await projectWorkspaces.refreshFromDesktop();
      setItems(projectWorkspaces.list(true));
      setActiveId(projectWorkspaces.activeId());
    } finally {
      setBusy(false);
    }
  }, [desktop]);

  useEffect(() => {
    const stop = deferEffect(() => void pull());
    const offProj = projectWorkspaces.subscribe(() => {
      setItems(projectWorkspaces.list(true));
      setActiveId(projectWorkspaces.activeId());
    });
    const offLib = library.subscribe(() => setLibItems(library.list()));
    return () => {
      stop();
      offProj();
      offLib();
    };
  }, [pull]);

  useEffect(() => {
    return brain.subscribe(() => {
      setThread(brain.getSnapshot().messages.slice(-8));
    });
  }, []);

  const active = items.find((item) => item.id === activeId);
  const activeFormId = active?.id ?? "";
  const [seenProject, setSeenProject] = useState(activeFormId);
  if (active && seenProject !== active.id) {
    setSeenProject(active.id);
    setInstructions(active.instructions);
    setLanguage(active.preferences.language);
    setStack(active.preferences.stack);
    setFormat(active.preferences.format);
    setModelHint(active.preferences.modelHint || "");
    setKind(active.kind);
  }

  useEffect(() => {
    registerProjectWorkspaceAsk((prompt) => {
      const result = brain.send(prompt, { extra: formatProjectExtra() });
      if (!result.accepted) toast.error(result.message || "FRIDAY is busy.");
    });
    return () => registerProjectWorkspaceAsk(null);
  }, []);

  useEffect(() => {
    publishProjectWorkspaceSession({
      desktop,
      items: projectWorkspaces.list(true),
      activeId,
      tab,
      dir: projectWorkspaces.dirPath(),
    });
  }, [desktop, items, activeId, tab]);

  const fileProjectId = active?.id;
  const fileUpdatedAt = active?.activity.updatedAt;
  useEffect(() => {
    if (!fileProjectId || tab !== "files") return;
    void projectWorkspaces.listFiles(fileProjectId).then(setFiles);
  }, [fileProjectId, tab, fileUpdatedAt]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((item) => {
      if (!showArchived && item.archived) return false;
      if (!q) return true;
      return `${item.name} ${item.kind} ${item.id}`.toLowerCase().includes(q);
    });
  }, [items, query, showArchived]);

  const runtimeHealth = (active?.runtime ?? []).map((pkg) => {
    const entry = installer.entries().find((row) => row.pkg === pkg);
    return { pkg, status: entry ? installer.statusOf(entry) : "not in Install Manager catalog" };
  });
  const handsOff = Boolean(active?.handsOffAuto || active?.preferences.handsOffAuto);

  const sendChat = (prompt: string) => {
    const result = brain.send(prompt, { extra: formatProjectExtra() });
    if (!result.accepted) toast.error(result.message || "FRIDAY is busy.");
    else toast.success("Sent to Chat.");
  };

  const onAsk = () => {
    const text =
      ask.trim() ||
      (active ? `What should we do next in project ${active.name}?` : "What projects do I have?");
    sendChat(active ? `Project ${active.name}: ${text}` : text);
    setAsk("");
  };

  const create = () => {
    const record = projectWorkspaces.create({ name: name.trim() || "Untitled project", kind });
    projectWorkspaces.setActive(record.id);
    setName("");
    setActiveId(record.id);
    setItems(projectWorkspaces.list(true));
    toast.success(`Created ${record.name}.`);
  };

  const saveActive = () => {
    if (!active) return;
    projectWorkspaces.save({
      id: active.id,
      instructions,
      kind,
      preferences: {
        language,
        stack,
        format,
        handsOffAuto: handsOff,
        ...(modelHint.trim() ? { modelHint: modelHint.trim() } : {}),
      },
    });
    setItems(projectWorkspaces.list(true));
    toast.success("Saved.");
  };

  const openFolder = async () => {
    if (!desktop) {
      toast.error("Open folder is desktop-only — same as Sandbox.");
      return;
    }
    const picked = await pickProjectFolder();
    if (!picked) return;
    const record = projectWorkspaces.create({
      name: name.trim() || picked.split(/[\\/]/).filter(Boolean).slice(-1)[0] || "Folder project",
      kind,
      rootPath: picked,
    });
    projectWorkspaces.setActive(record.id);
    setItems(projectWorkspaces.list(true));
    toast.success(`Opened ${record.name}. Folders scan is unchanged.`);
  };

  const installRequired = () => {
    if (!active?.runtime.length) {
      toast.error("This project has no runtime list yet.");
      return;
    }
    let n = 0;
    for (const pkg of active.runtime) {
      const entry = installer.entries().find((row) => row.pkg === pkg);
      if (!entry) continue;
      if (installer.statusOf(entry) !== "Not installed") continue;
      const job = installer.enqueue(pkg, "install");
      if (job) n += 1;
    }
    toast.success(n ? `Queued ${n} missing Install Manager job(s).` : "Nothing missing to queue.");
    void navigate({ to: "/install-manager" });
  };

  const openTerminalHere = async () => {
    if (!active) return;
    if (!desktop) {
      toast.error("Terminal is desktop-only — same honesty as Sandbox.");
      return;
    }
    if (!active.rootPath) {
      toast.error("This project has no folder yet.");
      return;
    }
    const root = await terminalRoot();
    const cwd = root || active.rootPath;
    const moved = await terminalCd(cwd, active.rootPath);
    if (!moved.ok) {
      toast.error(
        moved.error ||
          "Terminal cannot leave the FRIDAY folder. Keep this project under FRIDAY_ROOT or open Terminal from Folders.",
      );
      return;
    }
    toast.success("Terminal cwd set to this project (inside the FRIDAY folder).");
    void navigate({ to: "/terminal" });
  };

  const detectProject = async () => {
    if (!active) return;
    const listing = files.length ? files : await projectWorkspaces.listFiles(active.id);
    if (listing.length) setFiles(listing);
    const local = fingerprintFromFiles(listing);
    let kernelNote: string;
    try {
      const detected = await kernelApi.projects.detect();
      const rows = detected?.projects ?? [];
      const match = rows.find((row) => {
        const folder = String(row["path"] || "");
        if (!folder || !active.rootPath) return false;
        const a = active.rootPath.replace(/\\/g, "/").toLowerCase();
        const b = folder.replace(/\\/g, "/").toLowerCase();
        return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
      });
      kernelNote = match
        ? `kernel: ${String(match["language"] || "unknown")} via ${String(match["entry"] || "?")} runtimeInstalled=${String(match["runtimeInstalled"])}`
        : `kernel listed ${rows.length} FRIDAY_ROOT child project(s); nested work folders may not appear.`;
    } catch (error) {
      kernelNote = `kernel detect unavailable: ${String((error as Error)?.message || error)}`;
    }
    const note = [
      local
        ? `local fingerprint: ${local.file} (${local.language})`
        : "local fingerprint: none in the file listing",
      kernelNote,
      unsignedBinaryHonesty(active.kind),
    ]
      .filter(Boolean)
      .join("\n");
    setDetectNote(note);
    projectWorkspaces.save({
      id: active.id,
      activity: { ...active.activity, lastRunLog: note, updatedAt: activityUpdatedAt() },
    });
    setItems(projectWorkspaces.list(true));
    toast.success("Detect recorded on this project.");
  };

  const previewFile = async (file: string) => {
    if (!active) return;
    if (!isProjectTextPreview(file)) {
      setPreview({
        name: file,
        content: "",
        error:
          "Not a text preview. Binary/Office stay on disk; I will not invent contents. HTML is shown as source, never executed.",
      });
      return;
    }
    const result = await projectWorkspaces.readFile(active.id, file);
    setPreview({
      name: result.name || file,
      content: result.content || "",
      ...(result.ok ? {} : { error: result.error || "Could not read that file." }),
    });
  };

  return (
    <AppShell
      title="Projects & Workspaces"
      subtitle="You work here and FRIDAY works here — scoped instructions, knowledge, sources, Chat. Folders and Sandbox stay what they are."
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Labour app, Site, Notes…"
            className="h-8 max-w-[220px] font-mono text-[11px]"
          />
          <Button size="sm" variant="outline" disabled={busy} onClick={create}>
            <Plus className="size-4" /> New project
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void openFolder()}>
            <FolderOpen className="size-4" /> Open folder
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!active}
            onClick={() => {
              if (!active) return;
              const copy = projectWorkspaces.duplicate(active.id);
              if (copy) toast.success(`Duplicated ${copy.name}.`);
              setItems(projectWorkspaces.list(true));
            }}
          >
            <Copy className="size-4" /> Duplicate
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!active}
            onClick={() => {
              if (!active) return;
              projectWorkspaces.archive(active.id, !active.archived);
              setItems(projectWorkspaces.list(true));
              toast.success(active.archived ? "Restored." : "Archived.");
            }}
          >
            {active?.archived ? "Unarchive" : "Archive"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!active}
            onClick={() => {
              if (!active) return;
              if (
                !window.confirm(`Delete project "${active.name}"? This does not wipe FRIDAY_ROOT.`)
              )
                return;
              projectWorkspaces.remove(active.id);
              setItems(projectWorkspaces.list(true));
              setActiveId(projectWorkspaces.activeId());
            }}
          >
            <Trash2 className="size-4" /> Delete
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void pull()}>
            <RefreshCw className="size-4" /> Refresh
          </Button>
          <Button size="sm" variant="outline" onClick={() => revealWorkspaceFolder("projects")}>
            Reveal projects folder
          </Button>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects"
            className="h-8 min-w-[140px] flex-1 font-mono text-[11px]"
          />
          <Button
            size="sm"
            variant={showArchived ? "default" : "outline"}
            onClick={() => setShowArchived((v) => !v)}
          >
            {showArchived ? "Hiding archived off" : "Show archived"}
          </Button>
          <span className="ml-auto font-mono text-[10px] text-muted-foreground">
            {desktop ? "live FRIDAY_ROOT/projects" : "preview session copy"} · {visible.length}/
            {items.length}
          </span>
        </div>

        {!desktop ? (
          <p className="font-mono text-[11px] text-muted-foreground">
            Browser preview: session copy only. Persist, Open folder, reveal, and in-app file writes
            are desktop-only — same honesty as Sandbox.
          </p>
        ) : null}

        <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
          <HudPanel title="Projects" hint="one active for Chat + Auto pin">
            {visible.length === 0 ? (
              <p className="font-mono text-[11px] text-muted-foreground">
                No projects yet. Create “Labour app”, “Site”, or “Notes”. This is not Folders and
                not Sandbox.
              </p>
            ) : (
              <ul className="space-y-1">
                {visible.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className={`w-full rounded-sm border px-2 py-1.5 text-left font-mono text-[11px] ${
                        item.id === activeId
                          ? "border-primary/50 bg-primary/15 text-primary"
                          : "border-border bg-surface text-muted-foreground hover:text-foreground"
                      }`}
                      onClick={() => {
                        projectWorkspaces.setActive(item.id);
                        setActiveId(item.id);
                      }}
                    >
                      <span className="block truncate">{item.name}</span>
                      <span className="text-[10px] opacity-80">
                        {item.kind}
                        {item.archived ? " · archived" : ""}
                        {item.handsOffAuto || item.preferences.handsOffAuto ? " · hands-off" : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </HudPanel>

          <div className="space-y-3">
            {!active ? (
              <HudPanel title="Select a project">
                <p className="font-mono text-[11px] text-muted-foreground">
                  Create or select a workspace. Chat in this section is project-bound. Main Chat
                  only uses a project when you say so (@project / use project).
                </p>
              </HudPanel>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill label={active.name} />
                  <StatusPill label={active.kind} />
                  {handsOff ? (
                    <StatusPill label="Auto hands-off" />
                  ) : (
                    <StatusPill label="Auto may help" />
                  )}
                  <Button size="sm" variant="outline" onClick={saveActive}>
                    <Save className="size-4" /> Save
                  </Button>
                  <Button
                    size="sm"
                    variant={handsOff ? "default" : "outline"}
                    onClick={() => {
                      projectWorkspaces.setHandsOff(active.id, !handsOff);
                      setItems(projectWorkspaces.list(true));
                    }}
                  >
                    Auto Mode hands-off this project
                  </Button>
                </div>
                <p className="font-mono text-[11px] text-muted-foreground">
                  {handsOff
                    ? "ON: Auto Mode, background agents, and idle schedulers will not write, exec, forge, or import into this folder until you turn this off or instruct in Manual. Chat here still works when you ask."
                    : "OFF: Auto may help this project when you ask, still through governance / tool-authority. Turn ON if you will do the work yourself."}
                </p>

                <FilterTabs
                  tabs={PROJECT_TABS.map((key) => ({ key, label: key }))}
                  value={tab}
                  onChange={(key) => setTab(key as (typeof PROJECT_TABS)[number])}
                />

                {tab === "overview" ? (
                  <HudPanel title="Overview" hint="what FRIDAY is doing">
                    <div className="space-y-2 font-mono text-[11px]">
                      <p>
                        Root:{" "}
                        {active.rootPath ||
                          "(created under FRIDAY_ROOT/projects/<id>/work on desktop)"}
                      </p>
                      <p>
                        Last files FRIDAY wrote:{" "}
                        {active.activity.lastFiles.join(", ") || "none yet"}
                      </p>
                      <p>Last generate: {active.activity.lastGenerate || "none"}</p>
                      <p>
                        Last preview URL:{" "}
                        {active.activity.lastPreviewUrl || "none — http(s) opens in FRIDAY Browser"}
                      </p>
                      <p>
                        Last run log:{" "}
                        {active.activity.lastRunLog || detectNote || "none yet — Detect on Runs"}
                      </p>
                      {runtimeHealth.length ? (
                        <ul className="space-y-1">
                          {runtimeHealth.map((row) => (
                            <li key={row.pkg}>
                              {row.pkg}: {row.status}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p>Runtimes: none listed for this kind</p>
                      )}
                      <div className="flex flex-wrap gap-2 pt-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void navigate({ to: "/tasks" })}
                        >
                          Tasks
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void navigate({ to: "/logs" })}
                        >
                          Logs
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void navigate({ to: "/terminal" })}
                        >
                          Terminal
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void navigate({ to: "/sandbox" })}
                        >
                          Sandbox lab
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void navigate({ to: "/workspace" })}
                        >
                          Folders
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void navigate({ to: "/browser" })}
                        >
                          FRIDAY Browser
                        </Button>
                      </div>
                    </div>
                  </HudPanel>
                ) : null}

                {tab === "instructions" ? (
                  <HudPanel title="Work instructions" hint="Chat + Auto must read this">
                    <Textarea
                      value={instructions}
                      onChange={(e) => setInstructions(e.target.value)}
                      placeholder="What to do / what not to do in this project…"
                      className="min-h-[220px] font-mono text-[11px]"
                    />
                    <div className="mt-2">
                      <Button size="sm" onClick={saveActive}>
                        Save instructions
                      </Button>
                    </div>
                  </HudPanel>
                ) : null}

                {tab === "knowledge" ? (
                  <HudPanel title="Scoped knowledge" hint="not a global Brain dump">
                    <div className="mb-3 flex flex-wrap gap-2">
                      <Input
                        value={knowTitle}
                        onChange={(e) => setKnowTitle(e.target.value)}
                        placeholder="Title"
                        className="h-8 max-w-[160px] font-mono text-[11px]"
                      />
                      <Input
                        value={knowText}
                        onChange={(e) => setKnowText(e.target.value)}
                        placeholder="Fact for this project only"
                        className="h-8 min-w-[200px] flex-1 font-mono text-[11px]"
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          if (!knowText.trim()) return;
                          projectWorkspaces.addKnowledge(active.id, {
                            title: knowTitle,
                            text: knowText,
                            useInChat: true,
                          });
                          setKnowTitle("");
                          setKnowText("");
                          setItems(projectWorkspaces.list(true));
                        }}
                      >
                        Add + use in chat
                      </Button>
                    </div>
                    {active.knowledge.length === 0 ? (
                      <p className="font-mono text-[11px] text-muted-foreground">
                        No scoped facts yet.
                      </p>
                    ) : (
                      <ul className="space-y-2 font-mono text-[11px]">
                        {active.knowledge.map((row) => (
                          <li key={row.id} className="rounded-sm border border-border px-2 py-1">
                            <label className="flex items-start gap-2">
                              <input
                                type="checkbox"
                                checked={row.useInChat}
                                onChange={(e) => {
                                  projectWorkspaces.save({
                                    id: active.id,
                                    knowledge: active.knowledge.map((k) =>
                                      k.id === row.id ? { ...k, useInChat: e.target.checked } : k,
                                    ),
                                  });
                                  setItems(projectWorkspaces.list(true));
                                }}
                              />
                              <span>
                                <strong>{row.title}</strong>
                                {row.pinned ? " · pinned" : ""} — {row.text}
                              </span>
                            </label>
                            <button
                              type="button"
                              className="ml-6 text-[10px] text-muted-foreground underline"
                              onClick={() => {
                                projectWorkspaces.save({
                                  id: active.id,
                                  knowledge: active.knowledge.map((k) =>
                                    k.id === row.id ? { ...k, pinned: !k.pinned } : k,
                                  ),
                                });
                                setItems(projectWorkspaces.list(true));
                              }}
                            >
                              {row.pinned ? "Unpin" : "Pin"}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </HudPanel>
                ) : null}

                {tab === "preferences" ? (
                  <HudPanel title="Preferences" hint="project-scoped, not a second user profile">
                    <div className="grid gap-2 sm:grid-cols-2">
                      <label className="font-mono text-[11px]">
                        Kind
                        <select
                          className="mt-1 h-8 w-full rounded-sm border border-border bg-surface px-2"
                          value={kind}
                          onChange={(e) => {
                            const next = e.target.value as ProjectKind;
                            setKind(next);
                            projectWorkspaces.save({
                              id: active.id,
                              kind: next,
                              runtime: defaultRuntimesFor(next),
                            });
                            setItems(projectWorkspaces.list(true));
                          }}
                        >
                          {PROJECT_KINDS.map((key) => (
                            <option key={key} value={key}>
                              {key}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="font-mono text-[11px]">
                        Language
                        <Input
                          value={language}
                          onChange={(e) => setLanguage(e.target.value)}
                          className="mt-1 h-8"
                        />
                      </label>
                      <label className="font-mono text-[11px]">
                        Stack
                        <Input
                          value={stack}
                          onChange={(e) => setStack(e.target.value)}
                          className="mt-1 h-8"
                        />
                      </label>
                      <label className="font-mono text-[11px]">
                        Format
                        <Input
                          value={format}
                          onChange={(e) => setFormat(e.target.value)}
                          className="mt-1 h-8"
                        />
                      </label>
                      <label className="font-mono text-[11px] sm:col-span-2">
                        Model hint
                        <Input
                          value={modelHint}
                          onChange={(e) => setModelHint(e.target.value)}
                          className="mt-1 h-8"
                        />
                      </label>
                      <label className="font-mono text-[11px]">
                        Isolation engine (existing sandbox catalog)
                        <select
                          className="mt-1 h-8 w-full rounded-sm border border-border bg-surface px-2"
                          value={active.isolation || ""}
                          onChange={(e) => {
                            const value = e.target.value;
                            projectWorkspaces.save(
                              value
                                ? {
                                    id: active.id,
                                    isolation: value as (typeof PROJECT_ISOLATION_IDS)[number],
                                  }
                                : { id: active.id, clearIsolation: true },
                            );
                            setItems(projectWorkspaces.list(true));
                          }}
                        >
                          <option value="">none</option>
                          {PROJECT_ISOLATION_IDS.map((key) => (
                            <option key={key} value={key}>
                              {key}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <div className="mt-2">
                      <Button size="sm" onClick={saveActive}>
                        Save preferences
                      </Button>
                    </div>
                  </HudPanel>
                ) : null}

                {tab === "sources" ? (
                  <HudPanel title="Sources" hint="selected rows are the Chat/Auto context pack">
                    <div className="mb-3 flex flex-wrap gap-2">
                      <Input
                        value={sourceLabel}
                        onChange={(e) => setSourceLabel(e.target.value)}
                        placeholder="Label"
                        className="h-8 max-w-[140px] font-mono text-[11px]"
                      />
                      <Input
                        value={sourcePath}
                        onChange={(e) => setSourcePath(e.target.value)}
                        placeholder="Disk path"
                        className="h-8 min-w-[140px] flex-1 font-mono text-[11px]"
                      />
                      <Input
                        value={sourceUrl}
                        onChange={(e) => setSourceUrl(e.target.value)}
                        placeholder="URL"
                        className="h-8 min-w-[140px] flex-1 font-mono text-[11px]"
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          const source: {
                            label: string;
                            selected: boolean;
                            path?: string;
                            url?: string;
                          } = {
                            label: sourceLabel,
                            selected: true,
                          };
                          if (sourcePath.trim()) source.path = sourcePath.trim();
                          if (sourceUrl.trim()) source.url = sourceUrl.trim();
                          projectWorkspaces.addSource(active.id, source);
                          setSourceLabel("");
                          setSourcePath("");
                          setSourceUrl("");
                          setItems(projectWorkspaces.list(true));
                        }}
                      >
                        Add source
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={async () => {
                          if (!desktop) {
                            toast.error("Pick a disk folder is desktop-only.");
                            return;
                          }
                          const picked = await pickProjectFolder();
                          if (!picked) return;
                          projectWorkspaces.addSource(active.id, {
                            label: picked.split(/[\\/]/).filter(Boolean).slice(-1)[0] || "Folder",
                            path: picked,
                            selected: true,
                          });
                          setItems(projectWorkspaces.list(true));
                        }}
                      >
                        Add folder from disk
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          const chosen =
                            libItems.find((item) => item.id === libPick) ||
                            library.pinnedForAuto()[0] ||
                            libItems.find((item) => item.pinnedForAuto);
                          if (!chosen) {
                            toast.error("Pick a Library item, or pin one for Auto Mode first.");
                            return;
                          }
                          if (!chosen.text) void library.fetchText(chosen.id);
                          projectWorkspaces.addSource(active.id, {
                            label: chosen.name,
                            libraryId: chosen.id,
                            selected: true,
                          });
                          projectWorkspaces.refreshLibrarySources(active.id);
                          setItems(projectWorkspaces.list(true));
                          toast.success(`Pinned Library ${chosen.name}.`);
                        }}
                      >
                        Add from Library
                      </Button>
                      {libItems.length ? (
                        <select
                          className="h-8 max-w-[220px] rounded-sm border border-border bg-surface px-2 font-mono text-[11px]"
                          value={libPick}
                          onChange={(e) => setLibPick(e.target.value)}
                        >
                          <option value="">Library item…</option>
                          {libItems.slice(0, 40).map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.name}
                              {item.pinnedForAuto ? " (pinned Auto)" : ""}
                            </option>
                          ))}
                        </select>
                      ) : null}
                    </div>
                    {active.sources.length === 0 ? (
                      <p className="font-mono text-[11px] text-muted-foreground">
                        No sources. Add a path, URL, or Library item.
                      </p>
                    ) : (
                      <ul className="space-y-1 font-mono text-[11px]">
                        {active.sources.map((row) => (
                          <li key={row.id}>
                            <label className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={row.selected}
                                onChange={(e) => {
                                  projectWorkspaces.toggleSource(
                                    active.id,
                                    row.id,
                                    e.target.checked,
                                  );
                                  setItems(projectWorkspaces.list(true));
                                }}
                              />
                              <span>
                                {row.label}
                                {row.libraryId ? ` · library:${row.libraryId}` : ""}
                                {row.path ? ` · ${row.path}` : ""}
                                {row.url ? ` · ${row.url}` : ""}
                              </span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    )}
                  </HudPanel>
                ) : null}

                {tab === "files" ? (
                  <HudPanel
                    title="Files"
                    hint="FRIDAY writes in this project — not an external IDE"
                  >
                    <p className="mb-2 font-mono text-[11px] text-muted-foreground">
                      Last generate: {active.activity.lastGenerate || "none"}. Click a text file to
                      preview source (2 MB cap). HTML is not executed. Not a code-editor clone.
                    </p>
                    <div className="mb-2 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void projectWorkspaces.listFiles(active.id).then(setFiles)}
                      >
                        Refresh listing
                      </Button>
                    </div>
                    {(files.length ? files : active.activity.lastFiles).length === 0 ? (
                      <p className="font-mono text-[11px] text-muted-foreground">
                        No files recorded yet. Ask FRIDAY in Chat to create one here.
                      </p>
                    ) : (
                      <ul className="font-mono text-[11px]">
                        {(files.length ? files : active.activity.lastFiles).map((file) => (
                          <li key={file}>
                            <button
                              type="button"
                              className="text-left underline decoration-dotted"
                              onClick={() => void previewFile(file)}
                            >
                              {file}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    {preview ? (
                      <div className="mt-3">
                        <p className="font-mono text-[10px] text-muted-foreground">
                          {preview.name}
                        </p>
                        {preview.error ? (
                          <p className="font-mono text-[11px] text-warning">{preview.error}</p>
                        ) : null}
                        {preview.content ? (
                          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-sm border border-border bg-background p-2 text-[10px]">
                            {preview.content.slice(0, 20_000)}
                          </pre>
                        ) : null}
                      </div>
                    ) : null}
                  </HudPanel>
                ) : null}

                {tab === "chat" ? (
                  <HudPanel title="Chat" hint="same brain.send — project extra injected">
                    <Textarea
                      value={ask}
                      onChange={(e) => setAsk(e.target.value)}
                      placeholder="Ask FRIDAY to build or edit in this project…"
                      className="min-h-[90px] font-mono text-[11px]"
                    />
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button size="sm" onClick={onAsk}>
                        Ask FRIDAY
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          sendChat(
                            `Summarise instructions and selected sources for ${active.name}.`,
                          )
                        }
                      >
                        Summarise context
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void navigate({ to: "/" })}
                      >
                        Open Friday (Main Window)
                      </Button>
                    </div>
                    <ul className="mt-3 space-y-2 font-mono text-[11px]">
                      {thread.length === 0 ? (
                        <li className="text-muted-foreground">
                          Same Chat store as the main window. Replies appear here after you Ask
                          FRIDAY.
                        </li>
                      ) : (
                        thread.map((msg) => (
                          <li key={msg.id} className="rounded-sm border border-border px-2 py-1">
                            <strong>{msg.role}</strong> — {msg.text.slice(0, 400)}
                          </li>
                        ))
                      )}
                    </ul>
                  </HudPanel>
                ) : null}

                {tab === "preview" ? (
                  <HudPanel title="Preview" hint="reuse FRIDAY Browser — no second Chromium">
                    <p className="font-mono text-[11px] text-muted-foreground">
                      In-panel Chromium iframe and APK emulator are not built (Phase 2 refused).
                      Local text/HTML is source-only in Files. A selected http(s) source opens in
                      FRIDAY Browser.
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void navigate({ to: "/browser" })}
                      >
                        Open FRIDAY Browser
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          const url =
                            active.activity.lastPreviewUrl ||
                            active.sources.find(
                              (row) => row.selected && row.url && /^https?:\/\//i.test(row.url),
                            )?.url;
                          if (!url) {
                            toast.error(
                              "No preview URL yet. Add an http(s) source or wait until a local URL exists.",
                            );
                            return;
                          }
                          if (!desktop) {
                            toast.error(
                              "FRIDAY Browser preview is desktop-only — same honesty as Sandbox.",
                            );
                            return;
                          }
                          void sendBrowserCommand({ action: "newTab", url }).then((result) => {
                            if (!result.ok)
                              toast.error(result.error || "FRIDAY Browser is not open yet.");
                            else {
                              projectWorkspaces.save({
                                id: active.id,
                                activity: {
                                  ...active.activity,
                                  lastPreviewUrl: url,
                                  updatedAt: activityUpdatedAt(),
                                },
                              });
                              toast.success("Opened in FRIDAY Browser.");
                            }
                          });
                          void navigate({ to: "/browser" });
                        }}
                      >
                        Preview URL in Browser
                      </Button>
                    </div>
                  </HudPanel>
                ) : null}

                {tab === "runs" ? (
                  <HudPanel title="Runs" hint="Terminal / kernel detect — not a second runner">
                    <p className="font-mono text-[11px] text-muted-foreground">
                      Detect uses the file listing plus kernel project.detect (FRIDAY_ROOT
                      children). Run stays Terminal after you ask. APK/EXE: missing SDK → Install
                      Manager; no unsigned EXE auto-exec; no pretend emulator.
                    </p>
                    {detectNote || active.activity.lastRunLog ? (
                      <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-sm border border-border bg-background p-2 font-mono text-[10px]">
                        {detectNote || active.activity.lastRunLog}
                      </pre>
                    ) : null}
                    <ul className="mt-2 space-y-1 font-mono text-[11px]">
                      {runtimeHealth.length === 0 ? (
                        <li>Runtimes: none listed</li>
                      ) : (
                        runtimeHealth.map((row) => (
                          <li key={row.pkg}>
                            {row.pkg}: {row.status}
                          </li>
                        ))
                      )}
                    </ul>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" onClick={() => void detectProject()}>
                        Detect this folder
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => void openTerminalHere()}>
                        Open Terminal here
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void navigate({ to: "/terminal" })}
                      >
                        Open Terminal
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void navigate({ to: "/sandbox" })}
                      >
                        Open Sandbox
                      </Button>
                      <Button size="sm" variant="outline" onClick={installRequired}>
                        Install required for this project
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void navigate({ to: "/doctor" })}
                      >
                        Doctor: this project&apos;s tools
                      </Button>
                    </div>
                  </HudPanel>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
