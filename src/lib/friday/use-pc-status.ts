import { useCallback, useEffect, useRef, useState } from "react";
import { desktopApi } from "./desktop";
import { capabilityPending, type PcStatusView } from "./pc-status";
import { subscribeSystemPressure } from "./system-pressure";

/** The wider probes answer a few seconds after launch: ask again a few times, then stop (no standing timer). */
const PENDING_RETRY_MS = 4000;
const PENDING_RETRY_MAX = 3;
/** A burst of change signals (pressure, a governor notice) becomes one read. */
const CHANGE_DEBOUNCE_MS = 1500;

const message = (error: unknown): string =>
  String((error as Error)?.message || error).slice(0, 160);

/** One read of the facts and the governor. Never throws: a failure is an `error` view the page retries. */
export async function readPcStatus(force = false): Promise<PcStatusView> {
  const api = desktopApi();
  if (!api?.hardwareFacts) return { phase: "offline" };
  let facts;
  try {
    const answer = await api.hardwareFacts(force);
    if (!answer?.ok || !answer.facts) {
      return { phase: "error", message: String(answer?.error || "no answer").slice(0, 160) };
    }
    facts = answer.facts;
  } catch (error) {
    return { phase: "error", message: message(error) };
  }
  const governor = await api
    .governorStatus?.()
    .then((status) => (status?.ok ? status : null))
    .catch(() => null);
  return { phase: "ready", facts, governor: governor ?? null };
}

/**
 * The PC status for the Hardware and Status pages. It reads on mount, on the manual refresh, and when the main process
 * says something changed (the shared pressure store, a governor notice); while the wider probes are still measuring it
 * asks again a few times. It owns no standing timer.
 */
export function usePcStatus(): {
  view: PcStatusView;
  busy: boolean;
  refresh: () => void;
} {
  const [view, setView] = useState<PcStatusView>({ phase: "loading" });
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  const pendingTries = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const changeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const again = useRef<(force: boolean, quiet: boolean) => Promise<void>>(async () => {});
  const load = useCallback(async (force: boolean, quiet: boolean) => {
    const next = await readPcStatus(force);
    if (!live.current) return;
    // A quiet read that fails keeps what is on screen: the next change or the Refresh button tries again.
    setView((previous) =>
      quiet && next.phase === "error" && previous.phase === "ready" ? previous : next,
    );
    setBusy(false);
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = null;
    if (
      next.phase === "ready" &&
      capabilityPending(next.facts) &&
      pendingTries.current < PENDING_RETRY_MAX
    ) {
      pendingTries.current += 1;
      retryTimer.current = setTimeout(() => void again.current(false, true), PENDING_RETRY_MS);
    }
  }, []);

  useEffect(() => {
    again.current = load;
  }, [load]);

  useEffect(() => {
    live.current = true;
    pendingTries.current = 0;
    void load(false, false);
    const onChange = () => {
      if (changeTimer.current) clearTimeout(changeTimer.current);
      changeTimer.current = setTimeout(() => void load(false, true), CHANGE_DEBOUNCE_MS);
    };
    const stops: Array<() => void> = [];
    const unsubscribe = subscribeSystemPressure(onChange);
    stops.push(() => void unsubscribe());
    const notice = desktopApi()?.onGovernorNotice?.(onChange);
    if (notice) stops.push(notice);
    return () => {
      live.current = false;
      for (const stop of stops) stop();
      if (retryTimer.current) clearTimeout(retryTimer.current);
      if (changeTimer.current) clearTimeout(changeTimer.current);
    };
  }, [load]);

  const refresh = useCallback(() => {
    pendingTries.current = 0;
    setBusy(true);
    void load(true, false);
  }, [load]);

  return { view, busy, refresh };
}
