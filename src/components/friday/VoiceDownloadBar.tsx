import { CheckCircle2, Download, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import type { VoiceDownload } from "@/lib/friday/voice-download";
import { models } from "@/lib/friday/models-engine";
import { downloadRetryId } from "@/components/friday/voice-transcript-model";
import { cn } from "@/lib/utils";

/**
 * A speech model or the speech engine is being checked, fetched or installed. Shown on the Auto bar with the
 * same chip tokens as its neighbours: what is being fetched, how far, how fast, and how long is left.
 * Listening is not blocked while it runs (a size on disk keeps listening, see `chooseWeights`).
 */
export function VoiceDownloadBar({ download }: { download: VoiceDownload | null }) {
  // No router in a static render; Open Models then simply does nothing.
  const router = useRouter({ warn: false });
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
  const retryId = failed ? downloadRetryId(download.model) : null;
  return (
    <span
      data-voice-download={download.stage}
      role="status"
      aria-live="polite"
      className={cn(
        "inline-flex min-h-6 max-w-full items-center gap-1.5 rounded-ctl border px-2 py-0.5",
        failed && "flex-wrap",
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
        <span
          className={cn(
            "min-w-0 text-muted-foreground",
            failed ? "whitespace-normal break-words" : "truncate",
          )}
        >
          {download.detail}
        </span>
      ) : null}
      {failed && retryId ? (
        <button
          type="button"
          onClick={() => models.install(retryId)}
          className="inline-flex items-center gap-1 rounded-ctl border border-destructive/40 px-1.5 text-meta-sm uppercase text-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <RefreshCw className="size-3" aria-hidden="true" />
          Retry
        </button>
      ) : null}
      {failed ? (
        <button
          type="button"
          onClick={() => void router?.navigate({ to: "/models" })}
          className="inline-flex items-center rounded-ctl border border-primary/30 px-1.5 text-meta-sm uppercase text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          Open Models
        </button>
      ) : null}
    </span>
  );
}
