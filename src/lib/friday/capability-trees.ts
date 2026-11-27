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
import { deferEffect } from "./defer-effect";

export type CapabilityTree =
  "agents" | "skills" | "tools" | "modules" | "plugins" | "workflows" | "models";

/** Which layer a listed item comes from; the main process computes it, the UI only shows it. */
export type CapabilityStatus =
  "builtin" | "custom" | "overridden" | "forked-stale" | "identical" | "removed";

export type CapabilityProvenance = "user" | "import" | "marketplace" | "forge" | "release-content";

/** Where an owner's fork was cut from (config/capabilities.json `forks`). */
export interface CapabilityFork {
  baseVersion?: string | null;
  baseSha256?: string;
  at?: number;
}

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
  /** Layer of the item; a missing value reads as built-in or custom from `origin`. */
  status?: CapabilityStatus;
  /** Present on an owner's fork of a built-in. */
  fork?: CapabilityFork;
  /** Present when a workspace copy is byte-identical to the built-in. */
  identicalCopy?: { origin: "workspace"; path: string };
  /** Who put a workspace item there; missing reads as `user`. */
  provenance?: CapabilityProvenance | null;
}

/** An item "Update content" skipped because this release already ships it. */
export interface AlreadyInRelease {
  id: string;
  tree: string;
  version: string | null;
  builtinVersion: string | null;
  reason: string;
}

/** An item "Update content" left alone because the owner's copy is theirs. */
export interface KeptYours {
  id: string;
  tree: string;
  version: string | null;
  incomingVersion: string | null;
  provenance: string;
}

/** Result of `resetBuiltinCapability` (channel `capabilities:reset-builtin`). */
export interface ResetBuiltinResult {
  ok: boolean;
  id?: string;
  backup?: string;
  error?: string;
}

export const RESET_DESKTOP_ONLY = "desktop-only";

/** Only the owner's own copy of a built-in can be reset; the built-in itself stays untouched. */
export const canResetBuiltin = (status?: CapabilityStatus | null): boolean =>
  status === "overridden" || status === "forked-stale";

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
  resetBuiltinCapability?: (id: string) => Promise<ResetBuiltinResult>;
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
 * Remove the owner's copy of a built-in (a backup is saved first by the main
 * process) so the release version is used again. Outside the desktop app it
 * does nothing and says so.
 */
export async function resetBuiltin(id: string): Promise<ResetBuiltinResult> {
  const reset = isDesktopApp() ? api()?.resetBuiltinCapability : undefined;
  if (!reset) return { ok: false, error: RESET_DESKTOP_ONLY };
  try {
    const result = await reset(id);
    if (!result || typeof result !== "object") return { ok: false, error: "No answer." };
    return result.ok
      ? {
          ok: true,
          ...(result.id ? { id: result.id } : {}),
          ...(result.backup ? { backup: result.backup } : {}),
        }
      : { ok: false, error: result.error || "The reset did not finish." };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export const RESET_CONFIRM_TEXT =
  "A backup copy is saved first, then your copy is removed and the release version is used.";
export const RESET_DESKTOP_TEXT = "This change needs the FRIDAY desktop app.";

export type BadgeSpec = { label: string; hint: string; tone: string };

const BADGES: Record<"builtin" | "custom" | "overridden" | "forked-stale" | "removed", BadgeSpec> =
  {
    builtin: { label: "Built-in", hint: "Ships with FRIDAY.", tone: "" },
    custom: { label: "Custom", hint: "Added by you.", tone: "" },
    overridden: {
      label: "Overridden",
      hint: "Your copy wins over the built-in.",
      tone: "border-primary/40 text-primary",
    },
    "forked-stale": {
      label: "Forked-stale",
      hint: "The release changed this item, your fork is older.",
      tone: "border-warning/40 text-warning",
    },
    removed: {
      label: "Removed",
      hint: "This release no longer ships it; your copy stays.",
      tone: "text-muted-foreground",
    },
  };

/** The badge a row shows, or null when neither a status nor an origin is known. */
export function badgeSpec(
  status?: CapabilityStatus | null,
  origin?: string | null,
): BadgeSpec | null {
  if (status === "identical") return BADGES.builtin;
  if (status && Object.prototype.hasOwnProperty.call(BADGES, status))
    return BADGES[status as keyof typeof BADGES];
  if (origin === "app") return BADGES.builtin;
  if (origin === "workspace") return BADGES.custom;
  return null;
}

/** Shown when a reset fails; "desktop-only" is the wrapper's code for the browser preview. */
export const resetErrorText = (error?: string): string =>
  !error || error === RESET_DESKTOP_ONLY ? RESET_DESKTOP_TEXT : error;

export type ResetPhase =
  { kind: "idle" } | { kind: "confirm" } | { kind: "working" } | { kind: "error"; message: string };

/**
 * One reset: run the reset, say so on success, then re-read the list from its
 * source so the row changes status by itself. Everything is injected so the
 * flow runs under a fake bridge in tests.
 */
export async function runBuiltinReset(options: {
  id: string;
  name: string;
  refresh: () => Promise<unknown> | unknown;
  notify: { success: (message: string) => unknown };
  reset?: (id: string) => Promise<ResetBuiltinResult>;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { id, name, refresh, notify, reset = resetBuiltin } = options;
  const result = await reset(id);
  if (!result.ok) return { ok: false, error: resetErrorText(result.error) };
  notify.success(`${name} is back to the built-in version. Your copy was backed up first.`);
  await refresh();
  return { ok: true };
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
    const stop = deferEffect(() => void refresh());
    const off = api()?.onCapabilitiesChanged?.(() => void refresh());
    return () => {
      stop();
      off?.();
    };
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
