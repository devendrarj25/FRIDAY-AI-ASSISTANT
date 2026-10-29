/**
 * What PR Validation runs, read from the workflow itself.
 *
 * Its Windows job calls the shared build pipeline (the same one FRIDAY Release
 * and the CMD pack call) with a phase range. A test that asks "does PR
 * Validation run X?" must therefore look in the workflow text AND in the
 * commands of the phases the workflow's pipeline calls actually cover.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, "../../..");

export const prWorkflowText = (): string =>
  fs.readFileSync(path.join(ROOT, ".github/workflows/pr-validation.yml"), "utf8");

export const pipeline = require_(path.join(ROOT, "scripts/build-pipeline.cjs")) as {
  PHASES: string[];
  PHASE_COMMANDS: Record<string, string[]>;
  parseArgs: (argv: string[]) => { targets: string[]; channel: string; caller: string };
};

/** The phases covered by the `build-pipeline.cjs ... --caller pr-validation` calls in the workflow. */
export function phasesRunByPr(): string[] {
  const phases = pipeline.PHASES;
  const covered = new Set<string>();
  for (const match of prWorkflowText().matchAll(
    /build-pipeline\.cjs[^\n]*--caller pr-validation[^\n]*/g,
  )) {
    const line = match[0];
    const from = /--from (\S+)/.exec(line)?.[1] ?? phases[0]!;
    const through = /--through (\S+)/.exec(line)?.[1] ?? phases[phases.length - 1]!;
    for (let i = phases.indexOf(from); i <= phases.indexOf(through); i += 1) {
      if (i >= 0) covered.add(phases[i]!);
    }
  }
  return phases.filter((phase) => covered.has(phase));
}

/** True when the workflow itself, or a pipeline phase it runs, executes this command. */
export function prRuns(needle: string): boolean {
  if (prWorkflowText().includes(needle)) return true;
  const covered = new Set(phasesRunByPr());
  return Object.entries(pipeline.PHASE_COMMANDS).some(
    ([phase, commands]) =>
      covered.has(phase) && commands.some((command) => command.includes(needle)),
  );
}
