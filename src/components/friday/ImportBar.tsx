import { FolderUp, Loader2, Upload } from "lucide-react";
import { Github } from "@/components/friday/icons/github";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { imports } from "@/lib/friday/import-engine";
import { useImports } from "@/lib/friday/use-imports";
import { cn } from "@/lib/utils";

/**
 * Compact import strip: upload files, upload a whole folder, or clone a public
 * GitHub repository straight into the current section.
 */
export function ImportBar({ target, className }: { target: string; className?: string }) {
  const { items, busy } = useImports();
  const fileRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState("");
  const [open, setOpen] = useState(false);

  const mine = items.filter((i) => i.target === target);

  const onFiles = async (list: FileList | null, source: "upload" | "folder") => {
    if (!list?.length) return;
    const item = await imports.importFiles(list, target, source);
    if (item)
      toast.success(`Imported ${item.name}`, {
        description: `${item.fileCount} files → ${target}`,
      });
  };

  const clone = async () => {
    if (!url.trim()) return;
    try {
      const item = await imports.importGitHub(url.trim(), target);
      toast.success(`Cloned ${item.name}`, {
        description: `${item.fileCount} files · ${item.stack.join(", ") || "unknown stack"}`,
      });
      setUrl("");
    } catch (err) {
      toast.error("GitHub import failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  };

  return (
    <div className={cn("hud-tile rounded-md px-3 py-2", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="label-xs mr-1 text-primary/70">Import into {target}</p>

        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => void onFiles(e.target.files, "upload")}
        />
        <input
          ref={dirRef}
          type="file"
          hidden
          multiple
          // @ts-expect-error non-standard but supported in Chromium/Electron
          webkitdirectory=""
          directory=""
          onChange={(e) => void onFiles(e.target.files, "folder")}
        />

        <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
          <Upload className="size-4" /> Files
        </Button>
        <Button size="sm" variant="outline" onClick={() => dirRef.current?.click()}>
          <FolderUp className="size-4" /> Folder
        </Button>

        <div className="flex min-w-56 flex-1 items-center gap-2">
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void clone()}
            placeholder="github.com/owner/repo"
            className="h-8 border-primary/25 bg-surface font-mono text-xs"
          />
          <Button size="sm" onClick={() => void clone()} disabled={busy || !url.trim()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Github className="size-4" />}
            Clone
          </Button>
        </div>

        {mine.length ? (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="font-mono text-[11px] text-muted-foreground underline-offset-2 hover:text-primary hover:underline"
          >
            {mine.length} imported
          </button>
        ) : null}
      </div>

      {open && mine.length ? (
        <ul className="mt-2 space-y-1 border-t border-border/60 pt-2">
          {mine.slice(0, 6).map((i) => (
            <li
              key={i.id}
              className="flex items-center justify-between gap-3 font-mono text-[11px]"
            >
              <span className="truncate text-foreground">{i.name}</span>
              <span className="shrink-0 text-muted-foreground">
                {i.fileCount} files · {i.status}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
