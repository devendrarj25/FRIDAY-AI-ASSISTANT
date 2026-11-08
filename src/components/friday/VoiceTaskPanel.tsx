import { Button } from "@/components/ui/button";
import { useVoiceTasks } from "@/lib/friday/use-voice-tasks";
import { voiceTaskActions } from "@/lib/friday/voice-engine/voice-tasks";
import { TERMINAL, type TaskState } from "@/lib/friday/voice-engine/task-orchestrator";

const LABEL: Record<TaskState, string> = {
  CREATED: "Created",
  QUEUED: "Waiting",
  RUNNING: "Working",
  WAITING_FOR_INPUT: "Needs your answer",
  WAITING_FOR_APPROVAL: "Needs your yes",
  PAUSED: "Paused",
  COMPLETED: "Done",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};

/**
 * Work that continues while she keeps talking. Shown only when there is something to show. Cancel, pause and
 * resume act on one task and never on the voice session; a task that needs approval waits for a yes or a no.
 */
export function VoiceTaskPanel() {
  const tasks = useVoiceTasks();
  if (tasks.length === 0) return null;
  const shown = tasks.slice(-5).reverse();
  return (
    <div
      role="region"
      aria-label="Background tasks"
      className="grid gap-1 rounded-md border border-border p-2 text-meta-sm"
    >
      <p className="text-foreground">Background tasks</p>
      {shown.map((task) => {
        const live = !TERMINAL.includes(task.state);
        return (
          <div key={task.id} className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-foreground" title={task.label}>
              {task.label}
            </span>
            <span className="text-muted-foreground" aria-live="polite">
              {LABEL[task.state]}
              {task.percent !== undefined && live ? ` · ${task.percent}%` : ""}
              {task.state === "FAILED" && task.error ? ` · ${task.error}` : ""}
            </span>
            {task.state === "WAITING_FOR_APPROVAL" ? (
              <>
                <Button size="sm" onClick={() => voiceTaskActions.approve(task.id, true)}>
                  Yes
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => voiceTaskActions.approve(task.id, false)}
                >
                  No
                </Button>
              </>
            ) : null}
            {task.state === "RUNNING" ? (
              <Button size="sm" variant="outline" onClick={() => voiceTaskActions.pause(task.id)}>
                Pause
              </Button>
            ) : null}
            {task.state === "PAUSED" ? (
              <Button size="sm" variant="outline" onClick={() => voiceTaskActions.resume(task.id)}>
                Resume
              </Button>
            ) : null}
            {live ? (
              <Button size="sm" variant="ghost" onClick={() => voiceTaskActions.cancel(task.id)}>
                Cancel
              </Button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
