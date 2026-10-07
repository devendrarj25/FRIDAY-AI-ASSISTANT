import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { Bot, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { HudPanel, StatusPill, ToggleRow } from "@/components/friday/ui";
import { autonomy, type ApprovalLevel, type UpdatePolicy } from "@/lib/friday/self/autonomy";
import { backgroundTasks } from "@/lib/friday/self/background-tasks";
import { doctor } from "@/lib/friday/doctor-engine";
import { useAutonomy, useGovernance } from "@/lib/friday/self/use-self";

/**
 * Real autonomy controls. Every switch here writes straight into the autonomy
 * store the background worker, governance gate and model router read on every
 * cycle — there is no display-only value on this panel.
 */
export function AutonomySettings() {
  const settings = useAutonomy();
  const gov = useGovernance();
  const navigate = useNavigate();
  const [source, setSource] = useState("");

  const patch = (next: Parameters<typeof autonomy.update>[0]) => autonomy.update(next);

  const removeSource = (host: string) =>
    patch({ researchSources: settings.researchSources.filter((s) => s !== host) });

  const addSource = () => {
    const host = source
      .trim()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "");
    if (!host) return;
    if (settings.researchSources.includes(host)) {
      toast.info(`${host} is already allowed`);
      setSource("");
      return;
    }
    patch({ researchSources: [...settings.researchSources, host] });
    setSource("");
    toast.success(`${host} added to allowed research sources`);
  };

  return (
    <div className="space-y-4">
      <HudPanel
        title="Autonomy"
        hint={`${gov.pending.length} action(s) waiting for approval`}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void backgroundTasks.runNow("health").then((run) => {
                  toast.success(run?.note ?? "Health scan finished");
                });
                void doctor.scan();
              }}
            >
              Run health now
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void navigate({ to: "/self-management" })}
            >
              Approvals →
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                autonomy.reset();
                toast.success("Autonomy settings restored to defaults");
              }}
            >
              <RotateCcw className="size-4" /> Reset
            </Button>
          </div>
        }
      >
        <ToggleRow
          label="Background self-improvement worker"
          on={settings.autonomyEnabled}
          onToggle={() => patch({ autonomyEnabled: !settings.autonomyEnabled })}
        />
        <Choice
          label="Approval level"
          value={settings.approvalLevel}
          options={
            [
              ["strict", "Strict"],
              ["balanced", "Balanced"],
              ["trusted", "Trusted"],
            ] as [ApprovalLevel, string][]
          }
          onPick={(approvalLevel) => patch({ approvalLevel })}
          note="Strict asks for everything. Balanced auto-runs safe, reversible actions. Trusted also auto-runs reviewed ones; risky actions always ask."
        />
        <NumberRow
          label="Max concurrent tasks"
          value={settings.maxConcurrentTasks}
          min={1}
          max={8}
          onChange={(maxConcurrentTasks) => patch({ maxConcurrentTasks })}
        />
        <NumberRow
          label="Idle cycle"
          value={settings.idleCycleMinutes}
          min={5}
          max={120}
          step={5}
          suffix=" min"
          onChange={(idleCycleMinutes) => patch({ idleCycleMinutes })}
        />
      </HudPanel>

      <HudPanel title="Research">
        <ToggleRow
          label="Allow FRIDAY to research online while idle"
          on={settings.researchEnabled}
          onToggle={() => patch({ researchEnabled: !settings.researchEnabled })}
        />
        <NumberRow
          label="Research depth per cycle"
          value={settings.researchDepth}
          min={1}
          max={10}
          onChange={(researchDepth) => patch({ researchDepth })}
        />
        <p className="label-xs mt-4 text-muted-foreground">Allowed sources</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {settings.researchSources.length ? (
            settings.researchSources.map((host) => (
              <button
                key={host}
                type="button"
                onClick={() => removeSource(host)}
                title="Remove"
                className="rounded-sm border border-primary/25 bg-primary/10 px-2 py-0.5 font-mono text-[11px] text-primary hover:border-destructive/60 hover:text-destructive"
              >
                {host} ×
              </button>
            ))
          ) : (
            <span className="text-[11px] text-muted-foreground">
              no restriction — every host is allowed
            </span>
          )}
        </div>
        <div className="mt-3 flex gap-2">
          <Input
            value={source}
            placeholder="add host, e.g. arxiv.org"
            onChange={(e) => setSource(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addSource();
            }}
            className="h-8 border-primary/25 bg-surface font-mono text-xs"
          />
          <Button size="sm" variant="outline" onClick={addSource}>
            Add
          </Button>
        </div>
      </HudPanel>

      <HudPanel title="Models & Learning">
        <Choice
          label="Model preference"
          value={settings.modelPreference}
          options={[
            ["local-first", "Local first"],
            ["balanced", "Balanced"],
            ["cloud-first", "Cloud first"],
          ]}
          onPick={(modelPreference) => patch({ modelPreference })}
        />
        <ToggleRow
          label="Run parallel specialist models and reconcile"
          on={settings.parallelSpecialists}
          onToggle={() => patch({ parallelSpecialists: !settings.parallelSpecialists })}
        />
        <NumberRow
          label="Max parallel models"
          value={settings.maxParallelModels}
          min={1}
          max={6}
          onChange={(maxParallelModels) => patch({ maxParallelModels })}
        />
        <ToggleRow
          label="Learn from finished work"
          on={settings.learningEnabled}
          onToggle={() => patch({ learningEnabled: !settings.learningEnabled })}
        />
        <ToggleRow
          label="Promote only verified outcomes to long-term knowledge"
          on={settings.learnVerifiedOnly}
          onToggle={() => patch({ learnVerifiedOnly: !settings.learnVerifiedOnly })}
        />
        <NumberRow
          label="Memory retention"
          value={settings.memoryRetentionDays}
          min={7}
          max={365}
          step={1}
          suffix=" days"
          onChange={(memoryRetentionDays) => patch({ memoryRetentionDays })}
        />
      </HudPanel>

      <HudPanel title="Execution Safety & Updates">
        <ToggleRow
          label="Require the sandbox for generated code"
          on={settings.sandboxRequired}
          onToggle={() => patch({ sandboxRequired: !settings.sandboxRequired })}
        />
        <ToggleRow
          label="Limit security work to local / owned targets"
          on={settings.securityScopeLocalOnly}
          onToggle={() => patch({ securityScopeLocalOnly: !settings.securityScopeLocalOnly })}
        />
        <Choice
          label="Update policy"
          value={settings.updatePolicy}
          options={
            [
              ["manual", "Manual"],
              ["stage", "Stage & ask"],
              ["auto-safe", "Auto (safe only)"],
            ] as [UpdatePolicy, string][]
          }
          onPick={(updatePolicy) => patch({ updatePolicy })}
        />
        <ToggleRow
          label="Back up before applying an update"
          on={settings.backupsEnabled}
          onToggle={() => patch({ backupsEnabled: !settings.backupsEnabled })}
        />
        <ToggleRow
          label="Roll back automatically when verification fails"
          on={settings.autoRollback}
          onToggle={() => patch({ autoRollback: !settings.autoRollback })}
        />
        <div className="mt-4 flex items-center gap-2">
          <Bot className="size-4 text-primary" />
          <StatusPill
            label={settings.autonomyEnabled ? "autonomy active" : "autonomy paused"}
            tone={settings.autonomyEnabled ? "accent" : "warning"}
          />
          <span className="font-mono text-[11px] text-muted-foreground">
            {gov.items.length} governed item(s) tracked
          </span>
        </div>
      </HudPanel>
    </div>
  );
}

function Choice<T extends string>({
  label,
  value,
  options,
  onPick,
  note,
}: {
  label: string;
  value: T;
  options: [T, string][];
  onPick: (value: T) => void;
  note?: string;
}) {
  return (
    <div className="mt-4">
      <p className="label-xs text-muted-foreground">{label}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {options.map(([id, text]) => (
          <Button
            key={id}
            size="sm"
            variant={value === id ? "default" : "outline"}
            className="h-7 px-3 text-xs"
            onClick={() => onPick(id)}
          >
            {text}
          </Button>
        ))}
      </div>
      {note ? <p className="mt-2 text-[11px] text-muted-foreground">{note}</p> : null}
    </div>
  );
}

function NumberRow({
  label,
  value,
  min,
  max,
  step = 1,
  suffix = "",
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="mt-4 space-y-1">
      <div className="flex items-center justify-between">
        <p className="label-xs text-muted-foreground">{label}</p>
        <span className="font-mono text-[11px] text-primary">
          {value}
          {suffix}
        </span>
      </div>
      <Slider
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={(next) => onChange(Number(next[0] ?? value))}
      />
    </div>
  );
}
