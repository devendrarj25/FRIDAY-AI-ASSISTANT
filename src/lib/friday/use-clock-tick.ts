import { useEffect, useState } from "react";
import { onVisibleSecond } from "./frame-clock";

/**
 * Re-render every `everySeconds` seconds so "3 min ago" labels stay honest.
 * It rides the app's one shared one-second clock, which stops while the window
 * is hidden, instead of each page owning a setInterval.
 */
export function useSecondsTick(everySeconds: number): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let seconds = 0;
    return onVisibleSecond(() => {
      seconds += 1;
      if (seconds % everySeconds === 0) setTick((t) => t + 1);
    });
  }, [everySeconds]);
  return tick;
}
