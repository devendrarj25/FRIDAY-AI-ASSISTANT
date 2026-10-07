import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Copy, Home, ShieldAlert, Square, Trash2 } from "lucide-react";
import { AppShell, Panel } from "@/components/friday/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { brain } from "@/lib/friday/brain-engine";
import { formatTerminalExtra, registerTerminalAsk } from "@/lib/friday/terminal-awareness";
import { ops } from "@/lib/friday/ops-engine";
import { useBrain } from "@/lib/friday/use-brain";
import { useOps } from "@/lib/friday/use-ops";

export const Route = createFileRoute("/terminal")({
  head: () => ({
    meta: [
      { title: "Terminal — FRIDAY" },
      {
        name: "description",
        content:
          "A permission-gated console into cmd, PowerShell, WSL and the managed Python environment, driven by you or by FRIDAY.",
      },
      { property: "og:title", content: "Terminal — FRIDAY" },
      { property: "og:description", content: "Permission-gated local shell console with FRIDAY." },
    ],
  }),
  component: TerminalPage,
});

const TONE = {
  cmd: "text-primary",
  out: "text-muted-foreground",
  ok: "text-success",
  warn: "text-warning",
  err: "text-destructive",
} as const;

function TerminalPage() {
  const { terminal, cwd, pendingCommand, shell, shells, runningCommand, history } = useOps();
  const brainState = useBrain();
  const [cmd, setCmd] = useState("");
  const [ask, setAsk] = useState("");
  const [cursor, setCursor] = useState(-1);
  const scroller = useRef<HTMLPreElement>(null);

  useEffect(() => {
    void ops.initTerminal();
  }, []);

  useEffect(() => {
    registerTerminalAsk((prompt) => {
      const result = brain.send(prompt, { extra: formatTerminalExtra() });
      if (!result.accepted) ops.note("warn", result.message || "FRIDAY is busy.");
    });
    return () => registerTerminalAsk(null);
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [terminal]);

  const run = () => {
    if (!cmd.trim()) return;
    ops.submitCommand(cmd);
    setCursor(-1);
    setCmd("");
  };

  const askFriday = () => {
    const text = ask.trim();
    if (!text || brainState.activeRunId) return;
    setAsk("");
    brain.send(text, { extra: formatTerminalExtra() });
  };

  const copyBuffer = async () => {
    const text = terminal.map((line) => line.text).join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard may be denied in the browser preview */
    }
  };

  const recent = brainState.messages.slice(-8);

  return (
    <AppShell title="Terminal" subtitle="cmd · PowerShell · WSL · Git Bash · FRIDAY venv">
      <div className="space-y-4">
        <Panel
          title="Console"
          hint={`${cwd}${runningCommand ? " · running" : ""}`}
          actions={
            <div className="flex items-center gap-2">
              <select
                value={shell}
                onChange={(e) => ops.setShell(e.target.value)}
                className="rounded-sm border border-border bg-surface px-2 py-1 font-mono text-xs"
                aria-label="Shell profile"
              >
                {(shells.length
                  ? shells
                  : [{ id: shell, label: shell, available: true, bin: shell }]
                ).map((s) => (
                  <option key={s.id} value={s.id} disabled={!s.available} title={s.reason}>
                    {s.label}
                    {s.available ? "" : " (missing)"}
                  </option>
                ))}
              </select>
              <Button size="sm" variant="ghost" onClick={() => ops.submitCommand("home")}>
                <Home className="size-3.5" /> Home
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void copyBuffer()}>
                <Copy className="size-3.5" /> Copy
              </Button>
              {runningCommand ? (
                <Button size="sm" variant="outline" onClick={() => ops.cancelCommand()}>
                  <Square className="size-3.5" /> Stop
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" onClick={() => ops.clearTerminal()}>
                <Trash2 className="size-3.5" /> Clear
              </Button>
            </div>
          }
        >
          <pre
            ref={scroller}
            className="max-h-96 overflow-auto rounded-sm bg-background p-3 font-mono text-xs leading-relaxed"
          >
            {terminal.map((line) => (
              <div key={line.id} className={TONE[line.kind]}>
                {line.text}
              </div>
            ))}
          </pre>

          <div className="mt-3 flex gap-2">
            <Input
              value={cmd}
              onChange={(e) => setCmd(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  run();
                } else if (e.key === "c" && e.ctrlKey && runningCommand) {
                  e.preventDefault();
                  ops.cancelCommand();
                } else if (e.key === "ArrowUp" && history.length) {
                  e.preventDefault();
                  const next = Math.min(cursor + 1, history.length - 1);
                  setCursor(next);
                  setCmd(history[next] ?? "");
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  const next = Math.max(cursor - 1, -1);
                  setCursor(next);
                  setCmd(next === -1 ? "" : (history[next] ?? ""));
                }
              }}
              placeholder={
                runningCommand
                  ? "Send input to the running command…"
                  : "Command, or ? ask FRIDAY…  (help)"
              }
              className="bg-surface font-mono text-sm"
            />
            <Button disabled={!cmd.trim()} onClick={run}>
              {runningCommand ? "Send" : "Run"}
            </Button>
          </div>
        </Panel>

        <Panel
          title="Ask FRIDAY"
          hint={brainState.activeRunId ? "thinking" : "same brain as Chat / Auto Mode"}
        >
          <p className="mb-2 text-xs text-muted-foreground">
            FRIDAY can see this console (cwd, shell, last command, live buffer). Ask what a line
            means, why it failed, or what to run next. Commands she runs still wait for approval.
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
                No chat yet this session. Type below, or prefix a console line with ?.
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
              placeholder="Why did that fail? · what should I run next?"
              className="bg-surface text-sm"
              disabled={Boolean(brainState.activeRunId)}
            />
            <Button disabled={!ask.trim() || Boolean(brainState.activeRunId)} onClick={askFriday}>
              Ask
            </Button>
          </div>
        </Panel>

        {pendingCommand ? (
          <Panel title="Pending approval">
            <div className="flex items-start gap-2.5">
              <ShieldAlert className="mt-0.5 size-4 text-warning" />
              <div className="min-w-0 flex-1">
                <p className="text-sm">
                  FRIDAY wants to run <span className="font-mono">{pendingCommand.command}</span> in{" "}
                  <span className="font-mono">{pendingCommand.cwd}</span>
                </p>
                <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                  risk: {pendingCommand.risk} · gated by the shell.cmd tool permission
                </p>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => ops.resolveCommand(false)}>
                  Deny
                </Button>
                <Button size="sm" onClick={() => ops.resolveCommand(true)}>
                  Allow once
                </Button>
              </div>
            </div>
          </Panel>
        ) : null}
      </div>
    </AppShell>
  );
}
