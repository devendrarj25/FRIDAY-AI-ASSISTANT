import {
  COLOR_MODES,
  ACCENTS,
  COLOR_COMBOS,
  DISPLAY_FONTS,
  BODY_FONTS,
  TEXT_SIZES,
  DENSITIES,
  resolveColorMode,
  resolveAccent,
  activeComboId,
  persistColorMode,
  persistAccent,
  persistColorCombo,
  resetAppearancePreferences,
  accentClassFor,
} from "@/lib/friday/appearance";
import { HudPanel, ToggleRow } from "@/components/friday/ui";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { SelectField } from "@/components/friday/settings/fields";
import { preferences } from "@/lib/friday/preferences";
import { usePreferences } from "@/lib/friday/use-preferences";
import { SIDEBAR_PREF_EVENT } from "@/lib/friday/navigation";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const ACCENT_SWATCH: Record<string, string> = {
  cyan: "bg-primary",
  green: "bg-accent",
  orange: "bg-warning",
  purple: "bg-magenta",
};

export function AppearanceSettings() {
  const prefs = usePreferences();
  const mode = resolveColorMode(prefs);
  const accent = resolveAccent(prefs);
  const comboId = activeComboId(prefs);
  const isOn = (k: string) => prefs.toggles[k] === true;
  const flip = (k: string) => preferences.setToggle(k, !isOn(k));
  const field = (k: string) => prefs.fields[k] ?? "";
  const setField = (k: string) => (value: string) => preferences.setField(k, value);
  const panelOpacity = (() => {
    const raw = field("panelOpacity");
    if (!raw || raw === "92") return 100;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 100;
  })();
  const graphicIntensity = Number(prefs.fields["graphicIntensity"] ?? "70");

  return (
    <HudPanel title="Appearance">
      <p className="label-xs text-muted-foreground">Color mode</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {COLOR_MODES.map((item) => (
          <Button
            key={item.id}
            size="sm"
            variant={mode === item.id ? "default" : "outline"}
            onClick={() => persistColorMode(item.id)}
            className="min-w-24"
          >
            {item.label}
          </Button>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Dark and Daylight are surfaces. Match system follows Windows light / dark and still uses the
        accent below.
      </p>

      <p className="label-xs mt-4 text-muted-foreground">Accent color</p>
      <div className="mt-2 flex flex-wrap gap-3">
        {ACCENTS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-label={item.label}
            aria-pressed={accent === item.id}
            onClick={() => persistAccent(item.id)}
            className="flex flex-col items-center gap-1"
          >
            <span
              className={cn(
                "size-6 rounded-full border transition-transform hover:scale-110",
                accent === item.id ? "border-foreground ring-2 ring-primary/70" : "border-border",
                ACCENT_SWATCH[item.id],
              )}
            />
            <span className="font-mono text-[10px] text-muted-foreground">{item.label}</span>
          </button>
        ))}
      </div>

      <p className="label-xs mt-4 text-muted-foreground">Color combinations</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {COLOR_COMBOS.map((combo) => (
          <Button
            key={combo.id}
            size="sm"
            variant={comboId === combo.id ? "default" : "outline"}
            onClick={() => persistColorCombo(combo)}
            className="gap-2"
          >
            <span
              className={cn(
                "flex size-4 overflow-hidden rounded-full border border-border",
                combo.mode === "daylight" && "theme-daylight",
                accentClassFor(combo.accent),
              )}
            >
              <span className="w-1/2 bg-background" />
              <span className="w-1/2 bg-primary" />
            </span>
            {combo.label}
          </Button>
        ))}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <SelectField
          label="UI / heading font"
          value={field("font") || "Orbitron"}
          options={Object.keys(DISPLAY_FONTS).map((name) => ({ value: name, label: name }))}
          onChange={setField("font")}
        />
        <SelectField
          label="Body / chat font"
          value={field("bodyFont") || "Rajdhani"}
          options={Object.keys(BODY_FONTS).map((name) => ({
            value: name,
            label: name === "Atkinson Hyperlegible" ? "Atkinson Hyperlegible (readable)" : name,
          }))}
          onChange={setField("bodyFont")}
        />
        <SelectField
          label="Text size"
          value={field("textSize") || "Normal"}
          options={TEXT_SIZES.map((name) => ({ value: name, label: name }))}
          onChange={setField("textSize")}
        />
        <SelectField
          label="Interface density"
          value={field("density") || "Normal"}
          options={DENSITIES.map((name) => ({ value: name, label: name }))}
          onChange={setField("density")}
        />
        <SelectField
          label="Sidebar default"
          value={field("sidebarDefault") || "Expanded"}
          options={["Expanded", "Collapsed"].map((name) => ({ value: name, label: name }))}
          onChange={(value) => {
            preferences.setField("sidebarDefault", value);
            localStorage.setItem("friday.sidebar.collapsed", value === "Expanded" ? "0" : "1");
            window.dispatchEvent(new Event(SIDEBAR_PREF_EVENT));
          }}
        />
        <SelectField
          label="Chat bubble style"
          value={field("bubbleStyle") || "Compact"}
          options={["Compact", "Comfortable", "Full"].map((name) => ({
            value: name,
            label: name,
          }))}
          onChange={setField("bubbleStyle")}
        />
      </div>

      <div className="mt-4 space-y-3">
        <ToggleRow label="Animations" on={isOn("animations")} onToggle={() => flip("animations")} />
        <ToggleRow label="Blur effect" on={isOn("blur")} onToggle={() => flip("blur")} />
        <ToggleRow
          label="Live circuit graphic on the main window"
          on={isOn("circuit")}
          onToggle={() => flip("circuit")}
        />
        <ToggleRow
          label="Neon glow on panels and text"
          on={isOn("glow")}
          onToggle={() => flip("glow")}
        />
        <ToggleRow
          label="Scanlines overlay"
          on={isOn("scanlines")}
          onToggle={() => flip("scanlines")}
        />
        <ToggleRow
          label="GPU-accelerated rendering (recommended)"
          on={isOn("gpuRender")}
          onToggle={() => flip("gpuRender")}
        />
        <ToggleRow
          label="Reduce motion"
          on={isOn("reduceMotion")}
          onToggle={() => flip("reduceMotion")}
        />
        <ToggleRow
          label="High contrast text"
          on={isOn("highContrast")}
          onToggle={() => flip("highContrast")}
        />
        <ToggleRow
          label="Show timestamps on chat messages"
          on={isOn("chatTimestamps")}
          onToggle={() => flip("chatTimestamps")}
        />
        <label className="block">
          <span className="label-xs text-muted-foreground">Graphic intensity</span>
          <Slider
            className="mt-3"
            min={0}
            max={100}
            step={5}
            value={[Number.isFinite(graphicIntensity) ? graphicIntensity : 70]}
            onValueChange={(value) =>
              preferences.setField("graphicIntensity", String(value[0] ?? 70))
            }
          />
        </label>
        <label className="block">
          <span className="label-xs text-muted-foreground">Panel opacity</span>
          <Slider
            className="mt-3"
            min={55}
            max={100}
            step={5}
            value={[panelOpacity]}
            onValueChange={(value) => preferences.setField("panelOpacity", String(value[0] ?? 100))}
          />
        </label>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            resetAppearancePreferences();
            void preferences.flush();
            toast.success("Appearance restored to shipped defaults");
          }}
        >
          Reset appearance
        </Button>
      </div>
    </HudPanel>
  );
}
