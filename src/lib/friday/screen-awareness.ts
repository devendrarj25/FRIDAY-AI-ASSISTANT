/**
 * FRIDAY · screen awareness (renderer side)
 *
 * A thin, honest wrapper over the main-process capture bridge. Nothing here
 * fakes a capture: without the desktop bridge, or with screen vision disabled,
 * every call returns the real reason it could not look.
 *
 * The permission state is owned by the main process so the indicator cannot be
 * bypassed from the renderer.
 */

export type ScreenScope = "screen" | "window";

export type ScreenVisionState = {
  enabled: boolean;
  scope: ScreenScope;
  lastCaptureAt: number | null;
  captures: number;
  /** False in the browser preview — capture needs the desktop app. */
  supported: boolean;
};

export type ScreenSource = {
  id: string;
  name: string;
  kind: ScreenScope;
  displayId: string | null;
};

export type ScreenCapture = {
  ok: boolean;
  dataUrl?: string;
  source?: { id: string; name: string };
  width?: number;
  height?: number;
  at?: number;
  error?: string;
};

type ScreenApi = {
  screenVisionState?: () => Promise<Omit<ScreenVisionState, "supported">>;
  setScreenVision?: (patch: {
    enabled?: boolean;
    scope?: ScreenScope;
  }) => Promise<Omit<ScreenVisionState, "supported">>;
  screenSources?: () => Promise<{ ok: boolean; sources?: ScreenSource[]; error?: string }>;
  captureScreen?: (options: { sourceId?: string; scale?: number }) => Promise<ScreenCapture>;
};

const UNAVAILABLE = "screen awareness needs the FRIDAY desktop app";

const api = (): ScreenApi | undefined =>
  typeof window === "undefined" ? undefined : (window.friday as unknown as ScreenApi | undefined);

const OFFLINE: ScreenVisionState = {
  enabled: false,
  scope: "screen",
  lastCaptureAt: null,
  captures: 0,
  supported: false,
};

let cached: ScreenVisionState = OFFLINE;
const listeners = new Set<() => void>();

const publish = (next: ScreenVisionState): ScreenVisionState => {
  cached = next;
  listeners.forEach((listener) => listener());
  return cached;
};

export const subscribeScreenVision = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Last known state, synchronously. Refreshed by `readScreenVision()`. */
export const screenVisionSnapshot = (): ScreenVisionState => cached;

export async function readScreenVision(): Promise<ScreenVisionState> {
  const bridge = api();
  if (!bridge?.screenVisionState) return publish(OFFLINE);
  try {
    const state = await bridge.screenVisionState();
    return publish({ ...OFFLINE, ...state, supported: true });
  } catch {
    return publish(OFFLINE);
  }
}

/** Explicit owner action — screen capture is never enabled implicitly. */
export async function setScreenVision(patch: {
  enabled?: boolean;
  scope?: ScreenScope;
}): Promise<ScreenVisionState> {
  const bridge = api();
  if (!bridge?.setScreenVision) return publish(OFFLINE);
  try {
    const state = await bridge.setScreenVision(patch);
    return publish({ ...OFFLINE, ...state, supported: true });
  } catch {
    return publish(OFFLINE);
  }
}

export async function listScreenSources(): Promise<{
  ok: boolean;
  sources: ScreenSource[];
  error?: string;
}> {
  const bridge = api();
  if (!bridge?.screenSources) return { ok: false, sources: [], error: UNAVAILABLE };
  try {
    const result = await bridge.screenSources();
    return {
      ok: Boolean(result?.ok),
      sources: result?.sources ?? [],
      ...(result?.error ? { error: result.error } : {}),
    };
  } catch (error) {
    return { ok: false, sources: [], error: String((error as Error)?.message ?? error) };
  }
}

export async function captureScreen(
  options: { sourceId?: string; scale?: number } = {},
): Promise<ScreenCapture> {
  const bridge = api();
  if (!bridge?.captureScreen) return { ok: false, error: UNAVAILABLE };
  try {
    const result = await bridge.captureScreen(options);
    if (result?.ok) void readScreenVision();
    return result ?? { ok: false, error: "no response from the capture bridge" };
  } catch (error) {
    return { ok: false, error: String((error as Error)?.message ?? error) };
  }
}

/**
 * A capture packaged for a vision model, plus the window list so FRIDAY can
 * name what is on screen even when no vision model is available.
 */
export async function describeScreen(options: { sourceId?: string; scale?: number } = {}): Promise<{
  ok: boolean;
  dataUrl?: string;
  summary: string;
  windows: string[];
  error?: string;
}> {
  const [shot, sources] = await Promise.all([captureScreen(options), listScreenSources()]);
  const windows = sources.sources.filter((entry) => entry.kind === "window").map((e) => e.name);
  if (!shot.ok) {
    return {
      ok: false,
      summary: shot.error ?? "capture failed",
      windows,
      ...(shot.error ? { error: shot.error } : {}),
    };
  }
  const summary = [
    `Captured ${shot.source?.name ?? "the screen"} at ${shot.width}×${shot.height}.`,
    windows.length
      ? `Open windows: ${windows.slice(0, 12).join(", ")}.`
      : "No named windows reported.",
  ].join(" ");
  return { ok: true, ...(shot.dataUrl ? { dataUrl: shot.dataUrl } : {}), summary, windows };
}
