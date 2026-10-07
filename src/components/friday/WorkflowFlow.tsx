import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  WorkflowStep,
  WorkflowStepCatalogEntry,
  WorkflowStepKind,
} from "@/lib/friday/brain/workflow-forge";

export type WorkflowStepView = {
  id: string;
  label: string;
  kind: string;
  ref: string;
  risk: string;
};

const KINDS: WorkflowStepKind[] = ["note", "skill", "tool", "agent", "module", "connector"];
const RISKS: Array<"safe" | "write" | "exec"> = ["safe", "write", "exec"];

export function WorkflowFlow({
  steps,
  description,
}: {
  steps: WorkflowStepView[];
  description?: string;
}) {
  if (!steps.length) {
    return <p className="text-xs text-muted-foreground">This pack declares no steps yet.</p>;
  }
  return (
    <div className="workflow-flow space-y-2" data-testid="workflow-flow">
      <p className="font-mono text-[11px] text-muted-foreground">
        Block flow — {steps.length} step{steps.length === 1 ? "" : "s"}
      </p>
      {description ? (
        <p className="text-xs text-muted-foreground" data-testid="workflow-how">
          How it works — {description}
        </p>
      ) : null}
      <div className="flex flex-col items-stretch gap-1">
        <div className="rounded-sm border border-primary/20 bg-surface px-2 py-1 text-center font-mono text-[10px] text-muted-foreground">
          START
        </div>
        <p className="py-0.5 text-center font-mono text-[11px] text-primary" aria-hidden>
          ↓
        </p>
        {steps.map((step, index) => (
          <div key={step.id || `${step.label}-${index}`}>
            <div className="rounded-sm border border-primary/40 bg-surface px-2 py-2">
              <p className="font-mono text-[11px] text-primary">
                {index + 1}. {step.label}
              </p>
              <p className="font-mono text-[10px] text-muted-foreground">
                {step.kind}
                {step.ref ? ` · ${step.ref}` : ""}
                {step.risk && step.risk !== "safe" ? ` · ${step.risk}` : ""}
              </p>
            </div>
            {index < steps.length - 1 ? (
              <p className="py-0.5 text-center font-mono text-[11px] text-primary" aria-hidden>
                ↓
              </p>
            ) : null}
          </div>
        ))}
        <p className="py-0.5 text-center font-mono text-[11px] text-primary" aria-hidden>
          ↓
        </p>
        <div className="rounded-sm border border-primary/20 bg-surface px-2 py-1 text-center font-mono text-[10px] text-muted-foreground">
          END — local result, no web post
        </div>
      </div>
    </div>
  );
}

export function WorkflowEditor({
  name,
  description,
  category,
  schedule,
  steps,
  catalog,
  catalogQuery,
  busy,
  onName,
  onDescription,
  onCategory,
  onSchedule,
  onCatalogQuery,
  onStep,
  onAddStep,
  onRemoveStep,
  onMoveStep,
  onSave,
  onCancel,
}: {
  name: string;
  description: string;
  category: string;
  schedule: string;
  steps: WorkflowStep[];
  catalog: WorkflowStepCatalogEntry[];
  catalogQuery: string;
  busy: boolean;
  onName: (value: string) => void;
  onDescription: (value: string) => void;
  onCategory: (value: string) => void;
  onSchedule: (value: string) => void;
  onCatalogQuery: (value: string) => void;
  onStep: (index: number, next: WorkflowStep) => void;
  onAddStep: () => void;
  onRemoveStep: (index: number) => void;
  onMoveStep: (index: number, direction: -1 | 1) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const needle = catalogQuery.trim().toLowerCase();
  return (
    <div className="space-y-3" data-testid="workflow-editor">
      <div className="grid gap-2 sm:grid-cols-2">
        <Input
          value={name}
          onChange={(event) => onName(event.target.value)}
          placeholder="Workflow name"
          className="h-8 font-mono text-xs"
          disabled={busy}
        />
        <Input
          value={schedule}
          onChange={(event) => onSchedule(event.target.value)}
          placeholder="Schedule (on demand)"
          className="h-8 font-mono text-xs"
          disabled={busy}
        />
        <Input
          value={category}
          onChange={(event) => onCategory(event.target.value)}
          placeholder="Category"
          className="h-8 font-mono text-xs"
          disabled={busy}
        />
        <Input
          value={description}
          onChange={(event) => onDescription(event.target.value)}
          placeholder="How it works"
          className="h-8 font-mono text-xs"
          disabled={busy}
        />
      </div>
      <WorkflowFlow
        steps={steps}
        description={description || "Edit the blocks below, then Save."}
      />
      <div className="space-y-2">
        {steps.map((step, index) => {
          const matches = catalog.filter((entry) => {
            if (entry.kind !== step.kind) return false;
            if (!needle) return true;
            return `${entry.id} ${entry.name}`.toLowerCase().includes(needle);
          });
          return (
            <div
              key={step.id || index}
              className="rounded-sm border border-primary/20 bg-surface px-2 py-2"
            >
              <p className="mb-1 font-mono text-[11px] text-primary">
                {index + 1}. {step.label || "Untitled step"}
              </p>
              <div className="flex flex-wrap gap-1">
                <select
                  className="h-7 rounded-md border border-input bg-transparent px-1 font-mono text-[11px]"
                  value={step.kind}
                  disabled={busy}
                  onChange={(event) =>
                    onStep(index, { ...step, kind: event.target.value as WorkflowStepKind })
                  }
                  aria-label={`Kind for step ${index + 1}`}
                >
                  {KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {kind}
                    </option>
                  ))}
                </select>
                <select
                  className="h-7 rounded-md border border-input bg-transparent px-1 font-mono text-[11px]"
                  value={step.risk}
                  disabled={busy}
                  onChange={(event) =>
                    onStep(index, {
                      ...step,
                      risk: event.target.value as "safe" | "write" | "exec",
                    })
                  }
                  aria-label={`Risk for step ${index + 1}`}
                >
                  {RISKS.map((risk) => (
                    <option key={risk} value={risk}>
                      {risk}
                    </option>
                  ))}
                </select>
                <Input
                  value={step.label}
                  onChange={(event) => onStep(index, { ...step, label: event.target.value })}
                  placeholder="Step label"
                  className="h-7 min-w-[10rem] flex-1 font-mono text-[11px]"
                  disabled={busy}
                />
                <Input
                  value={step.ref}
                  onChange={(event) => onStep(index, { ...step, ref: event.target.value })}
                  placeholder="Step ref"
                  className="h-7 min-w-[10rem] flex-1 font-mono text-[11px]"
                  disabled={busy}
                  list={`workflow-step-refs-${index}`}
                />
                <datalist id={`workflow-step-refs-${index}`}>
                  {matches.slice(0, 40).map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </datalist>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-[11px]"
                  disabled={busy || index === 0}
                  onClick={() => onMoveStep(index, -1)}
                >
                  Up
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-[11px]"
                  disabled={busy || index === steps.length - 1}
                  onClick={() => onMoveStep(index, 1)}
                >
                  Down
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-[11px]"
                  disabled={busy || steps.length <= 1}
                  onClick={() => onRemoveStep(index)}
                >
                  Remove
                </Button>
              </div>
            </div>
          );
        })}
      </div>
      <Input
        value={catalogQuery}
        onChange={(event) => onCatalogQuery(event.target.value)}
        placeholder="Filter step catalog by name or id…"
        className="h-8 font-mono text-xs"
        disabled={busy}
      />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" className="h-8" variant="outline" disabled={busy} onClick={onAddStep}>
          Add step
        </Button>
        <Button size="sm" className="h-8" disabled={busy || !name.trim()} onClick={onSave}>
          Save
        </Button>
        <Button size="sm" variant="outline" className="h-8" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
