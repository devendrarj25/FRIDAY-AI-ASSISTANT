import { useMemo, useState } from "react";
import { ClipboardCopy, ListPlus } from "lucide-react";
import { toast } from "sonner";
import { Panel } from "@/components/friday/AppShell";
import { Button } from "@/components/ui/button";
import { personalDesk } from "@/lib/friday/personal-desk";
import { makeNotes, notesToMarkdown } from "@/lib/friday/self/meeting-notes";

/**
 * Notes from a meeting or lecture transcript: decisions, action items with who and by when, open questions.
 * Rules only, on this PC; the transcript is treated as data. Action items can be added to the to-do list.
 */
export function MeetingNotesPanel() {
  const [text, setText] = useState("");
  const notes = useMemo(() => (text.trim() ? makeNotes(text) : null), [text]);

  const addActions = () => {
    if (!notes?.actions.length) return;
    for (const item of notes.actions) {
      const label = `${item.who ? `${item.who}: ` : ""}${item.what}`.slice(0, 180);
      personalDesk.add(label, item.dueAt ?? null);
    }
    toast.success(`${notes.actions.length} action item(s) added to your to-do list`);
  };

  const copy = async () => {
    if (!notes) return;
    try {
      await navigator.clipboard.writeText(notesToMarkdown(notes));
      toast.success("Notes copied");
    } catch {
      toast.error("Copy was blocked; select the text and copy it by hand");
    }
  };

  return (
    <Panel
      title="Meeting notes"
      hint={
        notes
          ? `${notes.decisions.length} decisions · ${notes.actions.length} actions`
          : "from a transcript"
      }
    >
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={6}
        placeholder={
          'Paste a transcript. A line like "Ravi: I\'ll send the quote by friday." becomes an action item.'
        }
        aria-label="Transcript"
        className="w-full rounded-md border border-border bg-background p-2 text-data text-foreground"
      />
      {notes ? (
        <div className="mt-3 grid gap-2">
          <pre className="whitespace-pre-wrap break-words text-data text-foreground">
            {notesToMarkdown(notes)}
          </pre>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={addActions}
              disabled={!notes.actions.length}
            >
              <ListPlus className="mr-1 size-4" /> Add actions to to-do
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void copy()}>
              <ClipboardCopy className="mr-1 size-4" /> Copy
            </Button>
          </div>
        </div>
      ) : (
        <p className="mt-2 text-meta-sm text-muted-foreground">
          Nothing is sent anywhere. English and Hinglish are read; a name or a date appears only if
          the words say one.
        </p>
      )}
    </Panel>
  );
}
