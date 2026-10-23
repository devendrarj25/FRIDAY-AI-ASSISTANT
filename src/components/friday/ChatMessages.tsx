import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, Check, Copy, RotateCcw } from "lucide-react";
import type { Message } from "@/lib/friday/brain-engine";
import { brain } from "@/lib/friday/brain-engine";
import { splitChatBlocks } from "@/lib/friday/chat-blocks";
import { followsLatest, type ChatLevel, type TranscriptMark } from "@/lib/friday/chat-level";
import { copyText } from "@/lib/friday/clipboard";
import { formatOwnerDate } from "@/lib/friday/settings-runtime";
import { cn } from "@/lib/utils";

/**
 * The Manual-mode transcript. One row component serves all three chat
 * levels, so Compact and Expanded show exactly the same rows Full chat does.
 * Rows are memoised on the message object; the brain store replaces only the
 * message that changed, so a streaming reply re-renders one row, not all.
 */

const regenerate = () => brain.regenerate();

/** Within this many pixels of the bottom counts as "reading the newest". */
const PIN_SLACK_PX = 24;

function CopyButton({
  text,
  label,
  className,
}: {
  text: string;
  label: string;
  className?: string;
}) {
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
      aria-label={label}
      title={copied ? "Copied" : label}
      onClick={() => {
        void copyText(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1200);
        });
      }}
      className={cn(
        "chat-row-action inline-flex size-4 items-center justify-center rounded-ctl text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary",
        className,
      )}
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
    </button>
  );
}

/** FRIDAY's answer text: prose stays plain, fenced code gets its own box. */
function AnswerBody({ text, className }: { text: string; className: string }) {
  const blocks = splitChatBlocks(text);
  if (!blocks.some((b) => b.kind === "code")) {
    return <pre className={className}>{text}</pre>;
  }
  return (
    <div className="space-y-1">
      {blocks.map((block, i) =>
        block.kind === "text" ? (
          <pre key={i} className={className}>
            {block.text}
          </pre>
        ) : (
          <div
            key={i}
            className="overflow-hidden rounded-surface border border-primary/20 bg-surface"
          >
            <div className="flex items-center justify-between border-b border-primary/10 px-2 py-0.5">
              <span className="label-xs text-note-sm text-muted-foreground">
                {block.lang || "code"}
              </span>
              <CopyButton text={block.code} label="Copy code" />
            </div>
            <pre className="overflow-x-auto p-2 text-data leading-relaxed text-foreground/90">
              <code>{block.code}</code>
            </pre>
          </div>
        ),
      )}
    </div>
  );
}

/** Three soft dots while a turn is running and no answer text has arrived yet. */
export function TypingDots() {
  return (
    <div
      role="status"
      aria-label="FRIDAY is replying"
      className="bubble-friday bubble-typing flex w-fit items-center gap-1 px-3 py-2.5"
    >
      <span aria-hidden="true" className="typing-dot" />
      <span aria-hidden="true" className="typing-dot" />
      <span aria-hidden="true" className="typing-dot" />
    </div>
  );
}

export const ChatMessageRow = memo(function ChatMessageRow({
  message,
  userBubbleClass,
  showTimestamps,
  full,
  answerSize,
  canRegenerate,
}: {
  message: Message;
  userBubbleClass: string;
  showTimestamps: boolean;
  full: boolean;
  answerSize: "text-xs" | "text-sm";
  /** Only the last FRIDAY answer, and only while no turn is running. */
  canRegenerate: boolean;
}) {
  if (message.role === "user") {
    return (
      <div className="bubble-enter group flex items-start justify-end gap-1">
        <CopyButton text={message.text} label="Copy message" className="mt-0.5" />
        {/* The width cap lives on this column only, so a short line never wraps early. */}
        <div className="bubble-col flex min-w-0 max-w-[85%] flex-col items-end">
          <p className={cn("w-fit max-w-full whitespace-pre-wrap text-left", userBubbleClass)}>
            {message.text}
          </p>
          {showTimestamps ? (
            <p className="mt-0.5 text-meta-sm text-muted-foreground">
              {formatOwnerDate(message.at)}
            </p>
          ) : null}
        </div>
      </div>
    );
  }
  return (
    <div
      className={cn(
        "bubble-friday bubble-enter group w-fit min-w-0 max-w-[92%]",
        full ? "px-3.5 py-2.5" : "px-3 py-2",
      )}
    >
      <div className="mb-0.5 flex items-center gap-1">
        <p className="label-xs text-note-sm text-primary">
          FRIDAY
          {showTimestamps ? (
            <span className="ml-2 font-mono text-muted-foreground">
              {formatOwnerDate(message.at)}
            </span>
          ) : null}
        </p>
        {message.text ? (
          <span className="ml-auto flex items-center gap-0.5">
            <CopyButton text={message.text} label="Copy answer" />
            {canRegenerate ? (
              <button
                type="button"
                aria-label="Regenerate this answer"
                title="Regenerate this answer"
                onClick={regenerate}
                className="chat-row-action chat-row-keep inline-flex size-4 items-center justify-center rounded-ctl text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
              >
                <RotateCcw className="size-3" />
              </button>
            ) : null}
          </span>
        ) : null}
      </div>
      {message.text ? (
        <AnswerBody
          text={message.text}
          className={cn(
            "whitespace-pre-wrap font-sans leading-relaxed",
            answerSize,
            full ? "text-foreground/90" : "text-muted-foreground",
          )}
        />
      ) : null}
    </div>
  );
});

/**
 * Scroll container that follows a streaming reply while the owner is at the
 * bottom, stops following the moment they scroll up, and offers one
 * "Jump to latest" button to get back.
 */
export function ChatTranscript({
  messages,
  conversation,
  level,
  busy,
  bubbleStyle,
  showTimestamps,
  userBubbleClass,
  empty,
  className,
}: {
  /** What this level shows (Compact: the newest few; a search: the matches). */
  messages: Message[];
  /** The whole conversation, for "newest" and "a different chat". */
  conversation: Message[];
  level: ChatLevel;
  busy: boolean;
  bubbleStyle: string;
  showTimestamps: boolean;
  userBubbleClass: string;
  empty: string;
  className: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [away, setAway] = useState(false);
  const full = level === 3;
  const answerSize = full && bubbleStyle !== "Compact" ? "text-sm" : "text-xs";
  // Regenerate redoes the newest exchange, so it belongs only on the newest
  // message of the whole conversation, never on a filtered search result.
  const newest = conversation[conversation.length - 1];
  const regenerateId = newest?.role === "friday" ? newest.id : undefined;
  const seen = useRef<TranscriptMark>({});

  const toBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // Before paint, so a new chunk never flashes one frame above the bottom.
  useLayoutEffect(() => {
    const mark: TranscriptMark = {
      first: conversation[0]?.id,
      last: newest?.id,
      lastRole: newest?.role,
    };
    if (followsLatest(pinned.current, seen.current, mark)) {
      pinned.current = true;
      setAway(false);
      toBottom();
    }
    seen.current = mark;
  }, [messages, conversation, newest, level, toBottom]);

  // The height animates between levels; follow it to the end only if pinned.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onEnd = () => {
      if (pinned.current) toBottom();
    };
    el.addEventListener("transitionend", onEnd);
    return () => el.removeEventListener("transitionend", onEnd);
  }, [toBottom]);

  return (
    <div className={cn("relative min-h-0", full && "flex flex-1 flex-col")}>
      <div
        ref={scrollRef}
        role="log"
        aria-label="Conversation"
        // A log is a live region: keep token-by-token streaming out of it and
        // let the finished answer be announced once.
        aria-live={busy ? "off" : "polite"}
        aria-busy={busy}
        onScroll={(event) => {
          const el = event.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_SLACK_PX;
          pinned.current = atBottom;
          if (away === atBottom) setAway(!atBottom);
        }}
        className={cn("friday-chat-messages", className, busy && "transition-none")}
      >
        <div className={cn("space-y-2", full && "mx-auto w-full max-w-[48rem]")}>
          {messages.length === 0 ? (
            <p className="py-3 text-center text-meta text-muted-foreground">{empty}</p>
          ) : null}
          {messages.map((m) => (
            <ChatMessageRow
              key={m.id}
              message={m}
              userBubbleClass={userBubbleClass}
              showTimestamps={showTimestamps}
              full={full}
              answerSize={answerSize}
              canRegenerate={!busy && m.id === regenerateId}
            />
          ))}
          {busy && (!newest || newest.role === "user" || !newest.text) ? <TypingDots /> : null}
        </div>
      </div>
      {away ? (
        <button
          type="button"
          onClick={() => {
            pinned.current = true;
            setAway(false);
            toBottom();
          }}
          className="absolute bottom-2 left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-1 rounded-full border border-primary/30 bg-card px-2.5 py-0.5 text-meta-sm text-primary shadow-sm transition-colors hover:border-primary/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
        >
          <ArrowDown className="size-3" /> Jump to latest
        </button>
      ) : null}
    </div>
  );
}
