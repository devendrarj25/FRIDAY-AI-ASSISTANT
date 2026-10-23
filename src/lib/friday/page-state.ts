/** Pure helpers behind the shared page states and the Live indicator. */

export type PageStatus = "loading" | "error" | "empty" | "ready";

/** loading wins until the first answer, then error, then empty, else ready. */
export function pageStatus(input: {
  loading?: boolean;
  error?: string | null;
  count?: number;
  /** Something is already on screen: keep it instead of blanking on reload. */
  hasData?: boolean;
}): PageStatus {
  const { loading = false, error = null, count = 0, hasData = count > 0 } = input;
  if (error && !hasData) return "error";
  if (loading && !hasData) return "loading";
  return count > 0 || hasData ? "ready" : "empty";
}

/** "just now", "12 s ago", "3 min ago", "2 h ago". */
export function ageLabel(at: number | null | undefined, now: number): string {
  if (at == null) return "not yet";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}

export type Liveness = "live" | "stale" | "offline";

/**
 * Live while an answer arrived within two refresh periods, stale after that,
 * offline when the source says so or the last attempt failed.
 */
export function liveness(input: {
  at: number | null | undefined;
  now: number;
  everyMs: number;
  offline?: boolean;
  error?: string | null;
}): Liveness {
  if (input.offline || input.error) return "offline";
  if (input.at == null) return "stale";
  return input.now - input.at <= input.everyMs * 2 + 1000 ? "live" : "stale";
}
