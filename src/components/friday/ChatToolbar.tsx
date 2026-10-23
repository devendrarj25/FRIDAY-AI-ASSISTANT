import { forwardRef, type ComponentProps } from "react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSlidingThumb } from "@/components/friday/ui";
import { CHAT_LEVELS, CHAT_LEVEL_LABELS, chatLevel, type ChatLevel } from "@/lib/friday/chat-level";
import { cn } from "@/lib/utils";

/**
 * Small building blocks for the Manual chat header and toolbar: an icon
 * button whose label slides out on hover or keyboard focus (overlaid, so it
 * never pushes a neighbour) and the 1 | 2 | 3 level switch. The measured
 * toolbar overflow lives in chat-level.ts (useToolbarFit).
 */

type IconActionProps = Omit<ComponentProps<typeof Button>, "children"> & {
  icon: LucideIcon;
  label: string;
  /** Anchor the sliding label to the button's right edge (last buttons in a row). */
  alignEnd?: boolean;
  /** Header labels open downward, toolbar labels upward. */
  below?: boolean;
  children?: React.ReactNode;
};

export const IconAction = forwardRef<HTMLButtonElement, IconActionProps>(function IconAction(
  { icon: Icon, label, alignEnd, below, className, children, variant = "ghost", ...rest },
  ref,
) {
  return (
    <Button
      ref={ref}
      variant={variant}
      size="sm"
      aria-label={label}
      title={label}
      className={cn("chat-icon-btn relative h-7 gap-1 px-2", className)}
      {...rest}
    >
      <Icon className="size-3.5" />
      {children}
      <span
        aria-hidden="true"
        className={cn(
          "chat-hover-label",
          alignEnd && "chat-hover-label-end",
          below && "chat-hover-label-below",
        )}
      >
        {label}
      </span>
    </Button>
  );
});

/** 1 | 2 | 3 — Compact, Expanded, Full chat. Alt+1/2/3 does the same. */
export function LevelSwitch({ level }: { level: ChatLevel }) {
  const { listRef, thumbRef } = useSlidingThumb(level);
  return (
    <div
      ref={listRef}
      role="radiogroup"
      aria-label="Chat size"
      className="chat-level-switch friday-seg flex items-center rounded-surface border border-primary/20 p-0.5"
    >
      <span ref={thumbRef} aria-hidden="true" className="friday-seg-thumb" />
      {CHAT_LEVELS.map((value) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={level === value}
          aria-label={`${CHAT_LEVEL_LABELS[value]} (Alt+${value})`}
          title={`${CHAT_LEVEL_LABELS[value]} (Alt+${value})`}
          onClick={() => chatLevel.set(value)}
          className={cn(
            "friday-btn h-6 min-w-6 rounded-ctl px-1.5 text-meta-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary",
            level === value
              ? "bg-primary/20 text-primary"
              : "text-muted-foreground hover:bg-primary/10 hover:text-primary",
          )}
        >
          {value}
        </button>
      ))}
    </div>
  );
}
