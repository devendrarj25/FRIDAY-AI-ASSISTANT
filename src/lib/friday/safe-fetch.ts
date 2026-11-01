/**
 * FRIDAY · a fetch that cannot hang forever
 *
 * A page that never answers must not freeze an import, a marketplace install or a hub sync. The timeout covers the
 * whole request, the body included, and a caller's own signal still wins if it aborts first. A timeout is reported as
 * an error that says so ("timed out after 20s") with code ETIMEDOUT, which the failure classes already understand.
 */

export function timeoutSignal(init: RequestInit | undefined, ms: number): AbortSignal {
  const own = init?.signal ?? null;
  const limit = AbortSignal.timeout(ms);
  return own ? AbortSignal.any([own, limit]) : limit;
}

export async function fetchTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  ms = 20_000,
): Promise<Response> {
  try {
    return await fetch(input, { ...init, signal: timeoutSignal(init, ms) });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      const timed = new Error(`request timed out after ${Math.round(ms / 1000)}s`);
      (timed as Error & { code?: string }).code = "ETIMEDOUT";
      throw timed;
    }
    throw error;
  }
}
