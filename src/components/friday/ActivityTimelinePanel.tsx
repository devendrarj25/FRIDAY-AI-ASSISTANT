import { useMemo, useSyncExternalStore } from "react";
import { Panel } from "@/components/friday/AppShell";
import { personalDesk } from "@/lib/friday/personal-desk";
import { timeline } from "@/lib/friday/self/activity-timeline";
import { ledger } from "@/lib/friday/self/task-ledger";

const empty = { tasks: [] };

/** What FRIDAY did with the owner and what he finished, by day. Read from the ledger and the to-do list only. */
export function ActivityTimelinePanel() {
  const desk = useSyncExternalStore(
    personalDesk.subscribe,
    () => personalDesk.getSnapshot(),
    () => empty,
  );
  const groups = useMemo(
    () => timeline({ runs: ledger.list(), todos: desk.tasks }, Date.now()),
    [desk.tasks],
  );
  return (
    <Panel title="What I worked on" hint="last 7 days · from your runs and to-dos">
      {groups.length ? (
        <div className="grid gap-3">
          {groups.map((group) => (
            <section key={group.day} aria-label={group.label}>
              <h3 className="label-xs text-muted-foreground">{group.label}</h3>
              <ul className="mt-1 grid gap-1">
                {group.entries.map((entry) => (
                  <li key={`${entry.at}-${entry.text}`} className="text-data text-foreground">
                    {new Date(entry.at).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}{" "}
                    {entry.failed ? "— did not finish: " : "— "}
                    {entry.text}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <p className="text-meta-sm text-muted-foreground">
          Nothing yet. This is built only from runs and to-dos FRIDAY already keeps; no screen or
          keyboard is recorded.
        </p>
      )}
    </Panel>
  );
}
