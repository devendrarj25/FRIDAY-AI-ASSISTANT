const CAUSE_DEPTH_LIMIT = 5;

/**
 * A browser refresh, navigation, or proxy reconnect can close an HTTP request
 * before the server finishes reading it. Node reports that transport lifecycle
 * event as "aborted"/ECONNRESET; it is not an application failure.
 */
export function isExpectedClientAbort(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < CAUSE_DEPTH_LIMIT && current != null; depth++) {
    if (!(current instanceof Error)) return false;
    const code = (current as Error & { code?: unknown }).code;
    if (
      current.name === "AbortError" ||
      current.message.toLowerCase() === "aborted" ||
      code === "ECONNRESET" ||
      code === "ECONNABORTED"
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}
