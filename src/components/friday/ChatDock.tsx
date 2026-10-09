import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ArrowRight,
  Boxes,
  Briefcase,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  Download,
  FileSearch,
  Library,
  MessageSquarePlus,
  Mic,
  Paperclip,
  Pencil,
  Plug,
  RotateCcw,
  Save,
  Search,
  Send,
  Slash,
  Sparkle,
  Square,
  Trash2,
  Wrench,
  Workflow,
  Blocks,
  History,
  Link2,
  Plus,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { brain, type Message } from "@/lib/friday/brain-engine";
import { TurnTrace } from "@/components/friday/TurnTrace";
import { useBrain } from "@/lib/friday/use-brain";
import { models } from "@/lib/friday/models-engine";
import { useModels } from "@/lib/friday/use-models";
import {
  modelRegistry,
  groupModels,
  conversationEngineLabel,
  ROUTE_MODES,
  ROUTE_MODE_LABELS,
  ROUTE_MODE_HINTS,
  MODES_NEEDING_PICKS,
} from "@/lib/friday/model-registry";
import { useModelRegistry } from "@/lib/friday/use-model-registry";
import { refreshWorkspaceScan, useWorkspaceScan } from "@/lib/friday/desktop";
import { composer } from "@/lib/friday/composer";
import {
  buildCapabilityGroups,
  flatten,
  suggestCapabilities,
  type Capability,
  type CapabilityKind,
} from "@/lib/friday/capabilities";
import {
  attachmentDirective,
  formatBytes,
  readAttachments,
  type Attachment,
} from "@/lib/friday/attachments";
import {
  armDiagramExplanation,
  clearDiagramExplanation,
  enrichDiagramOcr,
  readAttachmentDiagrams,
} from "@/lib/friday/flow-diagram";
import { flowStudio } from "@/lib/friday/flow-studio-store";
import { useNavigate } from "@tanstack/react-router";
import { mergeTurnExtra, turnAwarenessExtra } from "@/lib/friday/turn-awareness";
import { library, looksLikeLibraryTeach, shouldAutoTeach } from "@/lib/friday/library-engine";
import { projectWorkspaces } from "@/lib/friday/project-workspace-engine";
import { isSheetName } from "@/lib/friday/library-logic";

import { cn } from "@/lib/utils";
import { copyText } from "@/lib/friday/clipboard";
import { readLocalState, writeState } from "@/lib/friday/persist";
import { usePreferences } from "@/lib/friday/use-preferences";
import { formatOwnerDate } from "@/lib/friday/settings-runtime";
/**
 * Compact conversation + chat, docked directly under the FRIDAY graphic.
 *
 * Everything lives in one panel: a short conversation preview that can be
 * expanded, all chat controls tucked into two dropdowns, and a fixed input at
 * the bottom of the main window. Nothing polls — the transcript re-renders
 * only when the brain store emits.
 */

const SESSION_KEY = "friday.chat.sessions.v1";

type Session = { id: string; title: string; at: number; messages: Message[] };

const COMMANDS = [
  { cmd: "/plan ", label: "Plan a goal step by step" },
  { cmd: "/code ", label: "Write or refactor code" },
  { cmd: "/research ", label: "Research a topic" },
  { cmd: "/explain ", label: "Explain something" },
  { cmd: "/remember ", label: "Save to long-term memory" },
  { cmd: "/status", label: "Report system status" },
];

/** Icon per capability group (the groups themselves are built from real state). */
const GROUP_ICONS: Record<CapabilityKind, typeof Boxes> = {
  models: Boxes,
  modules: Blocks,
  tools: Wrench,
  workflows: Workflow,
  skills: Sparkle,
  plugins: Plug,
  agents: Sparkle,
  connectors: Link2,
};

function readSessions(): Session[] {
  if (typeof window === "undefined") return [];
  return readLocalState<Session[]>(SESSION_KEY) ?? [];
}

function writeSessions(list: Session[]) {
  writeState(SESSION_KEY, list.slice(0, 40));
}

/**
 * Local / cloud / auto / manual / multi picker plus the installed-only
 * toggle. Both model menus render the same block, and every choice goes
 * straight to the one authoritative router in the main process.
 */
function RouteModeControls({
  mode,
  showAll,
  hidden,
  picks,
}: {
  mode: string;
  showAll: boolean;
  hidden: number;
  picks: number;
}) {
  return (
    <>
      <DropdownMenuLabel className="text-[10px] uppercase text-muted-foreground">
        Routing mode
      </DropdownMenuLabel>
      {ROUTE_MODES.map((m) => (
        <DropdownMenuCheckboxItem
          key={m}
          checked={mode === m}
          onCheckedChange={() => void modelRegistry.setRouteMode(m)}
          onSelect={(e) => e.preventDefault()}
        >
          <span className="truncate">{ROUTE_MODE_LABELS[m]}</span>
          <span className="ml-auto font-mono text-[9px] text-muted-foreground">
            {ROUTE_MODE_HINTS[m]}
          </span>
        </DropdownMenuCheckboxItem>
      ))}
      {MODES_NEEDING_PICKS.has(mode as (typeof ROUTE_MODES)[number]) && picks === 0 ? (
        <DropdownMenuLabel className="text-[10px] font-normal text-amber-400">
          Pick {mode === "multi" ? "one or more models" : "a model"} below — this mode runs only on
          your choice.
        </DropdownMenuLabel>
      ) : null}
      <DropdownMenuSeparator />
      <DropdownMenuCheckboxItem
        checked={showAll}
        onCheckedChange={(next) => modelRegistry.setShowAll(Boolean(next))}
        onSelect={(e) => e.preventDefault()}
      >
        <span className="truncate">Show every catalog model</span>
        {hidden > 0 ? (
          <span className="ml-auto font-mono text-[9px] text-muted-foreground">+{hidden}</span>
        ) : null}
      </DropdownMenuCheckboxItem>
      <DropdownMenuSeparator />
    </>
  );
}

export function ChatDock() {
  const state = useBrain();
  const modelsState = useModels();
  const registry = useModelRegistry();
  const prefs = usePreferences();
  const bubbleStyle = prefs.fields["bubbleStyle"] ?? "Compact";
  const showTimestamps = prefs.toggles["chatTimestamps"] === true;
  const userBubbleClass =
    bubbleStyle === "Full"
      ? "max-w-[95%] rounded-md bg-primary px-3.5 py-2.5 text-sm text-primary-foreground"
      : bubbleStyle === "Comfortable"
        ? "max-w-[88%] rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground"
        : "max-w-[80%] rounded-md bg-primary px-2.5 py-1.5 text-xs text-primary-foreground";
  // Keep keystrokes out of React state. This dock renders the transcript plus
  // every model/capability menu; controlling the textarea from here made each
  // character rebuild that entire tree and could stall packaged Electron on
  // slower Windows machines. React only needs to know when it is empty so the
  // Send button can update once, not once per character.
  const [hasInput, setHasInput] = useState(false);
  /** Debounced copy of the draft — only used to compute suggestions. */
  const [draft, setDraft] = useState("");

  const [files, setFiles] = useState<Attachment[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [sessions, setSessions] = useState<Session[]>(() => readSessions());
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Capability catalog built from what really exists: the models engine and
  // the workspace scan (skills, plugins, agents, workflows, modules, tools).
  const scan = useWorkspaceScan();
  const groups = useMemo(() => buildCapabilityGroups(modelsState, scan), [modelsState, scan]);
  const live = useMemo(() => flatten(groups), [groups]);
  // Attachments live in the shared composer store, so voice turns in Auto Mode
  // carry the same context as typed turns and selections survive restarts.
  const attached = useSyncExternalStore(
    composer.subscribe,
    composer.getSnapshot,
    composer.getSnapshot,
  );
  const attachedIds = useMemo(() => attached.map((c) => c.id), [attached]);
  // A capability that disappeared (model removed, plugin uninstalled) drops
  // itself the moment the live catalog changes.
  useEffect(() => {
    if (live.length) composer.reconcile(live);
  }, [live]);
  const modelGroup = useMemo(() => groups.find((g) => g.kind === "models") ?? null, [groups]);
  const capabilityGroups = useMemo(() => groups.filter((g) => g.kind !== "models"), [groups]);
  const attachedCapabilityCount = attached.filter((c) => c.kind !== "models").length;
  const attachedModelCount = attached.filter((c) => c.kind === "models").length;

  const navigate = useNavigate();
  const [libraryItems, setLibraryItems] = useState(() => library.list());
  const [projectsList, setProjectsList] = useState(() => projectWorkspaces.list());
  const [activeProjectId, setActiveProjectId] = useState(() => projectWorkspaces.activeId());
  const activeProject = useMemo(
    () => projectsList.find((p) => p.id === activeProjectId) ?? null,
    [projectsList, activeProjectId],
  );

  useEffect(() => {
    return library.subscribe(() => setLibraryItems(library.list()));
  }, []);

  useEffect(() => {
    return projectWorkspaces.subscribe(() => {
      setProjectsList(projectWorkspaces.list());
      setActiveProjectId(projectWorkspaces.activeId());
    });
  }, []);
  // Suggestions read a debounced copy of the draft, so typing never re-renders
  // the transcript on every keystroke.
  const suggestions = useMemo(
    () => suggestCapabilities(draft, groups, attachedIds),
    [draft, groups, attachedIds],
  );
  const busy = Boolean(state.activeRunId);
  const liveRun = state.runs.find((run) => run.id === state.activeRunId) ?? state.runs[0] ?? null;
  const executeDetail = liveRun?.stages.find((stage) => stage.id === "execute")?.detail ?? "";
  const statusLabel = !busy
    ? `${state.messages.length} messages`
    : executeDetail.startsWith("Checking")
      ? executeDetail
      : "streaming…";
  const answeredLine = liveRun?.answeredBy?.line;
  const turnOpen = Boolean(busy && liveRun && state.activeRunId === liveRun.id && !answeredLine);
  const drafting = hasInput && !busy;
  const showUsed = Boolean(answeredLine && !turnOpen && !drafting);
  const engineLabel = conversationEngineLabel({
    routeMode: registry.routeMode,
    selected: registry.selected,
    models: registry.models,
    liveLabel: answeredLine || undefined,
    phase: showUsed ? "used" : "will",
  });
  const stripRunId = state.activeRunId || liveRun?.id || "";
  const stripBadge = showUsed ? liveRun?.answeredBy?.badge : "";
  // Installed / reachable models only by default — the same rule the /models
  // page's "Installed" tab applies. "Show every catalog model" opens it up.
  const [modelQuery, setModelQuery] = useState("");
  const registryGroups = useMemo(() => {
    const groups = groupModels(registry.models, registry.showAll);
    const query = modelQuery.trim().toLowerCase();
    if (!query) return groups;
    return groups
      .map((group) => ({
        ...group,
        models: group.models.filter((model) =>
          `${model.choiceLabel || model.label} ${model.providerName || ""} ${(model.marks || []).join(" ")}`
            .toLowerCase()
            .includes(query),
        ),
      }))
      .filter((group) => group.models.length > 0);
  }, [registry.models, registry.showAll, modelQuery]);
  const selectableCount = useMemo(
    () =>
      groupModels(registry.models, registry.showAll).reduce(
        (count, group) => count + group.models.length,
        0,
      ),
    [registry.models, registry.showAll],
  );
  const hiddenModelCount = registry.showAll
    ? 0
    : registry.models.length - registry.models.filter((m) => m.available).length;

  // Typing is live the moment FRIDAY opens — no click needed. Focus is taken
  // once after the first paint, and once more only if the OS window gains
  // focus later (Electron activation can swallow the first attempt). No
  // timers, no polling, and never while another field is in use.
  useEffect(() => {
    const grab = () => {
      const el = inputRef.current;
      if (!el) return;
      const active = document.activeElement;
      const busyElsewhere =
        active instanceof HTMLElement &&
        active !== document.body &&
        active !== el &&
        (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName));
      if (!busyElsewhere) el.focus({ preventScroll: true });
    };
    const raf = window.requestAnimationFrame(grab);
    window.addEventListener("focus", grab, { once: true });
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("focus", grab);
    };
  }, []);

  // Keep the newest message in view without re-rendering on a timer.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.messages, expanded, state.activeRunId, state.runs]);

  const byId = useMemo(() => new Map(live.map((c) => [c.id, c] as const)), [live]);
  const toggle = (id: string) => {
    const cap =
      byId.get(id) ??
      attached.find((c) => c.id === id) ??
      ({
        id,
        kind: (id.split(":")[0] as CapabilityKind) ?? "tools",
        group: id.split(":")[0] ?? "tool",
        name: id.split(":").slice(1).join(":") || id,
        live: false,
      } satisfies Capability);
    composer.toggle(cap);
  };
  const detach = (id: string) => composer.detach(id);

  // Debounce the draft used for suggestions: keystrokes stay out of the
  // transcript render path, suggestions refresh a quarter second later.
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noteDraft = (value: string) => {
    setHasInput(Boolean(value.trim()));
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => setDraft(value), 250);
  };
  useEffect(
    () => () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    },
    [],
  );

  const send = () => {
    const typed = inputRef.current?.value.trim() ?? "";
    const text = typed || (files.length ? "Analyse the attached file(s)." : "");
    if (!text || busy) return;
    // Attached capabilities become a real instruction block plus concrete
    // model ids for this turn, not a cosmetic "[context: …]" suffix.
    // Explicit picks from the model menu pin this turn; empty = Auto, and the
    // free-first router chooses (and falls back on 429/quota) on its own.
    const { extra, modelIds: pinned } = composer.directive();
    const diagramFiles = files;
    const diagramOptions = {
      cloudAllowed: registry.routeMode === "cloud-only" || registry.routeMode === "hybrid",
      ownerOptIn: registry.routeMode === "cloud-only",
      question: typed || "explain this",
    };
    const diagram = readAttachmentDiagrams(diagramFiles, diagramOptions);
    if (diagram?.graph) flowStudio.openBoard(diagram.graph, "chart");
    if (diagram?.uncertain.length) {
      void enrichDiagramOcr(diagramFiles, diagramOptions).then((enriched) => {
        if (!enriched?.graph) return;
        const board = flowStudio.getSnapshot().board;
        if (board?.id !== "diagram-image" && board?.id !== "diagram-unread") return;
        flowStudio.openBoard(enriched.graph, "chart");
        if (!typed && enriched.explanation) armDiagramExplanation(enriched.explanation);
      });
    }
    if (diagram?.explanation && !typed) armDiagramExplanation(diagram.explanation);
    else clearDiagramExplanation();
    // Attached files carry their actual extracted content into the turn.
    const fileBlock = attachmentDirective(files);
    const teachNotes: string[] = [];
    const libraryIds = files.map((item) => item.libraryId).filter(Boolean) as string[];
    for (const item of files) {
      if (item.libraryId && isSheetName(item.name)) {
        const books = library.importSheetIfBooks(item.libraryId);
        if (books?.imported) teachNotes.push(books.note);
      }
    }
    if (libraryIds.length && (looksLikeLibraryTeach(typed) || shouldAutoTeach())) {
      const taught = library.teachMany(
        libraryIds,
        looksLikeLibraryTeach(typed) ? "teach" : "chat-learn",
      );
      teachNotes.push(...taught.notes);
    }
    const combined = mergeTurnExtra(
      extra,
      fileBlock.extra,
      teachNotes.join("\n"),
      turnAwarenessExtra(text, { kind: "typed", forceLibrary: libraryIds.length > 0 }),
    );
    const sent = brain.send(text, {
      ...(combined ? { extra: combined } : {}),
      ...(pinned.length ? { modelIds: pinned } : {}),
      routeMode: registry.routeMode,
      routingSurface: "chat",
    });
    if (!sent.accepted) {
      clearDiagramExplanation();
      return;
    }

    if (draftTimer.current) {
      clearTimeout(draftTimer.current);
      draftTimer.current = null;
    }
    if (inputRef.current) inputRef.current.value = "";
    setHasInput(false);
    setDraft("");
    setFiles([]);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  };

  const insertCommand = (command: string) => {
    const textarea = inputRef.current;
    if (!textarea) return;
    textarea.value = command + textarea.value;
    setHasInput(Boolean(textarea.value.trim()));
    window.requestAnimationFrame(() => {
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
  };

  const transcript = () =>
    state.messages.map((m) => `${m.role === "user" ? "YOU" : "FRIDAY"}: ${m.text}`).join("\n\n");

  const download = (ext: "md" | "json") => {
    const body =
      ext === "json" ? JSON.stringify(state.messages, null, 2) : `# FRIDAY chat\n\n${transcript()}`;
    const url = URL.createObjectURL(new Blob([body], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `friday-chat-${Date.now()}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const persist = (next: Session[]) => {
    setSessions(next);
    writeSessions(next);
  };

  const saveChat = () => {
    if (!state.messages.length) return;
    const first = state.messages.find((m) => m.role === "user")?.text ?? "Conversation";
    persist([
      {
        id: `s-${Date.now()}`,
        title: first.slice(0, 40),
        at: Date.now(),
        messages: state.messages,
      },
      ...sessions,
    ]);
  };

  const renameChat = (id: string) => {
    const s = sessions.find((x) => x.id === id);
    if (!s) return;
    const title = window.prompt("Rename chat", s.title);
    if (!title) return;
    persist(sessions.map((x) => (x.id === id ? { ...x, title } : x)));
  };

  const appendTranscript = (text: string) => {
    const value = text.trim();
    const textarea = inputRef.current;
    if (!value || !textarea) return;
    textarea.value = textarea.value ? `${textarea.value} ${value}` : value;
    setHasInput(Boolean(textarea.value.trim()));
  };

  const visible = useMemo(() => {
    const list = query.trim()
      ? state.messages.filter((m) => m.text.toLowerCase().includes(query.toLowerCase()))
      : state.messages;
    return expanded || query.trim() ? list : list.slice(-4);
  }, [state.messages, query, expanded]);

  return (
    <section className="friday-interactive-region hud-panel relative flex shrink-0 flex-col overflow-hidden rounded-lg rounded-t-none border-t border-primary/20">
      {/* Controls row — everything compact, inside the chat area */}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-primary/10 px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              busy ? "bg-warning pulse-dot" : "bg-accent shadow-[0_0_8px_var(--color-accent)]",
            )}
          />
          <h2 className="label-xs shrink-0 text-primary glow-text">Conversation</h2>
          <span className="truncate font-mono text-[10px] text-muted-foreground">
            {statusLabel}
            {engineLabel ? ` · ${engineLabel}` : ""}
            {stripBadge ? ` · ${stripBadge}` : ""}
          </span>
          {stripRunId ? <TurnTrace runId={stripRunId} /> : null}
        </div>

        <div className="flex min-w-0 flex-wrap items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            onClick={() => setSearching((s) => !s)}
            title="Search conversation"
          >
            <Search className="size-3.5" />
          </Button>

          {/* Chat history / switch */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 gap-1 px-2" title="Chat history">
                <History className="size-3.5" />
                <ChevronDown className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-72 w-64 overflow-y-auto">
              <DropdownMenuLabel>Saved chats</DropdownMenuLabel>
              {sessions.length === 0 ? (
                <DropdownMenuItem disabled>No saved chats yet</DropdownMenuItem>
              ) : (
                sessions.map((s) => (
                  <DropdownMenuSub key={s.id}>
                    <DropdownMenuSubTrigger>
                      <span className="truncate">{s.title}</span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      <DropdownMenuItem onSelect={() => brain.loadConversation(s.messages)}>
                        <MessageSquarePlus className="size-4" /> Switch to this chat
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => renameChat(s.id)}>
                        <Pencil className="size-4" /> Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive"
                        onSelect={() => persist(sessions.filter((x) => x.id !== s.id))}
                      >
                        <Trash2 className="size-4" /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                ))
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Chat actions */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-7 gap-1 px-2 text-[11px]">
                Actions <ChevronDown className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onSelect={() => brain.clearChat()}>
                <MessageSquarePlus className="size-4" /> New chat
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={saveChat}>
                <Save className="size-4" /> Save chat
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => download("md")}>
                <Download className="size-4" /> Export as Markdown
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => download("json")}>
                <Download className="size-4" /> Export as JSON
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void copyText(transcript())}>
                <Copy className="size-4" /> Copy transcript
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => brain.regenerate()} disabled={busy}>
                <RotateCcw className="size-4" /> Regenerate
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive" onSelect={() => brain.clearChat()}>
                <Trash2 className="size-4" /> Delete chat
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            onClick={() => setExpanded((e) => !e)}
            title={expanded ? "Collapse conversation" : "Expand conversation"}
          >
            {expanded ? (
              <ChevronsDownUp className="size-3.5" />
            ) : (
              <ChevronsUpDown className="size-3.5" />
            )}
          </Button>
        </div>
      </div>

      {searching ? (
        <div className="border-b border-primary/10 px-3 py-1.5">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search this conversation…"
            className="h-7 border-primary/25 bg-surface font-mono text-xs"
          />
        </div>
      ) : null}

      {/* Compact conversation preview */}
      <div
        ref={scrollRef}
        className={cn(
          "space-y-2 overflow-y-auto px-3 py-2 text-sm transition-[max-height] duration-200",
          expanded ? "max-h-[18rem]" : "max-h-[7.5rem]",
        )}
      >
        {visible.length === 0 ? (
          <p className="py-3 text-center font-mono text-[11px] text-muted-foreground">
            {query.trim()
              ? "No messages match that search."
              : "FRIDAY is online. Ask anything — attach models, tools, skills or plugins below."}
          </p>
        ) : null}
        {visible.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="flex justify-end">
              <div className="max-w-[95%] text-right">
                <p className={userBubbleClass}>{m.text}</p>
                {showTimestamps ? (
                  <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                    {formatOwnerDate(m.at)}
                  </p>
                ) : null}
              </div>
            </div>
          ) : (
            <div key={m.id} className="max-w-[92%]">
              <p className="label-xs mb-0.5 text-[9px] text-primary">
                FRIDAY
                {showTimestamps ? (
                  <span className="ml-2 font-mono text-muted-foreground">
                    {formatOwnerDate(m.at)}
                  </span>
                ) : null}
              </p>
              {m.text ? (
                <pre className="whitespace-pre-wrap font-sans text-xs leading-relaxed text-muted-foreground">
                  {m.text}
                </pre>
              ) : null}
            </div>
          ),
        )}
      </div>

      {state.approval ? (
        <div className="mx-3 mb-2 rounded-md border border-warning/40 bg-warning/8 px-2.5 py-1.5">
          <p className="text-[11px] text-foreground">
            Approval needed for{" "}
            <span className="font-mono text-warning">{state.approval.tool}</span> (
            {state.approval.risk})
          </p>
          <div className="mt-1.5 flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-6 text-[11px]"
              onClick={() => brain.approve(false)}
            >
              Deny
            </Button>
            <Button size="sm" className="h-6 text-[11px]" onClick={() => brain.approve(true)}>
              Allow once
            </Button>
          </div>
        </div>
      ) : null}

      {/* Fixed input at the bottom of the main window */}
      <div className="border-t border-primary/15 p-2">
        <Textarea
          ref={inputRef}
          defaultValue=""
          onChange={(e) => noteDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="Type your message…"
          className="min-h-11 resize-none border-primary/25 bg-surface font-mono text-sm cursor-text"
        />

        {/* Related capabilities FRIDAY suggests for what is being typed. */}
        {suggestions.length && !busy ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
              suggested
            </span>
            {suggestions.map((s) => (
              <button
                key={s.id}
                type="button"
                title={s.detail ? `${s.group} · ${s.detail}` : s.group}
                onClick={() => toggle(s.id)}
                className="flex items-center gap-1 rounded-sm border border-primary/25 bg-surface px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground transition-colors hover:border-primary/60 hover:text-primary"
              >
                <Plus className="size-2.5" />
                {s.name}
              </button>
            ))}
          </div>
        ) : null}

        {/* Attached capabilities and files — each removable right here. */}
        {attached.length || files.length ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {files.map((f) => (
              <span
                key={f.id}
                title={f.error ? `${f.name} — ${f.error}` : `${f.name} · ${formatBytes(f.size)}`}
                className={cn(
                  "flex items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-[9px]",
                  f.error
                    ? "border-destructive/40 bg-destructive/10 text-destructive"
                    : "border-primary/30 bg-primary/10 text-primary",
                )}
              >
                {f.name}
                <span className="text-[8px] opacity-70">{formatBytes(f.size)}</span>
                <button
                  type="button"
                  aria-label={`Remove ${f.name}`}
                  onClick={() => setFiles((list) => list.filter((x) => x.id !== f.id))}
                  className="text-primary/70 hover:text-primary"
                >
                  <X className="size-2.5" />
                </button>
              </span>
            ))}

            {attached.map((cap) => (
              <span
                key={cap.id}
                title={cap.detail ? `${cap.group} · ${cap.detail}` : cap.group}
                className="flex items-center gap-1 rounded-sm border border-primary/30 bg-primary/10 px-1.5 py-0.5 font-mono text-[9px] text-primary"
              >
                <span className="text-primary/60">{cap.group}</span>
                {cap.name}
                <button
                  type="button"
                  aria-label={`Remove ${cap.name}`}
                  onClick={() => detach(cap.id)}
                  className="text-primary/70 hover:text-primary"
                >
                  <X className="size-2.5" />
                </button>
              </span>
            ))}
            {attached.length > 1 ? (
              <button
                type="button"
                onClick={() => composer.clear()}
                className="rounded-sm px-1 font-mono text-[9px] text-muted-foreground hover:text-primary"
              >
                clear all
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="mt-1.5 flex min-w-0 flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            {/* Attach — files only */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-7 gap-1 px-2 text-[11px]">
                  <Paperclip className="size-3.5" /> Attach
                  {files.length ? (
                    <span className="rounded-sm bg-primary/20 px-1 font-mono text-[9px] text-primary">
                      {files.length}
                    </span>
                  ) : null}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuLabel>Attachments</DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => fileRef.current?.click()}>
                  <Paperclip className="size-4" /> Attach files…
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    void navigator.clipboard
                      ?.readText?.()
                      .then((text) => text && appendTranscript(text))
                      .catch(() => undefined);
                  }}
                >
                  <Copy className="size-4" /> Paste from clipboard
                </DropdownMenuItem>
                {files.length ? (
                  <>
                    <DropdownMenuSeparator />
                    {files.map((f) => (
                      <DropdownMenuItem
                        key={f.id}
                        onSelect={() => setFiles((list) => list.filter((x) => x.id !== f.id))}
                      >
                        <X className="size-4" />
                        <span className="truncate">{f.name}</span>
                        <span className="ml-auto font-mono text-[9px] text-muted-foreground">
                          {formatBytes(f.size)}
                        </span>
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuItem onSelect={() => setFiles([])}>
                      <Trash2 className="size-4" /> Remove all files
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Capabilities — skills, agents, tools, workflows, modules, plugins */}
            <DropdownMenu
              onOpenChange={(open) => {
                // Anything installed since the menu was last opened shows up now.
                if (open) void refreshWorkspaceScan(true);
              }}
            >
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-7 gap-1 px-2 text-[11px]">
                  <Blocks className="size-3.5" /> Capabilities
                  {attachedCapabilityCount ? (
                    <span className="rounded-sm bg-primary/20 px-1 font-mono text-[9px] text-primary">
                      {attachedCapabilityCount}
                    </span>
                  ) : null}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-60">
                <DropdownMenuLabel>Select capabilities</DropdownMenuLabel>
                {capabilityGroups.map((g) => {
                  const Icon = GROUP_ICONS[g.kind];
                  const count = g.items.filter((item) => attachedIds.includes(item.id)).length;
                  return (
                    <DropdownMenuSub key={g.kind}>
                      <DropdownMenuSubTrigger>
                        <Icon className="size-4" /> {g.label}
                        <span className="ml-auto font-mono text-[9px] text-muted-foreground">
                          {count ? `${count}/${g.items.length}` : g.items.length}
                        </span>
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
                        {g.items.length === 0 ? (
                          <DropdownMenuItem disabled>Nothing installed yet</DropdownMenuItem>
                        ) : null}
                        {g.items.map((item) => (
                          <DropdownMenuCheckboxItem
                            key={item.id}
                            checked={attachedIds.includes(item.id)}
                            onCheckedChange={() => toggle(item.id)}
                            onSelect={(e) => e.preventDefault()}
                          >
                            <span className="truncate">{item.name}</span>
                            {item.detail ? (
                              <span className="ml-2 truncate font-mono text-[9px] text-muted-foreground">
                                {item.detail}
                              </span>
                            ) : null}
                          </DropdownMenuCheckboxItem>
                        ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  );
                })}
                {attachedCapabilityCount ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={() =>
                        attached
                          .filter((c) => c.kind !== "models")
                          .forEach((c) => composer.detach(c.id))
                      }
                    >
                      <Trash2 className="size-4" /> Clear capabilities
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Models — unified selection: default brain routing + per-turn pinned overrides */}
            <DropdownMenu
              onOpenChange={(open) => {
                if (open) void modelRegistry.refresh();
              }}
            >
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 px-2 text-[11px]"
                  title="Model selection and routing"
                >
                  <Boxes className="size-3.5" /> Models
                  {attachedModelCount || registry.selected.length ? (
                    <span className="rounded-sm bg-primary/20 px-1 font-mono text-[9px] text-primary">
                      {attachedModelCount + registry.selected.length}
                    </span>
                  ) : null}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-80 w-64 overflow-y-auto">
                <RouteModeControls
                  mode={registry.routeMode}
                  showAll={registry.showAll}
                  hidden={hiddenModelCount}
                  picks={registry.selected.length}
                />

                {/* Sub-section 1: Default brain routing (persistent) */}
                <div className="px-2 py-1">
                  <div className="flex items-center justify-between text-[10px] font-bold uppercase text-muted-foreground">
                    <span>Default Brain</span>
                    <span className="font-mono text-[9px] font-normal lowercase">
                      {registry.selected.length ? `${registry.selected.length} picked` : "auto"}
                    </span>
                  </div>
                  <div className="text-[9px] text-muted-foreground">
                    Persistent routing for all turns
                  </div>
                </div>

                <DropdownMenuCheckboxItem
                  checked={registry.selected.length === 0}
                  onCheckedChange={() => modelRegistry.clearSelection()}
                  onSelect={(e) => e.preventDefault()}
                >
                  <span className="truncate">Auto</span>
                  <span className="ml-auto font-mono text-[9px] text-muted-foreground">
                    {registry.policy}
                  </span>
                </DropdownMenuCheckboxItem>
                {selectableCount > 8 ? (
                  <div className="px-2 py-1">
                    <Input
                      value={modelQuery}
                      onChange={(event) => setModelQuery(event.target.value)}
                      onKeyDown={(event) => event.stopPropagation()}
                      placeholder="Search models"
                      className="h-7 text-[11px]"
                    />
                  </div>
                ) : null}
                {registryGroups.map((group) => (
                  <div key={group.label}>
                    <DropdownMenuLabel className="text-[10px] uppercase text-muted-foreground">
                      {group.label}
                    </DropdownMenuLabel>
                    {group.models.map((m) => (
                      <DropdownMenuCheckboxItem
                        key={m.id}
                        checked={registry.selected.includes(m.id)}
                        disabled={
                          m.visibility === "disabled" || (m.visibility == null && !m.eligible)
                        }
                        onCheckedChange={() => modelRegistry.toggle(m.id)}
                        onSelect={(e) => e.preventDefault()}
                      >
                        <span className="truncate">{m.choiceLabel || m.label}</span>
                        <span className="ml-2 shrink-0 font-mono text-[9px] text-muted-foreground">
                          {m.badge || (m.type === "local" ? "LOCAL" : "")}
                          {m.marks?.length ? ` · ${m.marks.join(", ")}` : ""}
                        </span>
                        {m.disabledReason ? (
                          <span className="ml-auto shrink-0 font-mono text-[9px] text-muted-foreground">
                            {m.disabledReason}
                          </span>
                        ) : null}
                      </DropdownMenuCheckboxItem>
                    ))}
                  </div>
                ))}
                {registry.hint ? (
                  <DropdownMenuLabel className="text-[10px] font-normal normal-case text-muted-foreground">
                    {registry.hint}
                  </DropdownMenuLabel>
                ) : null}
                {!registry.loading && !registryGroups.length ? (
                  <DropdownMenuLabel className="text-[10px] font-normal text-muted-foreground">
                    {registry.error ?? "No models detected yet — install Ollama or add an API key."}
                  </DropdownMenuLabel>
                ) : null}

                {/* Sub-section 2: Just for this message (per-turn override) */}
                <DropdownMenuSeparator />
                <div className="px-2 py-1">
                  <div className="flex items-center justify-between text-[10px] font-bold uppercase text-muted-foreground">
                    <span>Just for this message</span>
                    <span className="font-mono text-[9px] font-normal lowercase">
                      {attachedModelCount ? `${attachedModelCount} pinned` : "none"}
                    </span>
                  </div>
                  <div className="text-[9px] text-muted-foreground">
                    Pin models to the composer for this turn only
                  </div>
                </div>
                {modelGroup?.items.length ? (
                  modelGroup.items.map((item) => (
                    <DropdownMenuCheckboxItem
                      key={item.id}
                      checked={attachedIds.includes(item.id)}
                      onCheckedChange={() => toggle(item.id)}
                      onSelect={(e) => e.preventDefault()}
                    >
                      <span className="truncate">{item.name}</span>
                      {item.detail ? (
                        <span className="ml-2 truncate font-mono text-[9px] text-muted-foreground">
                          {item.detail}
                        </span>
                      ) : null}
                    </DropdownMenuCheckboxItem>
                  ))
                ) : (
                  <DropdownMenuLabel className="text-[10px] font-normal text-muted-foreground">
                    No catalog models installed to pin
                  </DropdownMenuLabel>
                )}
                {attachedModelCount ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={() =>
                        attached
                          .filter((c) => c.kind === "models")
                          .forEach((c) => composer.detach(c.id))
                      }
                    >
                      <Trash2 className="size-4" /> Clear turn pinned models
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Library quick access — live synced with library-engine & /library */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 px-2 text-[11px]"
                  title="Library files"
                >
                  <Library className="size-3.5" /> Library
                  {libraryItems.length ? (
                    <span className="rounded-sm bg-primary/20 px-1 font-mono text-[9px] text-primary">
                      {libraryItems.length}
                    </span>
                  ) : null}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-80 w-64 overflow-y-auto">
                <div className="flex items-center justify-between px-2 py-1.5">
                  <DropdownMenuLabel className="p-0 text-xs font-semibold">
                    Library
                  </DropdownMenuLabel>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 gap-1 px-1.5 text-[10px]"
                    onClick={() => void navigate({ to: "/library" })}
                  >
                    Open full <ArrowRight className="size-3" />
                  </Button>
                </div>
                <DropdownMenuSeparator />
                {libraryItems.length === 0 ? (
                  <DropdownMenuItem disabled>No files in Library</DropdownMenuItem>
                ) : (
                  libraryItems.slice(0, 6).map((item) => (
                    <DropdownMenuItem
                      key={item.id}
                      onSelect={() => {
                        void navigate({ to: "/library" });
                      }}
                    >
                      <span className="truncate">{item.name}</span>
                      <span className="ml-auto font-mono text-[9px] text-muted-foreground">
                        {item.type}
                      </span>
                    </DropdownMenuItem>
                  ))
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => void navigate({ to: "/library" })}>
                  View all in Library ({libraryItems.length})
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Projects & Workspaces quick access — live synced with project-workspace-engine & /projects */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 px-2 text-[11px]"
                  title="Projects & Workspaces"
                >
                  <Briefcase className="size-3.5" /> Projects
                  {projectsList.length ? (
                    <span className="rounded-sm bg-primary/20 px-1 font-mono text-[9px] text-primary">
                      {projectsList.length}
                    </span>
                  ) : null}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-80 w-64 overflow-y-auto">
                <div className="flex items-center justify-between px-2 py-1.5">
                  <DropdownMenuLabel className="p-0 text-xs font-semibold">
                    Projects
                  </DropdownMenuLabel>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 gap-1 px-1.5 text-[10px]"
                    onClick={() => void navigate({ to: "/projects" })}
                  >
                    Open full <ArrowRight className="size-3" />
                  </Button>
                </div>
                {activeProject ? (
                  <>
                    <DropdownMenuSeparator />
                    <div className="px-2 py-1">
                      <div className="text-[10px] font-bold uppercase text-muted-foreground">
                        Active Workspace
                      </div>
                      <div className="truncate text-xs font-medium text-primary">
                        {activeProject.name}
                      </div>
                      <div className="font-mono text-[9px] text-muted-foreground">
                        {activeProject.kind}
                      </div>
                    </div>
                  </>
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-[10px] uppercase text-muted-foreground">
                  Workspaces ({projectsList.length})
                </DropdownMenuLabel>
                {projectsList.length === 0 ? (
                  <DropdownMenuItem disabled>No project workspaces</DropdownMenuItem>
                ) : (
                  projectsList.slice(0, 5).map((p) => (
                    <DropdownMenuItem
                      key={p.id}
                      onSelect={() => {
                        void projectWorkspaces.setActive(p.id);
                        void navigate({ to: "/projects" });
                      }}
                    >
                      <span className="truncate">{p.name}</span>
                      <span className="ml-auto font-mono text-[9px] text-muted-foreground">
                        {p.kind}
                      </span>
                    </DropdownMenuItem>
                  ))
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => void navigate({ to: "/projects" })}>
                  Manage Projects & Workspaces
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Slash commands */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-7 px-2" title="Commands">
                  <Slash className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-60">
                <DropdownMenuLabel>Commands</DropdownMenuLabel>
                {COMMANDS.map((c) => (
                  <DropdownMenuItem key={c.cmd} onSelect={() => insertCommand(c.cmd)}>
                    <span className="font-mono text-xs text-primary">{c.cmd.trim()}</span>
                    <span className="ml-2 truncate text-[11px] text-muted-foreground">
                      {c.label}
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2"
              disabled
              title="Chat does not use the microphone. Auto mode listens."
            >
              <Mic className="size-3.5" />
            </Button>

            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2"
              onClick={() => brain.regenerate()}
              disabled={busy || state.messages.length === 0}
              title="Regenerate last answer"
            >
              <RotateCcw className="size-3.5" />
            </Button>

            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              onClick={() => void copyText(transcript())}
              title="Copy transcript"
            >
              <FileSearch className="size-3.5" />
            </Button>
          </div>

          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? []).slice(0, 6);
              e.target.value = "";
              if (!picked.length) return;
              // Files are actually read here, so FRIDAY analyses content, not names.
              void readAttachments(picked).then((items) =>
                setFiles((list) => [...list, ...items].slice(0, 8)),
              );
            }}
          />

          {busy ? (
            <Button size="sm" variant="destructive" className="h-7" onClick={() => brain.stop()}>
              <Square className="size-3.5" /> Stop
            </Button>
          ) : (
            <Button size="sm" className="h-7" disabled={!hasInput && !files.length} onClick={send}>
              <Send className="size-3.5" /> Send
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
