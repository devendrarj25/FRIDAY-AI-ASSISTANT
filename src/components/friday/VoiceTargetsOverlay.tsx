import { Lock, WifiOff, X } from "lucide-react";
import { ActionButton, EmptyState, LoadingState } from "@/components/friday/ui";
import { ErrorState } from "@/components/friday/PageStates";

/**
 * The numbered "say a number to click it" list for Auto mode. It only draws
 * what the caller hands it: target names come from the screen, so they are
 * data and are rendered as plain text nodes, never as markup, links or
 * handlers. It holds no timer: an expired overlay arrives as state "idle".
 * Hidden unless `enabled` is true, and not mounted anywhere yet.
 */

const MAX_VOICE_TARGETS = 30;

export type VoiceTarget = { n: number; name: string; role: string };
export type VoiceTargetsState = "idle" | "loading" | "ready" | "error" | "offline" | "handoff";

export type VoiceTargetsOverlayProps = {
  enabled: boolean;
  targets: VoiceTarget[] | null;
  state: VoiceTargetsState;
  error?: string;
  onRetry(): void;
  onClose(): void;
  expiresAt?: number;
};

/** Valid chips only, in number order, at most MAX_VOICE_TARGETS. */
function visibleTargets(targets: VoiceTarget[] | null): VoiceTarget[] {
  if (!targets) return [];
  return targets
    .filter((t) => Number.isInteger(t.n) && t.n > 0 && typeof t.name === "string")
    .sort((a, b) => a.n - b.n)
    .slice(0, MAX_VOICE_TARGETS);
}

export function VoiceTargetsOverlay({
  enabled,
  targets,
  state,
  error,
  onRetry,
  onClose,
}: VoiceTargetsOverlayProps) {
  if (!enabled) return null;
  const chips = state === "ready" || state === "idle" ? visibleTargets(targets) : [];

  let body;
  if (state === "loading") {
    body = <LoadingState label="Reading the screen…" rows={2} />;
  } else if (state === "error") {
    body = (
      <ErrorState
        title="I could not read the screen"
        error={error ?? "Unknown error"}
        onRetry={onRetry}
      />
    );
  } else if (state === "offline") {
    body = (
      <EmptyState
        icon={WifiOff}
        title="The kernel is offline"
        hint="Numbers come back when it reconnects."
      />
    );
  } else if (state === "handoff") {
    body = <EmptyState icon={Lock} title="A secure prompt needs you. I will not look at it." />;
  } else if (chips.length === 0) {
    body = <EmptyState title="Nothing here I can click safely" />;
  } else {
    body = (
      <ol className="flex flex-wrap gap-2" aria-label="Numbered targets">
        {chips.map((t) => (
          <li
            key={t.n}
            tabIndex={0}
            aria-label={`${t.n}, ${t.name}, ${t.role}`}
            className="flex items-center gap-2 rounded-ctl border border-primary/25 bg-surface/60 px-2 py-1 text-xs text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
          >
            <span className="label-xs text-primary" aria-hidden="true">
              {t.n}
            </span>
            <span aria-hidden="true">{t.name}</span>
            <span className="text-meta text-muted-foreground" aria-hidden="true">
              {t.role}
            </span>
          </li>
        ))}
      </ol>
    );
  }

  return (
    <section
      aria-label="Voice click targets"
      className="space-y-2 rounded-surface border border-primary/25 bg-surface/80 p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <p role="status" className="label-xs text-primary/70">
          {state === "handoff" ? "Secure prompt" : "Say a number to click it"}
        </p>
        <ActionButton icon={X} label="Close" labelMode="inline" onClick={onClose} />
      </div>
      {body}
    </section>
  );
}
