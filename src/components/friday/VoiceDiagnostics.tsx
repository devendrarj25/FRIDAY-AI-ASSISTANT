import {
  ClipboardCopy,
  Download,
  Mic,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Volume2,
  Wrench,
} from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { assistantMode, voiceBudgetLine } from "@/lib/friday/assistant-mode";
import { heardQualityLine, speechModelHint } from "@/lib/friday/asr-bias";
import { wakeEngineDoctorRow } from "@/lib/friday/wake-engine";
import { preferences } from "@/lib/friday/preferences";
import { models } from "@/lib/friday/models-engine";
import { hearingCounters, hearingCountersLine } from "@/lib/friday/voice-hearing";
import {
  figureLine,
  unstampedStagesLine,
  voiceLatency,
} from "@/lib/friday/voice-engine/latency-monitor";
import { echoDiagnostics } from "@/lib/friday/voice-engine/echo-live";
import {
  earlyStartRows,
  echoReferenceRows,
  resourceRows,
  speechWorkerRows,
  thisPcRows,
  wakeGuardRows,
  type PcFactsView,
  type ResourceView,
  type SpeechWorkerView,
} from "@/lib/friday/voice-diagnostics-rows";
import { captureCounters, captureTapCount } from "@/lib/friday/pcm-capture";
import { desktopApi } from "@/lib/friday/desktop";
import { useVoiceProfile } from "@/lib/friday/use-voice-profile";
import { turnTraceLine, voiceTurn, whereItStopped } from "@/lib/friday/voice-turn-trace";
import {
  formatVoiceProbeReport,
  liveVoiceRuntimeLine,
  redactDiagnostics,
  selfTestSummary,
  voiceDoctorMarks,
  voiceSelfTestMatrix,
} from "@/lib/friday/voice-doctor";
import type { AssistantModeState } from "@/lib/friday/assistant-mode";
import { gateSpeechKey, voiceGate } from "@/lib/friday/voice-audio";
import {
  captureClockNote,
  keepUtteranceWavs,
  setKeepUtteranceWavs,
} from "@/lib/friday/voice-hearing";

/**
 * Voice Diagnostics — the real values behind Auto Mode, in the Auto Mode
 * style. Nothing here is decorative: every row is read from the live voice
 * state (microphone, VAD, wake engine, STT, TTS, session), and the two buttons
 * run the REAL probes in the main process.
 */
export function VoiceDiagnostics({ voice }: { voice: AssistantModeState }) {
  const myVoice = useVoiceProfile();
  const [checks, setChecks] = useState<
    Array<{
      id: string;
      label: string;
      ok: boolean;
      detail: string;
      optional?: boolean;
      installId?: string;
      rollbackId?: string;
    }>
  >([]);
  const [worker, setWorker] = useState<SpeechWorkerView>({ phase: "loading" });
  const [pc, setPc] = useState<PcFactsView>({ phase: "loading" });
  const [resources, setResources] = useState<ResourceView>({ phase: "loading" });
  const [restoreAsk, setRestoreAsk] = useState("");
  const [restoreLine, setRestoreLine] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [micBusy, setMicBusy] = useState(false);
  const [speakBusy, setSpeakBusy] = useState(false);
  const [micLine, setMicLine] = useState("");
  const [speakLine, setSpeakLine] = useState("");
  const [micLevel, setMicLevel] = useState(0);
  const micLevelRef = useRef(0);
  const [keepWav, setKeepWav] = useState(keepUtteranceWavs);
  const levelRef = useRef<HTMLSpanElement>(null);
  const gateKey = useSyncExternalStore(
    (fn) => voiceGate.subscribe(() => fn()),
    () => gateSpeechKey(voiceGate.getSnapshot()),
    () => gateSpeechKey(voiceGate.getSnapshot()),
  );
  const [runningFlag, speechFlag, guardFlag, floor] = gateKey.split("|");
  const gate = {
    running: runningFlag === "1",
    speech: speechFlag === "1",
    speakingGuard: guardFlag === "1",
    noiseFloor: Number(floor) || 0,
  };
  useEffect(() => {
    const paint = () => {
      const node = levelRef.current;
      if (node) node.textContent = voiceGate.getSnapshot().level.toFixed(3);
    };
    paint();
    return voiceGate.subscribe(() => paint());
  }, [gate.running]);

  const readWorker = async (): Promise<SpeechWorkerView> => {
    const api = desktopApi();
    if (!api?.sttStatus) return { phase: "offline" };
    try {
      const [status, budget] = await Promise.all([
        api.sttStatus(true, true, false),
        api.voiceBudget?.() ?? Promise.resolve(null),
      ]);
      return { phase: "ready", cache: status?.cache ?? null, budget: budget?.ok ? budget : null };
    } catch (error) {
      return { phase: "error", message: String((error as Error)?.message || error).slice(0, 120) };
    }
  };
  const readPc = async (force = false): Promise<PcFactsView> => {
    const api = desktopApi();
    if (!api?.hardwareFacts) return { phase: "offline" };
    try {
      const answer = await api.hardwareFacts(force);
      if (!answer?.ok || !answer.facts) {
        return { phase: "error", message: String(answer?.error || "no answer").slice(0, 120) };
      }
      return { phase: "ready", facts: answer.facts };
    } catch (error) {
      return { phase: "error", message: String((error as Error)?.message || error).slice(0, 120) };
    }
  };
  const readResources = async (): Promise<ResourceView> => {
    const api = desktopApi();
    if (!api?.governorStatus) return { phase: "offline" };
    try {
      const answer = await api.governorStatus();
      if (!answer?.ok) {
        return { phase: "error", message: String(answer?.error || "no answer").slice(0, 120) };
      }
      return { phase: "ready", status: answer };
    } catch (error) {
      return { phase: "error", message: String((error as Error)?.message || error).slice(0, 120) };
    }
  };
  useEffect(() => {
    let live = true;
    void readResources().then((view) => {
      if (live) setResources(view);
    });
    void readWorker().then((view) => {
      if (live) setWorker(view);
    });
    void readPc().then((view) => {
      if (live) setPc(view);
    });
    return () => {
      live = false;
    };
  }, []);

  const rows: Array<{ label: string; value: string; bad?: boolean }> = [
    { label: "state", value: voice.voiceState },
    {
      label: "microphone",
      value: voice.mic.available
        ? `${voice.mic.deviceLabel || "default device"} · ${voice.mic.state} · ${captureClockNote(voiceGate.inputRate())}`
        : `unavailable — ${voice.mic.reason ?? "no device"}`,
      bad: !voice.mic.available,
    },
    {
      label: "vad",
      value: gate.running
        ? `level · floor ${gate.noiseFloor.toFixed(3)} · ${
            gate.speech ? "speech" : gate.speakingGuard ? "guarded" : "silence"
          }`
        : "analyser stopped",
      bad: !gate.running,
    },
    {
      label: "wake engine",
      ...wakeEngineDoctorRow(voice.wakeEngine),
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
      label: "how sure",
      value: heardQualityLine(assistantMode.heardQuality(), voice.stt.lastTranscript || ""),
    },
    ...(speechModelHint(
      voice.stt.model || "",
      preferences.getSnapshot().voice.recognitionLang || "",
    )
      ? [
          {
            label: "speech model",
            value: speechModelHint(
              voice.stt.model || "",
              preferences.getSnapshot().voice.recognitionLang || "",
            ),
            bad: true,
          },
        ]
      : []),
    {
      label: "last turn",
      value: turnTraceLine(voiceTurn()),
      bad: Boolean(
        whereItStopped(voiceTurn())?.reason &&
        whereItStopped(voiceTurn())?.reason !== "never reached",
      ),
    },
    {
      label: "turn latency (heard to spoken)",
      value: voiceLatency.line(),
    },
    { label: "Voice latency budget (speech end to first sound)", value: voiceBudgetLine() },
    {
      label: "first sound after the final transcript (final to first sample)",
      value: figureLine("finalToFirstAudible"),
    },
    {
      label: "first sound after speech end, brain included (speech end is an estimate)",
      value: figureLine("endToFirstAudible"),
    },
    {
      label: "brain first token to first sound",
      value: figureLine("brainTokenToFirstAudible"),
    },
    {
      label: "first clause to first sound (brain not included)",
      value: figureLine("firstClauseToFirstAudible"),
    },
    { label: "early recognition overlap", value: figureLine("eagerOverlap") },
    { label: "acknowledgement (armed to audible)", value: figureLine("ackArmedToAudible") },
    ...earlyStartRows(preferences.getSnapshot().voice),
    ...echoReferenceRows(echoDiagnostics()),
    ...voiceGate.trackProcessingRows(),
    ...wakeGuardRows(voiceGate.wake.snapshot()),
    { label: "voice stages nothing stamps yet", value: unstampedStagesLine() },
    { label: "live wake word", value: assistantMode.liveWakeLine() },
    {
      label: "barge-in shadow (acoustic detector vs the live pause)",
      value: assistantMode.bargeShadowLine(),
    },
    {
      label: "barge-in readiness (is there enough real-device evidence to switch)",
      value: assistantMode.bargeShadowVerdictLine(),
    },
    {
      label: "self-test (16 checks)",
      value: selfTestSummary(
        voiceSelfTestMatrix({
          marks: voiceDoctorMarks(),
          measured: new Set(voiceLatency.metrics()),
          desktop: Boolean(desktopApi()?.voiceStreamOpen),
        }),
      ),
    },
    {
      label: "first sound (request to first sample)",
      value: voiceLatency.line("firstAudible"),
    },
    {
      label: "speech stop after interruption (stop asked, not measured at the speaker)",
      value: voiceLatency.line("audibleStop"),
    },
    {
      label: "cloud speech first chunk",
      value: voiceLatency.line("ttsFirstChunk"),
    },
    {
      label: "voice tone",
      value: assistantMode.voiceTone()?.line ?? "no voiced utterance yet",
    },
    { label: "heard / dropped", value: hearingCountersLine(hearingCounters()) },
    {
      label: "my voice (saved profile)",
      value: myVoice?.profile.built
        ? `built${myVoice.profile.stale ? ", recordings changed since" : ""} · voiceprint ${myVoice.profile.summary?.speaker?.ready ? "ready" : "not ready"} · personal wake ${myVoice.profile.summary?.wake?.ready ? "ready" : "not ready"}`
        : `no profile yet (${myVoice?.counts.total ?? 0} recording(s))`,
    },
    {
      label: "capture frames (numbered / listeners dropped)",
      value: `${captureCounters().frames} frames · ${captureCounters().samples} samples · ${captureCounters().tapsDropped} listener(s) dropped · ${captureTapCount()} listening`,
    },
    { label: "route", value: liveVoiceRuntimeLine(voice) },
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
    ...speechWorkerRows(worker),
    ...thisPcRows(pc),
    ...resourceRows(resources),
    ...(voice.error ? [{ label: "error", value: voice.error, bad: true }] : []),
  ];

  const runProbes = async () => {
    setBusy(true);
    try {
      const result = await assistantMode.verifyVoiceRuntime();
      setChecks(formatVoiceProbeReport(result.checks).checks);
    } finally {
      setBusy(false);
    }
  };

  return (
    // Opened from the "diagnostics" button on the Live captions strip, so it
    // renders open: the strip button is the only open/close.
    <section aria-label="Voice diagnostics">
      <p className="mb-1 text-meta-sm uppercase text-primary/70">
        voice diagnostics · {voice.voiceState.toLowerCase()}
      </p>
      <ul className="mt-1 space-y-0.5">
        {rows.map((row) => (
          <li key={row.label} className="flex gap-2">
            <span className="w-24 shrink-0 text-meta-sm uppercase text-muted-foreground">
              {row.label}
            </span>
            <span
              className={cn(
                "min-w-0 text-meta-sm",
                row.bad ? "text-destructive" : "text-foreground/80",
              )}
            >
              {row.label === "vad" && gate.running ? (
                <>
                  level <span ref={levelRef}>0.000</span>
                  {` · floor ${gate.noiseFloor.toFixed(3)} · ${
                    gate.speech ? "speech" : gate.speakingGuard ? "guarded" : "silence"
                  }`}
                </>
              ) : (
                row.value
              )}
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-1 flex flex-wrap gap-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-accent"
          onClick={() => {
            setMicBusy(true);
            setMicLevel(0);
            setMicLine("recording 3 seconds…");
            void assistantMode
              .micTest((level) => {
                micLevelRef.current = level;
                setMicLevel(level);
              })
              .then((result) =>
                setMicLine(`${result.line} · level ${micLevelRef.current.toFixed(3)}`),
              )
              .finally(() => setMicBusy(false));
          }}
          disabled={micBusy}
        >
          <Mic className="size-3" aria-hidden="true" />
          {micBusy ? "Listening…" : "Mic test"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-accent"
          onClick={() => {
            setSpeakBusy(true);
            setSpeakLine("Speaking…");
            void assistantMode
              .speakTest()
              .then((result) => setSpeakLine(result.detail))
              .finally(() => setSpeakBusy(false));
          }}
          disabled={speakBusy}
        >
          <Volume2 className="size-3" aria-hidden="true" />
          {speakBusy ? "Speaking…" : "Speak test"}
        </Button>
        <label className="flex items-center gap-1 text-meta-sm uppercase text-muted-foreground">
          <input
            type="checkbox"
            checked={keepWav}
            onChange={(event) => {
              const on = event.target.checked;
              setKeepWav(on);
              setKeepUtteranceWavs(on);
            }}
          />
          keep last 5 wavs
        </label>
        <Button type="button" variant="ghost" size="sm" onClick={() => runProbes()} disabled={busy}>
          <ShieldCheck className="size-3" aria-hidden="true" />
          {busy ? "Probing…" : "Run voice self-test"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-accent"
          onClick={() => {
            setWorker({ phase: "loading" });
            void readWorker().then(setWorker);
          }}
          disabled={worker.phase === "loading"}
        >
          <RefreshCw className="size-3" aria-hidden="true" />
          {worker.phase === "loading" ? "Reading…" : "Refresh speech worker"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-accent"
          onClick={() => {
            setPc({ phase: "loading" });
            void readPc(true).then(setPc);
          }}
          disabled={pc.phase === "loading"}
        >
          <RefreshCw className="size-3" aria-hidden="true" />
          {pc.phase === "loading" ? "Reading…" : "Refresh this PC"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-accent"
          onClick={() => {
            setResources({ phase: "loading" });
            void readResources().then(setResources);
          }}
          disabled={resources.phase === "loading"}
        >
          <RefreshCw className="size-3" aria-hidden="true" />
          {resources.phase === "loading" ? "Reading…" : "Refresh resources"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-accent"
          onClick={() => assistantMode.refreshWakeEngine(true)}
        >
          <RefreshCw className="size-3" aria-hidden="true" />
          Recheck wake engine
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => assistantMode.fixVoice()}>
          <Wrench className="size-3" aria-hidden="true" />
          Fix voice
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-accent"
          onClick={() => assistantMode.resetMicrophone()}
        >
          <RotateCcw className="size-3" aria-hidden="true" />
          Reset microphone
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-accent"
          onClick={() => {
            const probes = formatVoiceProbeReport(checks);
            const live = redactDiagnostics(
              [
                rows.map((row) => `${row.label}: ${row.value}`).join("\n"),
                assistantMode.micDebug(),
                `barge-in shadow data:\n${assistantMode.bargeShadowReport()}`,
                `soak record:\n${assistantMode.soakReport()}`,
              ]
                .filter(Boolean)
                .join("\n"),
            );
            void navigator.clipboard?.writeText(
              [probes.diagnostics, live].filter(Boolean).join("\n"),
            );
          }}
        >
          <ClipboardCopy className="size-3" aria-hidden="true" />
          Copy diagnostics
        </Button>
      </div>
      {micBusy ? (
        <p className="mt-1 text-meta-sm text-foreground/80">mic level {micLevel.toFixed(3)}</p>
      ) : null}
      {micLine ? <p className="mt-1 text-meta-sm text-foreground/80">{micLine}</p> : null}
      {speakLine ? <p className="mt-1 text-meta-sm text-foreground/80">{speakLine}</p> : null}
      {checks.length ? (
        <ul className="mt-1 space-y-0.5">
          {checks.map((check) => (
            <li key={check.id} className="flex gap-2">
              <span
                className={cn(
                  "w-24 shrink-0 text-meta-sm uppercase",
                  check.optional || check.ok ? "text-accent" : "text-destructive",
                )}
              >
                {check.optional ? "optional" : check.ok ? "pass" : "fail"}
              </span>
              <span className="min-w-0 text-meta-sm text-muted-foreground">
                {check.label} — {check.detail}
              </span>
              {check.optional && check.installId ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-accent"
                  onClick={() => models.install(check.installId || "")}
                >
                  <Download className="size-3" aria-hidden="true" />
                  Install
                </Button>
              ) : null}
              {check.rollbackId ? (
                <span className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-accent"
                    onClick={() => {
                      const id = check.rollbackId || "";
                      if (restoreAsk !== id) {
                        setRestoreAsk(id);
                        return;
                      }
                      setRestoreAsk("");
                      setRestoreLine((lines) => ({ ...lines, [id]: "restoring…" }));
                      const restore = desktopApi()?.restoreVoiceModel;
                      void (
                        restore
                          ? restore(id)
                          : Promise.resolve({
                              ok: false,
                              revision: "",
                              error: "restore runs in the installed FRIDAY app",
                            })
                      )
                        .then((result) =>
                          setRestoreLine((lines) => ({
                            ...lines,
                            [id]: result.ok
                              ? `restored revision ${(result.revision || "").slice(0, 8) || "previous"}; run the voice self-test again`
                              : `not restored: ${result.error || "unknown error"}`,
                          })),
                        )
                        .catch((error: unknown) =>
                          setRestoreLine((lines) => ({
                            ...lines,
                            [id]: `not restored: ${String((error as Error)?.message || error).slice(0, 120)}`,
                          })),
                        );
                    }}
                  >
                    <RotateCcw className="size-3" aria-hidden="true" />
                    {restoreAsk === check.rollbackId ? "Confirm restore" : "Restore"}
                  </Button>
                  {restoreLine[check.rollbackId] ? (
                    <span className="text-meta-sm text-foreground/80">
                      {restoreLine[check.rollbackId]}
                    </span>
                  ) : null}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
