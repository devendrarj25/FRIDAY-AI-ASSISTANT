/**
 * Renderer-side call into the one plugin hook registry in electron/plugins.cjs.
 * Reuses window.friday.dispatchPluginHooks (IPC). Not a second event bus —
 * callers fire this from the existing brain-engine push() / idle / skill sites.
 */

import { desktopApi, isDesktopApp } from "./desktop";

export const PLUGIN_HOOKS = [
  "on-app-start",
  "on-app-quit",
  "on-turn-start",
  "on-turn-complete",
  "on-error",
  "on-idle",
  "on-skill-run",
  "on-file-change",
] as const;

export type PluginHook = (typeof PLUGIN_HOOKS)[number];

type DispatchApi = {
  dispatchPluginHooks?: (
    hook: string,
    payload?: Record<string, unknown>,
    options?: { allowDisabled?: boolean; pluginId?: string },
  ) => Promise<{ ok?: boolean; hook?: string; fired?: unknown[]; error?: string }>;
};

function api(): DispatchApi | null {
  if (!isDesktopApp()) return null;
  return (desktopApi() as unknown as DispatchApi) || null;
}

/** Fire-and-forget so a plugin cannot stall a chat turn or idle cycle. */
export function dispatchPluginHook(hook: PluginHook, payload: Record<string, unknown> = {}): void {
  const bridge = api();
  if (!bridge?.dispatchPluginHooks) return;
  void bridge.dispatchPluginHooks(hook, payload).catch(() => {});
}
