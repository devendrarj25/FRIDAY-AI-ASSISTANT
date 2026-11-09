import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { assistantMode } from "@/lib/friday/assistant-mode";
import { preferences } from "@/lib/friday/preferences";
import { usePreferences } from "@/lib/friday/use-preferences";
import { voiceNotes } from "@/lib/friday/voice-notes";

const RETENTION = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 0, label: "Until I delete them" },
];

/** The running note, always visible while it records. Shown on the Auto page so it can never run unseen. */
export function VoiceNoteBanner() {
  const { active } = useSyncExternalStore(
    voiceNotes.subscribe,
    voiceNotes.getSnapshot,
    voiceNotes.getSnapshot,
  );
  const translating = useSyncExternalStore(
    assistantMode.subscribe,
    () => assistantMode.translationTarget(),
    () => null,
  );
  if (!active && !translating) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2 text-meta-sm"
    >
      {active ? (
        <>
          <span aria-hidden className="inline-block h-2 w-2 rounded-full bg-destructive" />
          <span className="min-w-0 flex-1 text-foreground">
            Writing a {active.kind === "meeting" ? "meeting" : "note"} · {active.lines.length} line
            {active.lines.length === 1 ? "" : "s"} · text only, no audio saved
          </span>
          <Button size="sm" variant="outline" onClick={() => voiceNotes.stop()}>
            Stop
          </Button>
        </>
      ) : null}
      {translating ? (
        <span className="text-foreground">
          Translating to {translating === "en" ? "English" : "Hindi"} — say “stop translating” to
          end
        </span>
      ) : null}
    </div>
  );
}

/** Saved notes with delete and the retention choice. Notes are text on this PC; no audio and no speaker names. */
export function VoiceNotesList() {
  const { notes } = useSyncExternalStore(
    voiceNotes.subscribe,
    voiceNotes.getSnapshot,
    voiceNotes.getSnapshot,
  );
  const prefs = usePreferences();
  return (
    <div className="grid gap-2 text-meta-sm text-muted-foreground">
      <p className="text-foreground">Voice notes and meeting notes</p>
      <p>
        Say “start a note”, “note shuru karo” or “start the meeting” in Auto mode. While one runs,
        what you say is written as text and does not go to the assistant; say “stop note” to end it.
        A meeting then gets short minutes from the assistant. Nothing is recorded as audio, and who
        said a line is not kept. Say “translate to English” or “hindi me translate karo” to hear
        each line translated.
      </p>
      <label className="flex flex-wrap items-center gap-2">
        <span>Keep finished notes for</span>
        <select
          className="rounded-md border border-border bg-background px-2 py-1 text-foreground"
          value={prefs.voice.notesRetentionDays}
          onChange={(e) => {
            const days = Number(e.target.value);
            preferences.setVoice({ notesRetentionDays: days });
            voiceNotes.purge(days);
          }}
        >
          {RETENTION.map((r) => (
            <option key={r.days} value={r.days}>
              {r.label}
            </option>
          ))}
        </select>
        {notes.length ? (
          <Button size="sm" variant="outline" onClick={() => voiceNotes.clear()}>
            Delete all
          </Button>
        ) : null}
      </label>
      {notes.length === 0 ? <p>No notes yet.</p> : null}
      {notes.slice(0, 20).map((note) => (
        <details key={note.id} className="rounded-md border border-border p-2">
          <summary className="cursor-pointer text-foreground">
            {note.title} · {note.lines.length} line{note.lines.length === 1 ? "" : "s"}
            {note.endedAt === null ? " · running" : ""}
          </summary>
          {note.summary ? (
            <p className="mt-1 whitespace-pre-wrap text-foreground">{note.summary}</p>
          ) : null}
          <ul className="mt-1 grid gap-0.5">
            {note.lines.slice(0, 200).map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
          <Button
            className="mt-1"
            size="sm"
            variant="outline"
            onClick={() => voiceNotes.remove(note.id)}
          >
            Delete
          </Button>
        </details>
      ))}
    </div>
  );
}
