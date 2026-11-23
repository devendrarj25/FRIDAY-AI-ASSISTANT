import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoadingState, ToggleRow } from "@/components/friday/ui";
import { ErrorState } from "@/components/friday/PageStates";
import { assistantMode } from "@/lib/friday/assistant-mode";
import { desktopApi } from "@/lib/friday/desktop";
import { NEURAL_VOICE_MODEL } from "@/lib/friday/model-catalog";
import { preferences, sanitizeSttSize, sanitizeTtsEngine } from "@/lib/friday/preferences";
import { listAudioDevices, type AudioDeviceInfo } from "@/lib/friday/voice-audio";
import {
  applySpeakerChoice,
  onSystemVoices,
  speakerFallbackNote,
} from "@/lib/friday/voice-library";
import { deviceOptions, planSavedDevice } from "@/lib/friday/voice-engine/audio-devices";
import {
  sttChoices,
  ttsChoices,
  type SpeechBudgetView,
} from "@/lib/friday/voice-engine/voice-choices";
import { useModels } from "@/lib/friday/use-models";
import { usePreferences } from "@/lib/friday/use-preferences";

const SELECT =
  "hud-tile mt-1 w-full rounded-ctl border border-primary/25 bg-transparent px-2.5 py-1.5 font-mono text-xs text-foreground";

type DeviceState =
  | { phase: "loading" }
  | { phase: "unsupported" }
  | { phase: "error"; error: unknown }
  | { phase: "ready"; inputs: AudioDeviceInfo[]; outputs: AudioDeviceInfo[] };

const enumerateSupported = () =>
  typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.enumerateDevices);

async function readDevices(): Promise<DeviceState> {
  if (!enumerateSupported()) return { phase: "unsupported" };
  try {
    const listed = await listAudioDevices();
    return { phase: "ready", inputs: listed.inputs, outputs: listed.outputs };
  } catch (error) {
    return { phase: "error", error };
  }
}

/**
 * Settings > Voice: the microphone, the speaker, the noise-suppression switch, the speech model and the voice engine.
 * Every row reads a stored key and every change is honoured: the input is reopened, the speaker is moved, the speech
 * size and the engine are read the next time a clause is heard or spoken. Device lists refresh from the system
 * (the browser's own devicechange event and the Refresh button), never from a timer.
 */
export function VoiceAudioPickers() {
  const prefs = usePreferences();
  const modelState = useModels();
  const router = useRouter({ warn: false });
  const [devices, setDevices] = useState<DeviceState>({ phase: "loading" });
  const [budget, setBudget] = useState<SpeechBudgetView | "offline">("offline");
  const [systemCount, setSystemCount] = useState<number | null>(null);
  const [notice, setNotice] = useState("");

  const refresh = useCallback(() => {
    setDevices({ phase: "loading" });
    void readDevices().then(setDevices);
  }, []);

  useEffect(() => {
    let live = true;
    const show = () =>
      void readDevices().then((next) => {
        if (live) setDevices(next);
      });
    show();
    const md = typeof navigator === "undefined" ? null : navigator.mediaDevices;
    md?.addEventListener?.("devicechange", show);
    return () => {
      live = false;
      md?.removeEventListener?.("devicechange", show);
    };
  }, []);

  useEffect(() => {
    let live = true;
    const read = desktopApi()?.voiceBudget;
    if (!read) return undefined;
    void read()
      .then((row) => {
        if (live && row?.ok)
          setBudget({ sttSize: row.sttSize, speechBudgetGb: row.speechBudgetGb });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => onSystemVoices((list) => setSystemCount(list.length)), []);

  const inputs = useMemo(() => (devices.phase === "ready" ? devices.inputs : []), [devices]);
  const outputs = useMemo(() => (devices.phase === "ready" ? devices.outputs : []), [devices]);
  const micPlan = planSavedDevice("microphone", prefs.voice.inputDeviceId, inputs);
  const speakerPlan = planSavedDevice("speaker", prefs.voice.outputDeviceId, outputs);
  const micRows = useMemo(
    () => deviceOptions("microphone", prefs.voice.inputDeviceId, inputs),
    [prefs.voice.inputDeviceId, inputs],
  );
  const speakerRows = useMemo(
    () => deviceOptions("speaker", prefs.voice.outputDeviceId, outputs),
    [prefs.voice.outputDeviceId, outputs],
  );
  const scanned = Boolean(modelState.lastScanAt);
  const stt = useMemo(
    () =>
      sttChoices({
        budget: budget === "offline" ? null : budget,
        installed: scanned ? modelState.installed : null,
      }),
    [budget, scanned, modelState.installed],
  );
  const tts = useMemo(
    () =>
      ttsChoices({
        localReady: scanned ? Boolean(modelState.installed[NEURAL_VOICE_MODEL]) : null,
        systemVoices: systemCount,
      }),
    [scanned, modelState.installed, systemCount],
  );
  const sttNow = stt.find((row) => row.value === prefs.voice.sttSize);
  const ttsNow = tts.find((row) => row.value === prefs.voice.ttsEngine);

  const pickMic = (id: string) => {
    preferences.setVoice({ inputDeviceId: id });
    void assistantMode.applyInputChoice();
  };
  const pickSpeaker = (id: string) => {
    preferences.setVoice({ outputDeviceId: id });
    void applySpeakerChoice().then(() => setNotice(speakerFallbackNote()));
  };
  const toggleNoise = () => {
    preferences.setVoice({ noiseSuppression: prefs.voice.noiseSuppression === false });
    void assistantMode.applyInputChoice();
  };

  return (
    <div className="space-y-3 sm:col-span-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-xs text-muted-foreground">
          Microphone, speaker, speech model and voice engine. Changes apply at once.
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={devices.phase === "loading"}
          title="Read the microphones and speakers plugged in now"
          onClick={refresh}
        >
          <RefreshCw className="mr-1.5 size-3.5" aria-hidden="true" />
          Refresh devices
        </Button>
      </div>

      {devices.phase === "loading" ? (
        <LoadingState label="Reading the microphones and speakers…" rows={2} />
      ) : null}
      {devices.phase === "error" ? (
        <ErrorState
          title="The microphones and speakers could not be listed"
          error={devices.error}
          onRetry={refresh}
        />
      ) : null}
      {devices.phase === "unsupported" ? (
        <p role="status" className="text-meta-sm text-muted-foreground">
          This window cannot list audio devices (the browser preview). The FRIDAY desktop app can;
          the system default microphone and speaker are used until then.
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="label-xs text-muted-foreground">Microphone</span>
          <select
            value={prefs.voice.inputDeviceId}
            onChange={(e) => pickMic(e.target.value)}
            className={SELECT}
          >
            {micRows.map((row) => (
              <option key={row.value || "default"} value={row.value} className="bg-background">
                {row.label}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-meta-sm text-muted-foreground">
            {devices.phase === "ready" && inputs.length === 0
              ? "No microphone was found. Plug one in; the list refreshes by itself."
              : micPlan.note ||
                "Reopened when you change it. While muted or paused it is read when the microphone opens."}
          </span>
        </label>
        <label className="block">
          <span className="label-xs text-muted-foreground">Speaker</span>
          <select
            value={prefs.voice.outputDeviceId}
            onChange={(e) => pickSpeaker(e.target.value)}
            className={SELECT}
          >
            {speakerRows.map((row) => (
              <option key={row.value || "default"} value={row.value} className="bg-background">
                {row.label}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-meta-sm text-muted-foreground">
            {devices.phase === "ready" && outputs.length === 0
              ? "No speaker list is available here; the system default plays."
              : speakerPlan.note ||
                notice ||
                "FRIDAY's voice plays here. The Windows system voice always uses the system default."}
          </span>
        </label>
      </div>

      <ToggleRow
        label="Noise suppression on the microphone"
        hint="The browser's own filter, on as FRIDAY has always opened the microphone. Switch it off for a studio or headset mic that is already clean. Hearing checks keep their own separate clean-up."
        on={prefs.voice.noiseSuppression !== false}
        onToggle={toggleNoise}
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="label-xs text-muted-foreground">Speech model size</span>
          <select
            value={prefs.voice.sttSize || "auto"}
            onChange={(e) => preferences.setVoice({ sttSize: sanitizeSttSize(e.target.value) })}
            className={SELECT}
          >
            {stt.map((row) => (
              <option key={row.value} value={row.value} className="bg-background">
                {row.label}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-meta-sm text-muted-foreground">
            {budget === "offline"
              ? "This PC's memory is read by the FRIDAY desktop app; sizes are listed without a fit until then."
              : "Memory counts the voice and helpers loaded beside it. Auto picks what this PC can carry."}
            {sttNow?.installed === false ? " This size is not downloaded yet." : ""}
          </span>
          {sttNow?.installed === false ? (
            <Button
              size="sm"
              variant="outline"
              className="mt-1"
              onClick={() => router?.navigate({ to: "/models" })}
            >
              Open Models to download it
            </Button>
          ) : null}
        </label>
        <label className="block">
          <span className="label-xs text-muted-foreground">Voice engine</span>
          <select
            value={prefs.voice.ttsEngine}
            onChange={(e) => preferences.setVoice({ ttsEngine: sanitizeTtsEngine(e.target.value) })}
            className={SELECT}
          >
            {tts.map((row) => (
              <option key={row.value} value={row.value} className="bg-background">
                {row.label}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-meta-sm text-muted-foreground">
            {ttsNow?.installed === false
              ? "Not installed on this PC yet, so FRIDAY will use the next voice until it is. "
              : ""}
            Privacy mode and private lines always keep the voice on this PC, whatever is picked.
          </span>
        </label>
      </div>
    </div>
  );
}
