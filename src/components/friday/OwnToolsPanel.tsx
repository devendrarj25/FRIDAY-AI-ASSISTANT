import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState, HudPanel } from "@/components/friday/ui";
import { installer, type ExtensionsInfo, type OwnToolEntry } from "@/lib/friday/installer-engine";
import { useInstaller } from "@/lib/friday/use-installer";

type Method = "winget" | "npm" | "pip";

const PLACEHOLDER: Record<Method, string> = {
  winget: "Publisher.Package, for example Hugo.Hugo.Extended",
  npm: "npm package, for example prettier",
  pip: "PyPI package, for example rich",
};

/**
 * Add a tool of your own to the Install Manager without a code change. It is written to
 * `<FRIDAY folder>\config\install-extensions.user.json` and checked again by the main process; it installs
 * through winget, npm or pip like every built-in tool, and is detected, updated and removed the same way.
 */
export function OwnToolsPanel({ title }: { title: string }) {
  const state = useInstaller();
  const desktop = state.bridge === "desktop";
  const [info, setInfo] = useState<ExtensionsInfo | null>(null);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [method, setMethod] = useState<Method>("winget");
  const [pkgId, setPkgId] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);

  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    if (!desktop) return undefined;
    let live = true;
    void installer.listOwnTools().then((value) => {
      if (live) setInfo(value);
    });
    return () => {
      live = false;
    };
  }, [desktop, version]);

  const add = async () => {
    const entry: OwnToolEntry = {
      id: name.trim(),
      url: url.trim(),
      [method]: pkgId.trim(),
      ...(command.trim() ? { cmd: command.trim() } : {}),
    };
    setBusy(true);
    const result = await installer.addOwnTool(entry);
    setBusy(false);
    if (!result.ok) {
      toast.error(result.error || "The tool was not added");
      return;
    }
    toast.success(`${entry.id} added — checking this PC`);
    setName("");
    setCommand("");
    setPkgId("");
    setUrl("");
    reload();
  };

  const remove = async (id: string) => {
    const result = await installer.removeOwnTool(id);
    if (!result.ok) toast.error(result.error || "Could not remove the tool");
    else toast(`${id} removed from your tools`);
    reload();
  };

  const mine = (info?.tools ?? []).filter((tool) => tool.own);
  const ready = name.trim().length >= 2 && pkgId.trim() && url.trim().startsWith("https://");

  return (
    <HudPanel
      title={title}
      hint={desktop ? `${mine.length} added by you` : "needs the desktop app"}
    >
      {!desktop ? (
        <EmptyState title="Adding a tool needs the desktop app." />
      ) : (
        <div className="space-y-3">
          <p className="text-note text-muted-foreground">
            Add anything that installs with winget, npm or pip. It appears in the catalog, is
            detected on this PC, shows when a newer version exists and updates like the rest. The
            list lives in <code>config\install-extensions.user.json</code> and an update never
            touches it.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <Input
              aria-label="Tool name"
              placeholder="Name, for example Hugo"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Input
              aria-label="Command to look for"
              placeholder="Command to look for, for example hugo"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
            />
            <div className="flex gap-2">
              <select
                aria-label="Install with"
                className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                value={method}
                onChange={(e) => setMethod(e.target.value as Method)}
              >
                <option value="winget">winget</option>
                <option value="npm">npm</option>
                <option value="pip">pip</option>
              </select>
              <Input
                aria-label="Package id"
                placeholder={PLACEHOLDER[method]}
                value={pkgId}
                onChange={(e) => setPkgId(e.target.value)}
              />
            </div>
            <Input
              aria-label="Official page"
              placeholder="Official page (https://…)"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => add()} disabled={busy || !ready}>
              <Plus className="size-4" /> {busy ? "Adding…" : "Add tool"}
            </Button>
            {!command.trim() && method !== "pip" ? (
              <span className="text-note text-muted-foreground">
                Without a command FRIDAY cannot tell whether it is installed.
              </span>
            ) : null}
          </div>
          {mine.length > 0 ? (
            <ul className="divide-y divide-border rounded-surface border border-border">
              {mine.map((tool) => (
                <li key={tool.id} className="flex items-center justify-between px-3 py-2 text-sm">
                  <span>{tool.id}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${tool.id}`}
                    onClick={() => remove(tool.id)}
                  >
                    <Trash2 className="size-4" /> Remove
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          {(info?.problems ?? []).length > 0 ? (
            <ul className="space-y-1 text-note text-warning">
              {info!.problems.map((problem, index) => (
                <li key={`${problem.id ?? "file"}-${index}`}>
                  Skipped {problem.id ?? "an entry"}: {problem.reason}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </HudPanel>
  );
}
