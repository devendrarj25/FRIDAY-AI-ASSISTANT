import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { Download, RefreshCw, Save, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HudPanel, MetricBar, ToggleRow } from "@/components/friday/ui";
import { memory, memoryTiers } from "@/lib/friday/self/memory-engine";
import { useMemory } from "@/lib/friday/self/use-self";
import { preferences } from "@/lib/friday/preferences";
import { usePreferences } from "@/lib/friday/use-preferences";
import { formatOwnerDate, shouldRememberChats } from "@/lib/friday/settings-runtime";
import { forgetOwner, ownerSnapshot } from "@/lib/friday/owner-model";

/**
 * Memory *settings* — toggles, caps overview, and snapshot/transfer.
 * Search, teach, pin and per-tier clear live on the Memory page.
 */
export function MemorySettings() {
  const navigate = useNavigate();
  const state = useMemory();
  const prefs = usePreferences();
  const [backupAt, setBackupAt] = useState<number | null>(null);
  const [noticedTick, setNoticedTick] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => setBackupAt(memory.lastBackupAt()), [state.lastWriteAt]);

  const isOn = (k: string) => prefs.toggles[k] === true;
  const flip = (k: string) => preferences.setToggle(k, !isOn(k));
  const total = state.items.length;

  const onImport = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    try {
      const added = memory.import(await file.text());
      toast.success(`Imported ${added} memory item(s)`);
    } catch (error) {
      toast.error(`Import failed — ${String((error as Error).message ?? error)}`);
    }
  };

  return (
    <div className="space-y-4">
      <HudPanel
        title="Memory Tiers"
        hint={`${total} item(s) stored`}
        actions={
          <Button size="sm" variant="outline" onClick={() => void navigate({ to: "/memory" })}>
            Open Memory →
          </Button>
        }
      >
        <div className="space-y-2">
          {memoryTiers.map((tier) => {
            const count = state.counts[tier.id] ?? 0;
            return (
              <div key={tier.id}>
                <MetricBar
                  label={tier.label}
                  value={tier.cap ? Math.min(100, Math.round((count / tier.cap) * 100)) : 0}
                  detail={`${count} of ${tier.cap} items`}
                  tone={count >= tier.cap ? "warning" : "primary"}
                />
                <p className="mt-1 truncate text-[11px] text-muted-foreground">{tier.note}</p>
              </div>
            );
          })}
        </div>
      </HudPanel>

      <HudPanel title="Memory Behaviour">
        <ToggleRow
          label="Memory optimization (compact and de-duplicate)"
          on={isOn("memOpt")}
          onToggle={() => flip("memOpt")}
        />
        <ToggleRow
          label="Auto clear expired working memory"
          on={isOn("autoClear")}
          onToggle={() => flip("autoClear")}
        />
        <ToggleRow
          label="Long term memory"
          on={isOn("longTerm")}
          onToggle={() => flip("longTerm")}
        />
        <ToggleRow
          label="Remember conversations automatically"
          on={shouldRememberChats()}
          onToggle={() => preferences.setToggle("rememberChats", !shouldRememberChats())}
        />
        <ToggleRow
          label="Snapshot memory before every self-update"
          on={isOn("memorySnapshot")}
          onToggle={() => flip("memorySnapshot")}
        />
        <ToggleRow
          label="Clear unpinned working memory when FRIDAY quits"
          on={isOn("clearWorkingOnQuit")}
          onToggle={() => flip("clearWorkingOnQuit")}
        />
      </HudPanel>

      <HudPanel
        title="Snapshot & Transfer"
        hint={backupAt ? `last snapshot ${formatOwnerDate(backupAt)}` : "no snapshot yet"}
      >
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={() => {
              const count = memory.backup();
              setBackupAt(memory.lastBackupAt());
              toast.success(`Snapshot taken — ${count} item(s)`);
            }}
          >
            <Save className="size-4" /> Snapshot now
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!backupAt}
            onClick={() => {
              const count = memory.restoreBackup();
              toast.success(`Restored ${count} item(s) from the last snapshot`);
            }}
          >
            <RefreshCw className="size-4" /> Restore snapshot
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const blob = new Blob([memory.export()], { type: "application/json" });
              const url = URL.createObjectURL(blob);
              const link = document.createElement("a");
              link.href = url;
              link.download = `friday-memory-${new Date().toISOString().slice(0, 10)}.json`;
              link.click();
              URL.revokeObjectURL(url);
              toast.success("Memory exported");
            }}
          >
            <Download className="size-4" /> Export JSON
          </Button>
          <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
            <Upload className="size-4" /> Import JSON
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const dropped = memory.optimize();
              toast.success(
                dropped ? `Compacted — ${dropped} record(s) dropped` : "Already within caps",
              );
            }}
          >
            Compact now
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (!window.confirm("Clear unpinned working memory?")) return;
              memory.clearTier("working");
              toast.success("Working memory cleared");
            }}
          >
            Clear working
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              void onImport(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      </HudPanel>
      <HudPanel title="What FRIDAY noticed">
        <p className="text-xs text-muted-foreground">
          Goals, habits, and names from this session. Local only.
        </p>
        <p className="mt-2 font-mono text-xs text-foreground">
          {noticedTick >= 0 ? ownerSnapshot().goals.join(", ") || "No goals yet." : ""}
        </p>
        <Button
          size="sm"
          variant="outline"
          className="mt-2"
          onClick={() => {
            forgetOwner("all");
            setNoticedTick((tick) => tick + 1);
          }}
        >
          Forget these notes
        </Button>
      </HudPanel>
    </div>
  );
}
