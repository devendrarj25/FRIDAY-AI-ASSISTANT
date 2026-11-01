/**
 * Brain internals, read straight from the live stores: what the forges drafted for a missing ability, how many
 * modules and tools the last route scored, the source-health result, the dev baseline, the last turn's durable
 * mark, and a read-only look at FRIDAY's own source folder. Two small tools sit here as well: "which skill would
 * take this request" and the source browser. Nothing here changes anything.
 */
import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { HudPanel, StatusPill } from "@/components/friday/ui";
import { recentAgentGapDrafts } from "@/lib/friday/brain/agent-forge";
import { baselineAlreadyInstalled } from "@/lib/friday/brain/cognitive-baseline";
import { lastMark } from "@/lib/friday/brain/cognitive-runtime";
import { lastModuleScoredCount } from "@/lib/friday/brain/module-router";
import { recentModuleGapDrafts } from "@/lib/friday/brain/module-forge";
import { pluginForgeAvailable, recentPluginGapDrafts } from "@/lib/friday/brain/plugin-forge";
import { lastSourceHealth } from "@/lib/friday/brain/self-diagnosis";
import { routeSkill, type SkillRun } from "@/lib/friday/brain/skill-router";
import { lastToolScoredCount } from "@/lib/friday/brain/tool-router";
import { recentWorkflowGapDrafts, workflowForgeAvailable } from "@/lib/friday/brain/workflow-forge";
import { devBaseline } from "@/lib/friday/self/dev-pipeline";
import { listSource } from "@/lib/friday/self/maintenance-bridge";
import { useBrain } from "@/lib/friday/use-brain";

type Entry = { name: string; path: string; kind: "dir" | "file" };
type Listing = { ok: true; path: string; entries: Entry[] } | { ok: false; error: string };

const when = (at: number) => (at ? new Date(at).toLocaleTimeString() : "never");

export function BrainInternalsPanel() {
  const brain = useBrain();
  const [tick, setTick] = useState(0);
  const [request, setRequest] = useState("");
  const [skill, setSkill] = useState<SkillRun | null | "none">(null);
  const [listing, setListing] = useState<Listing | null>(null);
  void tick;

  const forges = [
    { name: "agents", drafts: recentAgentGapDrafts(3), ready: true },
    { name: "modules", drafts: recentModuleGapDrafts(3), ready: true },
    { name: "plugins", drafts: recentPluginGapDrafts(3), ready: pluginForgeAvailable() },
    { name: "workflows", drafts: recentWorkflowGapDrafts(3), ready: workflowForgeAvailable() },
  ];
  const health = lastSourceHealth();
  const baseline = devBaseline();
  const latestRunId = brain.runs[0]?.id ?? "";
  const mark = latestRunId ? lastMark(latestRunId) : null;
  const passing = baseline ? Object.values(baseline.checks).filter(Boolean).length : 0;
  const total = baseline ? Object.keys(baseline.checks).length : 0;

  const ask = async () => {
    const text = request.trim();
    if (!text) return;
    setSkill((await routeSkill(text)) ?? "none");
  };

  const browse = async (relative = "") => setListing((await listSource(relative)) as Listing);

  return (
    <HudPanel
      title="Brain internals"
      hint="live, read only"
      actions={
        <Button size="sm" variant="ghost" onClick={() => setTick((n) => n + 1)}>
          <RefreshCw className="size-3.5" /> Refresh
        </Button>
      }
    >
      <div className="grid gap-3 text-sm">
        <div className="grid gap-1">
          <p className="label-xs text-primary/70">Drafts for abilities she lacked</p>
          {forges.map((forge) => (
            <div key={forge.name} className="flex flex-wrap items-center gap-2 text-meta-sm">
              <span className="w-20 text-muted-foreground">{forge.name}</span>
              <StatusPill
                label={forge.ready ? `${forge.drafts.length} drafts` : "needs the desktop app"}
                tone={forge.ready ? (forge.drafts.length ? "accent" : "muted") : "warning"}
              />
              {forge.drafts[0] ? (
                <span className="min-w-0 truncate">
                  {forge.drafts[0].goal} · {forge.drafts[0].stage}
                </span>
              ) : null}
            </div>
          ))}
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-1 text-meta-sm text-muted-foreground">
          <span>
            last route scored <span className="text-primary">{lastModuleScoredCount()}</span>{" "}
            modules and <span className="text-primary">{lastToolScoredCount()}</span> tools
          </span>
          <span>
            cognitive baseline{" "}
            <span className="text-primary">
              {baselineAlreadyInstalled() ? "installed" : "not yet"}
            </span>
          </span>
          <span>
            last turn mark{" "}
            <span className="text-primary">
              {mark ? `${mark.state} · v${mark.version}` : "none yet"}
            </span>
          </span>
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-1 text-meta-sm text-muted-foreground">
          <span>
            source health{" "}
            <span className="text-primary">
              {health
                ? `${health.inspected ? "inspected" : "not inspected"} at ${when(health.at)}, ${health.problems.length} problems`
                : "not checked this session"}
            </span>
          </span>
          <span>
            dev baseline{" "}
            <span className="text-primary">
              {baseline ? `${passing}/${total} checks passed (${baseline.version})` : "none stored"}
            </span>
          </span>
        </div>

        <div className="grid gap-1">
          <p className="label-xs text-primary/70">Which skill would take this?</p>
          <div className="flex gap-2">
            <Input
              value={request}
              onChange={(event) => setRequest(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void ask();
              }}
              placeholder="Type a request"
              className="h-8 font-mono text-xs"
              aria-label="Request to route"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!request.trim()}
              onClick={() => void ask()}
            >
              Route
            </Button>
          </div>
          {skill === "none" ? (
            <p className="text-meta-sm text-muted-foreground">No installed skill matches that.</p>
          ) : skill ? (
            <p className="text-meta-sm">
              <span className="text-primary">{skill.name}</span> · {skill.detail}
            </p>
          ) : null}
        </div>

        <div className="grid gap-1">
          <div className="flex items-center gap-2">
            <p className="label-xs text-primary/70">My own source</p>
            <Button size="sm" variant="outline" onClick={() => void browse("")}>
              Browse
            </Button>
          </div>
          {listing && !listing.ok ? (
            <p className="text-meta-sm text-muted-foreground">{listing.error}</p>
          ) : listing ? (
            <ul className="flex max-h-40 flex-wrap gap-1 overflow-y-auto text-meta-sm">
              {listing.path ? (
                <li>
                  <button
                    type="button"
                    className="rounded-ctl border border-primary/25 px-1.5 hover:border-primary/60"
                    onClick={() => void browse(listing.path.split("/").slice(0, -1).join("/"))}
                  >
                    ..
                  </button>
                </li>
              ) : null}
              {listing.entries.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    disabled={entry.kind === "file"}
                    onClick={() => void browse(entry.path)}
                    className="rounded-ctl border border-primary/25 px-1.5 hover:border-primary/60 disabled:opacity-60"
                  >
                    {entry.name}
                    {entry.kind === "dir" ? "/" : ""}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </HudPanel>
  );
}
