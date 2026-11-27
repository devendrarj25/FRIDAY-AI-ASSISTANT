import { useId } from "react";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { preferences } from "@/lib/friday/preferences";

/** Shared settings field widgets — moved out of settings.tsx unchanged. */
export function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="label-xs text-muted-foreground">{label}</p>
      <div className="hud-tile mt-1 truncate rounded-ctl px-2.5 py-1.5 font-mono text-xs text-foreground">
        {value}
      </div>
    </div>
  );
}

export function EditField({
  label,
  value,
  onChange,
  onBlur,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
}) {
  return (
    <div>
      <p className="label-xs text-muted-foreground">{label}</p>
      <Input
        value={value}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        className="hud-tile mt-1 h-auto rounded-ctl border-primary/25 px-2.5 py-1.5 font-mono text-xs text-foreground"
      />
    </div>
  );
}

/** The one look of a settings dropdown (hud-tile has no focus style, so the ring is added here). */
export const SELECT_CLASS =
  "hud-tile mt-1 w-full rounded-ctl border border-primary/25 bg-transparent px-2.5 py-1.5 font-mono text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** A labelled dropdown over a fixed list of words. The accessible name is the label; the hint describes it. */
export function PickRow<T extends string>({
  label,
  hint,
  value,
  picks,
  words,
  onPick,
}: {
  label: string;
  hint: string;
  value: T;
  picks: readonly T[];
  words: Record<T, string>;
  onPick: (next: T) => void;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={`${id}-select`} className="label-xs text-muted-foreground">
        {label}
      </label>
      <select
        id={`${id}-select`}
        value={value}
        aria-describedby={`${id}-hint`}
        onChange={(e) => onPick(e.target.value as T)}
        className={SELECT_CLASS}
      >
        {picks.map((pick) => (
          <option key={pick} value={pick} className="bg-background">
            {words[pick]}
          </option>
        ))}
      </select>
      <p id={`${id}-hint`} className="mt-1 text-meta-sm text-muted-foreground">
        {hint}
      </p>
    </div>
  );
}

export function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const known = options.some((option) => option.value === value);
  return (
    <div>
      <p className="label-xs text-muted-foreground">{label}</p>
      <select
        aria-label={label}
        value={known ? value : (options[0]?.value ?? "")}
        onChange={(event) => onChange(event.target.value)}
        className={SELECT_CLASS}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} className="bg-background">
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-border/60 pb-1.5 last:border-0">
      <dt>{k}</dt>
      <dd className="truncate text-foreground">{v}</dd>
    </div>
  );
}

/** One tunable numeric preference — the value is saved as it changes. */
export function TuneRow({
  label,
  value,
  min,
  max,
  detail,
  onChange,
  step = 0.05,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  detail: string;
  onChange: (value: number) => void;
  step?: number;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <p className="label-xs text-muted-foreground">{label}</p>
        <span className="text-meta text-primary">{detail}</span>
      </div>
      <Slider
        aria-label={label}
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(next) => onChange(Number(next[0] ?? value))}
        onValueCommit={() => void preferences.flush()}
      />
    </div>
  );
}
