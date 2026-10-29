import { useState, useSyncExternalStore } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Panel } from "@/components/friday/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { personalDesk, parseTaskTitle } from "@/lib/friday/personal-desk";

const empty = { tasks: [] };

/** The owner's to-do list: the same store "todo: ..." and "remind me to ..." in chat write to. */
export function TodoPanel() {
  const desk = useSyncExternalStore(
    personalDesk.subscribe,
    () => personalDesk.getSnapshot(),
    () => empty,
  );
  const [text, setText] = useState("");
  const open = desk.tasks.filter((task) => !task.done);
  const done = desk.tasks.filter((task) => task.done);

  const add = () => {
    const parsed = parseTaskTitle(text);
    if (!parsed.title) {
      toast.message("Write what needs doing first");
      return;
    }
    personalDesk.add(parsed.title, parsed.dueAt);
    setText("");
  };

  return (
    <Panel title="To-do" hint={`${open.length} open · ${done.length} done`}>
      <div className="mb-3 flex gap-2">
        <Input
          value={text}
          placeholder="Add a to-do, e.g. call the bank tomorrow at 5pm"
          aria-label="New to-do"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") add();
          }}
        />
        <Button size="sm" onClick={add}>
          <Plus className="size-3.5" /> Add
        </Button>
      </div>
      {desk.tasks.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing to do yet. Add one here, or say &ldquo;todo: renew the licence&rdquo; or
          &ldquo;remind me to call mom at 6pm&rdquo; in chat.
        </p>
      ) : (
        <ul className="space-y-1">
          {[...open, ...done].map((task) => (
            <li key={task.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={task.done}
                aria-label={`${task.done ? "Reopen" : "Finish"} ${task.title}`}
                onChange={() => personalDesk.toggle(task.id)}
              />
              <span className={cn("flex-1", task.done && "text-muted-foreground line-through")}>
                {task.title}
              </span>
              {task.dueAt ? (
                <span className="text-xs text-muted-foreground">
                  {new Date(task.dueAt).toLocaleString()}
                </span>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Delete ${task.title}`}
                onClick={() => personalDesk.remove(task.id)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {done.length > 0 ? (
        <div className="mt-2">
          <Button size="sm" variant="ghost" onClick={() => personalDesk.clearDone()}>
            Clear finished
          </Button>
        </div>
      ) : null}
    </Panel>
  );
}
