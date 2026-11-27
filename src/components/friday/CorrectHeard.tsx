import { useState } from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { Caption } from "@/lib/friday/assistant-mode";
import {
  canCorrect,
  correctionRow,
  heardOf,
  saveCorrection,
} from "@/lib/friday/glossary-correction";
import { usePreferences } from "@/lib/friday/use-preferences";

export type CorrectStatus = "editing" | "saving" | "error" | "done";

/** The form of "Correct what I heard": loading, error with Retry and the saved line are all shown here. */
export function CorrectHeardForm({
  heard,
  value,
  status,
  message,
  learning,
  onChange,
  onSave,
  onCancel,
}: {
  heard: string;
  value: string;
  status: CorrectStatus;
  message?: string;
  /** The stored "Learn the words I correct" setting. */
  learning: boolean;
  onChange: (next: string) => void;
  onSave: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const unchanged = !value.trim() || value.trim() === heard;
  const busy = status === "saving";
  if (status === "done") {
    return (
      <div className="mt-2 grid gap-1.5 text-left" role="status">
        <p className="text-meta-sm text-accent">Saved.</p>
        {learning ? null : (
          <p className="text-meta-sm text-muted-foreground">
            No word was learned: “Learn the words I correct” is off in Settings.
          </p>
        )}
        <div>
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            Close
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="mt-2 grid gap-1.5 text-left">
      <p className="text-meta-sm text-muted-foreground">I heard: {heard}</p>
      <Textarea
        value={value}
        disabled={busy}
        rows={2}
        aria-label="What you said"
        onChange={(event) => onChange(event.target.value)}
      />
      {unchanged ? (
        <p className="text-meta-sm text-muted-foreground">Change at least one word to save.</p>
      ) : null}
      {status === "saving" ? (
        <p className="text-meta-sm text-muted-foreground" role="status">
          Saving…
        </p>
      ) : null}
      {status === "error" ? (
        <p className="text-meta-sm text-destructive" role="alert">
          {message ?? "That did not save."}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={busy || unchanged} onClick={() => void onSave()}>
          {status === "error" ? "Retry" : "Save"}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * "Correct what I heard" on a heard line in the transcript. It sends one corrected owner row to the kernel glossary
 * and nothing else; her own lines, room talk and unfinished lines show no action.
 */
export function CorrectHeard({ caption }: { caption: Caption }) {
  const prefs = usePreferences();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<CorrectStatus>("editing");
  const [message, setMessage] = useState<string | undefined>(undefined);
  const glossaryOn = prefs.toggles["brainLearnGlossary"] !== false;
  if (!canCorrect(caption)) return null;

  const begin = () => {
    setValue(caption.text);
    setStatus("editing");
    setMessage(undefined);
    setOpen(true);
  };
  const save = async () => {
    if (!correctionRow(caption, value)) return;
    setStatus("saving");
    const out = await saveCorrection(caption, value, glossaryOn);
    if (out.ok) {
      setStatus("done");
    } else {
      setMessage(out.error);
      setStatus("error");
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        aria-label="Correct what I heard"
        title="Correct what I heard"
        onClick={begin}
        className="chat-row-action mt-1 inline-flex items-center gap-1 rounded-ctl text-meta-sm text-muted-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
      >
        <Pencil className="size-3" aria-hidden="true" />
        Correct what I heard
      </button>
    );
  }
  return (
    <CorrectHeardForm
      heard={heardOf(caption)}
      value={value}
      status={status}
      {...(message !== undefined ? { message } : {})}
      learning={glossaryOn}
      onChange={setValue}
      onSave={save}
      onCancel={() => setOpen(false)}
    />
  );
}
