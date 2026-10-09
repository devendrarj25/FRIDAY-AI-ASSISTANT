import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { deferEffect } from "@/lib/friday/defer-effect";
import { Download, FolderOpen, Pin, RefreshCw, Search, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/friday/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FilterTabs, HudPanel, StatusPill } from "@/components/friday/ui";
import { brain } from "@/lib/friday/brain-engine";
import { isDesktopApp, libraryReveal, revealWorkspaceFolder } from "@/lib/friday/desktop";
import { formatBytes, readAttachments } from "@/lib/friday/attachments";
import {
  library,
  looksLikeLibraryTeach,
  libraryTypeHonesty,
  LIBRARY_UPLOAD_CAP,
  type LibraryRecord,
  type LibraryType,
} from "@/lib/friday/library-engine";
import {
  formatLibraryExtra,
  publishLibrarySession,
  registerLibraryAsk,
} from "@/lib/friday/library-awareness";

export const Route = createFileRoute("/library")({
  head: () => ({
    meta: [
      { title: "Library — FRIDAY" },
      {
        name: "description",
        content:
          "Owner files FRIDAY uploaded, generated, or modified — the same store Chat and Auto Mode use.",
      },
      { property: "og:title", content: "Library — FRIDAY" },
      { property: "og:description", content: "Local owner Library under FRIDAY_ROOT." },
    ],
  }),
  component: LibraryPage,
});

const TYPES: Array<LibraryType | "all"> = [
  "all",
  "doc",
  "sheet",
  "image",
  "audio",
  "video",
  "zip",
  "other",
];

function LibraryPage() {
  const desktop = isDesktopApp();
  const [items, setItems] = useState<LibraryRecord[]>(() => library.list());
  const [query, setQuery] = useState("");
  const [type, setType] = useState<LibraryType | "all">("all");
  const [selected, setSelected] = useState<string[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sort, setSort] = useState<"newest" | "name" | "size">("newest");
  const [dragOver, setDragOver] = useState(false);
  const [ask, setAsk] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const pull = useCallback(async () => {
    setBusy(true);
    try {
      if (desktop) {
        await library.scan();
      }
      setItems(library.list());
    } finally {
      setBusy(false);
    }
  }, [desktop]);

  useEffect(() => {
    const stop = deferEffect(() => void pull());
    const off = library.subscribe(() => setItems(library.list()));
    return () => {
      stop();
      off();
    };
  }, [pull]);

  useEffect(() => {
    registerLibraryAsk((prompt) => {
      const result = brain.send(prompt, { extra: formatLibraryExtra() });
      if (!result.accepted) toast.error(result.message || "FRIDAY is busy.");
    });
    return () => registerLibraryAsk(null);
  }, []);

  useEffect(() => {
    publishLibrarySession({
      desktop,
      items,
      pinned: items.filter((item) => item.pinnedForAuto).map((item) => item.id),
      selectedId: openId,
      dir: library.dirPath(),
    });
  }, [desktop, items, openId]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = items.filter((item) => {
      if (type !== "all" && item.type !== type) return false;
      if (!q) return true;
      return `${item.name} ${item.source} ${item.origin} ${item.id}`.toLowerCase().includes(q);
    });
    return [...filtered].sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      if (sort === "size") return b.size - a.size;
      return b.updatedAt - a.updatedAt;
    });
  }, [items, query, type, sort]);

  const open = openId ? items.find((item) => item.id === openId) : undefined;

  useEffect(() => {
    if (!openId) return;
    const item = library.get(openId);
    if (item && !item.text) void library.fetchText(openId);
  }, [openId]);

  const takeFiles = async (list: FileList | File[]) => {
    const picked = Array.from(list).slice(0, LIBRARY_UPLOAD_CAP);
    if (!picked.length) return;
    setBusy(true);
    try {
      await readAttachments(picked);
      setItems(library.list());
      toast.success(`Added ${picked.length} file(s) to Library.`);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((row) => row !== id) : [...prev, id]));
  };

  const analyse = (item: LibraryRecord) => {
    const extract = (item.text || item.error || "").slice(0, 12_000);
    const result = brain.send(
      `Analyse Library file ${item.name} (library:${item.id}). Use only the extract that exists — do not invent unread pages.`,
      {
        extra: [
          formatLibraryExtra(),
          extract
            ? `EXTRACT library:${item.id}\n${extract}`
            : "No extractable text. Say so instead of guessing.",
        ].join("\n\n"),
      },
    );
    if (!result.accepted) toast.error(result.message || "FRIDAY is busy.");
    else toast.success("Sent to Chat.");
  };

  const askAbout = (item: LibraryRecord) => {
    const prompt = `Ask FRIDAY about Library file ${item.name} (library:${item.id}). Use only the extract that exists — do not invent pages I did not store.`;
    const result = brain.send(prompt, { extra: formatLibraryExtra() });
    if (!result.accepted) toast.error(result.message || "FRIDAY is busy.");
    else toast.success("Sent to Chat.");
  };

  const teach = (item: LibraryRecord) => {
    const result = library.teach(item.id, "teach");
    toast[result.ok ? "success" : "error"](
      result.ok ? `Taught ${result.chunks} chunk(s).` : result.skipped,
    );
    setItems(library.list());
  };

  const onAsk = () => {
    const text = ask.trim() || "What is in my Library right now?";
    const result = brain.send(looksLikeLibraryTeach(text) ? text : `Library: ${text}`, {
      extra: formatLibraryExtra(),
    });
    if (!result.accepted) toast.error(result.message || "FRIDAY is busy.");
    else {
      setAsk("");
      toast.success("Sent to Chat.");
    }
  };

  return (
    <AppShell
      title="Library"
      subtitle="Uploaded, generated and modified owner files — Chat, Memory, Hisab and Auto Mode share this store"
    >
      <div
        className="space-y-4"
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files?.length) void takeFiles(e.dataTransfer.files);
        }}
      >
        {dragOver ? (
          <p className="font-mono text-[11px] text-primary">
            Drop files here — they become Library items, not Import & Build packs.
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            <Upload className="size-4" /> Upload
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void pull()}>
            <RefreshCw className="size-4" /> Refresh / Scan
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={selected.length === 0}
            onClick={() =>
              void library.zipSelected(selected).then((result) => {
                if ("error" in result && result.error && !("id" in result))
                  toast.error(result.error);
                else {
                  toast.success("Packed a zip into Library.");
                  setItems(library.list());
                }
              })
            }
          >
            Zip selected
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={selected.length === 0}
            onClick={() => {
              if (
                !window.confirm(
                  `Delete ${selected.length} Library item(s)? This does not wipe FRIDAY_ROOT.`,
                )
              )
                return;
              selected.forEach((id) => library.remove(id));
              setSelected([]);
              setItems(library.list());
            }}
          >
            <Trash2 className="size-4" /> Delete
          </Button>
          <Button size="sm" variant="outline" onClick={() => revealWorkspaceFolder("library")}>
            <FolderOpen className="size-4" /> Reveal folder
          </Button>
          <div className="relative min-w-[180px] flex-1">
            <Search className="pointer-events-none absolute left-2 top-2 size-3.5 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, source, id"
              className="h-8 pl-7 font-mono text-[11px]"
            />
          </div>
          <span className="ml-auto font-mono text-[10px] text-muted-foreground">
            {desktop ? "live FRIDAY_ROOT/library" : "preview session copy"} · {visible.length}/
            {items.length}
          </span>
        </div>

        <FilterTabs
          tabs={TYPES.map((key) => ({ key, label: key }))}
          value={type}
          onChange={(key) => setType(key as LibraryType | "all")}
        />
        <FilterTabs
          tabs={[
            { key: "newest", label: "newest" },
            { key: "name", label: "name" },
            { key: "size", label: "size" },
          ]}
          value={sort}
          onChange={(key) => setSort(key as "newest" | "name" | "size")}
        />

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
          <HudPanel title="Items" hint={`${visible.length} shown`}>
            {visible.length ? (
              <ul className="space-y-2">
                {visible.map((item) => (
                  <li
                    key={item.id}
                    className="rounded-sm border border-border bg-surface px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <label className="flex min-w-0 items-center gap-2">
                        <input
                          type="checkbox"
                          checked={selected.includes(item.id)}
                          onChange={() => toggle(item.id)}
                          aria-label={`Select ${item.name}`}
                        />
                        <button
                          type="button"
                          className="truncate text-left text-sm"
                          onClick={() => setOpenId(item.id)}
                        >
                          {item.name}
                        </button>
                      </label>
                      <StatusPill label={item.type} tone={item.error ? "warning" : "accent"} />
                    </div>
                    <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                      {item.origin} · {item.source} · {formatBytes(item.size)} · library:{item.id}
                      {item.truncated ? " · partial" : ""}
                      {item.pinnedForAuto ? " · pinned Auto" : ""}
                      {item.hisabLinked ? " · hisab" : ""}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <Button size="sm" variant="outline" onClick={() => setOpenId(item.id)}>
                        Details
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => analyse(item)}>
                        Analyse
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => teach(item)}>
                        Teach
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => askAbout(item)}>
                        Ask FRIDAY
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          library.pin(item.id, !item.pinnedForAuto);
                          setItems(library.list());
                        }}
                      >
                        <Pin className="size-3.5" />{" "}
                        {item.pinnedForAuto ? "Unpin Auto" : "Use in Auto Mode"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          if (desktop) void libraryReveal(item.id);
                          else toast.error("Reveal runs in the desktop app.");
                        }}
                      >
                        <Download className="size-3.5" /> Reveal
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                Library is empty. Upload or drop files here, or attach them in Chat — both write the
                same index. Image generate, audio-file STT, and AI video edit are not built yet.
              </p>
            )}
          </HudPanel>

          <div className="space-y-4">
            <HudPanel title="Details" hint={open ? open.name : "none selected"}>
              {open ? (
                <div className="space-y-2 font-mono text-[11px] text-muted-foreground">
                  <p>id {open.id}</p>
                  <p>
                    {open.origin} / {open.source} / {open.type}
                  </p>
                  <p>
                    {formatBytes(open.size)} · hash {open.hash.slice(0, 16)}
                  </p>
                  {open.extractNote ? <p className="text-warning">{open.extractNote}</p> : null}
                  {open.skipped?.length ? (
                    <p>skipped: {open.skipped.slice(0, 8).join("; ")}</p>
                  ) : null}
                  {libraryTypeHonesty(open) && !open.text ? (
                    <p className="text-warning">{libraryTypeHonesty(open)}</p>
                  ) : null}
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-sm border border-border bg-background p-2 text-[10px] text-foreground">
                    {(
                      open.text ||
                      open.error ||
                      libraryTypeHonesty(open) ||
                      "No extractable text. I will not invent contents."
                    ).slice(0, 8000)}
                  </pre>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const result = brain.send(
                        `Generate or edit from Library file ${open.name}. If image/video generate is not wired, say so.`,
                        {
                          extra: formatLibraryExtra(),
                        },
                      );
                      if (!result.accepted) toast.error(result.message || "FRIDAY is busy.");
                    }}
                  >
                    Generate / Edit in Chat
                  </Button>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Select an item to preview its extract.
                </p>
              )}
            </HudPanel>

            <HudPanel title="Ask FRIDAY" hint="same Core Brain">
              <div className="flex gap-2">
                <Input
                  value={ask}
                  onChange={(e) => setAsk(e.target.value)}
                  placeholder="Ask about these files"
                  className="h-8 font-mono text-[11px]"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onAsk();
                  }}
                />
                <Button size="sm" onClick={onAsk}>
                  Ask FRIDAY
                </Button>
              </div>
            </HudPanel>
          </div>
        </div>

        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            const picked = e.target.files;
            e.target.value = "";
            if (picked?.length) void takeFiles(picked);
          }}
        />
      </div>
    </AppShell>
  );
}
