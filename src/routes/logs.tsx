import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, FolderOpen, Pause, Play, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { AppShell, Panel } from "@/components/friday/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { brain } from "@/lib/friday/brain-engine";
import { useBrain } from "@/lib/friday/use-brain";
import { copyText } from "@/lib/friday/clipboard";
import {
  isDesktopApp,
  onTelemetryCleared,
  onTelemetryIpc,
  onTelemetryLog,
  revealWorkspaceFolder,
  telemetryClear,
  telemetryFiles,
  telemetryReadFile,
  telemetrySnapshot,
  type TelemetryFileInfo,
} from "@/lib/friday/desktop";
import { logLines } from "@/lib/friday/mock";
import { formatLogsExtra, publishLogsSession, registerLogsAsk } from "@/lib/friday/logs-awareness";
import {
  appendIpcLines,
  appendLogLines,
  filterLogLines,
  ipcEntryToLine,
  summarizeLogErrors,
  telemetryEntryToLine,
  type IpcLine,
  type LogLevel,
  type LogLine,
} from "@/lib/friday/log-stream";

export const Route = createFileRoute("/logs")({
  head: () => ({
    meta: [
      { title: "Logs — FRIDAY" },
      {
        name: "description",
        content:
          "Live kernel, main-process, IPC and disk logs for debugging what FRIDAY did and why.",
      },
      { property: "og:title", content: "Logs — FRIDAY" },
      { property: "og:description", content: "Live local kernel and disk logs." },
    ],
  }),
  component: LogsPage,
});

const tone = {
  info: "text-muted-foreground",
  debug: "text-accent",
  warn: "text-warning",
  error: "text-destructive",
} as const;

const LEVELS: Array<LogLevel | "all"> = ["all", "error", "warn", "info", "debug"];

function LogsPage() {
  const desktop = isDesktopApp();
  const brainState = useBrain();
  const [lines, setLines] = useState<LogLine[]>(() =>
    desktop ? [] : (logLines as LogLine[]).map((line) => ({ ...line, atMs: 0 })),
  );
  const [ipc, setIpc] = useState<IpcLine[]>([]);
  const [files, setFiles] = useState<TelemetryFileInfo[]>([]);
  const [fileDir, setFileDir] = useState<string>("");
  const [filePreview, setFilePreview] = useState("");
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [logFile, setLogFile] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [follow, setFollow] = useState(true);
  const [level, setLevel] = useState<LogLevel | "all">("all");
  const [source, setSource] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [ask, setAsk] = useState("");
  const streamRef = useRef<HTMLPreElement | null>(null);

  const pull = useCallback(async () => {
    if (!desktop) return;
    setBusy(true);
    try {
      const snapshot = await telemetrySnapshot();
      if (snapshot) {
        setLines(snapshot.logs.map((entry, index) => telemetryEntryToLine(entry, index)));
        setIpc(snapshot.ipc.map((entry, index) => ipcEntryToLine(entry, index)));
        setLogFile(snapshot.file ?? null);
      }
      const listed = await telemetryFiles();
      if (listed.ok) {
        setFiles(listed.files);
        setFileDir(listed.dir ?? "");
      }
    } finally {
      setBusy(false);
    }
  }, [desktop]);

  useEffect(() => {
    if (!desktop) return;
    void pull();
    const offLog = onTelemetryLog((entry) => {
      setLines((prev) => appendLogLines(prev, [telemetryEntryToLine(entry)]));
    });
    const offIpc = onTelemetryIpc((entry) => {
      setIpc((prev) => appendIpcLines(prev, [ipcEntryToLine(entry)]));
    });
    const offClear = onTelemetryCleared(() => {
      void pull();
    });
    const onVisible = () => {
      if (!document.hidden) void pull();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      offLog();
      offIpc();
      offClear();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [desktop, pull]);

  useEffect(() => {
    if (!follow) return;
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, follow]);

  useEffect(() => {
    registerLogsAsk((prompt) => {
      const result = brain.send(prompt, { extra: formatLogsExtra() });
      if (!result.accepted) toast.error(result.message || "FRIDAY is busy.");
    });
    return () => registerLogsAsk(null);
  }, []);

  useEffect(() => {
    publishLogsSession({
      desktop,
      file: logFile,
      follow,
      lines,
      ipc,
      lastErrors: summarizeLogErrors(lines),
    });
  }, [desktop, logFile, follow, lines, ipc]);

  const sources = useMemo(() => {
    const set = new Set(lines.map((line) => line.source));
    return ["all", ...[...set].sort()];
  }, [lines]);

  const visible = useMemo(
    () => filterLogLines(lines, { level, source, query }),
    [lines, level, source, query],
  );

  const errors = summarizeLogErrors(lines);

  const copyBuffer = async () => {
    const text = visible
      .map((line) => `${line.at} [${line.level}] ${line.source} ${line.message}`)
      .join("\n");
    await copyText(text);
    toast.success("Copied the visible log lines.");
  };

  const onClear = async () => {
    if (!desktop) {
      setLines([]);
      return;
    }
    if (!window.confirm("Clear the live log ring? The files under logs/ stay on disk.")) return;
    await telemetryClear();
    setLines([]);
    setIpc([]);
  };

  const onOpenFile = async (rel: string) => {
    setOpenFile(rel);
    const result = await telemetryReadFile(rel);
    if (!result.ok) {
      toast.error(result.error ?? "Could not read that log file.");
      return;
    }
    setFilePreview(result.text ?? "");
  };

  const askFriday = () => {
    const text = ask.trim();
    if (!text || brainState.activeRunId) return;
    setAsk("");
    const prompt = /log/i.test(text) ? text : `${text} in the logs`;
    brain.send(prompt, { extra: formatLogsExtra() });
  };

  const recent = brainState.messages.slice(-8);

  return (
    <AppShell
      title="Logs"
      subtitle="Kernel, main, IPC and disk logs · live"
      actions={
        <div className="flex items-center gap-2">
          {desktop ? (
            <Button size="sm" variant="ghost" onClick={() => revealWorkspaceFolder("logs")}>
              <FolderOpen className="size-3.5" /> Folder
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => void copyBuffer()}>
            <Copy className="size-3.5" /> Copy
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setFollow((value) => !value)}>
            {follow ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
            {follow ? "Pause follow" : "Follow"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void onClear()}>
            <Trash2 className="size-3.5" /> Clear
          </Button>
          {desktop ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void pull()}>
              <RefreshCw className={`size-4 ${busy ? "animate-spin" : ""}`} /> Refresh
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="space-y-4">
        <Panel
          title="Stream"
          hint={
            desktop
              ? `${visible.length}/${lines.length} live · ${logFile || "memory"}`
              : "preview sample"
          }
        >
          <div className="mb-2 flex flex-wrap gap-1.5">
            {LEVELS.map((item) => (
              <Button
                key={item}
                size="sm"
                variant={level === item ? "default" : "outline"}
                onClick={() => setLevel(item)}
              >
                {item}
              </Button>
            ))}
          </div>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {sources.map((item) => (
              <Button
                key={item}
                size="sm"
                variant={source === item ? "default" : "outline"}
                onClick={() => setSource(item)}
              >
                {item}
              </Button>
            ))}
          </div>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter the live buffer"
            className="mb-2 h-8 font-mono text-xs"
          />
          <pre
            ref={streamRef}
            className="max-h-[min(32rem,calc(100vh-12rem))] overflow-auto rounded-sm bg-background p-3 font-mono text-xs leading-relaxed"
          >
            {visible.length === 0 ? (
              <div className="text-muted-foreground">no log entries yet</div>
            ) : (
              visible.map((l) => (
                <div key={l.id}>
                  <span className="text-muted-foreground">{l.at}</span>{" "}
                  <span className={tone[l.level]}>{`[${l.level}]`}</span>{" "}
                  <span className="text-accent">{l.source}</span> <span>{l.message}</span>
                </div>
              ))
            )}
          </pre>
          {errors ? (
            <pre className="mt-2 max-h-32 overflow-auto rounded-sm bg-background p-3 font-mono text-[11px] leading-relaxed text-destructive">
              {errors}
            </pre>
          ) : null}
        </Panel>

        <Panel
          title="Ask FRIDAY"
          hint={brainState.activeRunId ? "thinking" : "same brain as Chat / Auto Mode"}
        >
          <p className="mb-2 text-xs text-muted-foreground">
            FRIDAY can see this live ring (sources, last errors, disk file). Ask what failed, or
            tell her to find warnings. Clearing the ring does not delete files under logs/.
          </p>
          <div className="mb-3 max-h-48 space-y-2 overflow-auto text-sm">
            {recent.length ? (
              recent.map((line) => (
                <p key={line.id} className="whitespace-pre-wrap">
                  <span className="mr-2 text-[10px] uppercase tracking-widest text-muted-foreground">
                    {line.role === "user" ? "You" : "FRIDAY"}
                  </span>
                  {line.text}
                </p>
              ))
            ) : (
              <p className="text-xs text-muted-foreground">
                No chat yet this session. Type below, or ask her to find errors in the logs.
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
              placeholder="Find the errors in the logs"
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

        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="IPC" hint={`${ipc.length} recent calls`}>
            <pre className="max-h-56 overflow-auto rounded-sm bg-background p-3 font-mono text-[11px] leading-relaxed">
              {ipc.length ? (
                ipc.slice(-80).map((row) => (
                  <div key={row.id} className={cn(!row.ok && "text-destructive")}>
                    {row.at} {row.ok ? "ok" : "fail"} {row.ms}ms {row.channel}
                    {row.error ? ` ${row.error}` : ""}
                  </div>
                ))
              ) : (
                <div className="text-muted-foreground">no IPC calls recorded yet</div>
              )}
            </pre>
          </Panel>

          <Panel
            title="Files"
            hint={fileDir || "logs/"}
            actions={
              desktop ? (
                <Button size="sm" variant="ghost" onClick={() => void pull()}>
                  <RefreshCw className="size-3.5" /> Reload
                </Button>
              ) : null
            }
          >
            <div className="max-h-32 space-y-1 overflow-auto font-mono text-[11px]">
              {files.map((file) => (
                <button
                  key={file.rel}
                  className={cn(
                    "block w-full truncate rounded-sm px-1.5 py-0.5 text-left",
                    openFile === file.rel
                      ? "bg-primary/10 text-foreground"
                      : "text-muted-foreground",
                  )}
                  onClick={() => void onOpenFile(file.rel)}
                  title={file.rel}
                >
                  {file.rel} · {file.size}b
                </button>
              ))}
              {!files.length ? (
                <p className="text-muted-foreground">
                  {desktop ? "No log files on disk yet." : "Disk logs are desktop-only."}
                </p>
              ) : null}
            </div>
            <pre className="mt-2 max-h-40 overflow-auto rounded-sm bg-background p-3 font-mono text-[11px] text-muted-foreground">
              {filePreview || "Open a file to read its tail."}
            </pre>
          </Panel>
        </div>
      </div>
    </AppShell>
  );
}
