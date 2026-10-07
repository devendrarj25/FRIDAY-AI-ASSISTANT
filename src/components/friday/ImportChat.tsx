import { useState } from "react";
import { HudPanel } from "@/components/friday/ui";
import { useImports } from "@/lib/friday/use-imports";
import { handleImportIntent } from "@/lib/friday/import-chat";
import { imports } from "@/lib/friday/import-engine";

type Line = { role: "user" | "friday"; text: string };

export function ImportChat() {
  const { items } = useImports();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<Line[]>([
    {
      role: "friday",
      text: "Ask about the current import (what was classified, where it will land). Commands reuse the same Verify / Install / Analyse / Build pipeline as the buttons — install still waits for Self-management approval. FRIDAY's GitHub repo is not edited from here.",
    },
  ]);

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    setLines((prev) => [...prev, { role: "user", text }]);
    setBusy(true);
    try {
      const reply = await handleImportIntent(text, imports.list());
      setLines((prev) => [...prev, { role: "friday", text: reply.text }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <HudPanel title="FRIDAY · this import" className="mt-4" hint="same Core Brain as Chat">
      <p className="mb-2 text-[10px] uppercase tracking-widest text-muted-foreground">
        Answers are grounded in the {items.length} staged scan{items.length === 1 ? "" : "s"}.
      </p>
      <div className="mb-2 max-h-48 space-y-2 overflow-y-auto text-sm">
        {lines.map((line, i) => (
          <p
            key={`${line.role}-${i}`}
            className={line.role === "user" ? "text-foreground" : "text-muted-foreground"}
          >
            <span className="mr-2 text-[10px] uppercase tracking-widest">
              {line.role === "user" ? "You" : "FRIDAY"}
            </span>
            <span className="whitespace-pre-wrap">{line.text}</span>
          </p>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          className="flex-1 border border-border bg-background px-2 py-1 text-sm"
          value={draft}
          disabled={busy}
          placeholder="what's in this zip · analyse this · build friday exe · build zip of this project"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button
          type="button"
          className="hud-btn text-xs"
          disabled={busy || !draft.trim()}
          onClick={() => void send()}
        >
          {busy ? "…" : "Ask"}
        </button>
      </div>
    </HudPanel>
  );
}
