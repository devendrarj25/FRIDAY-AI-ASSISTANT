/**
 * Built-in versus your-own layers of a capability, shown on the six capability
 * lists (skills, agents, modules, plugins, tools, workflows) and in the
 * "Update content" report. The main process decides the status
 * (electron/capabilities.cjs `list`); this file only shows it and offers the
 * one way back: Reset to built-in, which saves a backup first.
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { badgeVariants } from "@/components/ui/badge";
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
  ROW_SELECTOR,
  RESET_CONFIRM_TEXT,
  RESET_UNFINISHED_TEXT,
  alreadyInReleaseSummary,
  badgeSpec,
  canResetBuiltin,
  keptYoursSummary,
  rowFocusTarget,
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
  // A span, so the badge is valid inside the name span of a row; the hint is said once, as the title.
  return (
    <span
      className={cn(badgeVariants({ variant: "outline" }), "text-note", spec.tone, className)}
      title={spec.hint}
      data-capability-status={status ?? origin}
    >
      {spec.label}
    </span>
  );
}

function focusElement(element: HTMLElement) {
  if (!element.hasAttribute("tabindex")) element.setAttribute("tabindex", "-1");
  element.focus({ preventScroll: true });
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
  /** Lets the control that owns the row find the button (and its row) after a reset. */
  askRef?: RefObject<HTMLButtonElement | null>;
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
  const ownRef = useRef<HTMLButtonElement>(null);
  const askRef = props.askRef ?? ownRef;
  const retryRef = useRef<HTMLButtonElement>(null);
  const previousKind = useRef(phase.kind);
  // Keyboard users keep their place: Retry takes focus on an error, the button gets it back after Dismiss.
  useEffect(() => {
    if (phase.kind === "error") retryRef.current?.focus();
    else if (phase.kind === "idle" && previousKind.current === "error") askRef.current?.focus();
    previousKind.current = phase.kind;
  }, [phase.kind, askRef]);
  if (!canResetBuiltin(status)) return null;
  if (phase.kind === "error") {
    return (
      <span className="flex flex-wrap items-center gap-1" data-reset-state="error">
        <span role="alert" className="max-w-prose break-words text-note text-destructive">
          {phase.message}
        </span>
        <Button
          ref={retryRef}
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
        title="Remove your copy and use the built-in version. A backup is saved first."
        data-reset-state={phase.kind}
        onClick={props.onAsk}
      >
        {working ? "Resetting…" : "Reset to built-in"}
      </Button>
      <span role="status" className="sr-only">
        {working ? `Resetting ${name} to built-in…` : ""}
      </span>
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
  const askRef = useRef<HTMLButtonElement>(null);
  const rowRef = useRef<HTMLElement | null>(null);
  const resettable = canResetBuiltin(status);
  // After a good reset the button is gone: focus moves to its row (or the page), never to nowhere.
  useEffect(() => {
    if (resettable || !rowRef.current) return;
    const target = rowFocusTarget(rowRef.current, () =>
      document.querySelector<HTMLElement>("main"),
    );
    rowRef.current = null;
    if (target) focusElement(target);
  }, [resettable]);
  const start = async () => {
    const row = askRef.current?.closest<HTMLElement>(ROW_SELECTOR);
    if (row) rowRef.current = row;
    setPhase({ kind: "working" });
    let next: ResetPhase = { kind: "error", message: RESET_UNFINISHED_TEXT };
    try {
      const outcome = await runBuiltinReset({ id, name, refresh, notify: toast });
      next = outcome.ok ? { kind: "idle" } : { kind: "error", message: outcome.error };
    } finally {
      setPhase(next);
    }
  };
  return (
    <ResetBuiltinView
      askRef={askRef}
      status={status}
      name={name}
      phase={phase}
      disabled={Boolean(disabled)}
      onAsk={() => setPhase({ kind: "confirm" })}
      onCancel={() => setPhase((now) => (now.kind === "confirm" ? { kind: "idle" } : now))}
      onConfirm={start}
      onRetry={start}
      onDismiss={() => {
        rowRef.current = null;
        setPhase({ kind: "idle" });
      }}
    />
  );
}

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
            {alreadyInReleaseSummary(shipped.length)}
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
            {keptYoursSummary(mine.length)}
          </summary>
          <ul className="mt-1 list-disc pl-5 font-mono text-note">
            {mine.map((entry) => {
              const notes = [entry.version ? `yours v${entry.version}` : "", entry.reason ?? ""]
                .filter(Boolean)
                .join(", ");
              return (
                <li key={entry.id}>
                  {entry.id}
                  {notes ? ` (${notes})` : ""}
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
