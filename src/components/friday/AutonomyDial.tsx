/**
 * FRIDAY · autonomy dial.
 *
 * Ask every time, Balanced, or Full. The kill switch is always here.
 */
import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { brain } from "@/lib/friday/brain-engine";
import { autonomy, type ApprovalLevel } from "@/lib/friday/self/autonomy";

const LEVELS: { id: ApprovalLevel; label: string }[] = [
  { id: "strict", label: "Ask every time" },
  { id: "balanced", label: "Balanced" },
  { id: "full", label: "Full autonomy" },
];

export function AutonomyDial() {
  const settings = useSyncExternalStore(
    autonomy.subscribe,
    autonomy.getSnapshot,
    autonomy.getSnapshot,
  );
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
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          if (settings.halted) autonomy.resume();
          else {
            autonomy.stopEverything();
            brain.stop();
          }
        }}
      >
        {settings.halted ? "Resume" : "Stop everything"}
      </Button>
    </div>
  );
}
