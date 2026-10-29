import { useSyncExternalStore } from "react";
import { brainKnowledge, type BrainKnowledgeState } from "./knowledge-base";
import { vectorIndex, type VectorIndexState } from "./vector-index";

const serverVector: VectorIndexState = vectorIndex.getSnapshot();

export function useVectorIndex(): VectorIndexState {
  return useSyncExternalStore(vectorIndex.subscribe, vectorIndex.getSnapshot, () => serverVector);
}

const serverKnowledge: BrainKnowledgeState = {
  entries: [],
  tasks: [],
  consent: [],
  updatedAt: null,
};

export function useBrainKnowledge(): BrainKnowledgeState {
  return useSyncExternalStore(
    brainKnowledge.subscribe,
    brainKnowledge.getSnapshot,
    () => serverKnowledge,
  );
}
