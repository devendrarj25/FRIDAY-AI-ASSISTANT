import { memo, useEffect, useRef, useState } from "react";
import { Check, Copy, X } from "lucide-react";
import {
  assistantMode,
  type Caption,
  type PanelDisplay,
  type PendingConfirm,
} from "@/lib/friday/assistant-mode";
import { copyText } from "@/lib/friday/clipboard";
import { formatOwnerDate } from "@/lib/friday/settings-runtime";
import { cn } from "@/lib/utils";

/**
 * What the Auto (voice) window shows of the conversation: one caption row
 * used at every level, the streaming interim line, FRIDAY's display panel and
 * the confirmation card. Compact and Expanded keep the one-line caption look;
 * Transcript lays the same rows out as a centred conversation. Everything is
 * read from the assistant-mode store; nothing here holds conversation state.
 */

export type CaptionLayout = "line" | "bubble";

/** FRIDAY shows code, a list, text or a status inside her own box. */
export function DisplayPanel({ display }: { display: PanelDisplay }) {
  const toneClass =
    display.kind === "status"
      ? display.tone === "ok"
        ? "border-accent/40 text-accent"
        : display.tone === "warn"
          ? "border-warning/40 text-warning"
          : display.tone === "error"
            ? "border-destructive/40 text-destructive"
            : "border-primary/30 text-primary"
      : "border-primary/25 text-foreground/90";

  return (
    <div className={cn("rounded-md border bg-surface/60 p-2.5", toneClass)}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="label-xs text-primary/70">{display.title ?? display.kind}</p>
        <button
          type="button"
          onClick={() => assistantMode.clearDisplay()}
          className="text-muted-foreground hover:text-primary"
          title="Dismiss"
          aria-label="Dismiss"
        >
          <X className="size-3" />
        </button>
      </div>
      {display.kind === "code" ? (
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground/90">
          {display.code}
        </pre>
      ) : display.kind === "list" ? (
        <ul className="space-y-1 text-xs text-foreground/90">
          {display.items.map((item, i) => (
            <li key={`${i}-${item.slice(0, 12)}`} className="flex gap-2">
              <span className="text-primary">›</span>
              <span className="min-w-0">{item}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="whitespace-pre-wrap text-xs leading-relaxed">{display.text}</p>
      )}
    </div>
  );
}

/** A spoken command waiting for YES or NO. The only path is confirmPending. */
export function ConfirmationCard({
  pending,
  className,
}: {
  pending: PendingConfirm;
  className?: string;
}) {
  return (
    <div
      role="alertdialog"
      aria-label="Confirmation required"
      className={cn(
        "mx-auto w-[min(560px,96%)] rounded-md border border-warning/50 bg-warning/10 p-3 backdrop-blur-sm",
        className,
      )}
    >
      <p className="label-xs text-warning">Confirmation required</p>
      <p className="mt-1 text-sm text-foreground">{pending.command}</p>
      <p className="mt-1 text-xs text-muted-foreground">{pending.reason}</p>
      <div className="mt-2.5 flex gap-2">
        <button
          type="button"
          onClick={() => assistantMode.confirmPending(true)}
          className="rounded-sm border border-accent/50 bg-accent/15 px-3 py-1.5 font-mono text-[11px] text-accent hover:bg-accent/25"
        >
          <Check className="size-3" aria-hidden="true" />
          YES · run it
        </button>
        <button
          type="button"
          onClick={() => assistantMode.confirmPending(false)}
          className="rounded-sm border border-primary/25 px-3 py-1.5 font-mono text-[11px] text-muted-foreground hover:border-destructive/60 hover:text-destructive"
        >
          <X className="size-3" aria-hidden="true" />
          NO · cancel
        </button>
      </div>
    </div>
  );
}

function CopyLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <button
      type="button"
      aria-label="Copy this line"
      title={copied ? "Copied" : "Copy this line"}
      onClick={() => {
        void copyText(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="chat-row-action inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
    </button>
  );
}

function CaptionMeta({ caption }: { caption: Caption }) {
  if (!caption.tag) return null;
  return (
    <span className="ml-2 font-mono text-[10px] uppercase text-muted-foreground">
      {caption.tag}
      {caption.language ? ` · ${caption.language}` : ""}
      {typeof caption.confidence === "number" ? ` · ${caption.confidence.toFixed(2)}` : ""}
    </span>
  );
}

/**
 * One caption. Memoised on the caption object: the store replaces only the
 * line that changed, so a streaming line re-renders itself and nothing else.
 */
export const CaptionRow = memo(function CaptionRow({
  caption,
  layout,
  showTime,
}: {
  caption: Caption;
  layout: CaptionLayout;
  showTime: boolean;
}) {
  const who = caption.who === "user" ? "you" : "friday";
  if (layout === "line") {
    return (
      <div className="flex gap-2 text-sm">
        <span
          className={cn(
            "shrink-0 font-mono text-[10px] uppercase",
            caption.who === "user" ? "text-accent" : "text-primary",
          )}
        >
          {who}
        </span>
        <span className="min-w-0 text-foreground/90">
          {caption.text}
          <CaptionMeta caption={caption} />
        </span>
      </div>
    );
  }
  const user = caption.who === "user";
  return (
    <div className={cn("group flex", user ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "w-fit min-w-0 max-w-[85%] px-3.5 py-2",
          user ? "bubble-user" : "bubble-friday",
        )}
      >
        <div
          className={cn(
            "mb-0.5 flex items-center gap-1.5 font-mono text-[10px] uppercase",
            user ? "flex-row-reverse text-accent" : "text-primary",
          )}
        >
          <span>{who}</span>
          {showTime ? (
            <span className="normal-case text-muted-foreground">{formatOwnerDate(caption.at)}</span>
          ) : null}
          <CopyLine text={caption.text} />
        </div>
        <p
          className={cn(
            "whitespace-pre-wrap text-sm leading-relaxed text-foreground/90",
            user && "text-right",
          )}
        >
          {caption.text}
          <CaptionMeta caption={caption} />
        </p>
      </div>
    </div>
  );
});

/** Speech still being recognised: italic and dimmed, at every level. */
export function InterimLine({ text, layout }: { text: string; layout: CaptionLayout }) {
  if (layout === "line") {
    return (
      <div className="flex gap-2 text-sm opacity-70">
        <span className="shrink-0 font-mono text-[10px] uppercase text-accent">you</span>
        <span className="min-w-0 italic text-foreground/70">{text}</span>
      </div>
    );
  }
  return (
    <div className="flex justify-end opacity-70">
      <p className="max-w-[85%] rounded-2xl rounded-br-md border border-dashed border-primary/35 bg-primary/5 px-3.5 py-2 text-right text-sm italic text-foreground/70">
        {text}
      </p>
    </div>
  );
}

/**
 * The conversation inside the caption scroller. Compact shows the last two
 * captions; Expanded and Transcript show all of them. Transcript centres the
 * column and also carries the confirmation card inline.
 */
export function VoiceTranscript({
  captions,
  interim,
  display,
  pending,
  layout,
  showTime,
}: {
  captions: Caption[];
  interim: string;
  display: PanelDisplay | null;
  pending: PendingConfirm | null;
  layout: CaptionLayout;
  showTime: boolean;
}) {
  const body = (
    <>
      {captions.length === 0 && !interim && !display ? (
        <p className="text-xs text-muted-foreground">
          Nothing heard yet. Say “FRIDAY” followed by what you need.
        </p>
      ) : null}
      {captions.map((c) => (
        <CaptionRow key={c.id} caption={c} layout={layout} showTime={showTime} />
      ))}
      {/* Live speech streams inside this same box */}
      {interim ? <InterimLine text={interim} layout={layout} /> : null}
      {display ? <DisplayPanel display={display} /> : null}
      {layout === "bubble" && pending ? <ConfirmationCard pending={pending} /> : null}
    </>
  );
  if (layout === "line") return body;
  return <div className="mx-auto w-full max-w-[48rem] space-y-2">{body}</div>;
}
