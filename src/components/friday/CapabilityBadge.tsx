/**
 * Built-in versus your-own layers of a capability, shown on the six capability
 * lists (skills, agents, modules, plugins, tools, workflows) and in the
 * "Update content" report. The main process decides the status
 * (electron/capabilities.cjs `list`); this file only shows it and offers the
 * one way back: Reset to built-in, which saves a backup first.
 */
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  RESET_CONFIRM_TEXT,
  badgeSpec,
  canResetBuiltin,
  runBuiltinReset,
  type AlreadyInRelease,
  type CapabilityStatus,
  type KeptYours,
  type ResetPhase,
} from "@/lib/friday/capability-trees";
import { cn } from "@/lib/utils";

export function CapabilityBadge({
  status,
  origin,
  className,
}: {
  status?: CapabilityStatus | null | undefined;
  origin?: string | null | undefined;
  className?: string;
}) {
  const spec = badgeSpec(status, origin);
  if (!spec) return null;
  return (
    <Badge
      variant="outline"
      className={cn("text-note", spec.tone, className)}
      title={spec.hint}
      data-capability-status={status ?? origin}
    >
      {spec.label}
      <span className="sr-only"> — {spec.hint}</span>
    </Badge>
  );
}

export function ResetConfirmBody({ name }: { name: string }) {
  return (
    <div className="space-y-1.5">
      <p className="text-foreground">{name}</p>
      <p>{RESET_CONFIRM_TEXT}</p>
    </div>
  );
}

export interface ResetBuiltinViewProps {
  status?: CapabilityStatus | null | undefined;
  name: string;
  phase: ResetPhase;
  disabled?: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: () => Promise<unknown> | void;
  onRetry: () => Promise<unknown> | void;
  onDismiss: () => void;
}

/** Presentation only: the button, its busy state and its error with Retry. */
export function ResetBuiltinView(props: ResetBuiltinViewProps) {
  const { status, name, phase } = props;
  const askRef = useRef<HTMLButtonElement>(null);
  if (!canResetBuiltin(status)) return null;
  if (phase.kind === "error") {
    return (
      <span className="flex flex-wrap items-center gap-1" data-reset-state="error">
        <span role="alert" className="text-note text-destructive">
          {phase.message}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-note"
          aria-label={`Retry resetting ${name} to built-in`}
          onClick={props.onRetry}
        >
          Retry
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-note"
          aria-label={`Dismiss the reset error for ${name}`}
          onClick={props.onDismiss}
        >
          Dismiss
        </Button>
      </span>
    );
  }
  const working = phase.kind === "working";
  return (
    <>
      <Button
        ref={askRef}
        size="sm"
        variant="outline"
        className="h-7 px-2 text-note"
        disabled={Boolean(props.disabled) || working}
        aria-busy={working}
        aria-label={`Reset ${name} to built-in`}
        title="Remove your copy and use the version that ships with FRIDAY. A backup is saved first."
        data-reset-state={phase.kind}
        onClick={props.onAsk}
      >
        {working ? "Resetting…" : "Reset to built-in"}
      </Button>
      <AlertDialog
        open={phase.kind === "confirm"}
        onOpenChange={(next) => {
          if (!next) props.onCancel();
        }}
      >
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            askRef.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Reset to built-in?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                <ResetConfirmBody name={name} />
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={props.onConfirm}>Reset to built-in</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * The reset control of one list row. Renders nothing unless the row is an
 * owner's copy of a built-in (overridden or forked-stale).
 */
export function ResetBuiltinButton({
  id,
  name,
  status,
  refresh,
  disabled,
}: {
  id: string;
  name: string;
  status?: CapabilityStatus | null | undefined;
  refresh: () => Promise<unknown> | unknown;
  disabled?: boolean;
}) {
  const [phase, setPhase] = useState<ResetPhase>({ kind: "idle" });
  const start = async () => {
    setPhase({ kind: "working" });
    const outcome = await runBuiltinReset({ id, name, refresh, notify: toast });
    setPhase(outcome.ok ? { kind: "idle" } : { kind: "error", message: outcome.error });
  };
  return (
    <ResetBuiltinView
      status={status}
      name={name}
      phase={phase}
      disabled={Boolean(disabled)}
      onAsk={() => setPhase({ kind: "confirm" })}
      onCancel={() => setPhase((now) => (now.kind === "confirm" ? { kind: "idle" } : now))}
      onConfirm={start}
      onRetry={start}
      onDismiss={() => setPhase({ kind: "idle" })}
    />
  );
}

const plural = (count: number) => (count === 1 ? "item" : "items");

/** What "Update content" did not change: already shipped in this release, or yours and kept. */
export function ContentUpdateReport({
  alreadyInRelease,
  keptYours,
}: {
  alreadyInRelease?: AlreadyInRelease[] | undefined;
  keptYours?: KeptYours[] | undefined;
}) {
  const shipped = alreadyInRelease ?? [];
  const mine = keptYours ?? [];
  if (!shipped.length && !mine.length) return null;
  return (
    <div className="space-y-1 text-meta text-muted-foreground" data-content-report>
      {shipped.length ? (
        <details data-content-report-shipped>
          <summary className="cursor-pointer text-foreground">
            {shipped.length} {plural(shipped.length)} already in this release
          </summary>
          <ul className="mt-1 list-disc pl-5 font-mono text-note">
            {shipped.map((entry) => (
              <li key={entry.id}>
                {entry.id}
                {entry.builtinVersion ? ` (release v${entry.builtinVersion})` : ""}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {mine.length ? (
        <details data-content-report-yours>
          <summary className="cursor-pointer text-foreground">
            {mine.length} {plural(mine.length)} kept your version
          </summary>
          <ul className="mt-1 list-disc pl-5 font-mono text-note">
            {mine.map((entry) => (
              <li key={entry.id}>
                {entry.id}
                {entry.version ? ` (yours v${entry.version})` : ""}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
