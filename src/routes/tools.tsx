import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Download, FileArchive, FolderUp, Loader2, Plus, RefreshCw } from "lucide-react";
import { AppShell, Panel } from "@/components/friday/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { runtimes as sampleRuntimes, tools as sampleTools } from "@/lib/friday/mock";
import { useCapabilities } from "@/lib/friday/capability-trees";
import { useInstaller } from "@/lib/friday/use-installer";
import { installer } from "@/lib/friday/installer-engine";
import { toast } from "sonner";
import { CapabilityMarket } from "@/components/friday/CapabilityMarket";
import { CapabilityImport } from "@/components/friday/CapabilityImport";
import {
  describeVerification,
  installToolFolder,
  installToolGit,
  installToolZip,
  verifyCapability,
  type CapabilityVerification,
} from "@/lib/friday/marketplace";
import { forgeTool, invokeToolPack } from "@/lib/friday/brain/tool-forge";

export const Route = createFileRoute("/tools")({
  head: () => ({
    meta: [
      { title: "Tools & Runtimes — FRIDAY" },
      {
        name: "description",
        content:
          "Manage the tools FRIDAY may use and install developer runtimes like Python, Node, Git, CUDA, llama.cpp and Ollama from official sources.",
      },
      { property: "og:title", content: "Tools & Runtimes — FRIDAY" },
      {
        property: "og:description",
        content: "Tool permissions and self-installing developer runtimes.",
      },
    ],
  }),
  component: ToolsPage,
});

const riskTone = {
  safe: "text-success",
  write: "text-warning",
  exec: "text-destructive",
} as const;

const DESKTOP_ONLY = "This change needs the FRIDAY desktop app.";

function ToolsPage() {
  const { supported, items, toggle, refresh } = useCapabilities("tools");
  const state = useInstaller();
  const [importBusy, setImportBusy] = useState<"zip" | "folder" | "git" | "forge" | "test" | null>(
    null,
  );
  const [gitOpen, setGitOpen] = useState(false);
  const [gitUrl, setGitUrl] = useState("");
  const [forgeGoal, setForgeGoal] = useState("");
  const [testInput, setTestInput] = useState("");
  const [forgeLog, setForgeLog] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Real tool manifests in the desktop app, sample rows in the browser preview.
  const tools = supported
    ? items.map((item) => ({
        id: item.id,
        name: item.name,
        summary: item.description || `${item.segment} tool`,
        risk: item.risk,
        enabled: item.enabled,
        toggleable: true,
        onToggle: (next: boolean) => {
          void toggle(item.id, next);
        },
      }))
    : sampleTools.map((tool) => ({
        id: "",
        ...tool,
        toggleable: false,
        onToggle: (_next: boolean) => {},
      }));

  // Runtime rows follow the live installer store on the desktop. An empty
  // probe is reported as empty — never the browser-preview sample catalog.
  const runtimes = supported
    ? state.probed.length
      ? installer
          .entries()
          .filter((entry) => state.probed.includes(entry.pkg))
          .map((entry) => ({
            name: entry.pkg,
            installed: state.installed[entry.pkg] ?? null,
            latest: installer.latestOf(entry),
            source: entry.source,
            size: entry.size,
            kind: entry.category,
          }))
      : []
    : sampleRuntimes;

  const addFrom = async (kind: "zip" | "folder" | "git") => {
    if (kind === "git" && !gitUrl.trim()) return;
    setImportBusy(kind);
    try {
      const result =
        kind === "zip"
          ? await installToolZip()
          : kind === "folder"
            ? await installToolFolder()
            : await installToolGit(gitUrl.trim());
      if (result?.ok) {
        if (kind === "git") {
          setGitUrl("");
          setGitOpen(false);
        }
        await refresh();
        const list = (result as { verification?: CapabilityVerification[] }).verification ?? [];
        if (!list.length) toast.success("Imported tool pack(s).");
        for (const item of list) {
          if (item.ok) toast.success(`${item.id ?? "tool"} — ${describeVerification(item)}`);
          else
            toast.error(describeVerification(item), {
              duration: 20000,
              description: item.id ? `${item.id} stays disabled until this passes.` : undefined,
              action: item.id
                ? {
                    label: "Retry",
                    onClick: async () => {
                      const retry = await verifyCapability(item.id as string);
                      await refresh();
                      if (retry.ok) toast.success(`${item.id} — ${describeVerification(retry)}`);
                      else toast.error(describeVerification(retry), { duration: 20000 });
                    },
                  }
                : undefined,
            });
        }
      } else if (result?.error && result.error !== "cancelled") {
        toast.error(result.error);
      }
    } finally {
      setImportBusy(null);
    }
  };

  const onForge = async () => {
    if (!forgeGoal.trim()) return;
    setImportBusy("forge");
    setForgeLog("");
    try {
      const run = await forgeTool(forgeGoal.trim(), {
        onProgress: (current) =>
          setForgeLog(
            current.log.map((line) => `${line.ok ? "ok" : "fail"} — ${line.text}`).join("\n"),
          ),
      });
      setForgeLog(run.log.map((line) => `${line.ok ? "ok" : "fail"} — ${line.text}`).join("\n"));
      if (run.stage === "done") {
        toast.success(`Installed ${run.toolId}. Enable it after you review the sandbox result.`);
        setForgeGoal("");
        await refresh();
      } else if (run.error) {
        toast.error(run.error);
      }
    } finally {
      setImportBusy(null);
    }
  };

  const onTest = async () => {
    const row =
      tools.find((tool) => tool.id && tool.id === selectedId) ?? tools.find((tool) => tool.id);
    if (!row?.id) {
      toast.error(supported ? "Select a tool to test." : DESKTOP_ONLY);
      return;
    }
    setImportBusy("test");
    try {
      let sample: Record<string, unknown> = {};
      if (testInput.trim().startsWith("{")) {
        try {
          sample = JSON.parse(testInput) as Record<string, unknown>;
        } catch {
          sample = { text: testInput, prompt: testInput };
        }
      } else if (testInput.trim()) {
        sample = { text: testInput, prompt: testInput, query: testInput, path: testInput };
      }
      const result = await invokeToolPack(row.id, sample, { allowDisabled: true });
      if (result?.ok) {
        const preview =
          typeof result.value === "string"
            ? result.value.slice(0, 400)
            : JSON.stringify(result.value)?.slice(0, 400);
        toast.success(`${row.name} ran${"ms" in result && result.ms ? ` in ${result.ms}ms` : ""}.`);
        setForgeLog(preview || "(no output)");
      } else {
        toast.error(String((result as { error?: string })?.error || "Tool test failed."));
      }
    } finally {
      setImportBusy(null);
    }
  };

  return (
    <AppShell
      title="Tools & Runtimes"
      subtitle="What FRIDAY is allowed to do, and what it keeps installed for you"
      actions={
        <div className="flex flex-wrap gap-2">
          <CapabilityMarket
            tree="tools"
            installedIds={items.map((item) => item.id)}
            onChanged={refresh}
          />
          <CapabilityImport
            tree="tools"
            installedIds={items.map((item) => item.id)}
            onChanged={refresh}
          />
          {gitOpen ? (
            <Input
              value={gitUrl}
              onChange={(event) => setGitUrl(event.target.value)}
              placeholder="https://github.com/owner/tools-repo"
              className="h-8 w-64 font-mono text-xs"
              disabled={importBusy !== null}
            />
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={!supported || importBusy !== null}
            onClick={() => (gitOpen ? void addFrom("git") : setGitOpen(true))}
          >
            {importBusy === "git" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            {gitOpen ? "Clone repo" : "Git clone"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!supported || importBusy !== null}
            onClick={() => void addFrom("zip")}
          >
            {importBusy === "zip" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <FileArchive className="size-4" />
            )}
            Zip
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!supported || importBusy !== null}
            onClick={() => void addFrom("folder")}
          >
            {importBusy === "folder" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <FolderUp className="size-4" />
            )}
            Folder
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={state.scanning}
            onClick={() => {
              installer.scanAll();
              toast.info("Scanning installed runtimes…");
            }}
          >
            <RefreshCw className="size-4" />
            Check for updates
          </Button>
        </div>
      }
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Tool permissions" hint="risk gated">
          {tools.length ? (
            <ul className="space-y-3">
              {tools.map((tool) => (
                <li key={tool.id || tool.name} className="flex items-start justify-between gap-3">
                  <button
                    type="button"
                    className={`min-w-0 text-left ${selectedId === tool.id ? "text-primary" : ""}`}
                    onClick={() => tool.id && setSelectedId(tool.id)}
                  >
                    <p className="font-mono text-sm">{tool.name}</p>
                    <p className="text-xs text-muted-foreground">{tool.summary}</p>
                    <span className={`label-xs ${riskTone[tool.risk]}`}>{tool.risk}</span>
                  </button>
                  <Switch
                    checked={tool.enabled}
                    onCheckedChange={tool.onToggle}
                    disabled={!tool.toggleable}
                    aria-label={`Enable ${tool.name}`}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-6 text-center text-xs text-muted-foreground">
              {supported
                ? "No tools installed yet — import a zip or folder, clone a tool repo, or forge one below."
                : "Tool permissions appear here in the desktop app."}
            </p>
          )}
        </Panel>

        <Panel title="Runtimes & engines" hint="official sources only">
          {runtimes.length ? (
            <ul className="space-y-3">
              {runtimes.map((rt) => {
                const outdated = rt.installed !== null && rt.installed !== rt.latest;
                return (
                  <li key={rt.name} className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 text-sm font-medium">
                        <span>{rt.name}</span>
                        <Badge variant="outline" className="label-xs">
                          {rt.kind}
                        </Badge>
                      </div>
                      <p className="font-mono text-[11px] text-muted-foreground">
                        {rt.installed ? `installed ${rt.installed}` : "not installed"} · latest{" "}
                        {rt.latest} · {rt.source} · {rt.size}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant={rt.installed ? "outline" : "default"}
                      onClick={() => {
                        installer.enqueue(
                          rt.name,
                          rt.installed ? (outdated ? "update" : "repair") : "install",
                        );
                        toast.info(`${rt.installed ? "Updating" : "Installing"} ${rt.name}…`);
                      }}
                    >
                      <Download className="size-4" />
                      {rt.installed ? (outdated ? "Update" : "Reinstall") : "Install"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="py-6 text-center text-xs text-muted-foreground">
              {supported
                ? "No runtimes detected yet — scan from Install Manager or Check for updates."
                : "Installed runtimes appear here in the desktop app."}
            </p>
          )}
        </Panel>
      </div>

      <div className="mt-4">
        <Panel title="Create and test" hint="sandbox then owner approval — tools only">
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Input
                value={forgeGoal}
                onChange={(event) => setForgeGoal(event.target.value)}
                placeholder="Describe a new tool FRIDAY should write…"
                className="h-8 min-w-[16rem] flex-1 font-mono text-xs"
                disabled={importBusy !== null}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void onForge();
                }}
              />
              <Button
                size="sm"
                className="h-8"
                disabled={!supported || importBusy !== null}
                onClick={() => void onForge()}
              >
                {importBusy === "forge" ? <Loader2 className="size-4 animate-spin" /> : null}
                Create tool
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <Input
                value={testInput}
                onChange={(event) => setTestInput(event.target.value)}
                placeholder='Sample JSON, e.g. {"path":"README.md"}'
                className="h-8 min-w-[16rem] flex-1 font-mono text-xs"
                disabled={importBusy !== null}
              />
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                disabled={!supported || importBusy !== null}
                onClick={() => void onTest()}
              >
                {importBusy === "test" ? <Loader2 className="size-4 animate-spin" /> : null}
                Test selected
              </Button>
            </div>
            {forgeLog ? (
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">
                {forgeLog}
              </pre>
            ) : (
              <p className="text-xs text-muted-foreground">
                Zip, folder, and git clone on this page accept tool.json / index.cjs only. Skills
                stay on the Skills page. Click a tool name to select it for Test.
              </p>
            )}
          </div>
        </Panel>
      </div>
    </AppShell>
  );
}
