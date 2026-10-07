// Bundled locally so the mark also renders inside the offline desktop app.
import logoUrl from "@/assets/friday-logo.png";
import { cn } from "@/lib/utils";

/**
 * The FRIDAY brand mark, rendered "alive": a breathing logo, a slow orbital
 * ring and a radar sweep that only animate while the kernel is connected.
 */
export function FridayOrb({
  size = 64,
  live = true,
  className,
}: {
  size?: number;
  live?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn("relative inline-grid shrink-0 place-items-center", className)}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <span
        className={cn("absolute inset-0 rounded-full blur-xl", live ? "orb-halo" : "opacity-20")}
        style={{
          background:
            "conic-gradient(from 0deg, var(--color-primary), oklch(0.72 0.16 200), oklch(0.7 0.18 300), var(--color-primary))",
        }}
      />
      <span
        className={cn(
          "absolute inset-[6%] rounded-full border border-primary/25",
          live && "orb-spin-slow",
        )}
        style={{
          maskImage:
            "conic-gradient(#000 0 25%, transparent 25% 50%, #000 50% 75%, transparent 75%)",
        }}
      />
      {live ? (
        <span
          className="orb-sweep absolute inset-0 rounded-full"
          style={{
            background:
              "conic-gradient(from 0deg, transparent 0deg, color-mix(in oklab, var(--color-primary) 45%, transparent) 30deg, transparent 60deg)",
          }}
        />
      ) : null}
      <img
        src={logoUrl}
        alt=""
        className={cn(
          "relative size-full object-contain",
          live ? "orb-breathe" : "opacity-50 grayscale",
        )}
        draggable={false}
      />
    </span>
  );
}

export function FridayWordmark({ live = true }: { live?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <FridayOrb size={36} live={live} />
      <div className="leading-tight">
        <p className="font-display text-sm font-semibold tracking-tight text-sidebar-foreground">
          FRIDAY
        </p>
        <p className="label-xs text-muted-foreground">{live ? "active · live" : "standby"}</p>
      </div>
    </div>
  );
}
