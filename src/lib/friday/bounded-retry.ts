/**
 * The same bounded backoff the kernel uses (`electron/kernel-auto-restart.cjs`).
 *
 * Renderer and phone code must not import that CJS module. These constants
 * stay numerically identical: immediate, then 2s, then 8s, three attempts.
 * Callers that must keep trying after the cap (the phone socket) repeat the
 * last delay. The kernel gives up after the cap. Voice keeps the last delay and
 * does not go silent.
 */
export const KERNEL_STYLE_DELAYS_MS: readonly [0, 2000, 8000] = [0, 2000, 8000];
export const KERNEL_STYLE_MAX_ATTEMPTS = 3;

/** Delay for this attempt index, or null when the cap is reached. */
export function nextRetryDelayMs(attemptIndex: number): number | null {
  if (attemptIndex <= 0) return 0;
  if (attemptIndex === 1) return 2000;
  if (attemptIndex === 2) return 8000;
  return null;
}

/** Delay that never gives up: after the cap, keep using the last slot. */
export function persistentRetryDelayMs(attemptIndex: number): number {
  return nextRetryDelayMs(attemptIndex) ?? 8000;
}
