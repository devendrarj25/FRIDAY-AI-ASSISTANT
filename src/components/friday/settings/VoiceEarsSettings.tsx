import { useEffect, useMemo, useState } from "react";
import { RefreshCw, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoadingState, ToggleRow } from "@/components/friday/ui";
import { ErrorState } from "@/components/friday/PageStates";
import { TuneRow } from "@/components/friday/settings/fields";
import { desktopApi } from "@/lib/friday/desktop";
import {
  DEFAULT_VOICE_EARS,
  EARS_AGC_PICKS,
  EARS_DENOISE_PICKS,
  EARS_EAGERNESS_PICKS,
  EARS_OTHER_VOICE_PICKS,
  EARS_SCENE_PICKS,
  EARS_VAD_PICKS,
  preferences,
  sanitizeVoiceEars,
  type VoiceEarsPrefs,
} from "@/lib/friday/preferences";
import { usePreferences } from "@/lib/friday/use-preferences";
import { earsRows, type EarsStats } from "@/lib/friday/voice-diagnostics-rows";

const SELECT =
  "hud-tile mt-1 w-full rounded-ctl border border-primary/25 bg-transparent px-2.5 py-1.5 font-mono text-xs text-foreground";

type StatsState =
  | { phase: "loading" }
  | { phase: "offline" }
  | { phase: "error"; error: unknown }
  | { phase: "ready"; stats: EarsStats | null };

/** The words for each pick. Plain, and each says what it does, not what it is worth. */
const AGC_LABELS: Record<VoiceEarsPrefs["agc"], string> = {
  browser: "The browser levels the volume (as today)",
  own: "FRIDAY levels the volume (slow, speech only)",
  off: "No volume levelling",
};
const VAD_LABELS: Record<VoiceEarsPrefs["vad"], string> = {
  auto: "Automatic (the small model when it is installed)",
  silero: "The small speech model",
  energy: "Loudness only",
};
const EAGERNESS_LABELS: Record<VoiceEarsPrefs["eagerness"], string> = {
  eager: "Quick: takes the turn after a short pause",
  normal: "Normal",
  patient: "Patient: waits through long pauses",
};
const DENOISE_LABELS: Record<VoiceEarsPrefs["denoise"], string> = {
  off: "Off (hear the plain sound)",
  rnnoise: "RNNoise",
  gtcrn: "GTCRN (very small)",
  dpdfnet2: "DPDFNet 2",
};
const SCENE_LABELS: Record<VoiceEarsPrefs["scene"], string> = {
  off: "Off",
  score: "Score the room (speech, music, TV, noise)",
};
const OTHER_VOICE_LABELS: Record<VoiceEarsPrefs["otherVoice"], string> = {
  off: "Off",
  score: "Score only",
  hold: "Score, and hold sensitive orders from another voice",
};

function PickRow<T extends string>({
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
  return (
    <label className="block">
      <span className="label-xs text-muted-foreground">{label}</span>
      <select value={value} onChange={(e) => onPick(e.target.value as T)} className={SELECT}>
        {picks.map((pick) => (
          <option key={pick} value={pick} className="bg-background">
            {words[pick]}
          </option>
        ))}
      </select>
      <span className="mt-1 block text-meta-sm text-muted-foreground">{hint}</span>
    </label>
  );
}

/**
 * Settings > Voice > Listening front end. Every control writes one key of `voice.ears` (clamped by
 * `sanitizeVoiceEars`) and is saved at once. Below the controls the same rows the Doctor shows say what was really
 * measured; with no measurement a row says "absent" instead of a number. Measurements come from `readStats` when the
 * listening path supplies one, never from a timer here.
 */
export function VoiceEarsSettings({ readStats }: { readStats?: () => Promise<EarsStats | null> }) {
  const prefs = usePreferences();
  const ears = prefs.voice.ears;
  const reads = Boolean(readStats) && Boolean(desktopApi());
  const [state, setState] = useState<StatsState>(() =>
    !desktopApi()
      ? { phase: "offline" }
      : readStats
        ? { phase: "loading" }
        : { phase: "ready", stats: null },
  );
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!readStats || !reads) return undefined;
    let live = true;
    readStats().then(
      (stats) => {
        if (live) setState({ phase: "ready", stats });
      },
      (error: unknown) => {
        if (live) setState({ phase: "error", error });
      },
    );
    return () => {
      live = false;
    };
  }, [readStats, reads, attempt]);

  const reload = () => {
    setState({ phase: "loading" });
    setAttempt((n) => n + 1);
  };

  const rows = useMemo(
    () => earsRows(ears, state.phase === "ready" ? state.stats : null),
    [ears, state],
  );

  const set = (patch: Partial<VoiceEarsPrefs>) =>
    preferences.setVoice({ ears: sanitizeVoiceEars({ ...ears, ...patch }) });
  const endMax = Math.round((ears.vadStart - 0.05) * 100) / 100;

  return (
    <div className="space-y-3 sm:col-span-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm text-foreground">Listening front end</p>
          <p className="text-meta-sm text-muted-foreground">
            How FRIDAY cleans up and listens to the microphone before the words are read. Changes
            are saved at once and read by the listening path. Not yet tried on a real microphone, so
            nothing here is a promise of better hearing; the measurements below say what was seen.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          title="Put every listening front end setting back to what FRIDAY ships"
          onClick={() => preferences.setVoice({ ears: { ...DEFAULT_VOICE_EARS } })}
        >
          <RotateCcw className="mr-1.5 size-3.5" aria-hidden="true" />
          Reset these settings
        </Button>
      </div>

      <ToggleRow
        label="Cut rumble and hum below 80 Hz"
        hint="A gentle filter for fan hum, desk thumps and DC offset. It removes no speech; its effect on recognition is not measured."
        on={ears.hpf}
        onToggle={() => set({ hpf: !ears.hpf })}
      />
      <ToggleRow
        label="Warn when the microphone is clipping"
        hint="A meter only: it shows in Voice diagnostics when the sound hits the top of the range. It changes no audio."
        on={ears.clipWarn}
        onToggle={() => set({ clipWarn: !ears.clipWarn })}
      />
      <ToggleRow
        label="Start the answer at a likely end of turn"
        hint="Streaming ear only. A draft starts when you probably finished and is thrown away if you keep talking. It uses a little more work; the browser noise filter stays as set above."
        on={ears.eagerTurn}
        onToggle={() => set({ eagerTurn: !ears.eagerTurn })}
      />
      <ToggleRow
        label="Use the PC's own playback as the echo reference"
        hint="Experimental and off until tried on this PC. It can only help when her voice plays through this PC; it does nothing for another speaker."
        on={ears.pcAudioRef}
        onToggle={() => set({ pcAudioRef: !ears.pcAudioRef })}
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <PickRow
          label="Volume levelling"
          hint="FRIDAY's own leveller moves only while you speak and never boosts silence. Switching to it turns the browser's own off."
          value={ears.agc}
          picks={EARS_AGC_PICKS}
          words={AGC_LABELS}
          onPick={(agc) => set({ agc })}
        />
        <PickRow
          label="Speech detector"
          hint="Decides when you start and stop talking. The small model needs its download (Models page); without it, loudness is used."
          value={ears.vad}
          picks={EARS_VAD_PICKS}
          words={VAD_LABELS}
          onPick={(vad) => set({ vad })}
        />
        <PickRow
          label="Turn taking"
          hint="How long she waits after a pause before she takes the turn. Quick may cut you off; patient answers later."
          value={ears.eagerness}
          picks={EARS_EAGERNESS_PICKS}
          words={EAGERNESS_LABELS}
          onPick={(eagerness) => set({ eagerness })}
        />
        <PickRow
          label="Noise clean-up copy"
          hint="A cleaned copy goes to the speech model only; the plain sound is still used for detection. A clean-up can also hurt, so it is off until you judge it on your voice. Each needs its model."
          value={ears.denoise}
          picks={EARS_DENOISE_PICKS}
          words={DENOISE_LABELS}
          onPick={(denoise) => set({ denoise })}
        />
        <PickRow
          label="Room score"
          hint="Guesses whether the room is speech, music, TV or noise and then asks for a little more certainty. A score only; it never approves an action."
          value={ears.scene}
          picks={EARS_SCENE_PICKS}
          words={SCENE_LABELS}
          onPick={(scene) => set({ scene })}
        />
        <PickRow
          label="Other voices"
          hint="Compares a voice with your saved voice (Settings, voice enrolment). A match never approves anything; it only adds care."
          value={ears.otherVoice}
          picks={EARS_OTHER_VOICE_PICKS}
          words={OTHER_VOICE_LABELS}
          onPick={(otherVoice) => set({ otherVoice })}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <TuneRow
          label="Speech starts at"
          value={ears.vadStart}
          min={0.2}
          max={0.9}
          step={0.05}
          detail={ears.vadStart.toFixed(2)}
          onChange={(vadStart) => set({ vadStart })}
        />
        <TuneRow
          label="Speech ends below"
          value={Math.min(ears.vadEnd, endMax)}
          min={0.05}
          max={Math.max(0.1, endMax)}
          step={0.05}
          detail={ears.vadEnd.toFixed(2)}
          onChange={(vadEnd) => set({ vadEnd })}
        />
        <TuneRow
          label="Shortest sound that counts"
          value={ears.minSpeechMs}
          min={60}
          max={400}
          step={10}
          detail={`${ears.minSpeechMs} ms`}
          onChange={(minSpeechMs) => set({ minSpeechMs })}
        />
        <TuneRow
          label="Sound kept before speech"
          value={ears.preRollMs}
          min={200}
          max={1000}
          step={50}
          detail={`${ears.preRollMs} ms`}
          onChange={(preRollMs) => set({ preRollMs })}
        />
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="label-xs text-muted-foreground">What was measured</p>
          <Button
            size="sm"
            variant="outline"
            disabled={state.phase === "loading" || !reads}
            title="Read the listening measurements again"
            onClick={reload}
          >
            <RefreshCw className="mr-1.5 size-3.5" aria-hidden="true" />
            Refresh measurements
          </Button>
        </div>
        {state.phase === "loading" ? (
          <LoadingState label="Reading the listening measurements…" rows={2} />
        ) : null}
        {state.phase === "error" ? (
          <ErrorState
            title="The listening measurements could not be read"
            error={state.error}
            onRetry={reload}
          />
        ) : null}
        {state.phase === "offline" ? (
          <p role="status" className="text-meta-sm text-muted-foreground">
            Measurements are read by the FRIDAY desktop app; this window only shows your settings.
          </p>
        ) : null}
        {state.phase === "ready" || state.phase === "offline" ? (
          <dl className="space-y-1">
            {rows.map((row) => (
              <div key={row.id} className="grid gap-0.5 sm:grid-cols-[14rem_minmax(0,1fr)]">
                <dt className="text-meta-sm text-muted-foreground">{row.label}</dt>
                <dd
                  className={
                    row.bad ? "text-meta-sm text-destructive" : "text-meta-sm text-foreground"
                  }
                >
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
    </div>
  );
}
