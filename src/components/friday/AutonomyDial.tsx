/**
 * FRIDAY · autonomy dial.
 *
 * Ask every time, Balanced, or Full. The kill switch is always here.
 * `compact` is the same control at HUD-chip size for the Auto Mode bar; the
 * Flow Studio toolbar keeps the full buttons.
 */
import { useSyncExternalStore } from "react";
import { OctagonX, Play, Scale, ShieldCheck, Zap, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { brain } from "@/lib/friday/brain-engine";
import { autonomy, type ApprovalLevel } from "@/lib/friday/self/autonomy";
import { cn } from "@/lib/utils";

const LEVELS: { id: ApprovalLevel; label: string; icon: LucideIcon }[] = [
  { id: "strict", label: "Ask every time", icon: ShieldCheck },
  { id: "balanced", label: "Balanced", icon: Scale },
  { id: "full", label: "Full autonomy", icon: Zap },
];

export function AutonomyDial({ compact = false }: { compact?: boolean }) {
  const settings = useSyncExternalStore(
    autonomy.subscribe,
    autonomy.getSnapshot,
    autonomy.getSnapshot,
  );
  const toggleHalt = () => {
    if (settings.halted) autonomy.resume();
    else {
      autonomy.stopEverything();
      brain.stop();
    }
  };

  if (compact) {
    return (
      <div className="inline-flex items-center gap-1.5">
        <div
          role="group"
          aria-label="Autonomy"
          className="inline-flex h-6 items-stretch overflow-hidden rounded-sm border border-primary/25"
        >
          {LEVELS.map((level, index) => {
            const on = settings.approvalLevel === level.id;
            const Icon = level.icon;
            return (
              <button
                key={level.id}
                type="button"
                aria-pressed={on}
                title={level.label}
                onClick={() => autonomy.update({ approvalLevel: level.id })}
                className={cn(
                  "inline-flex items-center gap-1 px-2 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/60",
                  index > 0 && "border-l border-primary/15",
                  on
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:bg-primary/5 hover:text-primary active:bg-primary/15",
                )}
              >
                <Icon className="size-3" />
                {level.label}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={toggleHalt}
          title={settings.halted ? "Resume FRIDAY" : "Stop every run and every action now"}
          className={cn(
            "inline-flex h-6 items-center gap-1 rounded-sm border px-2 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60",
            settings.halted
              ? "border-accent/40 bg-accent/10 text-accent hover:bg-accent/20"
              : "border-destructive/40 text-destructive hover:bg-destructive/10 active:bg-destructive/20",
          )}
        >
          {settings.halted ? <Play className="size-3" /> : <OctagonX className="size-3" />}
          {settings.halted ? "Resume" : "Stop everything"}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {LEVELS.map((level) => (
        <Button
          key={level.id}
          size="sm"
          variant={settings.approvalLevel === level.id ? "default" : "outline"}
          aria-pressed={settings.approvalLevel === level.id}
          onClick={() => autonomy.update({ approvalLevel: level.id })}
        >
          {level.label}
        </Button>
      ))}
      <Button size="sm" variant="outline" onClick={toggleHalt}>
        {settings.halted ? "Resume" : "Stop everything"}
      </Button>
    </div>
  );
}
