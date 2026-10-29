import type { ReactNode } from "react";
import { MoreHorizontal, type LucideIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CHAT_LEVELS, VOICE_LEVEL_LABELS, type ChatLevel } from "@/lib/friday/chat-level";
import { useSlidingThumb } from "@/components/friday/ui";
import { cn } from "@/lib/utils";

/**
 * Building blocks for the Auto (voice) window's control bar: one HUD button
 * shape, labelled groups (Listen, Speak, Safety, Tools), the Compact /
 * Expanded / Transcript switch, and a More menu for tools that do not fit.
 * The bar itself is assembled in AutoMode.tsx
 * from the live stores; nothing here holds voice state.
 *
 * Labels stay in the DOM right after their icon. On a narrow bar styles.css
 * hides the text (never removes it) and slides the label out on hover or
 * keyboard focus instead.
 */

/** One HUD control: icon + label, one height, clear pressed and focus states. */
export function HudButton({
  icon: Icon,
  label,
  title,
  active = false,
  onClick,
  className,
  ...pointer
}: {
  icon: LucideIcon;
  label: string;
  title?: string;
  active?: boolean;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  className?: string;
  onPointerDown?: () => void;
  onPointerUp?: () => void;
  onPointerLeave?: () => void;
}) {
  return (
    <button
      type="button"
      title={title ?? label}
      aria-label={label}
      aria-pressed={active}
      data-label={label}
      onClick={onClick}
      {...pointer}
      className={cn(
        "voice-btn friday-btn inline-flex h-6 items-center gap-1.5 rounded-ctl border px-2 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60",
        active
          ? "border-primary/40 bg-primary/10 text-primary"
          : "border-primary/20 text-muted-foreground hover:border-primary/35 hover:text-primary active:bg-primary/15",
        className,
      )}
    >
      <Icon className="size-3" />
      {label}
    </button>
  );
}

/** Thin separator between HUD groups. */
export function HudDivider() {
  return <span aria-hidden className="mx-0.5 h-4 w-px bg-primary/15" />;
}

/**
 * A named group of controls. It does not box its children, so the HUD row
 * still wraps control by control at the window minimum.
 */
export function HudGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="contents">
      {children}
    </div>
  );
}

/** Compact | Expanded | Transcript. Alt+1/2/3 in the voice window does the same. */
export function VoiceLevelSwitch({
  level,
  onSelect,
}: {
  level: ChatLevel;
  onSelect: (level: ChatLevel) => void;
}) {
  const { listRef, thumbRef } = useSlidingThumb(level);
  return (
    <div
      ref={listRef}
      role="radiogroup"
      aria-label="Voice window size"
      className="voice-level-switch friday-seg inline-flex h-6 items-stretch overflow-hidden rounded-ctl border border-primary/25 text-meta-sm"
    >
      <span ref={thumbRef} aria-hidden="true" className="friday-seg-thumb" />
      {CHAT_LEVELS.map((value, index) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={level === value}
          aria-label={`${VOICE_LEVEL_LABELS[value]} (Alt+${value})`}
          title={`${VOICE_LEVEL_LABELS[value]} (Alt+${value})`}
          onClick={() => onSelect(value)}
          className={cn(
            "friday-btn px-2 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/60",
            index > 0 && "border-l border-primary/15",
            level === value
              ? "bg-primary/15 text-primary"
              : "text-muted-foreground hover:bg-primary/5 hover:text-primary",
          )}
        >
          {VOICE_LEVEL_LABELS[value]}
        </button>
      ))}
    </div>
  );
}

export type VoiceTool = {
  id: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  render: () => ReactNode;
};

/**
 * Tools that fit render as HUD buttons; the rest move into one More menu
 * with the same handlers. The mic chip and Stop everything are never tools.
 */
export function VoiceTools({ tools, shown }: { tools: VoiceTool[]; shown: number }) {
  const inline = tools.slice(0, shown);
  const more = tools.slice(shown);
  return (
    <>
      {inline.map((tool) => (
        <span key={tool.id} className="contents">
          {tool.render()}
        </span>
      ))}
      {more.length ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="More voice tools"
              title="More voice tools"
              className="inline-flex h-6 items-center rounded-ctl border border-primary/20 px-2 text-muted-foreground transition-colors hover:border-primary/35 hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
            >
              <MoreHorizontal className="size-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="voice-glass-menu w-48">
            {more.map((tool) => (
              <DropdownMenuItem key={tool.id} onSelect={tool.onSelect}>
                <tool.icon className="size-4" /> {tool.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </>
  );
}
