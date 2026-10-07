/**
 * Renderer view of FRIDAY's manifest-driven capability trees.
 *
 * The desktop app reads real folders + manifests through the capability IPC
 * channels; in the browser preview `window.friday` is absent and the hook
 * reports "no desktop bridge", so callers keep their existing static preview
 * data and the page renders exactly as before.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { desktopApi, isDesktopApp, safeCall } from "./desktop";

export type CapabilityTree =
  "agents" | "skills" | "tools" | "modules" | "plugins" | "workflows" | "models";

export interface CapabilityItem {
  id: string;
  tree: CapabilityTree;
  segment: string;
  origin: "app" | "workspace";
  name: string;
  version: string | null;
  /** Manifest `summary` when the pack declared one; empty string otherwise. */
  summary: string;
  description: string;
  category: string;
  path: string;
  manifestFile: string | null;
  entry: string | null;
  permissions: string[];
  /** Manifest `inputs` when declared; empty when the pack has none. */
  inputs: string[];
  /** Manifest `approvalPrompt` when declared; empty when the pack has none. */
  approvalPrompt: string;
  /** Declared module UI page label when the pack has `ui.page`; empty otherwise. */
  uiPage: string;
  /** Declared module UI icon name when the pack has `ui.icon`; empty otherwise. */
  uiIcon: string;
  /** Agent persona role when declared; empty otherwise. */
  role: string;
  /** Agent skill ids when declared; empty otherwise. */
  skills: string[];
  /** Agent workflow ids when declared; empty otherwise. */
  workflows: string[];
  /** Declared lifecycle hooks when the pack is a plugin; empty otherwise. */
  hooks: string[];
  /** Declared workflow steps when the pack is a workflow; empty otherwise. */
  steps: {
    id: string;
    label: string;
    kind: string;
    ref: string;
    risk: "safe" | "write" | "exec";
  }[];
  /** Human schedule string when the pack is a workflow; empty otherwise. */
  schedule: string;
  risk: "safe" | "write" | "exec";
  enabled: boolean;
  configured: boolean;
  updatedAt: number;
}

export interface CapabilityIndex {
  items: CapabilityItem[];
  counts: Record<string, { total: number; enabled: number }>;
  scannedAt: number;
  appRoot: string | null;
  workspaceRoot: string | null;
}

type Api = {
  listCapabilities?: () => Promise<CapabilityIndex>;
  setCapabilityEnabled?: (id: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
  reloadCapabilities?: () => Promise<CapabilityIndex>;
  onCapabilitiesChanged?: (cb: (info: unknown) => void) => () => void;
};

const api = () => desktopApi() as unknown as Api | null;

export async function listCapabilities(): Promise<CapabilityIndex | null> {
  return safeCall<CapabilityIndex | null>(
    "capabilities:list",
    () => api()?.listCapabilities?.() ?? null,
    {
      fallback: null,
    },
  );
}

export async function setCapabilityEnabled(id: string, enabled: boolean): Promise<boolean> {
  const result = await safeCall<{ ok: boolean } | null>(
    `capabilities:set-enabled:${id}`,
    () => api()?.setCapabilityEnabled?.(id, enabled) ?? null,
    { fallback: null },
  );
  return Boolean(result?.ok);
}

/**
 * Live capability list for one tree. `supported` is false in the browser
 * preview so pages can keep rendering their existing sample rows unchanged.
 */
export function useCapabilities(tree?: CapabilityTree) {
  const [index, setIndex] = useState<CapabilityIndex | null>(null);
  const [loading, setLoading] = useState(isDesktopApp());

  const refresh = useCallback(async () => {
    if (!isDesktopApp()) return;
    const next = await listCapabilities();
    setIndex(next);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!isDesktopApp()) return;
    void refresh();
    const off = api()?.onCapabilitiesChanged?.(() => void refresh());
    return () => off?.();
  }, [refresh]);

  const items = useMemo(
    () => (index?.items ?? []).filter((item) => !tree || item.tree === tree),
    [index, tree],
  );

  const toggle = useCallback(
    async (id: string, enabled: boolean) => {
      const ok = await setCapabilityEnabled(id, enabled);
      if (ok) await refresh();
      return ok;
    },
    [refresh],
  );

  return {
    supported: isDesktopApp(),
    loading,
    items,
    counts: index?.counts ?? {},
    scannedAt: index?.scannedAt ?? 0,
    refresh,
    toggle,
  };
}
