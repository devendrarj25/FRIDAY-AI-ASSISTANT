import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Check,
  Copy,
  Download,
  Pencil,
  Pin,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DataTable, HudPanel, StatusPill, ToggleRow } from "@/components/friday/ui";
import { brain } from "@/lib/friday/brain-engine";
import { useBrain } from "@/lib/friday/use-brain";
import { memoryLayers, type MemoryLayer } from "@/lib/friday/brain-catalog";
import {
  memory as memoryEngine,
  memoryTiers,
  type MemoryTier,
} from "@/lib/friday/self/memory-engine";
import { useMemory } from "@/lib/friday/self/use-self";
import { vectorIndex } from "@/lib/friday/brain/vector-index";
import { useVectorIndex } from "@/lib/friday/brain/use-brain-memory";
import { copyText } from "@/lib/friday/clipboard";
import { cn } from "@/lib/utils";
import {
  reviseDurable,
  searchDurable,
  teachDurable,
  tierToLayer,
} from "@/lib/friday/self/memory-teach";

const relative = (at: number | null | undefined) => {
  if (!at) return "never";
  const diff = Date.now() - at;
  if (diff < 60_000) return `${Math.max(1, Math.round(diff / 1000))}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
};

const ttlLabel = (ms: number) => {
  if (!ms) return "no expiry";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
};

const ago = (ts: number) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
};

/**
 * Operational memory console — the single UI for browsing, teaching, indexing
 * and transferring FRIDAY's memory. Settings keeps configuration only.
 */
export function MemoryConsole() {
  const state = useBrain();
  const memoryState = useMemory();
  const vector = useVectorIndex();
  const [memTitle, setMemTitle] = useState("");
  const [memText, setMemText] = useState("");
  const [memQuery, setMemQuery] = useState("");
  const [memLayer, setMemLayer] = useState<MemoryLayer>("long-term");
  const [indexPath, setIndexPath] = useState("");
  const [tier, setTier] = useState<MemoryTier | "all">("all");
  const [tick, setTick] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 15_000);
    return () => clearInterval(id);
  }, []);
  void tick;

  useEffect(() => {
    void vectorIndex.refresh();
    const id = window.setInterval(() => void vectorIndex.refresh(), 8_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => {
      void vectorIndex.search(memQuery);
    }, 400);
    return () => window.clearTimeout(id);
  }, [memQuery]);

  const q = memQuery.trim().toLowerCase();
  const filteredMemory = useMemo(() => {
    const trimmed = memQuery.trim();
    if (!trimmed) return state.memory;
    const words = trimmed
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 2);
    const ranked = brain.recall(trimmed, 40);
    const matched = ranked.filter((hit) => {
      const hay = `${hit.title} ${hit.snippet}`.toLowerCase();
      return hay.includes(q) || words.some((w) => hay.includes(w));
    });
    if (matched.length) {
      const byId = new Map(state.memory.map((m) => [m.id, m]));
      const rows = matched.flatMap((hit) => {
        const row = byId.get(hit.id);
        return row ? [{ ...row, score: hit.score }] : [];
      });
      if (rows.length) return rows;
    }
    return state.memory.filter((m) => `${m.title} ${m.snippet}`.toLowerCase().includes(q));
  }, [state.memory, memQuery, q]);

  const tierRows = useMemo(
    () =>
      memoryTiers.map((spec) => {
        const count = memoryState.counts[spec.id] ?? 0;
        return { spec, count, pressure: Math.min(100, Math.round((count / spec.cap) * 100)) };
      }),
    [memoryState.counts],
  );

  const tieredResults = useMemo(
    () => searchDurable(memQuery, memoryState.items, tier),
    [memoryState.items, memQuery, tier],
  );

  const unpinnedBrain = filteredMemory.filter((m) => !m.pinned);
  const unpinnedTier = tieredResults.filter((item) => !item.pinned);

  const exportMemory = () => {
    const blob = new Blob([memoryEngine.export()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `friday-memory-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast.success("Memory exported");
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="space-y-4">
        <HudPanel
          title="Search memory"
          hint="ranked six-tier store + brain recall; vector index below"
        >
          <div className="flex items-center gap-2">
            <Search className="size-4 text-muted-foreground" />
            <Input
              value={memQuery}
              onChange={(e) => setMemQuery(e.target.value)}
              placeholder="Search files, chats, tasks, lessons and saved facts"
              className="border-0 bg-transparent font-mono text-sm shadow-none focus-visible:ring-0"
            />
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button size="sm" variant="outline" onClick={exportMemory}>
              <Download className="size-4" /> Export memory
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const n = memoryEngine.backup();
                toast.success(`${n} record(s) backed up`);
              }}
            >
              Backup
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const n = memoryEngine.restoreBackup();
                toast[n ? "success" : "error"](n ? `${n} record(s) restored` : "No backup found");
              }}
            >
              Restore
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void copyText(memoryEngine.export()).then((ok) =>
                  ok
                    ? toast.success("Memory exported to the clipboard")
                    : toast.error("Copying was blocked"),
                );
              }}
            >
              Copy JSON
            </Button>
            <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
              <Upload className="size-4" /> Import JSON
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const dropped = memoryEngine.optimize();
                toast.success(
                  dropped ? `Compacted — ${dropped} record(s) dropped` : "Already within caps",
                );
              }}
            >
              Compact now
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const { archived, dropped } = memoryEngine.hygiene();
                toast.success(
                  archived || dropped
                    ? `Hygiene — ${archived} archived, ${dropped} compacted`
                    : "Already clean",
                );
              }}
            >
              Hygiene now
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (
                  !window.confirm(
                    "Forget matching unpinned records in brain recall and the six-tier store?",
                  )
                )
                  return;
                unpinnedBrain.forEach((m) => brain.forget(m.id));
                unpinnedTier.forEach((item) => memoryEngine.forget(item.id));
                toast.success("Matching unpinned records forgotten");
              }}
              disabled={!memQuery.trim() || (!unpinnedBrain.length && !unpinnedTier.length)}
            >
              <Trash2 className="size-4" /> Forget shown
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                void file.text().then((text) => {
                  try {
                    const added = memoryEngine.import(text);
                    toast.success(`Imported ${added} memory item(s)`);
                  } catch (error) {
                    toast.error(`Import failed — ${String((error as Error).message ?? error)}`);
                  }
                });
              }}
            />
          </div>
        </HudPanel>

        <HudPanel
          title="Memory records"
          hint={`${filteredMemory.length} of ${state.memory.length}`}
        >
          <DataTable
            columns={["Layer", "Title", "Snippet", "Score", ""]}
            rows={filteredMemory.slice(0, 40).map((m) => [
              <StatusPill
                key="l"
                label={m.layer}
                tone={
                  m.layer === "long-term" ? "accent" : m.layer === "project" ? "primary" : "muted"
                }
              />,
              <span key="t" className="text-foreground">
                {m.title}
              </span>,
              <span key="s" className="block max-w-[26rem] truncate text-xs text-muted-foreground">
                {m.snippet}
              </span>,
              <span key="c" className="font-mono text-[11px] text-primary">
                {m.score}
              </span>,
              <span key="a" className="flex gap-2">
                <button
                  type="button"
                  onClick={() => brain.pin(m.id)}
                  className="font-mono text-[10px] text-primary hover:underline"
                >
                  {m.pinned ? "unpin" : "pin"}
                </button>
                <button
                  type="button"
                  onClick={() => brain.forget(m.id)}
                  className="font-mono text-[10px] text-destructive hover:underline"
                >
                  forget
                </button>
              </span>,
            ])}
          />
        </HudPanel>

        <HudPanel
          title="Six-tier store"
          hint={`${tieredResults.length} of ${memoryState.items.length} records`}
        >
          <div className="mb-3 flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setTier("all")}
              className={cn(
                "rounded-sm border px-2 py-1 font-mono text-[10px]",
                tier === "all"
                  ? "border-primary/50 bg-primary/15 text-primary"
                  : "border-border text-muted-foreground",
              )}
            >
              all
            </button>
            {memoryTiers.map((spec) => (
              <button
                key={spec.id}
                type="button"
                onClick={() => setTier(spec.id)}
                className={cn(
                  "rounded-sm border px-2 py-1 font-mono text-[10px]",
                  tier === spec.id
                    ? "border-primary/50 bg-primary/15 text-primary"
                    : "border-border text-muted-foreground",
                )}
              >
                {spec.label} {memoryState.counts[spec.id] ?? 0}
              </button>
            ))}
          </div>
          <div className="grid max-h-[380px] gap-2 overflow-y-auto pr-1">
            {tieredResults.length === 0 ? (
              <p className="text-sm text-muted-foreground">No records match that search.</p>
            ) : (
              tieredResults.slice(0, 60).map((item) => (
                <div
                  key={item.id}
                  className="rounded-lg border border-border/60 bg-card/40 px-3 py-2"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      {item.pinned ? <Pin className="h-3.5 w-3.5 shrink-0 text-primary" /> : null}
                      <p className="truncate text-sm font-medium text-foreground">{item.title}</p>
                      <StatusPill label={item.tier} tone="muted" />
                      {item.kind ? <StatusPill label={item.kind} tone="muted" /> : null}
                      {item.contradiction ? (
                        <StatusPill label="contradiction" tone="warning" />
                      ) : null}
                      {item.verified ? <StatusPill label="verified" tone="accent" /> : null}
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        title={item.pinned ? "Unpin" : "Pin"}
                        onClick={() => memoryEngine.pin(item.id)}
                      >
                        <Pin className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        title="Edit in Teach"
                        onClick={() => {
                          setEditingId(item.id);
                          setMemLayer(tierToLayer(item.tier, item.kind));
                          setMemTitle(item.title);
                          setMemText(item.text);
                        }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        title="Copy text"
                        onClick={() => {
                          void copyText(`${item.title}\n\n${item.text}`).then((ok) =>
                            toast[ok ? "success" : "error"](ok ? "Copied" : "Copying was blocked"),
                          );
                        }}
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </Button>
                      {!item.verified ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          title="Mark verified"
                          onClick={() => memoryEngine.update(item.id, { verified: true })}
                        >
                          <Check className="h-3.5 w-3.5" />
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        title="Promote to a longer-lived tier"
                        onClick={() => memoryEngine.promote(item.id)}
                      >
                        <Sparkles className="h-3.5 w-3.5" />
                      </Button>
                      {item.tier === "archived" ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          title="Restore from archive"
                          onClick={() => memoryEngine.restore(item.id)}
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          title="Archive"
                          onClick={() => memoryEngine.archive(item.id)}
                        >
                          <Archive className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        title="Forget"
                        onClick={() => memoryEngine.forget(item.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
                    {item.text}
                  </p>
                  <p className="mt-1 font-mono text-[11px] text-muted-foreground/70">
                    {item.source} · used {item.uses}× · confidence{" "}
                    {Math.round(item.confidence * 100)}% · {ago(item.updatedAt)}
                  </p>
                </div>
              ))
            )}
          </div>
        </HudPanel>

        <HudPanel
          title="Vector index search"
          hint={
            vector.available
              ? `${vector.backend} backend · ${vector.results.length} hits`
              : (vector.reason ?? "kernel vector memory unavailable")
          }
          actions={
            <Button
              size="sm"
              variant="outline"
              disabled={vector.busy || !memQuery.trim()}
              onClick={() => void vectorIndex.search(memQuery)}
            >
              <Search className={cn("size-4", vector.busy && "animate-pulse")} /> Search index
            </Button>
          }
        >
          <div className="mb-3 flex min-w-0 flex-wrap items-center gap-1.5">
            <Input
              value={indexPath}
              onChange={(e) => setIndexPath(e.target.value)}
              placeholder="Folder to index (e.g. C:/FRIDAY/workspace)"
              className="h-8 min-w-0 max-w-xs flex-1 bg-surface font-mono text-xs"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={vector.busy || !indexPath.trim()}
              onClick={() => {
                void vectorIndex.indexPath(indexPath.trim()).then((res) => {
                  toast[res ? "success" : "error"](
                    res
                      ? `Indexed ${res.files} file(s) · ${res.chunks} chunk(s)`
                      : "Index folder failed — kernel vector memory unavailable",
                  );
                });
              }}
            >
              Index folder
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={vector.busy}
              onClick={() => {
                void vectorIndex.reindex().then((ok) => {
                  toast[ok ? "success" : "error"](
                    ok ? "Index rebuilt" : "Rebuild failed — kernel vector memory unavailable",
                  );
                });
              }}
            >
              <RefreshCw className={cn("size-4", vector.busy && "animate-spin")} /> Rebuild
            </Button>
          </div>
          <ul className="space-y-3">
            {vector.results.map((r, i) => (
              <li
                key={r.id ?? `${r.title}-${i}`}
                className="border-b border-border/60 pb-3 last:border-0 last:pb-0"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <StatusPill label={r.kind} tone="muted" />
                  <p className="min-w-0 truncate text-sm font-medium text-foreground">
                    {r.title || "untitled"}
                  </p>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{r.snippet}</p>
                <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                  score {r.score.toFixed(3)}
                </p>
              </li>
            ))}
            {vector.results.length ? null : (
              <li className="font-mono text-[11px] text-muted-foreground">
                {vector.available
                  ? vector.searchedAt
                    ? "No documents match."
                    : "Type a query and search the durable index."
                  : (vector.reason ?? "Vector memory is not reachable right now.")}
              </li>
            )}
          </ul>
        </HudPanel>
      </div>

      <div className="space-y-4">
        <HudPanel title="Index" hint={`checked ${relative(vector.checkedAt)}`}>
          <dl className="space-y-2 font-mono text-[11px] text-muted-foreground">
            <div className="flex justify-between gap-3">
              <dt>backend</dt>
              <dd className={vector.available ? "text-accent" : "text-warning"}>
                {vector.backend ?? "unavailable"}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>synced records</dt>
              <dd>{vector.synced}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>last sync</dt>
              <dd>{relative(vector.lastSyncAt)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>memories</dt>
              <dd>{state.memory.length}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>pinned</dt>
              <dd>{state.memory.filter((m) => m.pinned).length}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>tiered records</dt>
              <dd>{memoryState.items.length}</dd>
            </div>
          </dl>
          <div className="mt-2">
            <ToggleRow
              label="Auto-sync"
              hint="push new memories to the durable index"
              on={vector.autoSync}
              onToggle={() => vectorIndex.setAutoSync(!vector.autoSync)}
            />
          </div>
        </HudPanel>

        <HudPanel title="Memory tiers" hint={`${memoryState.items.length} records`}>
          <ul className="space-y-2">
            {tierRows.map(({ spec, count, pressure }) => (
              <li key={spec.id} className="border-b border-border/60 pb-2 last:border-0">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-foreground">
                    {spec.label} <span className="font-mono text-[10px] text-primary">{count}</span>
                  </p>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {ttlLabel(spec.ttlMs)} · {pressure}%
                  </span>
                </div>
                <p className="font-mono text-[10px] text-muted-foreground">{spec.note}</p>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button size="sm" variant="outline" onClick={() => void vectorIndex.syncLocalMemory()}>
              <Sparkles className="size-4" /> Sync to index
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (!window.confirm("Clear unpinned working memory?")) return;
                memoryEngine.clearTier("working");
                toast.success("Working memory cleared");
              }}
            >
              Clear working
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void vectorIndex.refresh()}>
              Refresh status
            </Button>
          </div>
        </HudPanel>

        <HudPanel title={editingId ? "Edit memory" : "Teach FRIDAY"}>
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1.5">
              {memoryLayers.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => setMemLayer(l.id)}
                  className={cn(
                    "rounded-sm border px-2 py-1 font-mono text-[10px]",
                    memLayer === l.id
                      ? "border-primary/50 bg-primary/15 text-primary"
                      : "border-border text-muted-foreground",
                  )}
                >
                  {l.id}
                </button>
              ))}
            </div>
            <Input
              value={memTitle}
              onChange={(e) => setMemTitle(e.target.value)}
              placeholder="Title"
              className="bg-surface text-sm"
            />
            <Textarea
              value={memText}
              onChange={(e) => setMemText(e.target.value)}
              placeholder="What should FRIDAY remember?"
              className="min-h-20 resize-none bg-surface text-sm"
            />
            <div className="flex flex-wrap gap-1.5">
              <Button
                size="sm"
                disabled={!memTitle.trim() || !memText.trim()}
                onClick={() => {
                  const title = memTitle.trim();
                  const text = memText.trim();
                  if (editingId) {
                    const item = reviseDurable(editingId, title, text);
                    if (!item) {
                      toast.error("That record is gone");
                      setEditingId(null);
                      return;
                    }
                    void vectorIndex.add(
                      `${item.title}\n\n${item.text}`,
                      item.tier,
                      item.title,
                      item.id,
                    );
                    setEditingId(null);
                    setMemTitle("");
                    setMemText("");
                    toast.success(`Updated ${item.tier} memory`);
                    return;
                  }
                  const item = teachDurable(memLayer, title, text);
                  brain.remember(memLayer, title, text, memLayer === "long-term");
                  void vectorIndex.add(
                    `${item.title}\n\n${item.text}`,
                    item.tier,
                    item.title,
                    item.id,
                  );
                  setMemTitle("");
                  setMemText("");
                  toast.success(`Saved to ${item.tier} memory`);
                }}
              >
                {editingId ? "Update memory" : "Save to memory"}
              </Button>
              {editingId ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setEditingId(null);
                    setMemTitle("");
                    setMemText("");
                  }}
                >
                  Cancel
                </Button>
              ) : null}
            </div>
          </div>
        </HudPanel>
        <HudPanel title="Layers">
          <ul className="space-y-2">
            {memoryLayers.map((l) => (
              <li key={l.id}>
                <p className="text-xs text-foreground">
                  {l.label}{" "}
                  <span className="font-mono text-[10px] text-primary">
                    {state.memory.filter((m) => m.layer === l.id).length}
                  </span>
                </p>
                <p className="font-mono text-[10px] text-muted-foreground">{l.note}</p>
              </li>
            ))}
          </ul>
        </HudPanel>
      </div>
    </div>
  );
}
