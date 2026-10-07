import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HudPanel, ToggleRow } from "@/components/friday/ui";
import { Row } from "@/components/friday/settings/fields";
import { preferences } from "@/lib/friday/preferences";
import { usePreferences } from "@/lib/friday/use-preferences";
import { memory, memoryTiers } from "@/lib/friday/self/memory-engine";
import { useMemory } from "@/lib/friday/self/use-self";
import { useWorkspaceRootState } from "@/lib/friday/desktop";
import { useAppVersion } from "@/lib/friday/version";
import { formatOwnerDate, SETTINGS_BACKUP_KIND } from "@/lib/friday/settings-runtime";

export function BackupSettings() {
  const prefs = usePreferences();
  const memoryCounts = useMemory().counts;
  const memoryTotal = Object.values(memoryCounts).reduce((a, b) => a + b, 0);
  const workspaceRoot = useWorkspaceRootState();
  const appVersion = useAppVersion();
  const backupFileRef = useRef<HTMLInputElement | null>(null);
  const prefsFileRef = useRef<HTMLInputElement | null>(null);
  const allFileRef = useRef<HTMLInputElement | null>(null);
  const [backupAt, setBackupAt] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const isOn = (k: string) => prefs.toggles[k] === true;

  useEffect(() => setBackupAt(memory.lastBackupAt()), []);

  const run = async (id: string, label: string, action: () => Promise<unknown> | unknown) => {
    if (busy) return;
    setBusy(id);
    try {
      await action();
    } catch (error) {
      toast.error(`${label} failed — ${String((error as Error).message ?? error)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <HudPanel title="Backup & Restore" hint="local snapshots of FRIDAY state">
      <dl className="space-y-2 font-mono text-[11px] text-muted-foreground">
        <Row k="memory records" v={`${memoryTotal} across ${memoryTiers.length} tiers`} />
        <Row k="last snapshot" v={backupAt ? formatOwnerDate(backupAt) : "none yet"} />
        <Row k="workspace" v={workspaceRoot || "unknown"} />
        <Row k="app version" v={`${appVersion.label} · ${appVersion.build}`} />
      </dl>
      <ToggleRow
        label="Snapshot automatically before updates and risky changes"
        on={isOn("autoSnapshot")}
        onToggle={() => preferences.setToggle("autoSnapshot", !isOn("autoSnapshot"))}
      />
      <p className="mt-2 text-[11px] text-muted-foreground">
        Memory snapshots live in FRIDAY&apos;s local store. EXE update backup/rollback stays on the
        existing update-safety path — this panel does not replace it.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={busy === "snapshot"}
          onClick={() => {
            void run("snapshot", "Snapshot", () => {
              const count = memory.backup();
              setBackupAt(Date.now());
              toast.success(`Snapshot saved (${count} records)`);
            });
          }}
        >
          <Save className="size-4" /> Back up memory now
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy === "restore"}
          onClick={() => {
            void run("restore", "Restore", () => {
              const count = memory.restoreBackup();
              toast.success(count ? `Restored ${count} records` : "No local snapshot found");
            });
          }}
        >
          Restore memory snapshot
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const blob = new Blob([memory.export()], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `friday-memory-${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
            toast.success("Memory exported");
          }}
        >
          Export memory
        </Button>
        <Button size="sm" variant="outline" onClick={() => backupFileRef.current?.click()}>
          Import memory
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const blob = new Blob([preferences.exportJson()], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `friday-preferences-${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
            toast.success("Preferences exported");
          }}
        >
          Export preferences
        </Button>
        <Button size="sm" variant="outline" onClick={() => prefsFileRef.current?.click()}>
          Import preferences
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const payload = {
              kind: SETTINGS_BACKUP_KIND,
              savedAt: Date.now(),
              preferences: JSON.parse(preferences.exportJson()) as unknown,
              memory: JSON.parse(memory.export()) as unknown,
            };
            const blob = new Blob([JSON.stringify(payload, null, 2)], {
              type: "application/json",
            });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `friday-backup-${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
            toast.success("Combined backup exported");
          }}
        >
          Export everything
        </Button>
        <Button size="sm" variant="outline" onClick={() => allFileRef.current?.click()}>
          Import combined backup
        </Button>
        <input
          ref={backupFileRef}
          type="file"
          accept="application/json"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            void file.text().then((text) => {
              try {
                const count = memory.import(text);
                toast.success(`Imported ${count} records`);
              } catch {
                toast.error("That file is not a FRIDAY memory backup");
              }
            });
          }}
        />
        <input
          ref={prefsFileRef}
          type="file"
          accept="application/json"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            void file.text().then((text) => {
              try {
                preferences.importJson(text);
                toast.success("Preferences imported");
              } catch (error) {
                toast.error(String((error as Error).message ?? error));
              }
            });
          }}
        />
        <input
          ref={allFileRef}
          type="file"
          accept="application/json"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            void file.text().then((text) => {
              try {
                const parsed = JSON.parse(text) as {
                  kind?: string;
                  preferences?: unknown;
                  memory?: unknown;
                };
                if (parsed.kind !== SETTINGS_BACKUP_KIND) {
                  toast.error("That file is not a FRIDAY combined backup");
                  return;
                }
                if (parsed.preferences) {
                  preferences.importJson(JSON.stringify(parsed.preferences));
                }
                let added = 0;
                if (parsed.memory) {
                  added = memory.import(JSON.stringify(parsed.memory));
                }
                toast.success(
                  added ? `Imported settings and ${added} memory record(s)` : "Imported settings",
                );
              } catch (error) {
                toast.error(String((error as Error).message ?? error));
              }
            });
          }}
        />
      </div>
    </HudPanel>
  );
}
