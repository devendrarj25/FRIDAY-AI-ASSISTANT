import { useSyncExternalStore } from "react";
import { memory, type MemoryState } from "./memory-engine";
import { self, type SelfState } from "./self-manager";
import { ledger, type LedgerState } from "./task-ledger";
import { autonomy, type AutonomySettings } from "./autonomy";
import { governance, type GovState } from "./governance";
import { autonomousCore, type CoreState } from "./autonomous-core";
import { backgroundTasks, type BackgroundState } from "./background-tasks";
import { taskGraph, type TaskGraphState } from "./task-graph";
import { capabilityMatrix, type CapabilityMatrixState } from "./capability-matrix";

export function useTaskGraph(): TaskGraphState {
  return useSyncExternalStore(taskGraph.subscribe, taskGraph.getSnapshot, taskGraph.getSnapshot);
}

export function useMemory(): MemoryState {
  return useSyncExternalStore(memory.subscribe, memory.getSnapshot, memory.getSnapshot);
}

export function useSelf(): SelfState {
  return useSyncExternalStore(self.subscribe, self.getSnapshot, self.getSnapshot);
}

export function useLedger(): LedgerState {
  return useSyncExternalStore(ledger.subscribe, ledger.getSnapshot, ledger.getSnapshot);
}

export function useAutonomy(): AutonomySettings {
  return useSyncExternalStore(autonomy.subscribe, autonomy.getSnapshot, autonomy.getSnapshot);
}

export function useGovernance(): GovState {
  return useSyncExternalStore(governance.subscribe, governance.getSnapshot, governance.getSnapshot);
}

export function useAutonomousCore(): CoreState {
  return useSyncExternalStore(
    autonomousCore.subscribe,
    autonomousCore.getSnapshot,
    autonomousCore.getSnapshot,
  );
}

export function useBackgroundTasks(): BackgroundState {
  return useSyncExternalStore(
    backgroundTasks.subscribe,
    backgroundTasks.getSnapshot,
    backgroundTasks.getSnapshot,
  );
}

export function useCapabilityMatrix(): CapabilityMatrixState {
  return useSyncExternalStore(
    capabilityMatrix.subscribe,
    capabilityMatrix.getSnapshot,
    capabilityMatrix.getSnapshot,
  );
}
