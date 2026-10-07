import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { FileArchive, FolderUp, Loader2, Plus, Puzzle, Search, Sparkles } from "lucide-react";
import { AppShell } from "@/components/friday/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DataTable,
  FilterTabs,
  HudPanel,
  MetricBar,
  StatTile,
  StatusPill,
  toneForStatus,
} from "@/components/friday/ui";
import { useCapabilities, type CapabilityItem } from "@/lib/friday/capability-trees";
import { useLedger } from "@/lib/friday/self/use-self";
import { lastUsedLabel, statsFor } from "@/lib/friday/self/mastery";
import { CapabilityMarket } from "@/components/friday/CapabilityMarket";
import { CapabilityImport } from "@/components/friday/CapabilityImport";
import { toast } from "sonner";
import { governance } from "@/lib/friday/self/governance";
import {
  describeVerification,
  installSkillFolder,
  installSkillGit,
  installSkillZip,
  uninstallPack,
  verifyCapability,
  type CapabilityVerification,
} from "@/lib/friday/marketplace";
import { forgeSkill, invokeSkill, setSkillEnabled } from "@/lib/friday/brain/skill-forge";

export const Route = createFileRoute("/skills")({
  head: () => ({
    meta: [
      { title: "Skills — FRIDAY Console" },
      {
        name: "description",
        content:
          "Browse every FRIDAY skill by category and mastery level, see what is active, learning or ready to use.",
      },
      { property: "og:title", content: "Skills — FRIDAY Console" },
      {
        property: "og:description",
        content: "Skill registry with levels, categories and learning progress.",
      },
    ],
  }),
  component: SkillsPage,
});

type SkillRow = {
  id: string;
  name: string;
  category: string;
  status: "Active" | "Ready" | "Idle" | "Learning";
  level: string;
  lastUsed: string;
  mastery: number;
  enabled: boolean;
  summary: string;
  description: string;
  risk: string;
  permissions: string[];
  inputs: string[];
};

const DESKTOP_ONLY = "This change needs the FRIDAY desktop app.";

function skillSlug(capabilityId: string): string {
  const parts = capabilityId.split("/").filter(Boolean);
  return parts.length === 3 ? parts[2]! : capabilityId;
}

function listField(values: string[]): string {
  return values.length ? values.join(", ") : "—";
}

function SkillsPage() {
  const [tab, setTab] = useState("all");
  const [category, setCategory] = useState("all");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState<"zip" | "folder" | "git" | "forge" | "test" | null>(
    null,
  );
  const [gitOpen, setGitOpen] = useState(false);
  const [gitUrl, setGitUrl] = useState("");
  const [forgeGoal, setForgeGoal] = useState("");
  const [testInput, setTestInput] = useState("");
  const [forgeLog, setForgeLog] = useState("");
  const { supported, items, refresh, toggle } = useCapabilities("skills");
  const { tasks } = useLedger();

  // Real skills come from the skill manifests on disk. Mastery/level are
  // derived from the task ledger — see src/lib/friday/self/mastery.ts for the
  // exact formula (0.7 × success rate + 0.3 × saturated volume).
  const skills = useMemo<SkillRow[]>(() => {
    if (!supported) return [];
    return items.map((item: CapabilityItem) => {
      const stats = statsFor(tasks, item.id, item.name);
      return {
        id: item.id,
        name: item.name,
        category: item.category || item.segment,
        status: !item.enabled
          ? ("Idle" as const)
          : stats.running > 0
            ? ("Active" as const)
            : stats.executions > 0
              ? ("Active" as const)
              : ("Ready" as const),
        level: stats.level,
        lastUsed: lastUsedLabel(stats.lastUsedAt),
        mastery: stats.mastery,
        enabled: item.enabled,
        summary: item.summary || "",
        description: item.description || "",
        risk: item.risk || "",
        permissions: item.permissions || [],
        inputs: item.inputs || [],
      };
    });
  }, [supported, items, tasks]);

  const overallMastery = skills.length
    ? Math.round(skills.reduce((n, s) => n + (s.mastery || 0), 0) / skills.length)
    : 0;

  const addFrom = async (kind: "zip" | "folder" | "git") => {
    if (kind === "git" && !gitUrl.trim()) return;
    setImportBusy(kind);
    try {
      const result =
        kind === "zip"
          ? await installSkillZip()
          : kind === "folder"
            ? await installSkillFolder()
            : await installSkillGit(gitUrl.trim());
      if (result?.ok) {
        if (kind === "git") {
          setGitUrl("");
          setGitOpen(false);
        }
        await refresh();
        const list = (result as { verification?: CapabilityVerification[] }).verification ?? [];
        if (!list.length) toast.success("Imported skill pack(s).");
        for (const item of list) {
          if (item.ok) toast.success(`${item.id ?? "skill"} — ${describeVerification(item)}`);
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
      const run = await forgeSkill(forgeGoal.trim(), {
        onProgress: (current) =>
          setForgeLog(
            current.log.map((line) => `${line.ok ? "ok" : "fail"} — ${line.text}`).join("\n"),
          ),
      });
      setForgeLog(run.log.map((line) => `${line.ok ? "ok" : "fail"} — ${line.text}`).join("\n"));
      if (run.stage === "done") {
        toast.success(`Installed ${run.skillId}. Enable it after you review the sandbox result.`);
        setForgeGoal("");
        await refresh();
      } else if (run.error) {
        toast.error(run.error);
      }
    } finally {
      setImportBusy(null);
    }
  };

  const onTest = async (row: SkillRow) => {
    if (!row.id) {
      toast.error(DESKTOP_ONLY);
      return;
    }
    setImportBusy("test");
    try {
      let sample: Record<string, unknown> = { prompt: testInput };
      if (testInput.trim().startsWith("{")) {
        try {
          sample = JSON.parse(testInput) as Record<string, unknown>;
        } catch {
          sample = { prompt: testInput, text: testInput };
        }
      } else if (testInput.trim()) {
        sample = { prompt: testInput, text: testInput };
      }
      const result = await invokeSkill(skillSlug(row.id), sample, { allowDisabled: true });
      if (result?.ok) {
        const preview =
          typeof result.value === "string"
            ? result.value.slice(0, 400)
            : JSON.stringify(result.value)?.slice(0, 400);
        toast.success(`${row.name} ran${"ms" in result && result.ms ? ` in ${result.ms}ms` : ""}.`);
        setForgeLog(preview || "(no output)");
      } else {
        toast.error(String((result as { error?: string })?.error || "Skill test failed."));
      }
    } finally {
      setImportBusy(null);
    }
  };

  const counts = useMemo(
    () => ({
      all: skills.length,
      active: skills.filter((s) => s.status === "Active").length,
      ready: skills.filter((s) => s.status === "Ready").length,
      learning: skills.filter((s) => s.status === "Learning").length,
      idle: skills.filter((s) => s.status === "Idle").length,
    }),
    [skills],
  );

  const categories = useMemo(() => {
    const found = [...new Set(skills.map((s) => s.category).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b),
    );
    return found;
  }, [skills]);

  const rows = skills.filter((s) => {
    if (tab !== "all" && s.status.toLowerCase() !== tab) return false;
    if (category !== "all" && s.category !== category) return false;
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return [s.name, s.category, s.summary].some((field) => field.toLowerCase().includes(needle));
  });

  const openRow = openId
    ? (rows.find((s) => s.id === openId) ?? skills.find((s) => s.id === openId))
    : null;

  const gated = async (
    id: string,
    title: string,
    rationale: string,
    risk: "safe" | "review" | "risky",
    apply: () => Promise<{ ok: boolean; detail: string }>,
  ) => {
    toast.message("This change waits for your approval in Self-management.");
    const item = await governance.submit({
      kind: "install",
      title,
      rationale,
      risk,
      evidence: [`capability:${id}`],
      apply,
    });
    if (item.stage === "rejected") {
      toast.error("You did not approve this change.");
      return false;
    }
    if (item.stage !== "completed") {
      toast.error(item.error || "The change did not complete.");
      return false;
    }
    return true;
  };

  const onToggle = async (row: SkillRow) => {
    if (!supported || !row.id) {
      toast.error(DESKTOP_ONLY);
      return;
    }
    const next = !row.enabled;
    setBusyId(row.id);
    try {
      const ok = await gated(
        row.id,
        `${next ? "Enable" : "Disable"} skill — ${row.name}`,
        next
          ? `Turns ${row.name} on in the capability index and the skill runtime. Disabled skills stay listed; they do not auto-run.`
          : `Turns ${row.name} off in the capability index and the skill runtime.`,
        "review",
        async () => {
          const toggled = await toggle(row.id, next);
          if (!toggled) return { ok: false, detail: "Could not update the capability index." };
          const runtime = await setSkillEnabled(skillSlug(row.id), next);
          if (!runtime.ok) {
            return {
              ok: false,
              detail: runtime.error || "Could not update the skill runtime.",
            };
          }
          return { ok: true, detail: next ? "enabled" : "disabled" };
        },
      );
      if (ok) toast.success(`${row.name} ${next ? "enabled" : "disabled"}.`);
    } finally {
      setBusyId(null);
    }
  };

  const onRemove = async (row: SkillRow) => {
    if (!supported || !row.id) {
      toast.error(DESKTOP_ONLY);
      return;
    }
    if (confirmId !== row.id) {
      setConfirmId(row.id);
      return;
    }
    setBusyId(row.id);
    try {
      const ok = await gated(
        row.id,
        `Remove skill — ${row.name}`,
        `Deletes the installed pack ${row.id} from this workspace. Shipped skills outside the workspace are refused. This cannot be undone from the Skills page.`,
        "risky",
        async () => {
          const result = await uninstallPack(row.id);
          if (!result?.ok) return { ok: false, detail: result?.error || "Uninstall failed." };
          return { ok: true, detail: `removed ${row.id}` };
        },
      );
      if (ok) {
        toast.success(`${row.name} removed.`);
        setConfirmId(null);
        if (openId === row.id) setOpenId(null);
        await refresh();
      }
    } finally {
      setBusyId(null);
    }
  };

  return (
    <AppShell
      title="Skills"
      subtitle="What FRIDAY can already do — and what it is still learning"
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <CapabilityMarket
            tree="skills"
            installedIds={items.map((item) => item.id)}
            onChanged={refresh}
          />
          <CapabilityImport
            tree="skills"
            installedIds={items.map((item) => item.id)}
            onChanged={refresh}
          />
          {gitOpen ? (
            <Input
              value={gitUrl}
              onChange={(event) => setGitUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void addFrom("git");
              }}
              placeholder="https://github.com/owner/repo.git"
              className="h-8 w-56 font-mono text-xs"
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
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          <StatTile
            icon={<Puzzle className="size-4" />}
            label="Total"
            value={counts.all}
            state="skills"
          />
          <StatTile label="Active" value={counts.active} state="in use" tone="accent" />
          <StatTile label="Ready" value={counts.ready} state="standby" tone="primary" />
          <StatTile label="Learning" value={counts.learning} state="training" tone="warning" />
          <StatTile label="Idle" value={counts.idle} state="unused" tone="muted" />
        </div>

        <HudPanel
          title="All Skills"
          hint={`${rows.length} shown`}
          actions={
            <FilterTabs
              value={tab}
              onChange={setTab}
              tabs={[
                { key: "all", label: `All (${counts.all})` },
                { key: "active", label: `Active (${counts.active})` },
                { key: "ready", label: `Ready (${counts.ready})` },
                { key: "learning", label: `Learning (${counts.learning})` },
                { key: "idle", label: `Idle (${counts.idle})` },
              ]}
            />
          }
        >
          <div className="mb-3 flex flex-col gap-2">
            <div className="relative max-w-md">
              <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search name, category, or summary…"
                className="h-8 pl-8 font-mono text-xs"
              />
            </div>
            <FilterTabs
              value={category}
              onChange={setCategory}
              tabs={[
                { key: "all", label: "All categories" },
                ...categories.map((key) => ({
                  key,
                  label: `${key} (${skills.filter((s) => s.category === key).length})`,
                })),
              ]}
            />
          </div>

          {rows.length ? (
            <>
              <DataTable
                pinLast
                columns={["Skill Name", "Category", "Status", "Level", "Last Used", "Actions"]}
                rows={rows.map((s) => [
                  <span key="n" className="flex items-center gap-2 text-foreground">
                    <Puzzle className="size-3.5 text-primary" />
                    {s.name}
                  </span>,
                  <span key="c" className="text-muted-foreground">
                    {s.category}
                  </span>,
                  <StatusPill key="s" label={s.status} tone={toneForStatus(s.status)} />,
                  <span key="l" className="font-mono text-xs text-primary">
                    {s.level}
                  </span>,
                  <span key="u" className="font-mono text-xs text-muted-foreground">
                    {s.lastUsed}
                  </span>,
                  <span key="a" className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-[11px]"
                      disabled={Boolean(busyId) || !s.id}
                      onClick={() => void onToggle(s)}
                    >
                      {s.enabled ? "Disable" : "Enable"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-[11px]"
                      disabled={!s.id}
                      onClick={() => setOpenId((current) => (current === s.id ? null : s.id))}
                    >
                      {openId === s.id ? "Hide" : "Details"}
                    </Button>
                    <Button
                      size="sm"
                      variant={confirmId === s.id ? "destructive" : "outline"}
                      className="h-7 px-2 text-[11px]"
                      disabled={Boolean(busyId) || !s.id}
                      onClick={() => void onRemove(s)}
                    >
                      {confirmId === s.id ? "Confirm remove" : "Remove"}
                    </Button>
                    {confirmId === s.id ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => setConfirmId(null)}
                      >
                        Cancel
                      </Button>
                    ) : null}
                  </span>,
                ])}
              />
              {openRow ? (
                <div className="mt-3 space-y-2 border-t border-primary/15 pt-3 font-mono text-[11px]">
                  <p className="label-xs text-primary">{openRow.name}</p>
                  <p>
                    <span className="text-muted-foreground">Summary — </span>
                    {openRow.summary || "—"}
                  </p>
                  <p className="whitespace-pre-wrap">
                    <span className="text-muted-foreground">Description — </span>
                    {openRow.description || "—"}
                  </p>
                  <p>
                    <span className="text-muted-foreground">Risk — </span>
                    {openRow.risk || "—"}
                  </p>
                  <p>
                    <span className="text-muted-foreground">Permissions — </span>
                    {listField(openRow.permissions)}
                  </p>
                  <p>
                    <span className="text-muted-foreground">Inputs — </span>
                    {listField(openRow.inputs)}
                  </p>
                </div>
              ) : null}
            </>
          ) : (
            <p className="py-6 text-center text-xs text-muted-foreground">
              {skills.length
                ? "No skills match this filter."
                : "No skills installed yet — import a skill zip or folder, clone a skill repo, or forge one below."}
            </p>
          )}
        </HudPanel>

        <HudPanel title="Create and test" hint="sandbox then owner approval">
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Input
                value={forgeGoal}
                onChange={(event) => setForgeGoal(event.target.value)}
                placeholder="Describe a new skill FRIDAY should write…"
                className="h-8 min-w-[16rem] flex-1 font-mono text-xs"
                disabled={importBusy !== null}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void onForge();
                }}
              />
              <Button
                size="sm"
                className="h-8"
                disabled={importBusy !== null || !forgeGoal.trim()}
                onClick={() => void onForge()}
              >
                {importBusy === "forge" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Sparkles className="size-3.5" />
                )}
                Forge
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <Input
                value={testInput}
                onChange={(event) => setTestInput(event.target.value)}
                placeholder="Test input (text or JSON) for the selected skill…"
                className="h-8 min-w-[16rem] flex-1 font-mono text-xs"
                disabled={importBusy !== null || !openRow?.id}
              />
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                disabled={importBusy !== null || !openRow?.id}
                onClick={() => openRow && void onTest(openRow)}
              >
                {importBusy === "test" ? <Loader2 className="size-4 animate-spin" /> : null}
                Test selected
              </Button>
            </div>
            {forgeLog ? (
              <pre className="max-h-32 overflow-auto rounded-sm bg-background p-2 font-mono text-[10px] leading-relaxed">
                {forgeLog}
              </pre>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                Zip, folder, and git clone accept only skill.json / skill.mjs packs. Incomplete
                packs are healed into a loadable run(), then sandbox-tested before enable. Forge
                uses the same skill-forge path as Self-management.
              </p>
            )}
          </div>
        </HudPanel>

        <HudPanel title="Skill Learning Progress" hint={`${overallMastery}%`}>
          <MetricBar
            label="Overall mastery"
            value={overallMastery}
            detail={
              skills.length
                ? `Expert ${skills.filter((s) => s.level === "Expert").length} · Advanced ${
                    skills.filter((s) => s.level === "Advanced").length
                  } · Intermediate ${skills.filter((s) => s.level === "Intermediate").length}`
                : "no skills installed"
            }
            tone="accent"
          />

          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {(["Expert", "Advanced", "Intermediate", "Basic"] as const).map((lvl) => (
              <StatTile
                key={lvl}
                label={lvl}
                value={skills.filter((s) => s.level === lvl).length}
                state="skills"
                tone={lvl === "Expert" ? "accent" : lvl === "Basic" ? "muted" : "primary"}
              />
            ))}
          </div>
        </HudPanel>
      </div>
    </AppShell>
  );
}
