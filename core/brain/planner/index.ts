/**
 * FRIDAY · core/brain/planner
 *
 * Turns an intent into an explicit, inspectable list of steps. Nothing runs
 * from here — the planner only decides what should happen, which is what makes
 * approval and verification possible later in the pipeline.
 */
import type { FridayModule, ModuleContext } from "../../types";
import type { Intent } from "../intent";
import type { Capability } from "../../permissions";
import { bus } from "../../event-bus";

export type StepKind = "model" | "tool" | "skill" | "agent" | "plugin" | "memory" | "verify";

export interface PlanStep {
  id: string;
  kind: StepKind;
  /** Registered component id, or a model role for "model" steps. */
  target: string;
  description: string;
  /** Steps that must finish first. Empty means it can start immediately. */
  dependsOn: string[];
  capability?: Capability;
  input?: Record<string, unknown>;
}

export interface Plan {
  id: string;
  goal: string;
  steps: PlanStep[];
  /** True when at least one step needs the user's consent. */
  needsApproval: boolean;
  createdAt: number;
}

let seq = 0;

/** Rule-based plan for the intent. Complex goals are refined by the model later. */
export function buildPlan(intent: Intent): Plan {
  const id = `plan-${Date.now().toString(36)}-${(seq++).toString(36)}`;
  const steps: PlanStep[] = [];
  const push = (step: Omit<PlanStep, "id">) =>
    steps.push({ id: `${id}-s${steps.length + 1}`, ...step });

  push({
    kind: "memory",
    target: "recall",
    description: "Recall relevant memory for the request",
    dependsOn: [],
  });

  switch (intent.kind) {
    case "file":
      push({
        kind: "tool",
        target: "tools/filesystem",
        description: "Inspect or modify the requested path",
        dependsOn: [steps[0]!.id],
        capability: /\b(write|create|delete|rename|move|copy)\b/i.test(intent.text)
          ? "fs.write"
          : "fs.read",
        input: { paths: intent.entities.paths },
      });
      break;
    case "system":
      push({
        kind: "tool",
        target: "tools/system",
        description: "Read system state or perform the system action",
        dependsOn: [steps[0]!.id],
        capability: "system.control",
      });
      break;
    case "command":
      push({
        kind: "tool",
        target: "tools/automation",
        description: "Run the requested command",
        dependsOn: [steps[0]!.id],
        capability: "shell.exec",
        input: { apps: intent.entities.apps },
      });
      break;
    case "workflow":
      push({
        kind: "agent",
        target: "agents/core",
        description: "Break the goal into a workflow and run it",
        dependsOn: [steps[0]!.id],
      });
      break;
    case "code":
      push({
        kind: "model",
        target: "coder",
        description: "Reason about the code with the coding model",
        dependsOn: [steps[0]!.id],
      });
      break;
    case "memory":
      push({
        kind: "memory",
        target: "write",
        description: "Store or remove the remembered fact",
        dependsOn: [steps[0]!.id],
      });
      break;
    default:
      push({
        kind: "model",
        target: intent.kind === "question" ? "brain" : "fast",
        description: "Answer with the routed model",
        dependsOn: [steps[0]!.id],
      });
  }

  const last = steps[steps.length - 1]!;
  push({
    kind: "verify",
    target: "result",
    description: "Verify the result before answering",
    dependsOn: [last.id],
  });
  push({
    kind: "memory",
    target: "update",
    description: "Write the outcome back to memory",
    dependsOn: [steps[steps.length - 1]!.id],
  });

  const plan: Plan = {
    id,
    goal: intent.text,
    steps,
    needsApproval: steps.some((s) => Boolean(s.capability)),
    createdAt: Date.now(),
  };
  bus.emit("plan:created", { id: plan.id, steps: plan.steps.length });
  return plan;
}

/** Groups steps into waves that can safely run in parallel. */
export function planWaves(plan: Plan): PlanStep[][] {
  const done = new Set<string>();
  const waves: PlanStep[][] = [];
  let remaining = [...plan.steps];
  while (remaining.length) {
    const wave = remaining.filter((s) => s.dependsOn.every((d) => done.has(d)));
    if (!wave.length) break; // unsatisfiable dependency — stop rather than loop
    wave.forEach((s) => done.add(s.id));
    remaining = remaining.filter((s) => !done.has(s.id));
    waves.push(wave);
  }
  return waves;
}

export type PlannerModule = FridayModule;

export const plannerModule: PlannerModule = {
  id: "core/brain/planner",
  init(_ctx: ModuleContext) {},
};

export default plannerModule;
