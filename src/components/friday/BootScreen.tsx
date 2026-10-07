/**
 * FRIDAY boot screen — shown while the desktop shell detects the workspace,
 * runtimes and AI providers. Never rendered in the browser preview.
 */
import { CheckCircle2, CircleAlert, CircleDashed, XCircle } from "lucide-react";
import { FridayOrb } from "@/components/friday/FridayOrb";
import { useBootSequence } from "@/lib/friday/desktop";
import { cn } from "@/lib/utils";

const ICONS = {
  ok: CheckCircle2,
  warn: CircleAlert,
  missing: XCircle,
} as const;

const TONES = {
  ok: "text-success",
  warn: "text-warning",
  missing: "text-destructive",
} as const;

export function BootScreen() {
  const { steps, done, dismiss } = useBootSequence();
  if (done) return null;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-background/98 backdrop-blur"
      role="status"
      aria-live="polite"
      onClick={dismiss}
    >
      <span className="pointer-events-none absolute inset-0 scanline opacity-30" />
      <div className="relative w-full max-w-md px-6 text-center">
        <FridayOrb size={140} live className="mx-auto" />
        <p className="mt-5 font-display text-4xl font-bold tracking-[0.3em] text-primary glow-text">
          FRIDAY
        </p>
        <p className="label-xs mt-2 text-muted-foreground">Personal AI Assistant</p>
        <p className="mt-1 font-mono text-xs text-accent">Initializing…</p>

        <ul className="mt-6 space-y-1 text-left">
          {steps.map((step) => {
            const Icon = ICONS[step.status] ?? CircleDashed;
            return (
              <li
                key={`${step.label}-${step.at}`}
                className="flex items-start gap-2 font-mono text-[11px] text-muted-foreground"
              >
                <Icon className={cn("mt-0.5 size-3.5 shrink-0", TONES[step.status])} />
                <span className="text-foreground">{step.label}</span>
                {step.detail ? <span className="truncate">· {step.detail}</span> : null}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
