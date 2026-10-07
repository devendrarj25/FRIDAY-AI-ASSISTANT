import { FolderOpen, Loader2, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { FridayOrb } from "@/components/friday/FridayOrb";
import { TitleStrip } from "@/components/friday/TitleStrip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { applyWorkspaceRoot, isDesktopApp } from "@/lib/friday/desktop";
import { pickWorkspaceRoot } from "@/lib/friday/workspace";

/**
 * First-run step: choose FRIDAY's primary folder. Everything under it is
 * recognised automatically — code roots, docs, data — then created if missing,
 * indexed and watched. Nothing inside an existing folder is overwritten.
 */
export function WorkspaceSetup({ onDone }: { onDone?: (root: string) => void }) {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Suggest a sensible default: the install-time folder when the desktop shell
  // knows one, otherwise the classic FRIDAY location.
  useEffect(() => {
    let active = true;
    const desktop = (
      window as unknown as {
        friday?: { paths?: () => Promise<{ workspace: string | null; userData: string }> };
      }
    ).friday;
    void desktop
      ?.paths?.()
      .then((p) => {
        if (active && p?.workspace) setPath(p.workspace);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const browse = async () => {
    const picked = await pickWorkspaceRoot();
    if (picked) {
      setPath(picked);
      setError(null);
    } else if (!isDesktopApp()) {
      setError("Folder picking needs the FRIDAY desktop app. Type the full path instead.");
    }
  };

  const confirm = async () => {
    const value = path.trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await applyWorkspaceRoot(value);
      onDone?.(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That folder could not be opened.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-screen min-h-0 flex-col overflow-hidden bg-background">
      <TitleStrip />
      <div className="grid min-h-0 flex-1 place-items-center overflow-auto px-4 py-6">
        <div className="w-full max-w-lg rounded-md border border-border bg-card p-6">
          <div className="flex items-center gap-4">
            <FridayOrb size={72} />
            <div>
              <h1 className="font-display text-lg font-semibold">Choose your primary folder</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                FRIDAY works inside one root folder. It recognises your code roots and their
                sub-folders on its own, indexes them, and re-scans on every restart.
              </p>
            </div>
          </div>

          <label className="label-xs mt-6 block text-muted-foreground" htmlFor="root">
            Primary folder
          </label>
          <div className="mt-2 flex gap-2">
            <Input
              id="root"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              className="bg-surface font-mono text-xs"
              placeholder="D:\FRIDAY"
              disabled={busy}
            />
            <Button variant="outline" size="sm" onClick={browse} className="shrink-0">
              <FolderOpen className="size-4" /> Browse
            </Button>
          </div>

          {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}

          <ul className="mt-4 space-y-1.5 font-mono text-[11px] text-muted-foreground">
            <li>· an existing FRIDAY folder is reused — never duplicated or overwritten</li>
            <li>· missing parts of the layout are created, then everything is scanned</li>
            <li>· indexes into local memory and watches for edits — nothing leaves this PC</li>
          </ul>

          <div className="mt-6 flex items-center justify-between gap-3">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck className="size-3.5" /> Reads only. Writes and shell still need approval.
            </p>
            <Button size="sm" onClick={confirm} disabled={busy || !path.trim()}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              Scan &amp; continue
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
