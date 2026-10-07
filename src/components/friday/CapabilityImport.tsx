/**
 * FRIDAY · shared "add from file / add from GitHub / install the starter set" actions.
 *
 * The Plugins page has always been able to import a pack from a manifest file;
 * this is that exact flow (marketplace.installFromFile → capabilities:install-file)
 * lifted into one component so Skills, Tools, Modules, Workflows and Agents use
 * it too instead of each growing its own importer.
 *
 * "From GitHub" is a second SOURCE for the same pipeline: the manifests are
 * fetched through the GitHub connector's read-only actions and handed to the
 * identical install/validation path the file import uses.
 *
 * The accepted manifest format (JSON only), the per-tree schema, real examples
 * and what happens after an import are documented in
 * `docs/FRIDAY_IMPORT_FORMAT.md`.
 *
 * The Agents, Modules, Plugins, and Workflows pages also get Skills-style zip /
 * folder / git clone buttons. Those sources still end in installPack() and
 * accept only that page's pack shape.
 */
import { useState } from "react";
import { FileArchive, FileUp, FolderUp, Loader2, Plus, Sparkles } from "lucide-react";
import { Github } from "@/components/friday/icons/github";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CapabilityTree } from "@/lib/friday/capability-trees";
import {
  describeVerification,
  installAgentFolder,
  installAgentGit,
  installAgentZip,
  installFromFile,
  installFromGithub,
  installModuleFolder,
  installModuleGit,
  installModuleZip,
  installPluginFolder,
  installPluginGit,
  installPluginZip,
  installStarterSet,
  installWorkflowFolder,
  installWorkflowGit,
  installWorkflowZip,
  marketplaceSupported,
  missingStarterPacks,
  verifyCapability,
  type CapabilityVerification,
} from "@/lib/friday/marketplace";

export interface CapabilityImportProps {
  tree: CapabilityTree;
  /** Ids already on disk (`tree/segment/slug`). */
  installedIds: string[];
  onChanged: () => void | Promise<void>;
  label?: string;
}

export function CapabilityImport({
  tree,
  installedIds,
  onChanged,
  label = "Add from file",
}: CapabilityImportProps) {
  const [busy, setBusy] = useState<"file" | "starter" | "github" | "zip" | "folder" | "git" | null>(
    null,
  );
  const [repoOpen, setRepoOpen] = useState(false);
  const [repoUrl, setRepoUrl] = useState("");
  const [gitOpen, setGitOpen] = useState(false);
  const [gitUrl, setGitUrl] = useState("");
  const supported = marketplaceSupported();
  const missing = supported ? missingStarterPacks(tree, installedIds) : [];
  const agentExtras = tree === "agents";
  const moduleExtras = tree === "modules";
  const pluginExtras = tree === "plugins";
  const workflowExtras = tree === "workflows";
  const packExtras = agentExtras || moduleExtras || pluginExtras || workflowExtras;

  /**
   * Report the REAL test-before-enable outcome. A pack that failed its sandbox
   * test stays installed-but-disabled and the owner sees the actual error (or
   * the manual dependency steps) with a Retry that re-runs the same test.
   */
  const reportVerification = (list: CapabilityVerification[] | undefined, fallback: string) => {
    const results = list ?? [];
    if (!results.length) {
      toast.success(fallback);
      return;
    }
    for (const result of results) {
      if (result.ok) {
        toast.success(
          `${result.id ?? fallback} — ${describeVerification(result)}${
            result.installed?.length ? ` (installed ${result.installed.join(", ")})` : ""
          }`,
        );
        continue;
      }
      toast.error(describeVerification(result), {
        duration: 20000,
        description: result.id ? `${result.id} stays disabled until this passes.` : undefined,
        action: result.id
          ? {
              label: "Retry",
              onClick: async () => {
                const retry = await verifyCapability(result.id as string);
                await onChanged();
                if (retry.ok) toast.success(`${result.id} — ${describeVerification(retry)}`);
                else toast.error(describeVerification(retry), { duration: 20000 });
              },
            }
          : undefined,
      });
    }
  };

  const fromFile = async () => {
    setBusy("file");
    const result = await installFromFile(tree);
    setBusy(null);
    if (result?.ok) {
      await onChanged();
      reportVerification(
        (result as { verification?: CapabilityVerification[] }).verification,
        `Imported into ${tree}.`,
      );
    } else if (result?.error && result.error !== "cancelled") {
      toast.error(result.error);
    }
  };

  const fromGithub = async () => {
    if (!repoUrl.trim()) return;
    setBusy("github");
    const result = await installFromGithub(tree, repoUrl.trim());
    setBusy(null);
    if (result?.ok) {
      setRepoUrl("");
      setRepoOpen(false);
      await onChanged();
      reportVerification(
        (result as { verification?: CapabilityVerification[] }).verification,
        `Imported into ${tree} from GitHub.`,
      );
    } else if (result?.error) {
      toast.error(result.error);
    }
  };

  const starters = async () => {
    setBusy("starter");
    const result = await installStarterSet(tree, installedIds);
    setBusy(null);
    await onChanged();
    if (result.installed.length)
      toast.success(`Installed ${result.installed.length} default ${tree}.`);
    if (result.failed.length) toast.error(`Could not install: ${result.failed.join(", ")}`);
  };

  const addPackFrom = async (kind: "zip" | "folder" | "git") => {
    if (kind === "git" && !gitUrl.trim()) return;
    setBusy(kind);
    try {
      const pick = async () => {
        if (kind === "zip") {
          if (agentExtras) return installAgentZip();
          if (pluginExtras) return installPluginZip();
          if (workflowExtras) return installWorkflowZip();
          return installModuleZip();
        }
        if (kind === "folder") {
          if (agentExtras) return installAgentFolder();
          if (pluginExtras) return installPluginFolder();
          if (workflowExtras) return installWorkflowFolder();
          return installModuleFolder();
        }
        if (agentExtras) return installAgentGit(gitUrl.trim());
        if (pluginExtras) return installPluginGit(gitUrl.trim());
        if (workflowExtras) return installWorkflowGit(gitUrl.trim());
        return installModuleGit(gitUrl.trim());
      };
      const result = await pick();
      if (result?.ok) {
        if (kind === "git") {
          setGitUrl("");
          setGitOpen(false);
        }
        await onChanged();
        reportVerification(
          (result as { verification?: CapabilityVerification[] }).verification,
          agentExtras
            ? "Imported agent pack(s)."
            : pluginExtras
              ? "Imported plugin pack(s)."
              : workflowExtras
                ? "Imported workflow pack(s)."
                : "Imported module pack(s).",
        );
      } else if (result?.error && result.error !== "cancelled") {
        toast.error(result.error);
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {missing.length > 0 && (
        <Button size="sm" variant="outline" disabled={busy !== null} onClick={starters}>
          {busy === "starter" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Sparkles className="size-4" />
          )}
          Install defaults ({missing.length})
        </Button>
      )}
      {repoOpen && (
        <Input
          value={repoUrl}
          onChange={(event) => setRepoUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void fromGithub();
          }}
          placeholder="https://github.com/owner/repo"
          className="h-8 w-56 font-mono text-xs"
          disabled={busy !== null}
        />
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={!supported || busy !== null}
        onClick={() => (repoOpen ? void fromGithub() : setRepoOpen(true))}
      >
        {busy === "github" ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Github className="size-4" />
        )}
        {repoOpen ? "Import repo" : "From GitHub"}
      </Button>
      <Button size="sm" disabled={!supported || busy !== null} onClick={fromFile}>
        {busy === "file" ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <FileUp className="size-4" />
        )}
        {label}
      </Button>
      {packExtras ? (
        <>
          {gitOpen ? (
            <Input
              value={gitUrl}
              onChange={(event) => setGitUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void addPackFrom("git");
              }}
              placeholder="https://github.com/owner/repo.git"
              className="h-8 w-56 font-mono text-xs"
              disabled={busy !== null}
            />
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={!supported || busy !== null}
            onClick={() => (gitOpen ? void addPackFrom("git") : setGitOpen(true))}
          >
            {busy === "git" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            {gitOpen ? "Clone repo" : "Git clone"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!supported || busy !== null}
            onClick={() => void addPackFrom("zip")}
          >
            {busy === "zip" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <FileArchive className="size-4" />
            )}
            Zip
          </Button>
          <Button
            size="sm"
            disabled={!supported || busy !== null}
            onClick={() => void addPackFrom("folder")}
          >
            {busy === "folder" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <FolderUp className="size-4" />
            )}
            Folder
          </Button>
        </>
      ) : null}
    </>
  );
}
