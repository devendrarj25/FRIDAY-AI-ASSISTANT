import { useCallback, useEffect, useRef, useState } from "react";
import { livePoller } from "./live-poll";

/**
 * Run `job` on the shared poller while the component is mounted. `at` is the
 * time of the last successful run, `error` the last failure (cleared on the
 * next success), so a panel can show a Live badge and an honest offline line.
 */
export function useLivePoll(
  key: string,
  job: () => void | Promise<void>,
  every: number,
  enabled = true,
): { at: number | null; error: string | null; refresh: () => Promise<void> } {
  const [at, setAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const jobRef = useRef(job);
  useEffect(() => {
    jobRef.current = job;
  });

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const off = livePoller().subscribe(
      key,
      () => jobRef.current(),
      every,
      (failure) => {
        if (!active) return;
        if (failure) setError(failure instanceof Error ? failure.message : String(failure));
        else {
          setAt(Date.now());
          setError(null);
        }
      },
    );
    return () => {
      active = false;
      off();
    };
  }, [key, every, enabled]);

  const refresh = useCallback(() => livePoller().refresh(key), [key]);
  return { at, error, refresh };
}
