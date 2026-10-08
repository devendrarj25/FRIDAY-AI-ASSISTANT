import { useState, useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";
import { assistantMode } from "@/lib/friday/assistant-mode";
import { redactDiagnostics } from "@/lib/friday/voice-doctor";
import type { AssistantModeState } from "@/lib/friday/assistant-mode";
import { voiceGate } from "@/lib/friday/voice-audio";

/**
 * Voice Diagnostics — the real values behind Auto Mode, in the Auto Mode
 * style. Nothing here is decorative: every row is read from the live voice
 * state (microphone, VAD, wake engine, STT, TTS, session), and the two buttons
 * run the REAL probes in the main process.
 */
export function VoiceDiagnostics({ voice }: { voice: AssistantModeState }) {
  const [checks, setChecks] = useState<
    Array<{ id: string; label: string; ok: boolean; detail: string }>
  >([]);
  const [busy, setBusy] = useState(false);
  const gate = useSyncExternalStore(
    (fn) => voiceGate.subscribe(() => fn()),
    () => voiceGate.getSnapshot(),
    () => voiceGate.getSnapshot(),
  );

  const rows: Array<{ label: string; value: string; bad?: boolean }> = [
    { label: "state", value: voice.voiceState },
    {
      label: "microphone",
      value: voice.mic.available
        ? `${voice.mic.deviceLabel || "default device"} · ${voice.mic.state}`
        : `unavailable — ${voice.mic.reason ?? "no device"}`,
      bad: !voice.mic.available,
    },
    {
      label: "vad",
      value: gate.running
        ? `level ${gate.level.toFixed(3)} · floor ${gate.noiseFloor.toFixed(3)} · ${
            gate.speech ? "speech" : gate.speakingGuard ? "guarded" : "silence"
          }`
        : "analyser stopped",
      bad: !gate.running,
    },
    {
      label: "wake engine",
      value: voice.wakeEngine.ready
        ? `${voice.wakeEngine.engine} · ${voice.wakeEngine.model ?? "model"}`
        : `transcript fallback — ${voice.wakeEngine.reason ?? "native wake model not ready"}`,
      bad: !voice.wakeEngine.ready,
    },
    {
      label: "last wake",
      value: voice.lastWake ? `${voice.lastWake.engine} · ${voice.lastWake.detail}` : "—",
    },
    {
      label: "stt",
      value: `${voice.stt.engine}${voice.stt.model ? ` · ${voice.stt.model}` : ""} · ${
        voice.stt.ready ? "verified" : "not verified"
      }${voice.stt.lastLatencyMs ? ` · ${voice.stt.lastLatencyMs}ms` : ""}`,
      bad: Boolean(voice.stt.lastError),
    },
    { label: "last transcript", value: voice.stt.lastTranscript || "—" },
    {
      label: "tts",
      value: voice.tts.engine
        ? `${voice.tts.engine.toUpperCase()}${voice.tts.voice ? ` · ${voice.tts.voice}` : ""}`
        : "not used yet",
      bad: voice.tts.engine === "none",
    },
    {
      label: "session",
      value: `${voice.mode} · ${voice.paused ? "paused" : "active"} · hands-free ${
        voice.handsFree ? "on" : "off"
      }`,
    },
    ...(voice.error ? [{ label: "error", value: voice.error, bad: true }] : []),
  ];

  const runProbes = async () => {
    setBusy(true);
    try {
      const result = await assistantMode.verifyVoiceRuntime();
      setChecks(result.checks);
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="mt-2 rounded-md border border-border/50 px-2 py-1">
      <summary className="cursor-pointer font-mono text-[10px] uppercase text-muted-foreground">
        voice diagnostics · {voice.voiceState.toLowerCase()}
      </summary>
      <ul className="mt-1 space-y-0.5">
        {rows.map((row) => (
          <li key={row.label} className="flex gap-2">
            <span className="w-24 shrink-0 font-mono text-[10px] uppercase text-muted-foreground">
              {row.label}
            </span>
            <span
              className={cn(
                "min-w-0 font-mono text-[10px]",
                row.bad ? "text-destructive" : "text-foreground/80",
              )}
            >
              {row.value}
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-1 flex gap-3">
        <button
          type="button"
          onClick={() => void runProbes()}
          disabled={busy}
          className="font-mono text-[10px] uppercase text-accent disabled:opacity-50"
        >
          {busy ? "probing…" : "run voice self-test"}
        </button>
        <button
          type="button"
          onClick={() => void assistantMode.refreshWakeEngine(true)}
          className="font-mono text-[10px] uppercase text-accent"
        >
          recheck wake engine
        </button>
        <button
          type="button"
          onClick={() => assistantMode.fixVoice()}
          className="font-mono text-[10px] uppercase text-accent"
        >
          fix voice
        </button>
        <button
          type="button"
          onClick={() =>
            void navigator.clipboard?.writeText(
              redactDiagnostics(rows.map((row) => `${row.label}: ${row.value}`).join("\n")),
            )
          }
          className="font-mono text-[10px] uppercase text-accent"
        >
          copy diagnostics
        </button>
      </div>
      {checks.length ? (
        <ul className="mt-1 space-y-0.5">
          {checks.map((check) => (
            <li key={check.id} className="flex gap-2">
              <span
                className={cn(
                  "w-24 shrink-0 font-mono text-[10px] uppercase",
                  check.ok ? "text-accent" : "text-destructive",
                )}
              >
                {check.ok ? "pass" : "fail"}
              </span>
              <span className="min-w-0 font-mono text-[10px] text-muted-foreground">
                {check.label} — {check.detail}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}
