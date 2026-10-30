/**
 * FRIDAY · what she can read and make
 *
 * One row per kind of file, from the same registry the brain answers from. A gap is shown as a gap:
 * "partly" and "not yet" say what is missing in words, never a decorative tick.
 */
import { useMemo, useState } from "react";
import { EmptyState, HudPanel, StatusPill } from "@/components/friday/ui";
import { FORMAT_ROWS, findFormats, type FormatStatus } from "@/lib/friday/brain/format-atlas";

type Tone = "accent" | "warning" | "destructive" | "muted";

const TONE: Record<FormatStatus, Tone> = {
  built: "accent",
  "needs-tool": "warning",
  partial: "warning",
  "not-built": "destructive",
};

const LABEL: Record<FormatStatus, string> = {
  built: "yes",
  "needs-tool": "needs a program",
  partial: "partly",
  "not-built": "not yet",
};

export function FormatAtlasPanel() {
  const [query, setQuery] = useState("");
  const rows = useMemo(() => {
    const text = query.trim();
    if (!text) return [...FORMAT_ROWS];
    const found = findFormats(text).map((row) => row.id);
    const lower = text.toLowerCase();
    return FORMAT_ROWS.filter(
      (row) => found.includes(row.id) || row.label.toLowerCase().includes(lower),
    );
  }, [query]);

  return (
    <HudPanel title="What I can read and make" hint={`${FORMAT_ROWS.length} kinds of file`}>
      <div className="grid gap-3">
        <label className="grid gap-1 text-meta text-muted-foreground">
          Find a kind of file (docx, video, zip, php…)
          <input
            className="rounded-surface border border-border bg-background p-2 text-foreground"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Find a kind of file"
          />
        </label>
        {rows.length === 0 ? (
          <EmptyState
            title="No kind of file matches that"
            hint="Try a name like Word, Excel, PDF, image, audio, video or zip, or an extension such as .docx."
          />
        ) : (
          <ul className="grid gap-1.5">
            {rows.map((row) => (
              <li key={row.id} className="rounded-ctl border border-border/60 px-2.5 py-1.5">
                <span className="text-sm text-foreground">{row.label}</span>
                {(["read", "make"] as const).map((side) => (
                  <div key={side} className="mt-1 flex flex-wrap items-center gap-2">
                    <span className="w-12 text-meta-sm uppercase text-muted-foreground">
                      {side}
                    </span>
                    <StatusPill label={LABEL[row[side].status]} tone={TONE[row[side].status]} />
                    <span className="break-words text-data text-muted-foreground">
                      {row[side].note}
                    </span>
                  </div>
                ))}
              </li>
            ))}
          </ul>
        )}
      </div>
    </HudPanel>
  );
}
