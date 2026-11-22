import type { EchoLiveDiagnostics } from "./voice-engine/echo-live";
import { figureLine, LatencyMonitor, voiceLatency } from "./voice-engine/latency-monitor";

/** One read-only diagnostics row in the shape the Voice diagnostics list already uses. */
export type DiagnosticsRow = { label: string; value: string; bad?: boolean };

/** The three stored switches these rows report; nothing here changes them. */
export type VoiceSwitches = { instantAck?: boolean; eagerTurn?: boolean; echoReference?: boolean };

const onOff = (value: boolean | undefined): string => (value === true ? "on" : "off");

/** A derived latency figure, or "not used yet" until the stages behind it were really stamped. Never a made-up number. */
export function stampedFigure(metric: string, monitor: LatencyMonitor = voiceLatency): string {
  const line = figureLine(metric, monitor);
  return monitor.summary(metric) ? line : "not used yet";
}

const decibels = (value: number | null): string =>
  value === null || !Number.isFinite(value) ? "no measurement yet" : `${value.toFixed(1)} dB`;

/** The echo reference rows. Empty when the reference is switched off: nothing to report, nothing invented. */
export function echoReferenceRows(diagnostics: EchoLiveDiagnostics): DiagnosticsRow[] {
  if (!diagnostics.enabled) return [];
  return [
    {
      label: "echo reference (reduction measured by the local canceller)",
      value: decibels(diagnostics.reductionDb),
    },
    {
      label: "echo reference delay",
      value:
        diagnostics.delayMs === null || !Number.isFinite(diagnostics.delayMs)
          ? "no measurement yet"
          : `${Math.round(diagnostics.delayMs)} ms`,
    },
    {
      label: "echo reference frames (cancelled / passed unchanged)",
      value: `${diagnostics.cancelledFrames} cancelled · ${diagnostics.passedFrames} passed`,
    },
    { label: "echo reference shadow check", value: diagnostics.shadowReason || "not run yet" },
    {
      label: "echo reference scope",
      value:
        "exists only while raw-sample playback (voice.pcmPlayback) is used; unverified on the owner's PC",
    },
  ];
}

/** Instant acknowledgement and early start: the stored setting, then what the latency monitor really stamped. */
export function earlyStartRows(
  switches: VoiceSwitches,
  monitor: LatencyMonitor = voiceLatency,
): DiagnosticsRow[] {
  return [
    {
      label: "instant acknowledgement (setting · armed to audible)",
      value: `${onOff(switches.instantAck)} · ${stampedFigure("ackArmedToAudible", monitor)}`,
    },
    {
      label: "early start (setting · started to resolved)",
      value: `${onOff(switches.eagerTurn)} · ${stampedFigure("eagerOverlap", monitor)}`,
    },
    { label: "echo reference (setting)", value: onOff(switches.echoReference) },
  ];
}
