import { useEffect, useState } from "react";
import { toast } from "sonner";
import { FolderPlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HudPanel } from "@/components/friday/ui";
import { ErrorState } from "@/components/friday/PageStates";
import { pickFolder } from "@/lib/friday/desktop";
import { kernelApi } from "@/lib/friday/kernel-api";

type Key = "read_roots" | "write_roots" | "read_only_roots";

const LISTS: { key: Key; title: string; hint: string }[] = [
  {
    key: "read_roots",
    title: "FRIDAY may read",
    hint: "Besides her own workspace. Passwords, keys and .env files are never opened.",
  },
  {
    key: "write_roots",
    title: "FRIDAY may write",
    hint: "Files she makes or changes here still need your approval each time.",
  },
  {
    key: "read_only_roots",
    title: "Never write here",
    hint: "Wins over the other two lists, even inside her workspace.",
  },
];

/** The three folder lists, set by the owner and checked by the kernel before they are saved. */
export function FolderAccessSettings() {
  const [lists, setLists] = useState<Record<Key, string[]> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Key | null>(null);

  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    kernelApi.settings
      .get()
      .then((out) => {
        if (!alive) return;
        const read = (key: Key) =>
          Array.isArray(out?.settings?.[key]) ? (out.settings[key] as unknown[]).map(String) : [];
        setLists({
          read_roots: read("read_roots"),
          write_roots: read("write_roots"),
          read_only_roots: read("read_only_roots"),
        });
        setError(null);
      })
      .catch((failure) => {
        if (alive) setError(failure instanceof Error ? failure.message : String(failure));
      });
    return () => {
      alive = false;
    };
  }, [reload]);

  const load = () => setReload((n) => n + 1);

  const save = async (key: Key, next: string[]) => {
    setBusy(key);
    try {
      const out = await kernelApi.settings.set(key, next);
      if (out && out["ok"] === false) {
        toast.error(String(out["error"] ?? "That folder list was refused"));
      } else {
        load();
      }
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(null);
    }
  };

  const add = async (key: Key) => {
    const folder = await pickFolder();
    if (!folder || !lists) return;
    if (lists[key].includes(folder)) return;
    await save(key, [...lists[key], folder]);
  };

  return (
    <HudPanel title="Folder access" hint="what she may read, write and never touch">
      {error ? (
        <ErrorState title="Folder lists could not be loaded" error={error} onRetry={load} />
      ) : !lists ? (
        <p className="text-meta-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="grid gap-4">
          {LISTS.map((list) => (
            <section key={list.key} aria-label={list.title} className="grid gap-1">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm text-foreground">{list.title}</h3>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy === list.key}
                  onClick={() => void add(list.key)}
                >
                  <FolderPlus className="size-4" /> Add folder
                </Button>
              </div>
              <p className="text-meta-sm text-muted-foreground">{list.hint}</p>
              {lists[list.key].length ? (
                <ul className="grid gap-1">
                  {lists[list.key].map((folder) => (
                    <li key={folder} className="flex items-center justify-between gap-2 text-data">
                      <span className="break-all text-foreground">{folder}</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Remove ${folder}`}
                        disabled={busy === list.key}
                        onClick={() =>
                          void save(
                            list.key,
                            lists[list.key].filter((other) => other !== folder),
                          )
                        }
                      >
                        <X className="size-4" />
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-meta-sm text-muted-foreground">None added.</p>
              )}
            </section>
          ))}
        </div>
      )}
    </HudPanel>
  );
}
