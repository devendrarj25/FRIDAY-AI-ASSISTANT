import { useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  HardDriveDownload,
  Mic,
  Save,
  ShieldCheck,
  Settings2,
  Trash2,
  Volume2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { HudPanel, StatusPill, ToggleRow } from "@/components/friday/ui";
import { EditField, TuneRow } from "@/components/friday/settings/fields";
import { VoiceEngineSettings } from "@/components/friday/settings/VoiceEngineSettings";
import { readEarsStats } from "@/lib/friday/voice-audio";
import { VoiceEarsSettings } from "@/components/friday/settings/VoiceEarsSettings";
import { VoiceAudioPickers } from "@/components/friday/settings/VoiceAudioPickers";
import { VoiceEnrollment } from "@/components/friday/settings/VoiceEnrollment";
import { FridayVoice } from "@/components/friday/settings/FridayVoice";
import { desktopApi } from "@/lib/friday/desktop";
import { ErrorState } from "@/components/friday/PageStates";
import {
  LOCAL_VOICE_CHOICES,
  SYNTHETIC_VOICE_NOTE,
  localVoicePickerState,
  pickerValueFor,
} from "@/lib/friday/voice-engine/friday-voice-profile";
import { readFridayVoiceStatus, type FridayVoiceStatus } from "@/lib/friday/voice-diagnostics-rows";
import {
  ownerAcceptanceSteps,
  voiceReadinessNote,
  voiceSelfTestPlan,
} from "@/lib/friday/voice-doctor";
import {
  preferences,
  sanitizeLocalVoiceStyle,
  sanitizeConfirmLevel,
  type LocalVoiceStyle,
  sanitizeStreamEngine,
  sanitizeVoiceTaskPrefs,
} from "@/lib/friday/preferences";
import { usePreferences } from "@/lib/friday/use-preferences";
import { useBilling } from "@/lib/friday/use-billing";
import { realtimeStatus } from "@/lib/friday/voice-realtime";
import { kernelApi } from "@/lib/friday/kernel-api";
import { pickFolder } from "@/lib/friday/desktop";
import { assistantMode } from "@/lib/friday/assistant-mode";
import { useAssistantMode } from "@/lib/friday/use-assistant-mode";
import { attentionWindowSeconds, clampAttentionSeconds } from "@/lib/friday/attention-window";
import { Slider } from "@/components/ui/slider";
import { VoiceNotesList } from "@/components/friday/VoiceNotesPanel";
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
  resetToBestVoice,
} from "@/lib/friday/voice-library";

const RECOGNITION_LANGS = [
  { value: "auto", label: "Auto (Hindi, English or mixed)" },
  { value: "hi-IN", label: "Hindi (India)" },
  {
    value: "hi-Latn",
    label: "Hinglish in Roman letters (optional Hinglish ear, downloads on demand)",
  },
  { value: "en-IN", label: "English (India)" },
  { value: "en-US", label: "English (US)" },
];

export function VoiceSettings() {
  const prefs = usePreferences();
  const voice = useAssistantMode();
  const router = useRouter({ warn: false });
  const [busy, setBusy] = useState(false);

  return (
    <div className="space-y-4">
      <FridayVoice />
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
              className="hud-tile mt-1 w-full rounded-ctl border border-primary/25 bg-transparent px-2.5 py-1.5 font-mono text-xs text-foreground"
            >
              {RECOGNITION_LANGS.map((lang) => (
                <option key={lang.value} value={lang.value} className="bg-background">
                  {lang.label}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-wrap items-center justify-between gap-2 sm:col-span-2">
            <p className="min-w-0 text-xs text-muted-foreground">
              Voice language packs: install Hindi, English or Hinglish in one click
            </p>
            <Button size="sm" variant="outline" onClick={() => router?.navigate({ to: "/models" })}>
              Open voice language packs
            </Button>
          </div>
          <label className="block sm:col-span-2">
            <span className="label-xs text-muted-foreground">How often she asks yes or no</span>
            <select
              value={sanitizeConfirmLevel(prefs.voice.confirmLevel)}
              onChange={(e) =>
                preferences.setVoice({ confirmLevel: sanitizeConfirmLevel(e.target.value) })
              }
              className="hud-tile mt-1 w-full rounded-ctl border border-primary/25 bg-transparent px-2.5 py-1.5 font-mono text-xs text-foreground"
            >
              <option value="rare" className="bg-background">
                Rare: only for things that cannot be undone, or when she clearly did not understand
              </option>
              <option value="normal" className="bg-background">
                Normal: also for cautious things like install or rename
              </option>
              <option value="always" className="bg-background">
                Always: asks like Ask every time
              </option>
            </select>
            <span className="mt-1 block text-meta-sm text-muted-foreground">
              Default is rare. Dangerous actions (delete, send, pay, shutdown, uninstall) always
              ask, in every position.
            </span>
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
            <span className="label-xs text-muted-foreground">When FRIDAY answers</span>
            <select
              value={prefs.voice.addressMode || "conversation"}
              onChange={(e) =>
                preferences.setVoice({
                  addressMode: e.target.value as "name-only" | "conversation" | "meant-for-me",
                })
              }
              className="hud-tile mt-1 w-full rounded-ctl border border-primary/25 bg-transparent px-2.5 py-1.5 font-mono text-xs text-foreground"
            >
              <option value="name-only" className="bg-background">
                Only when I say FRIDAY
              </option>
              <option value="conversation" className="bg-background">
                Conversation (name + follow-ups)
              </option>
              <option value="meant-for-me" className="bg-background">
                Respond to anything meant for me
              </option>
            </select>
          </label>
          <label className="block sm:col-span-2">
            <span className="label-xs text-muted-foreground">How Auto mode listens</span>
            <select
              value={prefs.voice.listenStyle || "always"}
              onChange={(e) =>
                preferences.setVoice({
                  listenStyle: e.target.value === "push-to-talk" ? "push-to-talk" : "always",
                })
              }
              className="hud-tile mt-1 w-full rounded-ctl border border-primary/25 bg-transparent px-2.5 py-1.5 font-mono text-xs text-foreground"
            >
              <option value="always" className="bg-background">
                Always listening (wake word and follow-ups)
              </option>
              <option value="push-to-talk" className="bg-background">
                Push to talk (hold Ctrl+Space, or Ctrl+Alt+Space to toggle)
              </option>
            </select>
          </label>
          <label className="block">
            <span className="label-xs text-muted-foreground">Heard lines kept on this PC</span>
            <select
              value={String(prefs.voice.heardKeepMin ?? 10)}
              onChange={(e) => preferences.setVoice({ heardKeepMin: Number(e.target.value) })}
              className="hud-tile mt-1 w-full rounded-ctl border border-primary/25 bg-transparent px-2.5 py-1.5 font-mono text-xs text-foreground"
            >
              <option value="0" className="bg-background">
                Off
              </option>
              <option value="10" className="bg-background">
                10 minutes
              </option>
              <option value="30" className="bg-background">
                30 minutes
              </option>
              <option value="60" className="bg-background">
                1 hour
              </option>
            </select>
          </label>
          <label className="block">
            <span className="label-xs text-muted-foreground">Heard rows kept on this PC</span>
            <select
              value={String(prefs.voice.heardKeepRows ?? 40)}
              onChange={(e) => preferences.setVoice({ heardKeepRows: Number(e.target.value) })}
              className="hud-tile mt-1 w-full rounded-ctl border border-primary/25 bg-transparent px-2.5 py-1.5 font-mono text-xs text-foreground"
            >
              <option value="0" className="bg-background">
                Off
              </option>
              <option value="20" className="bg-background">
                20 rows
              </option>
              <option value="40" className="bg-background">
                40 rows
              </option>
              <option value="80" className="bg-background">
                80 rows
              </option>
            </select>
          </label>
          <VoiceAudioPickers />
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
            label="Speaker match bar (0.30 to 0.99; 0.75 is what your saved voice was measured at)"
            value={prefs.fields["speakerThreshold"] ?? "0.75"}
            onChange={(value) => preferences.setField("speakerThreshold", value)}
          />
          <VoiceEnrollment />
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
          <LocalVoicePicker />
          <ToggleRow
            label="Expressive speech"
            hint="A question rises, an apology softens, good news brightens, with short natural pauses between clauses. Small changes on top of your own voice settings. Off keeps the pace and pitch exactly as set."
            on={prefs.voice.expressiveSpeech !== false}
            onToggle={() =>
              preferences.setVoice({ expressiveSpeech: prefs.voice.expressiveSpeech === false })
            }
          />
          <ToggleRow
            label="Tidy the words shown for what I say"
            hint="Auto mode. Drops um and uh, turns spoken punctuation (comma, full stop, purn viram, new line) into symbols, and lets a spoken correction (two, actually three) replace what it corrects, in Hindi, English and Hinglish. It runs on this PC and never changes what FRIDAY acts on or the script you spoke. On by default."
            on={prefs.voice.tidyDictation !== false}
            onToggle={() =>
              preferences.setVoice({ tidyDictation: prefs.voice.tidyDictation === false })
            }
          />
          <ToggleRow
            label="Speech Prep for Hindi and Hinglish"
            hint="Before she speaks, English words inside a Hindi reply and Roman Hindi (kal meeting hai) are written in Devanagari so the Hindi voice says them properly, and numbers, times and rupee amounts are said as words. English sentences, quoted names, code and links are never changed. On by default."
            on={prefs.voice.speechPrep !== false}
            onToggle={() => preferences.setVoice({ speechPrep: prefs.voice.speechPrep === false })}
          />
          <ToggleRow
            label="Show words while I speak (experimental)"
            hint="Auto mode only. Reads what you have said so far about once a second and shows the words two readings agree on. Uses more CPU while you talk; the answer still waits for the normal final reading. Off by default."
            on={prefs.voice.liveWords === true}
            onToggle={() => preferences.setVoice({ liveWords: prefs.voice.liveWords !== true })}
          />
          <label className="block">
            <span className="label-xs text-muted-foreground">
              FRIDAY's own streaming ear (experimental)
            </span>
            <select
              value={sanitizeStreamEngine(prefs.voice.streamEngine)}
              onChange={(e) =>
                preferences.setVoice({ streamEngine: sanitizeStreamEngine(e.target.value) })
              }
              className="hud-tile mt-1 w-full rounded-ctl border border-primary/25 bg-transparent px-2.5 py-1.5 font-mono text-xs text-foreground"
            >
              <option value="off" className="bg-background">
                Off: the normal listening path
              </option>
              <option value="auto" className="bg-background">
                Auto: use it when its model is installed
              </option>
              <option value="nemotron" className="bg-background">
                Nemotron streaming
              </option>
              <option value="stream-ear-nemotron" className="bg-background">
                Nemotron streaming, int8 (the pinned download)
              </option>
            </select>
            <span className="mt-1 block text-meta-sm text-muted-foreground">
              Auto mode only. Words appear while you speak, in Hindi, English and Hinglish, on this
              PC only; nothing is sent anywhere. It needs the streaming model (Models page); without
              it, or when anything fails, the normal listening path carries on. Off by default and
              not yet tried on a real microphone.
            </span>
          </label>
          <ToggleRow
            label="Write spoken numbers, times and money as digits"
            hint="Hindi, English and Hinglish: spoken numbers, times, money and web addresses are written as digits in the words shown, only where the reading is sure. It runs on this PC after the tidy step and never changes the script you spoke. On by default."
            on={prefs.voice.itn !== false}
            onToggle={() => preferences.setVoice({ itn: prefs.voice.itn === false })}
          />
          <ToggleRow
            label="Listen for the wake word live (needs a wake model)"
            hint="Auto mode, wake word required. Scores the microphone on this PC as you talk; nothing is sent anywhere. It needs an openWakeWord model for your wake word in the wake folder; without one it says so in Voice diagnostics and the normal wake matching carries on. Off by default and not yet tried on a real microphone."
            on={prefs.voice.liveWake === true}
            onToggle={() => preferences.setVoice({ liveWake: prefs.voice.liveWake !== true })}
          />
          <VoiceNotesList />
          <RealtimeEngineNotes />
          <VoiceEngineSettings />
          <VoiceEarsSettings readStats={readEarsStats} />
          <SpeechModelCheck />
          <ToggleRow
            label="Realtime voice (experimental)"
            hint="Auto mode only. Closes a pause sooner and starts speaking at the first clause. Nothing leaves this PC; it only moves timing."
            on={prefs.voice.realtimeExperiment === true}
            onToggle={() =>
              preferences.setVoice({ realtimeExperiment: prefs.voice.realtimeExperiment !== true })
            }
          />
          <VoiceTasksCard />
          <ToggleRow
            label="Say a short acknowledgement while I work"
            hint="Auto mode. When a task takes a while, she says one short line (like 'On it') so you know she heard you. It only adds a spoken line; nothing leaves this PC. Off by default and unverified on your PC until you try it."
            on={prefs.voice.instantAck === true}
            onToggle={() => preferences.setVoice({ instantAck: prefs.voice.instantAck !== true })}
          />
          <ToggleRow
            label="Ignore nods while she talks"
            hint="Auto mode. While she speaks, a short sound like 'hmm', 'haan' or 'theek hai' only lowers her volume for a moment; she stops for real words, 'wait', 'ruko', or your answer to her question. Off means any voice stops her at once. Unverified on your PC until you try it."
            on={prefs.voice.interruptGate.enabled !== false}
            onToggle={() =>
              preferences.setVoice({
                interruptGate: {
                  ...prefs.voice.interruptGate,
                  enabled: prefs.voice.interruptGate.enabled === false,
                },
              })
            }
          />
          <ToggleRow
            label="Start thinking before I finish speaking (experimental)"
            hint="Auto mode. She begins a draft answer while you are still finishing the sentence, and throws it away if you say more. It never acts on a draft and uses more CPU. Off by default and unverified on your PC until you try it."
            on={prefs.voice.eagerTurn === true}
            onToggle={() => preferences.setVoice({ eagerTurn: prefs.voice.eagerTurn !== true })}
          />
          <ToggleRow
            label="Cancel her own voice from the microphone (experimental)"
            hint="Auto mode. Her own voice is subtracted from what the microphone hears, so you can interrupt her without a headset. Runs on this PC and plays nothing extra. Off by default and unverified on your PC until you try it."
            on={prefs.voice.echoReference === true}
            onToggle={() =>
              preferences.setVoice({ echoReference: prefs.voice.echoReference !== true })
            }
          />
          <ToggleRow
            label="Warm up the voice when Auto mode starts"
            hint="Once the microphone is open, FRIDAY loads and tries her speech, voice, turn and kernel engines so your first question is not slow. Nothing is played, no microphone is added and nothing leaves this PC. It is skipped on the Lite profile and on battery, and a failure shows in Voice Doctor, not as an error. On by default."
            on={prefs.voice.prewarm !== false}
            onToggle={() => preferences.setVoice({ prewarm: prefs.voice.prewarm === false })}
          />
          <ToggleRow
            label="Remember only what I heard when I cut her off"
            hint="When you interrupt a spoken reply, the conversation keeps the part you heard and notes that she was cut off, so the next answer does not assume you heard the rest. The whole reply stays in the saved conversation on this PC. On by default."
            on={prefs.voice.trimHistoryToPlayed !== false}
            onToggle={() =>
              preferences.setVoice({
                trimHistoryToPlayed: prefs.voice.trimHistoryToPlayed === false,
              })
            }
          />
          <ToggleRow
            label="Fast first clause (experimental)"
            hint="Auto mode only. FRIDAY starts speaking after the first four to eight words, at a comma or a dash, instead of waiting for the end of the first sentence. Numbers, names like Dr. Sharma, links, code and quotations are never cut. Nothing leaves this PC; it only moves timing. Off by default and not yet measured on a real speaker."
            on={prefs.voice.fastFirstClause === true}
            onToggle={() =>
              preferences.setVoice({ fastFirstClause: prefs.voice.fastFirstClause !== true })
            }
          />
          <ToggleRow
            label="Play the local voice as raw samples (experimental)"
            hint="Only for the local Supertonic voice. Skips the audio file and plays each clause through the gapless scheduler. If anything fails, that clause and the rest of the session play the old way, and Voice diagnostics says why. Off by default and not yet measured on a real speaker."
            on={prefs.voice.pcmPlayback === true}
            onToggle={() => preferences.setVoice({ pcmPlayback: prefs.voice.pcmPlayback !== true })}
          />
          <ToggleRow
            label="Use the light Hindi voice for Hindi (optional download, CC-BY-4.0 credit: Sulabh Katiyar, AI4Bharat Rasa)"
            hint="Lines written fully in Devanagari are spoken by a small Hindi voice that runs on this PC; English and mixed lines keep the usual voice. It needs the Hindi light voice download in Models (about 91 MB); until then, and whenever it cannot speak a line, the usual local voice speaks and Voice diagnostics says why. Plays as raw samples. Off by default and not yet heard on your PC."
            on={prefs.voice.hindiLightVoice === true}
            onToggle={() =>
              preferences.setVoice({ hindiLightVoice: prefs.voice.hindiLightVoice !== true })
            }
          />
          <ToggleRow
            label="Check the language on every phrase (experimental)"
            hint="faster-whisper listens for the language again in each phrase, so a sentence that switches between Hindi and English is read in both. Works with the Hindi and English choices above, where FRIDAY detects the language itself. Uses a little more CPU. Off by default."
            on={prefs.voice.sttMultilingual === true}
            onToggle={() =>
              preferences.setVoice({ sttMultilingual: prefs.voice.sttMultilingual !== true })
            }
          />
          <label className="block">
            <span className="label-xs text-muted-foreground">Talkativeness</span>
            <select
              value={prefs.fields["talk"] || "balanced"}
              onChange={(e) => preferences.update({ fields: { talk: e.target.value } })}
              className="hud-tile mt-1 w-full rounded-ctl border border-primary/25 bg-transparent px-2.5 py-1.5 font-mono text-xs text-foreground"
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
              className="hud-tile mt-1 w-full rounded-ctl border border-primary/25 bg-transparent px-2.5 py-1.5 font-mono text-xs text-foreground"
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
            <p className="mt-1 text-meta text-muted-foreground">
              {voiceSelfTestPlan().join(" → ")}. This page does not open the microphone. The live
              check runs in Auto mode.
            </p>
            <ol className="mt-2 list-decimal space-y-1 pl-4 text-meta text-muted-foreground">
              {ownerAcceptanceSteps().map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <p className="mt-2 text-meta text-muted-foreground">
              {voiceReadinessNote("").includes("Flow resume")
                ? "A simulated clean PC reaches listening again. This page still does not open the microphone."
                : "The simulated voice flow did not finish. Doctor has the detail."}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                className="hud-tile rounded-ctl border border-primary/25 bg-transparent px-2.5 py-1.5 font-mono text-xs text-foreground"
                onClick={() =>
                  void desktopApi()?.openExternalUrl?.("ms-settings:privacy-microphone")
                }
              >
                <ShieldCheck className="size-3" aria-hidden="true" />
                Windows microphone privacy
              </button>
              <button
                type="button"
                className="hud-tile rounded-ctl border border-primary/25 bg-transparent px-2.5 py-1.5 font-mono text-xs text-foreground"
                onClick={() => desktopApi()?.openExternalUrl?.("ms-settings:sound")}
              >
                <Settings2 className="size-3" aria-hidden="true" />
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
            className="hud-tile rounded-ctl border border-primary/25 bg-transparent px-2.5 py-1.5 text-left font-mono text-xs text-foreground"
            onClick={() => {
              const api = (window as unknown as { friday?: { clearVoiceprint?: () => void } })
                .friday;
              void api?.clearVoiceprint?.();
            }}
          >
            <Trash2 className="size-3" aria-hidden="true" />
            Delete voice data
          </button>
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <p className="label-xs text-muted-foreground">Attention window after wake</p>
              <span className="text-meta text-primary">{attentionWindowSeconds()} s</span>
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
                recognitionLang: "auto",
                speechLang: "hi-IN",
                voiceName: "",
                speakReplies: true,
                hinglish: true,
              });
              resetToBestVoice();
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

/**
 * Settings, Voice: which local voice speaks. FRIDAY (sweet and warm) is the default and needs nothing chosen; the
 * variants and the presets are the owner's explicit pick. Preview plays one without saving it, through the same
 * sample path as Test voice, so it needs Auto mode like every spoken line.
 */
function LocalVoicePicker() {
  const prefs = usePreferences();
  const desktop = Boolean(desktopApi());
  const [loading, setLoading] = useState(desktop);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<FridayVoiceStatus | null>(null);
  const ask = () =>
    neuralVoiceStatus()
      .then((answer) => setStatus(readFridayVoiceStatus(answer.fridayVoice)))
      .catch((failure: unknown) =>
        setError(
          String((failure as Error)?.message ?? failure) || "the local voice did not answer",
        ),
      )
      .finally(() => setLoading(false));
  const retry = () => {
    setError("");
    setLoading(true);
    void ask();
  };
  useEffect(() => {
    if (desktop) void ask();
    // The status is read once when the page opens; Retry asks again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const state = localVoicePickerState({ loading, desktop, error, status });
  const chosen = pickerValueFor(prefs.voice.localVoiceStyle);
  const chosenLabel = LOCAL_VOICE_CHOICES.find((choice) => choice.id === chosen)?.label ?? "";
  // Speech plays only in Auto mode, so the previews say so up front instead of failing after the click.
  const autoMode = useAssistantMode().mode === "auto";
  const canPreview = state.kind === "ready" && autoMode;
  const hintId = "local-voice-preview-hint";
  const preview = (style: LocalVoiceStyle) => {
    if (assistantMode.getSnapshot().mode !== "auto") {
      toast.error("FRIDAY speaks only in Auto mode");
      return;
    }
    const tuning = activeVoiceSettings();
    if (!speakSample("Namaste, main FRIDAY hoon.", { ...tuning, previewStyle: style })) {
      toast.error("Speech synthesis is unavailable on this machine");
    }
  };

  return (
    <div className="sm:col-span-2" data-testid="local-voice-picker">
      <span className="label-xs text-muted-foreground" id="local-voice-label">
        Local voice
      </span>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <select
          aria-labelledby="local-voice-label"
          value={chosen}
          onChange={(e) =>
            preferences.setVoice({ localVoiceStyle: sanitizeLocalVoiceStyle(e.target.value) })
          }
          className="h-8 min-w-[220px] flex-1 rounded-md border border-border bg-transparent px-2 text-meta-sm text-foreground"
        >
          {LOCAL_VOICE_CHOICES.map((choice) => (
            <option key={choice.id || "default"} value={choice.id} className="bg-background">
              {choice.label}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant="outline"
          disabled={!canPreview}
          aria-label={`Preview ${chosenLabel}`}
          aria-describedby={state.kind === "ready" && !autoMode ? hintId : undefined}
          onClick={() => preview(chosen)}
        >
          <Volume2 className="size-4" /> Preview
        </Button>
      </div>
      {state.kind === "ready" && !autoMode ? (
        <p id={hintId} className="mt-1 text-meta-sm text-muted-foreground">
          Previews play in Auto mode only. Switch to Auto mode to hear a voice.
        </p>
      ) : null}
      <ul className="mt-2 space-y-1">
        {LOCAL_VOICE_CHOICES.map((choice) => (
          <li key={choice.id || "default"} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 text-meta-sm text-muted-foreground">
              {choice.label}: {choice.hint}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={!canPreview}
              aria-label={`Preview ${choice.label}`}
              title={`Preview ${choice.label}`}
              aria-describedby={state.kind === "ready" && !autoMode ? hintId : undefined}
              onClick={() => preview(choice.id)}
            >
              <Volume2 className="size-4" />
            </Button>
          </li>
        ))}
      </ul>
      {state.kind === "error" ? (
        <ErrorState title="The local voice did not answer" error={state.note} onRetry={retry} />
      ) : (
        <p
          className="mt-2 flex flex-wrap items-center gap-2 text-meta-sm text-muted-foreground"
          role="status"
        >
          <StatusPill
            label={
              state.kind === "ready"
                ? state.own
                  ? "own engine"
                  : "package voice"
                : state.kind === "loading"
                  ? "checking"
                  : state.kind === "empty"
                    ? "not installed"
                    : "desktop only"
            }
            tone={
              state.kind === "ready" && state.own
                ? "accent"
                : state.kind === "loading" || state.kind === "offline"
                  ? "muted"
                  : "warning"
            }
          />
          {state.note}
        </p>
      )}
      <p className="mt-1 text-meta-sm text-muted-foreground">{SYNTHETIC_VOICE_NOTE}</p>
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
            className="hud-tile mt-1 w-full rounded-ctl border border-primary/25 bg-transparent px-2.5 py-1.5 font-mono text-xs text-foreground"
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
              "hud-tile rounded-ctl border p-3",
              model.id === activeId ? "border-primary/60" : "border-primary/20",
            )}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-mono text-xs text-foreground">{model.label}</p>
                <p className="truncate text-meta text-muted-foreground">
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
                <Button size="sm" variant="outline" onClick={() => removeVoiceModel(model.id)}>
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

/** Tasks that keep running while she talks: how much she says, and what happens after a restart. */
function VoiceTasksCard() {
  const prefs = usePreferences();
  const tasks = sanitizeVoiceTaskPrefs(prefs.voice.tasks);
  const set = (patch: Partial<typeof tasks>) =>
    preferences.setVoice({ tasks: sanitizeVoiceTaskPrefs({ ...tasks, ...patch }) });
  const selectClass =
    "mt-1 h-8 w-full rounded-md border border-border bg-transparent px-2 text-meta-sm text-foreground";
  return (
    <div className="grid gap-2 rounded-md border border-border p-2 text-meta-sm text-muted-foreground">
      <p className="text-foreground">Tasks while talking</p>
      <p>
        One task runs at a time for now; a second waits in line and shows in the task list in Auto
        mode. These settings only change what she says, never what she is allowed to do.
      </p>
      <label className="block">
        <span className="label-xs text-muted-foreground">How much she says about a task</span>
        <select
          value={tasks.narration}
          onChange={(e) => set({ narration: e.target.value as typeof tasks.narration })}
          className={selectClass}
        >
          <option value="quiet">Quiet (only the result)</option>
          <option value="normal">Normal</option>
          <option value="chatty">Chatty</option>
        </select>
      </label>
      <TuneRow
        label="Progress lines per minute"
        value={tasks.progressLinesPerMinute}
        min={0}
        max={6}
        step={1}
        detail={tasks.progressLinesPerMinute === 0 ? "none" : `${tasks.progressLinesPerMinute}`}
        onChange={(progressLinesPerMinute) => set({ progressLinesPerMinute })}
      />
      <ToggleRow
        label="Say a short line when a task is done"
        on={tasks.speakDone}
        onToggle={() => set({ speakDone: !tasks.speakDone })}
      />
      <label className="block">
        <span className="label-xs text-muted-foreground">After a restart</span>
        <select
          value={tasks.resumeAfterRestart}
          onChange={(e) =>
            set({ resumeAfterRestart: e.target.value as typeof tasks.resumeAfterRestart })
          }
          className={selectClass}
        >
          <option value="ask">Ask me before resuming</option>
          <option value="auto">Resume on its own</option>
        </select>
        <span className="mt-1 block text-meta-sm text-muted-foreground">
          Resume on its own only runs read-only tasks, and only under Full autonomy. A task that
          changes something always asks.
        </span>
      </label>
      <ToggleRow
        label="Answer a quick question while a task runs"
        hint="A short side question is answered at once, beside the task, instead of waiting for it."
        on={tasks.sideQuestionLane}
        onToggle={() => set({ sideQuestionLane: !tasks.sideQuestionLane })}
      />
    </div>
  );
}

/** Why the two other realtime engines are not on, in plain words, from the live switches. */
function RealtimeEngineNotes() {
  const prefs = usePreferences();
  const billing = useBilling();
  const status = realtimeStatus({
    enabled: prefs.voice.realtimeExperiment === true,
    surface: "auto",
    paused: false,
    gpuVramGb: 0,
    s2sRuntimeInstalled: false,
    paidAccess: billing.billing.paidAccess,
    cloudKey: false,
    privacyMode: prefs.voice.privacyMode === true,
  });
  return (
    <div className="grid gap-1 rounded-md border border-border p-2 text-meta-sm text-muted-foreground">
      <p className="text-foreground">Realtime engines</p>
      <p>This PC, overlapping listen, think and speak: available (the switch below).</p>
      {status.unavailable.map((row) => (
        <p key={row.engine}>
          {row.engine === "local-speech-to-speech" ? "Local speech-to-speech" : "Cloud realtime"}:
          not on — {row.why}.{" "}
          {row.engine === "local-speech-to-speech"
            ? "The session protocol, its safety gate and the connection to an engine on this PC are built; no microphone or speaker is attached to it yet."
            : "The session protocol, its safety gate and the connection to a named cloud provider are built; no microphone or speaker is attached to it yet, and it has not been tried against the live provider."}
        </p>
      ))}
    </div>
  );
}

const SIZES = ["tiny", "base", "small", "medium"] as const;

type BenchRow = {
  model: string;
  files: number;
  scored: number;
  failed: number;
  wer: number | null;
  cer: number | null;
  seconds_per_file: number;
};

/**
 * Which speech model size hears this owner best. A folder of his own recordings (`name.wav`) with what he said
 * (`name.txt`) is transcribed by each size and scored under one fixed normalizer. Nothing leaves this PC.
 */
function SpeechModelCheck() {
  const [folder, setFolder] = useState("");
  const [sizes, setSizes] = useState<string[]>(["base", "small"]);
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<BenchRow[] | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const run = async () => {
    if (!folder || !sizes.length) return;
    setBusy(true);
    setNote(null);
    try {
      const out = await kernelApi.stt.bench(folder, sizes);
      if (out?.ok && out.results) {
        setRows(out.results);
        setNote(`${out.files} recording(s) with a matching text file.`);
      } else
        setNote(out?.error ?? "The check did not run (the desktop app and its kernel are needed).");
    } catch (failure) {
      setNote(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const pct = (value: number | null) => (value === null ? "—" : `${Math.round(value * 100)}%`);
  return (
    <div className="grid gap-2 rounded-md border border-border p-2 text-meta-sm text-muted-foreground">
      <p className="text-foreground">Which speech model hears you best</p>
      <p>
        Put a few of your own recordings in a folder, each with a text file of the same name that
        says what you said (in the script you expect back). Every size listens and is scored on the
        same rules.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => pickFolder().then((picked) => picked && setFolder(picked))}
        >
          Choose folder
        </Button>
        <span className="break-all">{folder || "no folder chosen"}</span>
      </div>
      <div className="flex flex-wrap gap-3">
        {SIZES.map((size) => (
          <label key={size} className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={sizes.includes(size)}
              onChange={(event) =>
                setSizes((current) =>
                  event.target.checked
                    ? [...current, size]
                    : current.filter((item) => item !== size),
                )
              }
            />
            {size}
          </label>
        ))}
        <Button size="sm" disabled={busy || !folder || !sizes.length} onClick={() => run()}>
          {busy ? "Listening…" : "Run the check"}
        </Button>
      </div>
      {note ? <p>{note}</p> : null}
      {rows ? (
        <ul className="grid gap-1">
          {rows.map((row) => (
            <li key={row.model} className="text-data text-foreground">
              {row.model}: words wrong {pct(row.wer)}, letters wrong {pct(row.cer)},{" "}
              {row.seconds_per_file}s per file
              {row.failed ? `, ${row.failed} file(s) it could not read` : ""}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
