import { useState } from "react";
import { HudPanel } from "@/components/friday/ui";
import { handleHubIntent } from "@/lib/friday/hub-chat";

type Line = { role: "user" | "friday"; text: string };

/**
 * Same pattern as ImportChat: HudPanel + Core Brain, grounded in live Hub
 * diff/validate/history. Capability import chat stays on Import & Build.
 */
export function HubChat() {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<Line[]>([
    {
      role: "friday",
      text: "Ask about the selected Hub repo (review this diff, failing tests, safe to merge). Answers use the live workspace/diff/validate/history — they are not invented. File fixes wait for your approval. This panel does not check whether FRIDAY herself is out of date.",
    },
  ]);

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    setLines((prev) => [...prev, { role: "user", text }]);
    setBusy(true);
    try {
      const reply = await handleHubIntent(text);
      setLines((prev) => [...prev, { role: "friday", text: reply.text }]);
    } catch (error) {
      setLines((prev) => [
        ...prev,
        { role: "friday", text: String((error as Error)?.message || error) },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <HudPanel title="FRIDAY · this repo" className="mt-4" hint="same Core Brain as Chat">
      <p className="mb-2 text-[10px] uppercase tracking-widest text-muted-foreground">
        Grounded in the selected Hub checkout. Clone from GitHub below stays capability import.
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
          placeholder="review this diff · find the bug · validate before I push"
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
