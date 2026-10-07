import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { preferences } from "@/lib/friday/preferences";

/** Shared settings field widgets — moved out of settings.tsx unchanged. */
export function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="label-xs text-muted-foreground">{label}</p>
      <div className="hud-tile mt-1 truncate rounded-sm px-2.5 py-1.5 font-mono text-xs text-foreground">
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
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        className="hud-tile mt-1 h-auto rounded-sm border-primary/25 px-2.5 py-1.5 font-mono text-xs text-foreground"
      />
    </div>
  );
}

const SELECT_CLASS =
  "hud-tile mt-1 w-full rounded-sm border border-primary/25 bg-transparent px-2.5 py-1.5 font-mono text-xs text-foreground";

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
        <span className="font-mono text-[11px] text-primary">{detail}</span>
      </div>
      <Slider
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
