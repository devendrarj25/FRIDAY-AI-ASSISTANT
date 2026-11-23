import { Component, useState, type ReactNode } from "react";
import { WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/friday/ui";
import { ErrorState } from "@/components/friday/PageStates";
import { isDesktopApp } from "@/lib/friday/desktop";
import { pageStatus, type PageStatus } from "@/lib/friday/page-state";
import { useKernelStatus } from "@/lib/friday/use-kernel-status";
import { useVoiceTasks } from "@/lib/friday/use-voice-tasks";
import type { VoiceTask } from "@/lib/friday/voice-engine/task-orchestrator";
import { liveTaskActions, taskRows, type TaskPanelActions } from "@/lib/friday/voice-task-rows";

export type VoiceTaskPanelViewProps = {
  tasks: readonly VoiceTask[];
  loading?: boolean;
  /** The task list could not be shown. */
  error?: unknown;
  /** The kernel is not connected: running work may wait or fail; the list stays. */
  offline?: boolean;
  /** One line about the last button press that changed nothing. */
  notice?: string;
  actions?: TaskPanelActions;
  /** Retry after an error. */
  onReload?: () => void;
  /** Called with the result line of a button press. */
  onNotice?: (line: string) => void;
};

/**
 * The live list of voice tasks. Data, loading, empty, error with Retry and offline are all drawn here; the
 * buttons call the task desk and never touch the voice session (a task is cancelled, the microphone is not).
 */
export function VoiceTaskPanelView({
  tasks,
  loading = false,
  error = null,
  offline = false,
  notice = "",
  actions = liveTaskActions,
  onReload,
  onNotice,
}: VoiceTaskPanelViewProps) {
  const status: PageStatus = pageStatus({
    loading,
    error: error ? "error" : null,
    count: tasks.length,
  });
  const rows = taskRows(tasks);
  const liveCount = rows.filter((row) => row.live).length;
  const run = (done: boolean, line: string) => {
    if (!done) onNotice?.(line);
  };
  return (
    <div
      role="region"
      aria-label="Background tasks"
      className="grid gap-1 rounded-md border border-border p-2 text-meta-sm"
    >
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 text-foreground">Background tasks</p>
        {status === "ready" && liveCount > 0 ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              run(actions.cancelAll() > 0, "Nothing was still running, so nothing was cancelled.")
            }
          >
            Cancel all
          </Button>
        ) : null}
      </div>
      {offline ? (
        <p role="status" className="flex items-center gap-1.5 text-warning">
          <WifiOff className="size-3.5 shrink-0" aria-hidden="true" />
          <span>
            The FRIDAY kernel is not connected. A task that needs it waits or fails; the list stays
            and updates when it is back.
          </span>
        </p>
      ) : null}
      {status === "loading" ? <LoadingState label="Loading tasks…" rows={1} /> : null}
      {status === "error" ? (
        <ErrorState
          title="The task list could not be shown"
          error={error}
          {...(onReload ? { onRetry: onReload } : {})}
          className="py-3"
        />
      ) : null}
      {status === "empty" ? (
        <p role="status" className="text-muted-foreground">
          No tasks running
        </p>
      ) : null}
      {status === "ready"
        ? rows.map((row) => (
            <div key={row.id} className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">{row.ordinal}.</span>
              <span className="min-w-0 flex-1 truncate text-foreground" title={row.name}>
                {row.name}
              </span>
              <span className="text-muted-foreground" aria-live="polite">
                {row.words}
                {row.waiting ? ` · ${row.waiting}` : ""}
                {row.detail ? ` · ${row.detail}` : ""}
              </span>
              {row.state === "WAITING_FOR_APPROVAL" ? (
                <>
                  <Button
                    size="sm"
                    onClick={() => run(actions.approve(row.id, true), "That task already changed.")}
                  >
                    Yes
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      run(actions.approve(row.id, false), "That task already changed.")
                    }
                  >
                    No
                  </Button>
                </>
              ) : null}
              {row.state === "RUNNING" ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => run(actions.pause(row.id), "That task cannot be paused now.")}
                >
                  Pause
                </Button>
              ) : null}
              {row.state === "PAUSED" ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => run(actions.resume(row.id), "That task cannot be resumed now.")}
                >
                  Resume
                </Button>
              ) : null}
              {row.canRetry && actions.retry ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    run(actions.retry?.(row.id) === true, "That task could not be started again.")
                  }
                >
                  Retry
                </Button>
              ) : null}
              {row.live ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => run(actions.cancel(row.id), "That task already finished.")}
                >
                  Cancel
                </Button>
              ) : null}
            </div>
          ))
        : null}
      {notice ? (
        <p role="status" className="text-muted-foreground">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

/** Reads the real task desk, the kernel status and the last button result. */
function LiveTaskPanel() {
  const tasks = useVoiceTasks();
  const kernel = useKernelStatus();
  const [notice, setNotice] = useState("");
  return (
    <VoiceTaskPanelView
      tasks={tasks}
      offline={isDesktopApp() && !kernel.connected}
      notice={notice}
      onNotice={setNotice}
    />
  );
}

type BoundaryState = { error: unknown; loading: boolean };

/** A render failure in the list shows the error with Retry; Retry draws the list again. */
class TaskPanelBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  override state: BoundaryState = { error: null, loading: false };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error: error ?? new Error("unknown error"), loading: false };
  }

  override componentDidUpdate(): void {
    if (this.state.loading) this.setState({ loading: false });
  }

  private readonly reload = () => this.setState({ error: null, loading: true });

  override render(): ReactNode {
    if (this.state.error || this.state.loading)
      return (
        <VoiceTaskPanelView
          tasks={[]}
          loading={this.state.loading}
          error={this.state.error}
          onReload={this.reload}
        />
      );
    return this.props.children;
  }
}

/**
 * Work that continues while she keeps talking. Cancel, pause and resume act on one task and never on the voice
 * session; a task that needs approval waits for a yes or a no.
 */
export function VoiceTaskPanel() {
  return (
    <TaskPanelBoundary>
      <LiveTaskPanel />
    </TaskPanelBoundary>
  );
}
