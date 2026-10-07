import { Brain, FlaskConical, Loader2, RefreshCw, Save, Search, Sparkles } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Panel } from "@/components/friday/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { askFriday, canAsk } from "@/lib/friday/ask";
import {
  hub,
  type HubAnalysis,
  type HubCandidate,
  type HubResource,
  type StagedFile,
} from "@/lib/friday/hub-engine";

/**
 * Hub workbench.
 *
 * Everything here works on the *staged* copy of an import: browse it, read and
 * edit files, ask FRIDAY what it contains, run it in an isolated sandbox
 * project, and finally adopt only the capabilities the owner ticked. The live
 * FRIDAY tree is untouched until "Install selected".
 */
const STATUS_TONE: Record<HubCandidate["status"], string> = {
  new: "text-success",
  updated: "text-warning",
  identical: "text-muted-foreground",
};

const kb = (bytes: number) =>
  bytes > 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export function HubWorkbench({ resource }: { resource: HubResource }) {
  const [analysis, setAnalysis] = useState<HubAnalysis | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [files, setFiles] = useState<StagedFile[]>([]);
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<string>("");
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string>("");
  const [advice, setAdvice] = useState("");

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } catch (error) {
      toast.error(label, {
        description: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      setBusy("");
    }
  };

  const analyze = () =>
    run("Analyse", async () => {
      const result = await hub.analyze(resource);
      setAnalysis(result);
      if (!result.ok) {
        toast.error("Analysis failed", { description: result.error });
        return;
      }
      // Pre-tick everything FRIDAY does not have yet; identical files are left
      // alone so an adoption never rewrites the tree with the same bytes.
      setPicked(
        new Set((result.candidates ?? []).filter((c) => c.status !== "identical").map((c) => c.id)),
      );
      setFiles(await hub.stagedFiles(resource));
    });

  const openFile = (path: string) =>
    run("Open file", async () => {
      const result = await hub.readStaged(resource, path);
      if (!result.ok) {
        toast.error("Could not open", { description: result.error });
        return;
      }
      setOpen(path);
      setContent(
        result.binary ? `[binary file · ${kb(result.bytes ?? 0)}]` : (result.content ?? ""),
      );
      setDirty(false);
    });

  const save = () =>
    run("Save", async () => {
      const result = await hub.writeStaged(resource, open, content);
      if (!result.ok) {
        toast.error("Could not save", { description: result.error });
        return;
      }
      setDirty(false);
      toast.success("Saved to the staging copy");
    });

  const ask = () =>
    run("Ask FRIDAY", async () => {
      const list = (analysis?.candidates ?? [])
        .slice(0, 40)
        .map((c) => `${c.status.padEnd(9)} ${c.dest} (${c.kind}, ${c.files} files)`)
        .join("\n");
      const answer = await askFriday(
        [
          `I imported "${resource.name}" (${resource.source}) into my Hub staging area.`,
          analysis?.mode ? `Detected package type: ${analysis.mode}.` : "",
          list ? `Capabilities found:\n${list}` : "",
          open ? `Currently open file ${open}:\n${content.slice(0, 4000)}` : "",
          "In short bullets: what is this, which parts are worth adopting into FRIDAY, and what should I be careful about?",
        ]
          .filter(Boolean)
          .join("\n\n"),
        { system: "You are FRIDAY reviewing an import for your owner. Be concrete and brief." },
      );
      setAdvice(answer);
    });

  const workbench = () =>
    run("Open sandbox", async () => {
      const result = await hub.openWorkbench(resource);
      if (!result.ok) {
        toast.error("Sandbox failed", { description: result.error });
        return;
      }
      toast.success("Sandbox project created", {
        description: `${result.project?.name} — open the Sandbox section to run and preview it.`,
      });
    });

  const install = () =>
    run("Install selected", async () => {
      const result = await hub.extract(resource, [...picked]);
      if (!result.ok) {
        toast.error("Install failed", { description: result.error });
        return;
      }
      toast.success(`Adopted ${result.applied ?? 0} files`, {
        description: "Backed up — you can roll this back from Import & Build.",
      });
      await analyze();
    });

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const shown = files
    .filter(
      (f) => !f.dir && (!filter.trim() || f.path.toLowerCase().includes(filter.toLowerCase())),
    )
    .slice(0, 400);

  return (
    <Panel
      title="Workbench"
      hint={
        analysis?.summary ? `${analysis.summary.groups} capabilities` : "staged · not installed"
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={Boolean(busy)} onClick={() => void analyze()}>
            {busy === "Analyse" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Search className="size-3.5" />
            )}
            Analyse contents
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={Boolean(busy)}
            onClick={() => void workbench()}
          >
            <FlaskConical className="size-3.5" /> Open in sandbox
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={Boolean(busy) || !canAsk()}
            onClick={() => void ask()}
          >
            {busy === "Ask FRIDAY" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Brain className="size-3.5" />
            )}
            Ask FRIDAY
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={Boolean(busy) || !picked.size}
            onClick={() => void install()}
          >
            <Sparkles className="size-3.5" /> Install selected ({picked.size})
          </Button>
        </div>

        {analysis?.summary ? (
          <p className="font-mono text-[11px] text-muted-foreground">
            {analysis.summary.total} files · {analysis.summary.new} new · {analysis.summary.updated}{" "}
            updated · {analysis.summary.identical} identical
            {analysis.label ? ` · ${analysis.label}` : ""}
          </p>
        ) : null}

        {analysis?.candidates?.length ? (
          <ul className="max-h-64 space-y-1 overflow-auto pr-1">
            {analysis.candidates.map((candidate) => (
              <li
                key={candidate.id}
                className="flex items-start gap-2 rounded-sm border border-border bg-surface px-2 py-1.5"
              >
                <input
                  type="checkbox"
                  className="mt-1 accent-primary"
                  checked={picked.has(candidate.id)}
                  onChange={() => toggle(candidate.id)}
                  aria-label={`Select ${candidate.dest}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-xs text-foreground">{candidate.name}</span>
                    <Badge variant="outline" className="label-xs">
                      {candidate.kind}
                    </Badge>
                    <span className={`font-mono text-[10px] ${STATUS_TONE[candidate.status]}`}>
                      {candidate.status}
                    </span>
                  </div>
                  <p className="truncate font-mono text-[10px] text-muted-foreground">
                    {candidate.dest} · {candidate.files} files · {kb(candidate.bytes)}
                    {candidate.version ? ` · v${candidate.version}` : ""}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        ) : null}

        {advice ? (
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-sm border border-primary/20 bg-surface p-2 font-mono text-[11px] text-muted-foreground">
            {advice}
          </pre>
        ) : null}

        {files.length ? (
          <div className="grid gap-2 lg:grid-cols-[minmax(0,240px)_minmax(0,1fr)]">
            <div className="space-y-1">
              <div className="flex items-center gap-1.5">
                <Input
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="filter files"
                  className="h-8 font-mono text-[11px]"
                />
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Reload file list"
                  onClick={() =>
                    void run("Reload", async () => setFiles(await hub.stagedFiles(resource)))
                  }
                >
                  <RefreshCw className="size-3.5" />
                </Button>
              </div>
              <ul className="max-h-64 overflow-auto rounded-sm border border-border bg-surface">
                {shown.map((file) => (
                  <li key={file.path}>
                    <button
                      type="button"
                      onClick={() => void openFile(file.path)}
                      className={`block w-full truncate px-2 py-1 text-left font-mono text-[10px] hover:text-primary ${
                        open === file.path ? "text-primary" : "text-muted-foreground"
                      }`}
                    >
                      {file.path}
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate font-mono text-[11px] text-muted-foreground">
                  {open || "select a file"}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!open || !dirty || Boolean(busy)}
                  onClick={() => void save()}
                >
                  <Save className="size-3.5" /> Save
                </Button>
              </div>
              <textarea
                value={content}
                spellCheck={false}
                onChange={(event) => {
                  setContent(event.target.value);
                  setDirty(true);
                }}
                className="h-64 w-full resize-none rounded-sm border border-border bg-background p-2 font-mono text-[11px] text-foreground outline-none focus:border-primary/40"
                placeholder="Open a file from the staged import to preview or edit it."
              />
            </div>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
