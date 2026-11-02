/**
 * Settings · Fonts and text.
 *
 * Every font and text setting in one panel, with a preview that shows the real thing: the heading font, the body
 * font in English and Hindi, small text, code, and a chat bubble at the chat size. The fonts are bundled with the
 * app (src/lib/friday/fonts.ts), so none of them is downloaded. A setting left at its default changes nothing.
 */
import { RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { HudPanel } from "@/components/friday/ui";
import { SelectField } from "@/components/friday/settings/fields";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import {
  BODY_FONTS,
  CHAT_TEXT_SIZES,
  CODE_FONTS,
  DISPLAY_FONTS,
  LETTER_SPACINGS,
  LINE_SPACINGS,
  SMALL_TEXT_MODES,
  TEXT_SCALE_MAX,
  TEXT_SCALE_MIN,
  TEXT_SIZES,
  TEXT_WEIGHTS,
  resetTextPreferences,
  resolveTextScale,
} from "@/lib/friday/appearance";
import { preferences } from "@/lib/friday/preferences";
import { usePreferences } from "@/lib/friday/use-preferences";

const options = (names: readonly string[]) => names.map((name) => ({ value: name, label: name }));

export function FontsAndTextSettings() {
  const prefs = usePreferences();
  const field = (key: string) => prefs.fields[key] ?? "";
  const setField = (key: string) => (value: string) => preferences.setField(key, value);
  const scale = resolveTextScale(prefs.fields);

  return (
    <HudPanel title="Fonts and text" hint="size, spacing, weight and fonts">
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          label="UI / heading font"
          value={field("font") || "Orbitron"}
          options={options(Object.keys(DISPLAY_FONTS))}
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
          label="Code font"
          value={field("codeFont") || "JetBrains Mono"}
          options={options(Object.keys(CODE_FONTS))}
          onChange={setField("codeFont")}
        />
        <SelectField
          label="Text size"
          value={field("textSize") || "Normal"}
          options={options(TEXT_SIZES)}
          onChange={(value) => {
            // Picking a named size ends a custom size, so the choice the owner just made is the one shown.
            preferences.setField("textSize", value);
            preferences.setField("textScale", "");
          }}
        />
        <SelectField
          label="Chat text size"
          value={field("chatTextSize") || "Match"}
          options={options(Object.keys(CHAT_TEXT_SIZES))}
          onChange={setField("chatTextSize")}
        />
        <SelectField
          label="Small text"
          value={field("smallText") || "Standard"}
          options={options(SMALL_TEXT_MODES)}
          onChange={setField("smallText")}
        />
        <SelectField
          label="Line spacing"
          value={field("lineSpacing") || "Normal"}
          options={options(Object.keys(LINE_SPACINGS))}
          onChange={setField("lineSpacing")}
        />
        <SelectField
          label="Letter spacing"
          value={field("letterSpacing") || "Normal"}
          options={options(Object.keys(LETTER_SPACINGS))}
          onChange={setField("letterSpacing")}
        />
        <SelectField
          label="Text weight"
          value={field("textWeight") || "Regular"}
          options={options(Object.keys(TEXT_WEIGHTS))}
          onChange={setField("textWeight")}
        />
      </div>

      <label className="mt-4 block">
        <span className="label-xs text-muted-foreground">
          Fine text size · {scale.percent}%{scale.custom ? "" : " (named size)"}
        </span>
        <Slider
          className="mt-3"
          min={TEXT_SCALE_MIN}
          max={TEXT_SCALE_MAX}
          step={5}
          aria-label="Fine text size"
          value={[scale.percent]}
          onValueChange={(value) =>
            preferences.setField("textScale", String(value[0] ?? scale.percent))
          }
        />
      </label>

      <div
        className="mt-4 space-y-2 rounded-surface border border-primary/20 bg-card/60 p-3"
        aria-label="Live preview of the text settings"
      >
        <p className="font-display text-sm font-bold uppercase tracking-wider text-primary">
          FRIDAY · Heading font
        </p>
        <p className="text-sm text-foreground">
          The quick brown fox jumps over the lazy dog. 0123456789 · नमस्ते, आज का काम क्या है?
        </p>
        <p className="text-meta text-muted-foreground">Small text: last checked a minute ago</p>
        <p className="text-meta-sm text-muted-foreground">Smallest text: model · 12 ms · local</p>
        <pre className="overflow-x-auto rounded-ctl bg-background/60 p-2 font-mono text-note text-foreground">
          {"const reply = await friday.ask('hello');"}
        </pre>
        <div style={{ zoom: "var(--friday-chat-scale, 1)" }}>
          <p className="bubble-friday w-fit max-w-full px-3 py-2 text-sm">
            This is how a chat bubble reads at the chat text size.
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          onClick={() => {
            preferences.setField("font", "Orbitron");
            preferences.setField("bodyFont", "Rajdhani");
            preferences.setField("textSize", "Normal");
            resetTextPreferences();
            void preferences.flush();
            toast.success("Text settings restored to their defaults");
          }}
        >
          <RotateCcw className="size-3.5" />
          Reset text settings
        </Button>
        <span className="text-meta-sm text-muted-foreground">
          Every font is bundled with the app, so nothing is downloaded and they look the same
          offline.
        </span>
      </div>
    </HudPanel>
  );
}
