/**
 * FRIDAY · capability marketplace dialog.
 *
 * One shared browser/installer used by the Skills, Tools, Agents, Modules,
 * Plugins and Workflows pages. Everything it does is real: installing writes
 * manifest folders into the selected FRIDAY workspace through the desktop
 * bridge, uninstalling deletes them, and a pack can also be imported from a
 * local `.json` pack file or a remote URL.
 */
import { useMemo, useState } from "react";
import { Download, FileUp, Link2, Loader2, Search, Store, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { CapabilityTree } from "@/lib/friday/capability-trees";
import {
  capabilityId,
  categoriesForTree,
  installFromFile,
  installFromUrl,
  installPack,
  marketplaceSupported,
  searchPacks,
  uninstallPack,
  type MarketPack,
} from "@/lib/friday/marketplace";

const riskTone: Record<string, string> = {
  safe: "text-success",
  write: "text-warning",
  exec: "text-destructive",
};

export interface CapabilityMarketProps {
  tree: CapabilityTree;
  /** Ids already present on disk (`tree/segment/slug`). */
  installedIds: string[];
  /** Re-read the capability index after an install/uninstall. */
  onChanged: () => void | Promise<void>;
  label?: string;
}

export function CapabilityMarket({
  tree,
  installedIds,
  onChanged,
  label = "Marketplace",
}: CapabilityMarketProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [url, setUrl] = useState("");

  const categories = useMemo(() => categoriesForTree(tree), [tree]);
  const packs = useMemo(() => searchPacks(tree, query, category), [tree, query, category]);
  const installed = useMemo(() => new Set(installedIds), [installedIds]);
  const supported = marketplaceSupported();

  const finish = async (message: string) => {
    toast.success(message);
    await onChanged();
  };

  const install = async (pack: MarketPack) => {
    setBusy(pack.slug);
    const result = await installPack(pack);
    setBusy(null);
    if (result?.ok) await finish(`${pack.name} installed`);
    else toast.error(result?.error || "Install failed.");
  };

  const remove = async (pack: MarketPack) => {
    setBusy(pack.slug);
    const result = await uninstallPack(capabilityId(pack));
    setBusy(null);
    if (result?.ok) await finish(`${pack.name} removed`);
    else toast.error(result?.error || "Uninstall failed.");
  };

  const fromUrl = async () => {
    if (!url.trim()) return;
    setBusy("url");
    const result = await installFromUrl(url.trim());
    setBusy(null);
    if (result?.ok) {
      setUrl("");
      await finish("Pack installed from URL");
    } else toast.error(result?.error || "Download failed.");
  };

  const fromFile = async () => {
    setBusy("file");
    const result = await installFromFile();
    setBusy(null);
    if (result?.ok) await finish("Pack imported");
    else if (result?.error !== "cancelled") toast.error(result?.error || "Import failed.");
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Store className="size-4" /> {label}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[min(90vh,40rem)] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="capitalize">{tree} marketplace</DialogTitle>
          <DialogDescription>
            Install real capability packs into your FRIDAY workspace, or bring your own from a pack
            file or URL.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${tree}…`}
              className="pl-8"
            />
          </div>
          <Button variant="outline" size="sm" onClick={() => void fromFile()} disabled={!supported}>
            {busy === "file" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <FileUp className="size-4" />
            )}
            Upload pack
          </Button>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCategory(c)}
              className={`label-xs rounded-full border px-2.5 py-1 transition ${
                category === c
                  ? "border-primary/60 bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {c}
            </button>
          ))}
        </div>

        <ScrollArea className="h-[46vh] pr-3">
          <ul className="space-y-2">
            {packs.map((pack) => {
              const id = capabilityId(pack);
              const isInstalled = installed.has(id);
              return (
                <li
                  key={id}
                  className="flex items-start justify-between gap-3 rounded-lg border border-border bg-card/40 p-3"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-medium text-foreground">{pack.name}</span>
                      <Badge variant="outline" className="label-xs">
                        {pack.category}
                      </Badge>
                      <span className={`label-xs ${riskTone[pack.risk]}`}>{pack.risk}</span>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        v{pack.version}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{pack.description}</p>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {pack.tags.map((tag) => (
                        <span
                          key={tag}
                          className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant={isInstalled ? "outline" : "default"}
                    disabled={!supported || busy === pack.slug}
                    onClick={() => void (isInstalled ? remove(pack) : install(pack))}
                  >
                    {busy === pack.slug ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : isInstalled ? (
                      <Trash2 className="size-4" />
                    ) : (
                      <Download className="size-4" />
                    )}
                    {isInstalled ? "Remove" : "Install"}
                  </Button>
                </li>
              );
            })}
            {!packs.length && (
              <li className="py-8 text-center text-xs text-muted-foreground">
                Nothing matches “{query}”.
              </li>
            )}
          </ul>
        </ScrollArea>

        <div className="flex items-center gap-2 border-t border-border pt-3">
          <Link2 className="size-4 text-muted-foreground" />
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…/pack.json"
            className="flex-1"
          />
          <Button size="sm" onClick={() => void fromUrl()} disabled={!supported || busy === "url"}>
            {busy === "url" ? <Loader2 className="size-4 animate-spin" /> : null}
            Install from URL
          </Button>
        </div>

        {!supported && (
          <p className="text-[11px] text-muted-foreground">
            Installing writes real folders into your workspace — available in the FRIDAY desktop
            app.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
