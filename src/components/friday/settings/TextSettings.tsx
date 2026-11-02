/**
 * Settings · Fonts & Text: the whole section. Every font and text control lives here and nowhere else:
 * the fonts, sizes, spacing and weight with their live preview, and the settings that decide how text is read
 * (High contrast text, chat bubbles, chat timestamps). Each one is applied by src/lib/friday/appearance.ts.
 */
import { HudPanel, ToggleRow } from "@/components/friday/ui";
import { FontsAndTextSettings } from "@/components/friday/settings/FontsAndTextSettings";
import { SelectField } from "@/components/friday/settings/fields";
import { preferences } from "@/lib/friday/preferences";
import { usePreferences } from "@/lib/friday/use-preferences";

export function TextSettings() {
  const prefs = usePreferences();
  const isOn = (key: string) => prefs.toggles[key] === true;
  const flip = (key: string) => preferences.setToggle(key, !isOn(key));
  const field = (key: string) => prefs.fields[key] ?? "";

  return (
    <div className="space-y-4">
      <FontsAndTextSettings />

      <HudPanel title="Reading" hint="contrast, chat bubbles and time stamps">
        <div className="space-y-3">
          <ToggleRow
            label="High contrast text"
            hint="Brighter text and stronger edges on the dark themes"
            on={isOn("highContrast")}
            onToggle={() => flip("highContrast")}
          />
          <ToggleRow
            label="Show timestamps on chat messages"
            on={isOn("chatTimestamps")}
            onToggle={() => flip("chatTimestamps")}
          />
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <SelectField
            label="Chat bubble style"
            value={field("bubbleStyle") || "Compact"}
            options={["Compact", "Comfortable", "Full"].map((name) => ({
              value: name,
              label: name,
            }))}
            onChange={(value) => preferences.setField("bubbleStyle", value)}
          />
        </div>
        <p className="mt-3 text-note text-muted-foreground">
          The chat text size above also sizes the voice captions in Auto mode.
        </p>
      </HudPanel>
    </div>
  );
}
