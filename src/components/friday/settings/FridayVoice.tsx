import { toast } from "sonner";
import { Mic, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HudPanel } from "@/components/friday/ui";
import { TuneRow } from "@/components/friday/settings/fields";
import { assistantMode } from "@/lib/friday/assistant-mode";
import { preferences } from "@/lib/friday/preferences";
import { usePreferences } from "@/lib/friday/use-preferences";
import {
  applyVoicePreset,
  resetToBestVoice,
  setVoiceDelivery,
  speakSample,
} from "@/lib/friday/voice-library";
import {
  DEFAULT_ENGLISH_VOICE,
  DEFAULT_HINDI_VOICE,
  INDIAN_FEMALE_VOICES,
  PREVIEW_LINES,
  VOICE_PRESETS,
  detectPreset,
  pitchOffsetHz,
} from "@/lib/friday/voice-presets";

const SELECT =
  "hud-tile mt-1 w-full rounded-ctl border border-primary/25 bg-transparent px-2.5 py-1.5 font-mono text-xs text-foreground";

/**
 * Settings → Voice → FRIDAY's voice. One place for how FRIDAY sounds: a female Indian voice for Hindi and one for
 * English (she switches per sentence, so Hinglish is spoken by both), a delivery preset, the three sliders, and
 * preview buttons for Hindi, English and Hinglish. The shipped choice is Swara, Neerja and the natural preset.
 */
export function FridayVoice() {
  const prefs = usePreferences();
  const voice = prefs.voice;
  const hindi = INDIAN_FEMALE_VOICES.filter((row) => row.lang === "hi-IN");
  const english = INDIAN_FEMALE_VOICES.filter((row) => row.lang === "en-IN");
  const hindiVoice = voice.hindiVoice || DEFAULT_HINDI_VOICE;
  const englishVoice = voice.englishVoice || DEFAULT_ENGLISH_VOICE;
  const current = detectPreset(voice);

  const pick = (kind: "hindi" | "english", id: string) => {
    preferences.setVoice(kind === "hindi" ? { hindiVoice: id } : { englishVoice: id });
    // A library voice picked earlier would still win for its own language; the owner just chose a different one.
    const active = (voice.models ?? []).find((model) => model.id === voice.activeId);
    if (active?.kind === "neural" && active.voiceName !== id) {
      const sameLanguage =
        kind === "hindi" ? active.lang.startsWith("hi") : active.lang.startsWith("en");
      if (sameLanguage) preferences.setVoice({ activeId: "" });
    }
  };

  const preview = (line: string, lang: string, name: string) => {
    if (assistantMode.getSnapshot().mode !== "auto") {
      toast.error("FRIDAY speaks only in Auto mode");
      return;
    }
    const ok = speakSample(line, {
      voiceName: name,
      lang,
      rate: voice.rate,
      pitch: voice.pitch,
      volume: voice.volume,
    });
    if (!ok) toast.error("Speech synthesis is unavailable on this machine");
  };

  return (
    <HudPanel title="FRIDAY's voice" hint="a female Indian voice for Hindi and English">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="label-xs text-muted-foreground">Hindi voice</span>
          <select
            value={hindiVoice}
            onChange={(event) => pick("hindi", event.target.value)}
            className={SELECT}
            aria-label="Hindi voice"
          >
            {hindi.map((row) => (
              <option key={row.id} value={row.id} className="bg-background">
                {row.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="label-xs text-muted-foreground">English voice</span>
          <select
            value={englishVoice}
            onChange={(event) => pick("english", event.target.value)}
            className={SELECT}
            aria-label="English voice"
          >
            {english.map((row) => (
              <option key={row.id} value={row.id} className="bg-background">
                {row.label}
              </option>
            ))}
          </select>
        </label>
        <p className="text-meta-sm text-muted-foreground sm:col-span-2">
          She picks the voice sentence by sentence, so a Hinglish reply is spoken by the Hindi voice
          for Devanagari and by the English voice for English words.{" "}
          {INDIAN_FEMALE_VOICES.find((row) => row.id === hindiVoice)?.note}{" "}
          {INDIAN_FEMALE_VOICES.find((row) => row.id === englishVoice)?.note} These are online
          neural voices (they need the network and Privacy mode off). Offline she speaks with the
          on-device voice, and with a Windows voice if that is missing; the voice library below adds
          more.
        </p>
      </div>

      <div className="mt-3">
        <p className="label-xs text-muted-foreground">Delivery</p>
        <div className="mt-1 flex flex-wrap gap-2">
          {VOICE_PRESETS.map((preset) => (
            <Button
              key={preset.id}
              size="sm"
              variant={current === preset.id ? "default" : "outline"}
              title={preset.hint}
              onClick={() => applyVoicePreset(preset.id)}
            >
              {preset.label}
            </Button>
          ))}
          <span className="self-center text-meta-sm text-muted-foreground">
            {current === "custom"
              ? "Custom: the sliders were moved."
              : VOICE_PRESETS.find((row) => row.id === current)?.hint}
          </span>
        </div>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <TuneRow
          label="Speaking rate"
          value={voice.rate}
          min={0.5}
          max={2}
          detail={`${voice.rate.toFixed(2)}x`}
          onChange={(rate) => setVoiceDelivery({ rate })}
        />
        <TuneRow
          label="Pitch"
          value={voice.pitch}
          min={0.7}
          max={1.3}
          detail={`${voice.pitch.toFixed(2)} (${pitchOffsetHz(voice.pitch) >= 0 ? "+" : ""}${pitchOffsetHz(voice.pitch)} Hz)`}
          onChange={(pitch) => setVoiceDelivery({ pitch })}
        />
        <TuneRow
          label="Volume"
          value={voice.volume}
          min={0}
          max={1}
          detail={`${Math.round(voice.volume * 100)}%`}
          onChange={(volume) => setVoiceDelivery({ volume })}
        />
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => preview(PREVIEW_LINES.hi, "hi-IN", hindiVoice)}
        >
          <Mic className="size-4" /> Hear Hindi
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => preview(PREVIEW_LINES.en, "en-IN", englishVoice)}
        >
          <Mic className="size-4" /> Hear English
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => preview(PREVIEW_LINES.hinglish, "hi-IN", "")}
        >
          <Mic className="size-4" /> Hear Hinglish
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            resetToBestVoice();
            void preferences.flush();
            toast.success("FRIDAY's voice is back to Swara, Neerja and the natural delivery");
          }}
        >
          <RotateCcw className="size-4" /> Reset to the best voice
        </Button>
      </div>
    </HudPanel>
  );
}
