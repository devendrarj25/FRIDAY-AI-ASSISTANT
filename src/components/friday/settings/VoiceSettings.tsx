import { useEffect, useState } from "react";
import { toast } from "sonner";
import { HardDriveDownload, Mic, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HudPanel, StatusPill, ToggleRow } from "@/components/friday/ui";
import { EditField, TuneRow } from "@/components/friday/settings/fields";
import { desktopApi } from "@/lib/friday/desktop";
import {
  ownerAcceptanceSteps,
  voiceReadinessNote,
  voiceSelfTestPlan,
} from "@/lib/friday/voice-doctor";
import { preferences } from "@/lib/friday/preferences";
import { usePreferences } from "@/lib/friday/use-preferences";
import { assistantMode } from "@/lib/friday/assistant-mode";
import { useAssistantMode } from "@/lib/friday/use-assistant-mode";
import { attentionWindowSeconds, clampAttentionSeconds } from "@/lib/friday/attention-window";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import {
  activeVoiceSettings,
  addNeuralVoice,
  addSystemVoice,
  installNeuralVoice,
  listNeuralVoices,
  neuralVoiceStatus,
  type NeuralVoice,
  importVoiceFile,
  onSystemVoices,
  removeVoiceModel,
  selectVoiceModel,
  speakSample,
  updateVoiceModel,
} from "@/lib/friday/voice-library";

const RECOGNITION_LANGS = [
  { value: "hi-IN", label: "Hindi (India)" },
  { value: "en-IN", label: "English (India)" },
  { value: "en-US", label: "English (US)" },
];

export function VoiceSettings() {
  const prefs = usePreferences();
  const voice = useAssistantMode();
  const [busy, setBusy] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);

  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) return;
    void navigator.mediaDevices
      .enumerateDevices()
      .then((list) => setDevices(list.filter((d) => d.kind === "audioinput")))
      .catch(() => setDevices([]));
  }, []);

  return (
    <div className="space-y-4">
      <HudPanel title="Voice & Wake Word" hint="used by auto mode in the title bar">
        <div className="grid gap-3 sm:grid-cols-2">
          <EditField
            label="Wake word"
            value={prefs.voice.wakeWord}
            onChange={(v) => preferences.setVoice({ wakeWord: v })}
          />
          <label className="block">
            <span className="label-xs text-muted-foreground">Recognition language</span>
            <select
              value={prefs.voice.recognitionLang}
              onChange={(e) => preferences.setVoice({ recognitionLang: e.target.value })}
              className="hud-tile mt-1 w-full rounded-sm border border-primary/25 bg-transparent px-2.5 py-1.5 font-mono text-xs text-foreground"
            >
              {RECOGNITION_LANGS.map((lang) => (
                <option key={lang.value} value={lang.value} className="bg-background">
                  {lang.label}
                </option>
              ))}
            </select>
          </label>
          <EditField
            label="Reply language"
            value={prefs.voice.speechLang}
            onChange={(v) => preferences.setVoice({ speechLang: v })}
          />
          <EditField
            label="Voice"
            value={prefs.voice.voiceName}
            onChange={(v) => preferences.setVoice({ voiceName: v })}
          />
          <label className="block sm:col-span-2">
            <span className="label-xs text-muted-foreground">Microphone</span>
            <select
              value={prefs.voice.inputDeviceId}
              onChange={(e) => preferences.setVoice({ inputDeviceId: e.target.value })}
              className="hud-tile mt-1 w-full rounded-sm border border-primary/25 bg-transparent px-2.5 py-1.5 font-mono text-xs text-foreground"
            >
              <option value="" className="bg-background">
                System default
              </option>
              {devices.map((device) => (
                <option key={device.deviceId} value={device.deviceId} className="bg-background">
                  {device.label || `Microphone ${device.deviceId.slice(0, 8)}`}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-4 space-y-3">
          <ToggleRow
            label="Speak FRIDAY's replies out loud in auto mode"
            on={prefs.voice.speakReplies}
            onToggle={() => preferences.setVoice({ speakReplies: !prefs.voice.speakReplies })}
          />
          <ToggleRow
            label="Reply in natural Hindi–English mix (Hinglish)"
            on={prefs.voice.hinglish}
            onToggle={() => preferences.setVoice({ hinglish: !prefs.voice.hinglish })}
          />
          <ToggleRow
            label="Hands-free (talk without the wake word)"
            on={voice.handsFree}
            onToggle={() => assistantMode.setHandsFree(!voice.handsFree)}
          />
          <ToggleRow
            label="Mute microphone"
            on={voice.paused}
            onToggle={() => assistantMode.setPaused(!voice.paused)}
          />
          <EditField
            label="Speaker match threshold"
            value={prefs.fields["speakerThreshold"] ?? "0.75"}
            onChange={(value) => preferences.setField("speakerThreshold", value)}
          />
          <p className="font-mono text-[11px] text-muted-foreground">
            WeSpeaker ECAPA is CC-BY-4.0 and is not bundled. A match never approves an action. Enrol
            waits until that file is on this PC.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const api = desktopApi();
                if (!api?.voiceprintStatus) {
                  toast.message("The speaker model is not on disk");
                  return;
                }
                void api.voiceprintStatus().then((row) => {
                  toast.message(row?.reason || "The speaker model is not on disk");
                });
              }}
            >
              Enrol voiceprint
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const api = desktopApi();
                if (!api?.clearVoiceprint) {
                  toast.error("Forget voiceprint runs in the desktop app");
                  return;
                }
                void api.clearVoiceprint().then(() => toast.success("Voiceprint forgotten"));
              }}
            >
              Forget voiceprint
            </Button>
          </div>
          <ToggleRow
            label="Lower other audio while FRIDAY speaks"
            hint="Quiet hours leave other apps alone. A voice match never approves an action."
            on={prefs.voice.duckOthers !== false}
            onToggle={() => preferences.setVoice({ duckOthers: prefs.voice.duckOthers === false })}
          />
          <ToggleRow
            label="Quiet voice"
            hint="FRIDAY speaks more softly. Permissions stay the same."
            on={prefs.voice.whisperMode === true}
            onToggle={() => preferences.setVoice({ whisperMode: prefs.voice.whisperMode !== true })}
          />
          <ToggleRow
            label="Keep speech on this PC"
            hint="A Neural voice stays unused. Local speech or the system voice speaks."
            on={prefs.voice.privacyMode === true}
            onToggle={() => preferences.setVoice({ privacyMode: prefs.voice.privacyMode !== true })}
          />
          <ToggleRow
            label="Pause listening during calls"
            hint="Teams, Zoom, Webex, and Skype. FRIDAY does not speak over the call."
            on={prefs.voice.pauseDuringCalls !== false}
            onToggle={() =>
              preferences.setVoice({ pauseDuringCalls: prefs.voice.pauseDuringCalls === false })
            }
          />
          <label className="block">
            <span className="label-xs text-muted-foreground">Speech model size</span>
            <select
              value={prefs.voice.sttSize || "auto"}
              onChange={(e) =>
                preferences.setVoice({
                  sttSize: e.target.value as typeof prefs.voice.sttSize,
                })
              }
              className="hud-tile mt-1 w-full rounded-sm border border-primary/25 bg-transparent px-2.5 py-1.5 font-mono text-xs text-foreground"
            >
              <option value="auto" className="bg-background">
                Auto
              </option>
              <option value="tiny" className="bg-background">
                Tiny
              </option>
              <option value="base" className="bg-background">
                Base
              </option>
              <option value="small" className="bg-background">
                Small
              </option>
              <option value="medium" className="bg-background">
                Medium
              </option>
              <option value="large-v3" className="bg-background">
                Large
              </option>
            </select>
          </label>
          <label className="block">
            <span className="label-xs text-muted-foreground">Talkativeness</span>
            <select
              value={prefs.fields["talk"] || "balanced"}
              onChange={(e) => preferences.update({ fields: { talk: e.target.value } })}
              className="hud-tile mt-1 w-full rounded-sm border border-primary/25 bg-transparent px-2.5 py-1.5 font-mono text-xs text-foreground"
            >
              <option value="reserved" className="bg-background">
                Reserved
              </option>
              <option value="balanced" className="bg-background">
                Balanced
              </option>
              <option value="chatty" className="bg-background">
                Chatty
              </option>
            </select>
          </label>
          <label className="block">
            <span className="label-xs text-muted-foreground">Warmth</span>
            <select
              value={prefs.fields["warmth"] || "steady"}
              onChange={(e) => preferences.update({ fields: { warmth: e.target.value } })}
              className="hud-tile mt-1 w-full rounded-sm border border-primary/25 bg-transparent px-2.5 py-1.5 font-mono text-xs text-foreground"
            >
              <option value="plain" className="bg-background">
                Plain
              </option>
              <option value="steady" className="bg-background">
                Steady
              </option>
              <option value="warm" className="bg-background">
                Warm
              </option>
            </select>
          </label>
          <div className="block sm:col-span-2">
            <p className="label-xs text-muted-foreground">Voice check</p>
            <p className="mt-1 font-mono text-[11px] text-muted-foreground">
              {voiceSelfTestPlan().join(" → ")}. This page does not open the microphone. The live
              check runs in Auto mode.
            </p>
            <ol className="mt-2 list-decimal space-y-1 pl-4 font-mono text-[11px] text-muted-foreground">
              {ownerAcceptanceSteps().map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <p className="mt-2 font-mono text-[11px] text-muted-foreground">
              {voiceReadinessNote("").includes("Flow resume")
                ? "A simulated clean PC reaches listening again. This page still does not open the microphone."
                : "The simulated voice flow did not finish. Doctor has the detail."}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                className="hud-tile rounded-sm border border-primary/25 bg-transparent px-2.5 py-1.5 font-mono text-xs text-foreground"
                onClick={() =>
                  void desktopApi()?.openExternalUrl?.("ms-settings:privacy-microphone")
                }
              >
                Windows microphone privacy
              </button>
              <button
                type="button"
                className="hud-tile rounded-sm border border-primary/25 bg-transparent px-2.5 py-1.5 font-mono text-xs text-foreground"
                onClick={() => void desktopApi()?.openExternalUrl?.("ms-settings:sound")}
              >
                Sound input settings
              </button>
            </div>
          </div>
          <EditField
            label="Address name"
            value={prefs.voice.addressName || ""}
            onChange={(v) => preferences.setVoice({ addressName: v })}
          />
          <button
            type="button"
            className="hud-tile rounded-sm border border-primary/25 bg-transparent px-2.5 py-1.5 text-left font-mono text-xs text-foreground"
            onClick={() => {
              const api = (window as unknown as { friday?: { clearVoiceprint?: () => void } })
                .friday;
              void api?.clearVoiceprint?.();
            }}
          >
            Delete voice data
          </button>
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <p className="label-xs text-muted-foreground">Attention window after wake</p>
              <span className="font-mono text-[11px] text-primary">
                {attentionWindowSeconds()} s
              </span>
            </div>
            <Slider
              min={10}
              max={300}
              step={5}
              value={[attentionWindowSeconds()]}
              onValueChange={(next) =>
                preferences.setField(
                  "attentionWindow",
                  String(clampAttentionSeconds(Number(next[0] ?? 45))),
                )
              }
              onValueCommit={() => void preferences.flush()}
            />
          </div>
          <TuneRow
            label="Speaking rate"
            value={prefs.voice.rate}
            min={0.5}
            max={2}
            detail={`${prefs.voice.rate.toFixed(2)}x`}
            onChange={(rate) => preferences.setVoice({ rate })}
          />
          <TuneRow
            label="Pitch"
            value={prefs.voice.pitch}
            min={0}
            max={2}
            detail={prefs.voice.pitch.toFixed(2)}
            onChange={(pitch) => preferences.setVoice({ pitch })}
          />
          <TuneRow
            label="Volume"
            value={prefs.voice.volume}
            min={0}
            max={1}
            detail={`${Math.round(prefs.voice.volume * 100)}%`}
            onChange={(volume) => preferences.setVoice({ volume })}
          />
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (assistantMode.getSnapshot().mode !== "auto") {
                toast.error("FRIDAY speaks only in Auto mode");
                return;
              }
              const tuning = activeVoiceSettings();
              if (!speakSample("Namaste, main FRIDAY hoon.", tuning)) {
                toast.error("Speech synthesis is unavailable on this machine");
                return;
              }
              toast.success(`Speaking with ${tuning.voiceName || "the default voice"}`);
            }}
          >
            <Mic className="size-4" /> Test voice
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              preferences.setVoice({
                wakeWord: "friday",
                recognitionLang: "hi-IN",
                speechLang: "hi-IN",
                voiceName: "Microsoft Swara Online (Natural) - Hindi (India)",
                rate: 0.96,
                pitch: 1.12,
                volume: 1,
                speakReplies: true,
                hinglish: true,
              });
              assistantMode.setHandsFree(true);
              assistantMode.setMuted(false);
              assistantMode.setPaused(false);
              void preferences.flush();
              toast.success("Voice defaults restored (library kept)");
            }}
          >
            Reset voice defaults
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void preferences
                .flush()
                .then(() => toast.success("Voice settings saved"))
                .catch((error) =>
                  toast.error(
                    `Could not save voice settings — ${String((error as Error).message ?? error)}`,
                  ),
                )
                .finally(() => setBusy(false));
            }}
          >
            <Save className="size-4" /> Save voice settings
          </Button>
        </div>
      </HudPanel>
      <VoiceLibraryPanel />
    </div>
  );
}

function VoiceLibraryPanel() {
  const prefs = usePreferences();
  const [installed, setInstalled] = useState<SpeechSynthesisVoice[]>([]);
  const [picked, setPicked] = useState("");
  const [importing, setImporting] = useState(false);
  const [neural, setNeural] = useState<NeuralVoice[]>([]);
  const [neuralReason, setNeuralReason] = useState("");
  const [installingNeural, setInstallingNeural] = useState(false);

  useEffect(() => onSystemVoices(setInstalled), []);
  const loadNeural = () => {
    void neuralVoiceStatus().then(async (status) => {
      setNeuralReason(status.available ? "" : (status.reason ?? "unavailable"));
      setNeural(status.available ? await listNeuralVoices() : []);
    });
  };
  useEffect(loadNeural, []);
  if (!picked && installed[0]?.name) setPicked(installed[0].name);

  const models = prefs.voice.models ?? [];
  const activeId = prefs.voice.activeId;

  const onImport = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setImporting(true);
    try {
      const model = await importVoiceFile(file);
      toast.success(`Imported voice "${model.label}"`);
    } catch (error) {
      toast.error(`Voice import failed — ${String((error as Error).message ?? error)}`);
    } finally {
      setImporting(false);
    }
  };

  return (
    <HudPanel title="Voice Library" hint="installed voices + imported voice models">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[220px] flex-1">
          <p className="label-xs text-muted-foreground">Installed system voices</p>
          <select
            value={picked}
            onChange={(e) => setPicked(e.target.value)}
            className="hud-tile mt-1 w-full rounded-sm border border-primary/25 bg-transparent px-2.5 py-1.5 font-mono text-xs text-foreground"
          >
            {neural.length ? (
              <optgroup label="Neural (free · natural)">
                {neural.map((v) => (
                  <option key={v.id} value={`neural:${v.id}`} className="bg-background">
                    {v.label}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {installed.length ? (
              installed.map((v) => (
                <option key={`${v.name}-${v.lang}`} value={v.name} className="bg-background">
                  {v.name} · {v.lang}
                </option>
              ))
            ) : (
              <option value="">no system voices detected</option>
            )}
          </select>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={!picked && !prefs.voice.voiceName.trim()}
          onClick={() => {
            const name = picked || prefs.voice.voiceName.trim();
            if (name.startsWith("neural:")) {
              const id = name.slice("neural:".length);
              const found = neural.find((v) => v.id === id);
              const model = addNeuralVoice(found ?? { id, label: id, lang: id.slice(0, 5) });
              toast.success(`Added "${model.label}" to the library`);
              return;
            }
            const voice = installed.find((v) => v.name === name);
            const model = addSystemVoice(name, voice?.lang ?? prefs.voice.speechLang);
            toast.success(`Added "${model.label}" to the library`);
          }}
        >
          Add voice
        </Button>
        {neuralReason ? (
          <Button
            size="sm"
            variant="outline"
            disabled={installingNeural}
            onClick={() => {
              setInstallingNeural(true);
              void installNeuralVoice()
                .then((result) => {
                  if (result.ok) {
                    toast.success(
                      "Cloud neural voices installed. They speak only after you add that voice, and not for sensitive text.",
                    );
                    loadNeural();
                  } else {
                    toast.error(`Neural voices unavailable — ${result.error ?? neuralReason}`);
                  }
                })
                .finally(() => setInstallingNeural(false));
            }}
          >
            {installingNeural ? "Installing…" : "Enable neural voices"}
          </Button>
        ) : null}
        <label className="inline-flex">
          <input
            type="file"
            className="hidden"
            accept=".onnx,.json,.bin,.pth,.pt,.wav,.mp3,.zip,.gguf,.ckpt,.safetensors"
            onChange={(e) => {
              void onImport(e.target.files);
              e.currentTarget.value = "";
            }}
          />
          <Button size="sm" variant="outline" asChild disabled={importing}>
            <span>
              <HardDriveDownload className="size-4" />{" "}
              {importing ? "Importing…" : "Import voice file"}
            </span>
          </Button>
        </label>
      </div>

      <div className="mt-4 space-y-3">
        {models.length === 0 ? (
          <p className="font-mono text-xs text-muted-foreground">
            No voices saved yet — add an installed voice or import a local voice model file.
          </p>
        ) : null}
        {models.map((model) => (
          <div
            key={model.id}
            className={cn(
              "hud-tile rounded-sm border p-3",
              model.id === activeId ? "border-primary/60" : "border-primary/20",
            )}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-mono text-xs text-foreground">{model.label}</p>
                <p className="truncate font-mono text-[11px] text-muted-foreground">
                  {model.kind === "file"
                    ? (model.filePath ?? "imported file")
                    : model.kind === "neural"
                      ? "neural"
                      : "system voice"}{" "}
                  · {model.lang}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <StatusPill
                  label={model.id === activeId ? "ACTIVE" : "SAVED"}
                  tone={model.id === activeId ? "primary" : "muted"}
                />
                <Button size="sm" variant="outline" onClick={() => selectVoiceModel(model.id)}>
                  Use
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    if (assistantMode.getSnapshot().mode !== "auto") {
                      toast.error("FRIDAY speaks only in Auto mode");
                      return;
                    }
                    if (
                      !speakSample("Namaste, main FRIDAY hoon.", {
                        voiceName: model.voiceName,
                        lang: model.lang,
                        rate: model.rate,
                        pitch: model.pitch,
                        volume: model.volume,
                      })
                    ) {
                      toast.error("Speech synthesis is unavailable on this machine");
                    }
                  }}
                >
                  Test
                </Button>
                <Button size="sm" variant="outline" onClick={() => void removeVoiceModel(model.id)}>
                  Remove
                </Button>
              </div>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <EditField
                label="Display name"
                value={model.label}
                onChange={(label) => updateVoiceModel(model.id, { label })}
              />
              <EditField
                label="Language"
                value={model.lang}
                onChange={(lang) => updateVoiceModel(model.id, { lang })}
              />
            </div>
            <div className="mt-3 space-y-2">
              <TuneRow
                label="Rate"
                value={model.rate}
                min={0.5}
                max={2}
                detail={`${model.rate.toFixed(2)}x`}
                onChange={(rate) => updateVoiceModel(model.id, { rate })}
              />
              <TuneRow
                label="Pitch"
                value={model.pitch}
                min={0}
                max={2}
                detail={model.pitch.toFixed(2)}
                onChange={(pitch) => updateVoiceModel(model.id, { pitch })}
              />
              <TuneRow
                label="Volume"
                value={model.volume}
                min={0}
                max={1}
                detail={`${Math.round(model.volume * 100)}%`}
                onChange={(volume) => updateVoiceModel(model.id, { volume })}
              />
            </div>
            <div className="mt-3">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (model.id === activeId) selectVoiceModel(model.id);
                  void preferences.flush();
                  toast.success(`Saved "${model.label}"`);
                }}
              >
                <Save className="size-4" /> Save this voice
              </Button>
            </div>
          </div>
        ))}
      </div>
    </HudPanel>
  );
}
