import { HudPanel, StatusPill } from "@/components/friday/ui";
import type { GithubFile } from "@/lib/friday/github-updates";

const mb = (bytes: number) =>
  bytes > 0 ? `${(bytes / 1048576).toFixed(bytes > 1e8 ? 0 : 1)} MB` : "";

const KIND_TONE: Record<string, "primary" | "accent" | "muted" | "warning"> = {
  installer: "primary",
  portable: "accent",
  "source-zip": "accent",
  "source-archive": "accent",
};

/** What a release contains, file by file, with what each one is for. */
export function ReleaseFiles({ files }: { files: GithubFile[] | undefined }) {
  if (!files?.length) return null;
  return (
    <div className="mt-3 rounded-surface border border-border/60 bg-background/40 p-3">
      <p className="mb-2 text-note uppercase tracking-wide text-accent">
        What this release contains
      </p>
      <ul className="space-y-2">
        {files.map((file) => (
          <li key={file.name} className="text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-foreground">{file.name}</span>
              <StatusPill label={file.label} tone={KIND_TONE[file.kind] ?? "muted"} />
              {file.bytes ? <span className="text-muted-foreground">{mb(file.bytes)}</span> : null}
            </div>
            <p className="mt-0.5 text-muted-foreground">{file.purpose}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The always-visible "how does this work" for the Updates section. */
export function UpdateGuide() {
  return (
    <HudPanel
      title="How updates work"
      hint="Read this once. Updates only ever read from GitHub; they never write to your repository."
    >
      <ol className="space-y-2 text-xs text-muted-foreground">
        <li>
          <span className="font-medium text-foreground">1. Connect the repository.</span> Paste the
          repository address. A public repository needs nothing else. For a private one add a
          read-only token: GitHub, Settings, Developer settings, Fine-grained tokens, repository
          access to this one repository only, permission <em>Contents: Read-only</em> (Metadata is
          added for you). That token cannot push or change anything. Pushing and releasing use the
          separate connection on Friday Hub.
        </li>
        <li>
          <span className="font-medium text-foreground">2. Test connection.</span> FRIDAY shows
          whether the repository is public or private, which token she used and whether it is
          read-only, and the newest official and test release she can see.
        </li>
        <li>
          <span className="font-medium text-foreground">3. Choose a channel.</span> <em>Stable</em>{" "}
          sees official releases only. <em>Test</em> sees test builds only and marks them TEST. The
          other channel is shown beside the result, and switching is always your choice.
        </li>
        <li>
          <span className="font-medium text-foreground">4. Check for updates.</span> FRIDAY lists
          every file of the release and what each is for: the Windows installer (updates the app and
          restarts it), the portable app (download only), checksums (used to verify), release notes,
          and the full source code of that version.
        </li>
        <li>
          <span className="font-medium text-foreground">5. Install or apply.</span> The installer is
          downloaded, checked against its published SHA-256, your data is backed up, then FRIDAY
          closes, the new version installs and she reopens. That is how an installed app updates.
          The source zip is for a source checkout: it is scanned, the changes are shown, a backup is
          taken, and the files are merged into the folder when you apply them. Content packs
          (plugins, modules, workflows, themes) update from the list under Check for updates.
        </li>
        <li>
          <span className="font-medium text-foreground">6. What is never touched.</span> Your chats,
          memory, settings, credentials, models, voices, downloads, uploads and work stay as they
          are. If the new version does not start, FRIDAY offers to restore the backup.
        </li>
      </ol>
    </HudPanel>
  );
}
