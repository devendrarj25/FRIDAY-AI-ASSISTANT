import { useSyncExternalStore } from "react";
import { imports, type ImportState } from "./import-engine";

const server: ImportState = imports.getSnapshot();

export function useImports(): ImportState {
  return useSyncExternalStore(imports.subscribe, imports.getSnapshot, () => server);
}
