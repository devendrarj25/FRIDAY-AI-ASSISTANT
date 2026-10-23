import { useState } from "react";
import {
  Check,
  CircleDashed,
  Layers,
  Monitor,
  Moon,
  MousePointerClick,
  Palette,
  RotateCcw,
  Sparkles,
  Sun,
  type LucideIcon,
} from "lucide-react";
import {
  COLOR_MODES,
  ACCENTS,
  COLOR_COMBOS,
  DISPLAY_FONTS,
  BODY_FONTS,
  TEXT_SIZES,
  DENSITIES,
  UI_STYLES,
  GLASS_DEPTHS,
  CORNER_STYLES,
  AMBIENT_LIGHTS,
  AMBIENT_MOTIONS,
  BUTTON_LABEL_MODES,
  resolveColorMode,
  resolveAccent,
  resolveUiStyle,
  resolveGlassDepth,
  resolveCornerStyle,
  resolveAmbientLight,
  resolveAmbientMotion,
  resolveButtonLabels,
  activeComboId,
  persistColorMode,
  persistAccent,
  persistColorCombo,
  resetAppearancePreferences,
  accentClassFor,
} from "@/lib/friday/appearance";
import { HudPanel, SegmentedControl, StatusPill, ToggleRow } from "@/components/friday/ui";
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

const MODE_ICON: Record<string, LucideIcon> = { dark: Moon, daylight: Sun, system: Monitor };

/** A row of choice buttons: one pressed, each with an icon. */
function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
  icon: Icon,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ id: T; label: string }>;
  onChange: (value: T) => void;
  icon: LucideIcon;
}) {
  return (
    <div>
      <p className="label-xs text-muted-foreground">{label}</p>
      <SegmentedControl
        label={label}
        value={value}
        options={options.map((item) => ({
          id: item.id,
          label: item.label,
          icon: value === item.id ? Check : Icon,
        }))}
        onChange={onChange}
        className="mt-2"
      />
    </div>
  );
}

/** A mini conversation, a switch, a segmented control, a button and a panel
 *  built from the real classes, so every setting shows up here at once. */
function LivePreview() {
  const [on, setOn] = useState(true);
  const [seg, setSeg] = useState("two");
  return (
    <div className="mt-4 space-y-3" aria-label="Live preview of the look">
      <div className="space-y-2.5">
        <div className="flex justify-end">
          <p className="bubble-user w-fit max-w-[78%] px-3 py-2 text-sm">What changed today?</p>
        </div>
        <p className="bubble-friday w-fit max-w-[78%] px-3 py-2 text-sm">
          Three things. All of them are done.
        </p>
      </div>
      <SegmentedControl
        label="Preview segmented control"
        value={seg}
        options={[
          { id: "one", label: "One" },
          { id: "two", label: "Two" },
          { id: "three", label: "Three" },
        ]}
        onChange={setSeg}
      />
      <ToggleRow label="Preview switch" on={on} onToggle={() => setOn((value) => !value)} />
      <div className="hud-panel p-3 text-sm text-foreground/90">
        A glass panel over the ambient light.
      </div>
    </div>
  );
}

export function AppearanceSettings() {
  const prefs = usePreferences();
  const mode = resolveColorMode(prefs);
  const accent = resolveAccent(prefs);
  const comboId = activeComboId(prefs);
  const uiStyle = resolveUiStyle(prefs);
  const glassDepth = resolveGlassDepth(prefs);
  const cornerStyle = resolveCornerStyle(prefs);
  const ambientLight = resolveAmbientLight(prefs);
  const ambientMotion = resolveAmbientMotion(prefs);
  const buttonLabels = resolveButtonLabels(prefs);
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
  const modeLabel = COLOR_MODES.find((m) => m.id === mode)?.label ?? mode;
  const accentLabel = ACCENTS.find((a) => a.id === accent)?.label ?? accent;
  const styleLabel = UI_STYLES.find((s) => s.id === uiStyle)?.label ?? uiStyle;

  return (
    <div className="space-y-4">
      {/* Live preview: the real primitives under the real settings. */}
      <HudPanel title="Appearance" hint="Changes apply immediately">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <div
            className="hud-tile rounded-surface p-3"
            aria-label="Preview of your current choices"
          >
            <p className="label-xs text-primary glow-text">Preview</p>
            <h3 className="mt-2 font-display text-lg font-bold text-foreground">FRIDAY</h3>
            <p className="mt-1 text-sm text-foreground/90">
              {modeLabel} · {accentLabel} · {styleLabel} · {glassDepth} glass
            </p>
            <p className="mt-1 text-meta text-muted-foreground">
              {field("font") || "Orbitron"} headings · {field("bodyFont") || "Rajdhani"} body ·{" "}
              {field("textSize") || "Normal"} text · {field("density") || "Normal"} density
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button size="sm" className="gap-1.5" tabIndex={-1} aria-hidden="true">
                <Sparkles className="size-3.5" />
                Primary
              </Button>
              <Button size="sm" variant="outline" tabIndex={-1} aria-hidden="true">
                Outline
              </Button>
              <StatusPill label="ready" tone="accent" />
              <StatusPill label="warning" tone="warning" />
            </div>
            <LivePreview />
          </div>
          <Choice
            label="Color mode"
            value={mode}
            options={COLOR_MODES}
            onChange={(id) => persistColorMode(id)}
            icon={MODE_ICON[mode] ?? Moon}
          />
        </div>
      </HudPanel>

      <HudPanel title="Theme">
        <p className="text-note text-muted-foreground">
          Dark and Daylight are surfaces. Match system follows Windows light / dark and still uses
          the accent below.
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
              className="friday-btn flex flex-col items-center gap-1 rounded-surface p-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <span
                className={cn(
                  "size-6 rounded-full border transition-transform hover:scale-110",
                  accent === item.id ? "border-foreground ring-2 ring-primary/70" : "border-border",
                  ACCENT_SWATCH[item.id],
                )}
              />
              <span className="text-meta-sm text-muted-foreground">{item.label}</span>
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
              aria-pressed={comboId === combo.id}
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
      </HudPanel>

      <HudPanel title="Look">
        <div className="grid gap-4 lg:grid-cols-2">
          <Choice
            label="Interface style"
            value={uiStyle}
            options={UI_STYLES}
            onChange={setField("uiStyle")}
            icon={Layers}
          />
          <Choice
            label="Glass depth"
            value={glassDepth}
            options={GLASS_DEPTHS.map((d) => ({ id: d, label: d }))}
            onChange={setField("glassDepth")}
            icon={Palette}
          />
          <Choice
            label="Corner style"
            value={cornerStyle}
            options={CORNER_STYLES.map((d) => ({ id: d, label: d }))}
            onChange={setField("cornerStyle")}
            icon={CircleDashed}
          />
          <Choice
            label="Ambient light"
            value={ambientLight}
            options={AMBIENT_LIGHTS.map((d) => ({ id: d, label: d }))}
            onChange={setField("ambientLight")}
            icon={Sparkles}
          />
          <Choice
            label="Ambient motion"
            value={ambientMotion}
            options={AMBIENT_MOTIONS.map((d) => ({ id: d, label: d }))}
            onChange={setField("ambientMotion")}
            icon={Sparkles}
          />
        </div>
        <p className="mt-2 text-note text-muted-foreground">
          Corner style, Ambient light and Ambient motion apply to Futuristic Glass. Ambient motion
          is a slow drift of the background lights and stays off with Reduce motion or GPU rendering
          off.
        </p>
        <div className="mt-4 space-y-3">
          <ToggleRow label="Blur effect" on={isOn("blur")} onToggle={() => flip("blur")} />
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
            label="Live circuit graphic on the main window"
            on={isOn("circuit")}
            onToggle={() => flip("circuit")}
          />
          <ToggleRow
            label="GPU-accelerated rendering (recommended)"
            on={isOn("gpuRender")}
            onToggle={() => flip("gpuRender")}
          />
          <label className="block">
            <span className="label-xs text-muted-foreground">Graphic intensity</span>
            <Slider
              className="mt-3"
              min={0}
              max={100}
              step={5}
              aria-label="Graphic intensity"
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
              aria-label="Panel opacity"
              value={[panelOpacity]}
              onValueChange={(value) =>
                preferences.setField("panelOpacity", String(value[0] ?? 100))
              }
            />
          </label>
        </div>
      </HudPanel>

      <HudPanel title="Motion">
        <div className="space-y-3">
          <ToggleRow
            label="Animations"
            on={isOn("animations")}
            onToggle={() => flip("animations")}
          />
          <ToggleRow
            label="Reduce motion"
            hint="Every transition becomes instant; the live graphics stop moving"
            on={isOn("reduceMotion")}
            onToggle={() => flip("reduceMotion")}
          />
        </div>
      </HudPanel>

      <HudPanel title="Text and layout">
        <div className="grid gap-3 sm:grid-cols-2">
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
        </div>
        <div className="mt-4">
          <Choice
            label="Button labels"
            value={buttonLabels}
            options={BUTTON_LABEL_MODES}
            onChange={setField("buttonLabels")}
            icon={MousePointerClick}
          />
          <p className="mt-1 text-note text-muted-foreground">
            For compact icon controls in the chat, voice and toolbars. The name always stays in the
            accessible label and the tooltip.
          </p>
        </div>
        <div className="mt-4 space-y-3">
          <ToggleRow
            label="High contrast text"
            on={isOn("highContrast")}
            onToggle={() => flip("highContrast")}
          />
        </div>
      </HudPanel>

      <HudPanel title="Chat">
        <div className="grid gap-3 sm:grid-cols-2">
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
          <ToggleRow
            label="Show timestamps on chat messages"
            on={isOn("chatTimestamps")}
            onToggle={() => flip("chatTimestamps")}
          />
        </div>
      </HudPanel>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          onClick={() => {
            resetAppearancePreferences();
            void preferences.flush();
            toast.success("Appearance restored to shipped defaults");
          }}
        >
          <RotateCcw className="size-3.5" />
          Reset appearance
        </Button>
        <span className="text-meta-sm text-muted-foreground">
          Shipped defaults: Futuristic Glass, Balanced glass, labels on hover.
        </span>
      </div>
    </div>
  );
}
