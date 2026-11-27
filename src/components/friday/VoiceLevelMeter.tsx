import { useEffect, useRef } from "react";
import { voiceGate } from "@/lib/friday/voice-audio";
import { meterScale } from "@/components/friday/voice-live-status-model";

/**
 * Live microphone level for the Auto bar. The fill is painted straight onto one element through a ref from the
 * gate's own notifications: no timer, no React render per frame, and the listener goes away on unmount or when
 * `active` turns off. Decorative (the mic chip beside it carries the words), so it is hidden from assistive tech.
 */
export function VoiceLevelMeter({ active }: { active: boolean }) {
  const fill = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = fill.current;
    if (!el) return undefined;
    const reduce =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;
    const paint = (level: number) => {
      el.style.transform = `scaleX(${meterScale(level, reduce?.matches === true)})`;
    };
    if (!active) {
      paint(0);
      return undefined;
    }
    paint(voiceGate.getSnapshot().level);
    const stop = voiceGate.subscribe((snapshot) => paint(snapshot.level));
    return () => {
      stop();
      paint(0);
    };
  }, [active]);

  return (
    <span
      aria-hidden
      data-voice-meter={active ? "on" : "off"}
      className="inline-block h-1.5 w-10 shrink-0 overflow-hidden rounded-full bg-primary/15"
    >
      <span
        ref={fill}
        className="block h-full origin-left rounded-full bg-accent motion-safe:transition-transform motion-safe:duration-100"
        style={{ transform: "scaleX(0)" }}
      />
    </span>
  );
}
