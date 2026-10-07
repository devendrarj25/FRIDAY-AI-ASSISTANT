/**
 * FRIDAY · durable state persistence
 *
 * One storage path for every engine (chat, brain, memory, models, tasks).
 * In the browser the record lives in localStorage. In the packaged desktop app
 * the same record is additionally mirrored to a real JSON file inside the
 * FRIDAY workspace, so chats, memory, learned facts and model choices survive
 * a cache clear, a reinstall or an update.
 *
 * Nothing here changes what an engine stores — only where it durably lands.
 */

type StateApi = {
  getState?: (namespace: string) => Promise<unknown>;
  setState?: (namespace: string, value: unknown) => Promise<boolean>;
  storageIdentity?: { id: string; root: string | null } | null;
};

const api = (): StateApi | undefined =>
  typeof window === "undefined" ? undefined : (window.friday as unknown as StateApi | undefined);

const IDENTITY_KEY = "friday.storage.identity";

/**
 * The selected FRIDAY folder is the only store. The browser copy lives with
 * Chromium's profile, so a deleted/changed root would otherwise leave a second
 * store behind (old chats and settings reappearing after a clean reinstall).
 * The main process stamps each root with an id; when the cached stamp does not
 * match, the whole FRIDAY browser cache is dropped before anything hydrates.
 */
function alignWithRoot(): void {
  if (typeof window === "undefined") return;
  const identity = api()?.storageIdentity;
  if (!identity?.id) return; // browser preview, or no folder selected yet
  try {
    if (window.localStorage.getItem(IDENTITY_KEY) === identity.id) return;
    const stale = Object.keys(window.localStorage).filter(
      (key) => key.startsWith("friday.") && key !== IDENTITY_KEY,
    );
    for (const key of stale) window.localStorage.removeItem(key);
    window.localStorage.setItem(IDENTITY_KEY, identity.id);
  } catch {
    /* storage blocked — the disk copy stays authoritative on its own */
  }
}

// Runs at module load: every engine reads through this module, so the cache is
// already aligned with the current root by the time one of them hydrates.
alignWithRoot();

/** Synchronous read of the browser copy. Always safe, never throws. */
export function readLocalState<T>(namespace: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(namespace);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** Reads the durable desktop copy. Resolves to null in the browser preview. */
export async function readDiskState<T>(namespace: string): Promise<T | null> {
  const bridge = api();
  if (!bridge?.getState) return null;
  try {
    const value = await bridge.getState(namespace);
    return (value ?? null) as T | null;
  } catch {
    return null;
  }
}

const pending = new Map<string, ReturnType<typeof setTimeout>>();
/** Namespaces this session has already written — never overwritten by a restore. */
const written = new Set<string>();

/**
 * Writes the browser copy immediately and the durable desktop copy on a short
 * debounce, so a streaming run never hits disk on every token.
 */
export function writeState(namespace: string, value: unknown): void {
  if (typeof window === "undefined") return;
  written.add(namespace);
  try {
    window.localStorage.setItem(namespace, JSON.stringify(value));
  } catch {
    /* storage blocked — desktop mirror below still persists the record */
  }
  const bridge = api();
  if (!bridge?.setState) return;
  const queued = pending.get(namespace);
  if (queued) clearTimeout(queued);
  pending.set(
    namespace,
    setTimeout(() => {
      pending.delete(namespace);
      void bridge.setState?.(namespace, value).catch(() => undefined);
    }, 400),
  );
}

/** True when a durable FRIDAY_ROOT store is reachable (packaged desktop app). */
export function hasDiskStore(): boolean {
  return Boolean(api()?.getState);
}

/**
 * Restores a namespace from the durable FRIDAY_ROOT copy.
 *
 * On the desktop the folder on disk is the ONLY authoritative store: the
 * browser copy is a synchronous paint cache, so the disk record is applied
 * even when a cached copy exists. A namespace the engine has already written
 * this session is skipped so an in-flight change is never clobbered.
 * In the browser preview (no bridge) the cached copy is all there is.
 */
export function restoreFromDisk<T>(namespace: string, apply: (value: T) => void): void {
  if (typeof window === "undefined") return;
  const cached = readLocalState<T>(namespace);
  if (!hasDiskStore()) return;
  if (cached !== null && !written.has(namespace)) {
    /* fall through: disk still wins */
  } else if (written.has(namespace)) {
    return;
  }
  void readDiskState<T>(namespace).then((value) => {
    if (value === null || value === undefined) return;
    if (written.has(namespace)) return;
    if (cached !== null && JSON.stringify(cached) === JSON.stringify(value)) return;
    try {
      window.localStorage.setItem(namespace, JSON.stringify(value));
    } catch {
      /* cache is optional */
    }
    apply(value);
  });
}
