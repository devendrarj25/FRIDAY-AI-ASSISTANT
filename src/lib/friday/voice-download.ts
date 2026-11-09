/**
 * FRIDAY · what the Auto window shows while a speech model or the speech engine is fetched or checked.
 *
 * One event shape comes from the main process (`electron/stt.cjs` → `voice:stt-progress`). This turns it
 * into the label, percent and detail line of the bar. Nothing is invented: a missing size, speed or time
 * left is simply not shown.
 */

export type SttProgressPayload = {
  stage?: string;
  model?: string;
  status?: string;
  progress?: number | null;
  gbDone?: number | null;
  gbTotal?: number | null;
  speedMbps?: number | null;
  etaSeconds?: number | null;
  host?: string;
  error?: string;
  updateAvailable?: boolean;
  latest?: string;
};

export type VoiceDownload = {
  stage: "download" | "check" | "install" | "ready" | "failed";
  model: string;
  label: string;
  /** 0 to 100, or null while the size is not known yet. */
  percent: number | null;
  /** "0.4 of 1.6 GB · 12 MB/s · about 1 min left", only the parts that are known. */
  detail: string;
  updateAvailable: boolean;
};

const STAGES = new Set(["download", "check", "install", "ready", "failed"]);

export function formatEta(seconds: number): string {
  if (!(seconds > 0)) return "";
  if (seconds < 60) return "under a minute left";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  return `about ${hours} h ${minutes % 60} min left`;
}

export function describeDownload(
  payload: SttProgressPayload | null | undefined,
): VoiceDownload | null {
  const label = String(payload?.status || "")
    .trim()
    .slice(0, 120);
  if (!label) return null;
  const raw = String(payload?.stage || "download");
  const stage = (STAGES.has(raw) ? raw : "download") as VoiceDownload["stage"];
  const percent =
    typeof payload?.progress === "number" && Number.isFinite(payload.progress)
      ? Math.max(0, Math.min(100, Math.round(payload.progress)))
      : null;
  const parts: string[] = [];
  if (typeof payload?.gbTotal === "number" && payload.gbTotal > 0) {
    const done = typeof payload.gbDone === "number" ? payload.gbDone : 0;
    parts.push(`${done.toFixed(2)} of ${payload.gbTotal.toFixed(2)} GB`);
  }
  if (typeof payload?.speedMbps === "number" && payload.speedMbps > 0)
    parts.push(`${payload.speedMbps.toFixed(payload.speedMbps >= 10 ? 0 : 1)} MB/s`);
  const eta = typeof payload?.etaSeconds === "number" ? formatEta(payload.etaSeconds) : "";
  if (eta) parts.push(eta);
  if (stage === "failed" && payload?.error) parts.push(String(payload.error).slice(0, 120));
  if (stage === "check" && payload?.updateAvailable && payload.latest)
    parts.push(`newer release ${payload.latest} is available`);
  return {
    stage,
    model: String(payload?.model || ""),
    label,
    percent: stage === "ready" ? 100 : percent,
    detail: parts.join(" · "),
    updateAvailable: Boolean(payload?.updateAvailable),
  };
}
