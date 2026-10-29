/**
 * FRIDAY renderer error reporting.
 *
 * Boundary-caught errors never reach window.onerror in production React, so the
 * root error component forwards them here. The report is written to the console
 * so it lands in FRIDAY's log stream.
 */

export function reportRendererError(error: unknown, context: Record<string, unknown> = {}) {
  if (typeof window === "undefined") return;

  // Loaders and server functions can throw a raw Response; String(it) would be
  // the opaque "[object Response]", so pull out the status and URL instead.
  const message =
    error instanceof Response
      ? `Response ${error.status}${error.url ? ` at ${error.url}` : ""}`
      : error instanceof Error
        ? error.message
        : String(error);
  const stack = error instanceof Error ? error.stack : undefined;

  console.error("[friday] renderer error", { message, stack, ...context });
}
