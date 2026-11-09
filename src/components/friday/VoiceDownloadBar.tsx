import { CheckCircle2, Download, Loader2, TriangleAlert } from "lucide-react";
import type { VoiceDownload } from "@/lib/friday/voice-download";
import { cn } from "@/lib/utils";

/**
 * A speech model or the speech engine is being checked, fetched or installed. Shown on the Auto bar with the
 * same chip tokens as its neighbours: what is being fetched, how far, how fast, and how long is left.
 * Listening is not blocked while it runs (a size on disk keeps listening, see `chooseWeights`).
 */
export function VoiceDownloadBar({ download }: { download: VoiceDownload | null }) {
  if (!download) return null;
  const failed = download.stage === "failed";
  const done = download.stage === "ready";
  const Icon = failed
    ? TriangleAlert
    : done
      ? CheckCircle2
      : download.percent == null
        ? Loader2
        : Download;
  return (
    <span
      data-voice-download={download.stage}
      className={cn(
        "inline-flex min-h-6 max-w-full items-center gap-1.5 rounded-ctl border px-2 py-0.5",
        failed
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-primary/30 bg-primary/5 text-primary",
      )}
    >
      <Icon
        className={cn("size-3 shrink-0", Icon === Loader2 && "animate-spin")}
        aria-hidden="true"
      />
      <span className="min-w-0 truncate">{download.label}</span>
      {!failed && !done && download.percent != null ? (
        <span
          role="progressbar"
          aria-label={download.label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={download.percent}
          className="h-1 w-20 shrink-0 overflow-hidden rounded-full bg-primary/15"
        >
          <span
            className="block h-full rounded-full bg-primary transition-[width] duration-300"
            style={{ width: `${download.percent}%` }}
          />
        </span>
      ) : null}
      {download.percent != null && !done ? (
        <span className="shrink-0">{download.percent}%</span>
      ) : null}
      {download.detail ? (
        <span className="min-w-0 truncate text-muted-foreground">{download.detail}</span>
      ) : null}
    </span>
  );
}
