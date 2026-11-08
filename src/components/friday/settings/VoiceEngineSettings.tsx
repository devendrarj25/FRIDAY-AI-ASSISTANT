import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ToggleRow } from "@/components/friday/ui";
import { desktopApi } from "@/lib/friday/desktop";
import { preferences } from "@/lib/friday/preferences";
import { useBilling } from "@/lib/friday/use-billing";
import { usePreferences } from "@/lib/friday/use-preferences";
import { useSystemSample } from "@/lib/friday/use-live-metrics";
import { useAssistantMode } from "@/lib/friday/use-assistant-mode";
import {
  closeRealtimeVoice,
  realtimeVoiceSession,
} from "@/lib/friday/voice-engine/realtime-voice-live";
import { missingModels, selectProfile } from "@/lib/friday/voice-engine/hardware-profile";
import {
  factsFromSample,
  loadLedger,
  sanitizeCloudPrefs,
  toRouterSettings,
  type VoiceCloudPrefs,
} from "@/lib/friday/voice-engine/voice-cloud-settings";
import { PROVIDERS, routeVoice, type Need } from "@/lib/friday/voice-engine/voice-provider-router";
import {
  prepareForSpeech,
  sanitizePronunciations,
} from "@/lib/friday/voice-engine/text-normalizer";
import { speakWithCloud } from "@/lib/friday/voice-engine/voice-cloud-client";
import { saveLedger } from "@/lib/friday/voice-engine/voice-cloud-settings";

const NEEDS: { need: Need; label: string }[] = [
  { need: "text", label: "Answers" },
  { need: "stt", label: "Listening" },
  { need: "tts", label: "Speaking" },
  { need: "realtime-audio", label: "Realtime audio" },
];

const REALTIME_HOSTS = {
  openai: "api.openai.com",
  xai: "api.x.ai",
  gemini: "generativelanguage.googleapis.com",
} as const;

const inputClass =
  "h-8 w-24 rounded-md border border-border bg-transparent px-2 text-meta-sm text-foreground";

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Cloud realtime voice (paid, experimental). It needs Auto mode, paid use allowed and approved here and in the
 * billing firewall, a saved key, privacy mode off, a realtime model the owner names, and a yes for this session
 * because microphone audio leaves this PC. Unverified against a live provider.
 */
function RealtimeCloudSession({
  prefs: cloud,
  keys,
}: {
  prefs: VoiceCloudPrefs;
  keys: Record<string, boolean>;
}) {
  const prefs = usePreferences();
  const billing = useBilling();
  const mode = useAssistantMode();
  const [provider, setProvider] = useState<"openai" | "xai" | "gemini">("openai");
  const [model, setModel] = useState("");
  const [consent, setConsent] = useState(false);
  const [status, setStatus] = useState("Not running.");
  const [running, setRunning] = useState(false);
  const [stats, setStats] = useState("");

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      const s = realtimeVoiceSession().voice.stats();
      setStats(
        `${Math.round(s.elapsedMs / 1000)} s · ${s.sentFrames} frames sent · ${s.droppedFrames} dropped · ${s.bargeIns} interruptions · speaker queue ${s.playback.queuedMs} ms · ${s.playback.underruns} gaps · echo ${s.echo ? `delay ${s.echo.delayMs} ms, ${s.echo.erleDb === null ? "not yet judged" : `${s.echo.erleDb} dB removed`}` : "off"}`,
      );
    }, 1000);
    return () => clearInterval(timer);
  }, [running]);

  useEffect(
    () => () => {
      void realtimeVoiceSession().voice.stop("settings closed").finally(closeRealtimeVoice);
    },
    [],
  );

  const autoOn = mode.mode === "auto" && !mode.paused;
  const start = async () => {
    const { voice } = realtimeVoiceSession();
    const out = await voice.start({
      gate: {
        engine: "cloud-realtime",
        url: `wss://${REALTIME_HOSTS[provider]}`,
        surface: autoOn ? "auto" : "manual",
        paused: mode.paused,
        paidAccess: billing.billing.paidAccess,
        cloudKey: keys[provider] === true,
        privacyMode: prefs.voice.privacyMode === true,
        sessionConsent: consent,
        halted: false,
      },
      cloud: { provider, model },
      settings: { instructions: "You are FRIDAY, a calm assistant. Keep answers short." },
      router: {
        cloud: toRouterSettings(cloud, keys),
        privacyMode: prefs.voice.privacyMode === true,
        billingAllowsPaid: billing.billing.paidAccess,
        online: typeof navigator === "undefined" ? true : navigator.onLine,
      },
      onStop: (why) => {
        setRunning(false);
        setStatus(`Ended: ${why}`);
        closeRealtimeVoice();
      },
    });
    if (out.ok) {
      setRunning(true);
      setStatus("Connected (not yet confirmed against the live provider).");
    } else {
      setStatus(`Not started: ${out.reasons.join("; ")}`);
      closeRealtimeVoice();
    }
  };

  return (
    <div className="grid gap-1">
      <p className="text-foreground">Cloud realtime voice (paid, experimental)</p>
      <p>
        Needs Auto mode ({autoOn ? "on" : "off now"}), paid use allowed and approved above, a saved
        OpenAI key ({keys[provider] ? "saved" : "none"}), and privacy mode off. Microphone audio
        leaves this PC while it runs.
      </p>
      <label className="flex items-center gap-2">
        <span>Provider</span>
        <select
          className={`${inputClass} w-44`}
          value={provider}
          disabled={running}
          onChange={(e) => setProvider(e.target.value as typeof provider)}
        >
          <option value="openai">OpenAI Realtime</option>
          <option value="xai">xAI Grok Voice</option>
          <option value="gemini">Google Gemini Live</option>
        </select>
      </label>
      <label className="flex items-center gap-2">
        <span>Realtime model (you name it; none is chosen for you)</span>
        <input
          className={`${inputClass} w-56`}
          value={model}
          onChange={(e) => setModel(e.target.value.trim())}
          disabled={running}
        />
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={consent}
          onChange={() => setConsent(!consent)}
          disabled={running}
        />
        <span>I agree that my microphone audio is sent to the provider for this session only.</span>
      </label>
      <div className="flex items-center gap-2">
        {running ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => realtimeVoiceSession().voice.stop("owner stopped")}
          >
            Stop session
          </Button>
        ) : (
          <Button size="sm" disabled={!autoOn || !model || !consent} onClick={() => start()}>
            Start session
          </Button>
        )}
        <span>{status}</span>
      </div>
      {running ? <p>{stats}</p> : null}
    </div>
  );
}

/**
 * Cloud speech keys and a spoken sample. Keys are written to the encrypted store through the main process and
 * are never shown or read back. A sample goes through the same router and quota as any cloud speech.
 */
function CloudSpeechTest({
  cloud,
  keys,
  ledger,
  setKeys,
  set,
}: {
  cloud: VoiceCloudPrefs;
  keys: Record<string, boolean>;
  ledger: ReturnType<typeof loadLedger>;
  setKeys: (next: Record<string, boolean>) => void;
  set: (patch: Partial<VoiceCloudPrefs>) => void;
}) {
  const prefs = usePreferences();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [line, setLine] = useState("");
  const providers = [
    { id: "sarvam" as const, label: "Sarvam AI" },
    { id: "azure-speech" as const, label: "Azure Speech" },
  ];

  const saveKey = async (id: string) => {
    const out = await desktopApi()?.voiceCloudSaveKey?.(id, draft[id] ?? "");
    setDraft((d) => ({ ...d, [id]: "" }));
    if (!out) return setLine("Saving a key needs the desktop app.");
    setLine(
      out.ok ? (out.stored ? `${id}: key saved.` : `${id}: key removed.`) : `${id}: ${out.error}`,
    );
    const status = await desktopApi()?.voiceCloudKeyStatus?.();
    if (status) setKeys({ ...keys, ...status });
  };

  const SAMPLES = {
    hindi: {
      label: "Hindi",
      language: "hi-IN",
      text: "नमस्ते, मैं फ्राइडे हूँ। आज मैं आपकी क्या मदद कर सकती हूँ?",
    },
    hinglish: {
      label: "Hinglish",
      language: "hi-IN",
      text: "नमस्ते, मैं फ्राइडे हूँ। Aapka meeting reminder set हो गया है, and I will tell you ten minutes पहले.",
    },
    english: {
      label: "Indian English",
      language: "en-IN",
      text: "Hello, I am Friday. Your report is ready, and I can read the summary whenever you like.",
    },
  } as const;

  const sample = async (id: "sarvam" | "azure-speech", kind: keyof typeof SAMPLES = "hindi") => {
    const chosen = SAMPLES[kind];
    const out = await speakWithCloud(
      id,
      {
        text: chosen.text,
        language: chosen.language,
        prefs: cloud,
        keys,
        privacyMode: prefs.voice.privacyMode === true,
        online: typeof navigator === "undefined" ? true : navigator.onLine,
      },
      {
        ledger,
        persistLedger: () =>
          saveLedger(typeof localStorage === "undefined" ? null : localStorage, ledger),
      },
    );
    if (!out.ok) return setLine(`${id}: not spoken — ${out.error}`);
    setLine(`${id}: playing a sample (counted against your quota).`);
    try {
      await new Audio(`data:${out.mime};base64,${out.audioBase64}`).play();
    } catch (error) {
      setLine(
        `${id}: the audio could not play (${error instanceof Error ? error.message : "blocked"}).`,
      );
    }
  };

  return (
    <div className="grid gap-1">
      <p className="text-foreground">Cloud speech keys and a sample</p>
      <p>
        Keys go to the encrypted store and are never shown again. A sample needs cloud voice on, the
        provider allowed, a quota above 0 (including audio minutes), and privacy mode off.
      </p>
      {providers.map((p) => (
        <div key={p.id} className="flex flex-wrap items-center gap-2">
          <span className="text-foreground">{p.label}</span>
          <span>{keys[p.id] ? "key saved" : "no key"}</span>
          <input
            type="password"
            autoComplete="off"
            placeholder="paste key"
            className={`${inputClass} w-44`}
            value={draft[p.id] ?? ""}
            onChange={(e) => setDraft((d) => ({ ...d, [p.id]: e.target.value }))}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!(draft[p.id] ?? "").trim()}
            onClick={() => saveKey(p.id)}
          >
            Save key
          </Button>
          {(Object.keys(SAMPLES) as Array<keyof typeof SAMPLES>).map((kind) => (
            <Button key={kind} size="sm" variant="outline" onClick={() => sample(p.id, kind)}>
              {SAMPLES[kind].label} sample
            </Button>
          ))}
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2">
          <span>Azure region</span>
          <input
            className={inputClass}
            value={cloud.azureRegion}
            placeholder="centralindia"
            onChange={(e) => set({ azureRegion: e.target.value.trim() })}
          />
        </label>
        <label className="flex items-center gap-2">
          <span>Azure voice</span>
          <input
            className={`${inputClass} w-44`}
            value={cloud.azureVoice}
            placeholder="name from Azure's voice list"
            onChange={(e) => set({ azureVoice: e.target.value.trim() })}
          />
        </label>
        <label className="flex items-center gap-2">
          <span>Sarvam voice</span>
          <input
            className={inputClass}
            value={cloud.sarvamSpeaker}
            placeholder="default"
            onChange={(e) => set({ sarvamSpeaker: e.target.value.trim() })}
          />
        </label>
      </div>
      <label className="flex flex-wrap items-center gap-2">
        <span className="text-foreground">Speak replies with</span>
        <select
          className={`${inputClass} w-64`}
          value={cloud.speakWith}
          onChange={(e) => set({ speakWith: e.target.value as VoiceCloudPrefs["speakWith"] })}
        >
          <option value="">This PC and the free Neural voice (default)</option>
          <option value="sarvam">Sarvam AI (Indian female voice, cloud)</option>
          <option value="azure-speech">Azure Speech (the voice named above, cloud)</option>
        </select>
      </label>
      {cloud.speakWith === "sarvam" ? (
        <ToggleRow
          label="Stream Sarvam speech"
          hint="One open connection for all clauses of a reply instead of a request each. Needs a Sarvam voice named like aparna_hi_customer (bulbul v4 flash); any clause the stream cannot make is spoken by the normal Sarvam request. Off by default and not yet run against a live account."
          on={cloud.streaming}
          onToggle={() => set({ streaming: !cloud.streaming })}
        />
      ) : null}
      {cloud.allowedProviders.includes("sarvam") ? (
        <ToggleRow
          label="Live captions from Sarvam"
          hint="Shows Hindi, English and Hinglish words as you speak. Sends the audio of what you say to Sarvam, only while you speak, and only with cloud voice on, a saved key, privacy mode off and quota left. It draws words only; the reply still comes from the normal listening path. Off by default and not yet run against a live account."
          on={cloud.streamCaptions}
          onToggle={() => set({ streamCaptions: !cloud.streamCaptions })}
        />
      ) : null}
      {cloud.speakWith ? (
        <p>
          Each clause of a reply is sent to {cloud.speakWith === "sarvam" ? "Sarvam" : "Azure"} and
          counted against your quota. It needs cloud voice on, the provider allowed, a saved key,
          and privacy mode off. Anything that looks sensitive is never sent, and when the cloud
          refuses or fails the normal voice speaks.
        </p>
      ) : null}
      <datalist id="sarvam-voices">
        {[
          "anushka",
          "manisha",
          "vidya",
          "arya",
          "ritu",
          "priya",
          "neha",
          "pooja",
          "simran",
          "kavya",
          "ishita",
          "shreya",
          "roopa",
          "tanya",
          "shruti",
          "suhani",
          "kavitha",
          "rupali",
          "aparna_hi_customer",
          "ritu_hi_customer",
          "simran_enhi_customer",
          "shubh_hi_devotional",
        ].map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <p>
        Sarvam voices: anushka, manisha, vidya and arya are stated as female by Sarvam (bulbul:v2,
        the default is anushka). The other names listed are bulbul:v3 voices whose gender Sarvam
        does not state; listen and choose.
      </p>
      <p>
        bulbul:v4-flash voices are named like aparna_hi_customer (name, language, style; enhi is
        English mixed with Hindi). Those four names come from Sarvam's pages and an outside plan;
        none is stated female, and not every voice is equally good in every language. Use the Hindi,
        Hinglish and Indian English samples above to listen to each, then keep the one you like.
      </p>
      {line ? <p>{line}</p> : null}
    </div>
  );
}

/** Words the voice should say differently, and a preview of how a sentence is prepared for speech. */
function PronunciationSettings() {
  const prefs = usePreferences();
  const entries = sanitizePronunciations(prefs.voice.pronunciations);
  const [written, setWritten] = useState("");
  const [said, setSaid] = useState("");
  const [sample, setSample] = useState(
    "आपका बिल ₹1,200 है, pay by 25/01/2026 at 5:30 pm. GST 18%.",
  );
  const save = (next: Record<string, string>) =>
    preferences.setVoice({ pronunciations: sanitizePronunciations(next) });
  return (
    <div className="grid gap-1">
      <p className="text-foreground">How words are said</p>
      <p>
        Numbers, money, dates and times are said as words in each language. Add a word below to
        change how it is said (a name, a brand). Your entries win over the built-in ones.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          className={inputClass}
          placeholder="written"
          value={written}
          onChange={(e) => setWritten(e.target.value)}
        />
        <span>→</span>
        <input
          className={`${inputClass} w-44`}
          placeholder="said as"
          value={said}
          onChange={(e) => setSaid(e.target.value)}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={!written.trim() || !said.trim()}
          onClick={() => {
            save({ ...entries, [written.trim()]: said.trim() });
            setWritten("");
            setSaid("");
          }}
        >
          Add
        </Button>
      </div>
      {Object.entries(entries).map(([key, value]) => (
        <p key={key} className="flex items-center gap-2">
          <span className="text-foreground">{key}</span> → {value}
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              save(Object.fromEntries(Object.entries(entries).filter(([k]) => k !== key)))
            }
          >
            Remove
          </Button>
        </p>
      ))}
      <label className="grid gap-1">
        <span>Try a sentence</span>
        <input
          className={`${inputClass} w-full`}
          value={sample}
          onChange={(e) => setSample(e.target.value)}
        />
      </label>
      <p>
        <span className="text-foreground">Said as:</span>{" "}
        {prepareForSpeech(sample, entries) || "nothing speakable"}
      </p>
    </div>
  );
}

/**
 * Cloud voice limits and the machine profile, in plain words. Everything here starts off and at zero. The
 * decision rows show what the router would pick right now; they change nothing by themselves.
 */
export function VoiceEngineSettings() {
  const prefs = usePreferences();
  const billing = useBilling();
  const sample = useSystemSample();
  const [keys, setKeys] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let live = true;
    const api = desktopApi();
    void Promise.all([
      api?.providerKeys?.() ?? Promise.resolve({}),
      api?.voiceCloudKeyStatus?.() ?? Promise.resolve({}),
    ])
      .then(([chat, speech]) => live && setKeys({ ...(chat ?? {}), ...(speech ?? {}) }))
      .catch(() => live && setKeys({}));
    return () => {
      live = false;
    };
  }, []);

  const cloud = sanitizeCloudPrefs(prefs.voice.cloudVoice);
  const set = (patch: Partial<VoiceCloudPrefs>) =>
    preferences.setVoice({ cloudVoice: sanitizeCloudPrefs({ ...cloud, ...patch }) });
  const ledger = useMemo(() => loadLedger(storage()), []);
  const settings = toRouterSettings(cloud, keys);
  const facts = factsFromSample(sample);
  const profile = facts ? selectProfile(facts) : null;
  const cloudProviders = PROVIDERS.filter((p) => p.kind === "cloud");

  return (
    <div className="grid gap-2 rounded-md border border-border p-2 text-meta-sm text-muted-foreground">
      <p className="text-foreground">Voice engine · cloud limits and this PC</p>
      <p>
        Local is the default and the fallback. A cloud provider is used only when it is allowed
        here, has a saved key, is inside the quota you set, and privacy mode is off. A quota of 0
        means none allowed. When a quota is used up the answer is local, never a paid provider.
      </p>
      <ToggleRow
        label="Enable local AI"
        hint="On this PC. Turning it off leaves only the cloud providers you allow below."
        on={cloud.localEnabled}
        onToggle={() => set({ localEnabled: !cloud.localEnabled })}
      />
      <ToggleRow
        label="Enable cloud AI"
        hint="Off by default. Nothing is sent to a cloud provider while this is off."
        on={cloud.cloudEnabled}
        onToggle={() => set({ cloudEnabled: !cloud.cloudEnabled })}
      />
      <div className="grid gap-1">
        <p className="text-foreground">Allowed providers</p>
        {cloudProviders.map((p) => (
          <label key={p.id} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={cloud.allowedProviders.includes(p.id)}
              onChange={() =>
                set({
                  allowedProviders: cloud.allowedProviders.includes(p.id)
                    ? cloud.allowedProviders.filter((x) => x !== p.id)
                    : [...cloud.allowedProviders, p.id],
                })
              }
            />
            <span className="text-foreground">{p.label}</span>
            <span>
              · {keys[p.id] ? "key saved" : "no key"} · {p.note}
            </span>
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {(
          [
            ["dailyRequests", "Requests per day"],
            ["monthlyRequests", "Requests per month"],
            ["monthlyAudioMinutes", "Audio minutes per month"],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="flex items-center gap-2">
            <span>{label}</span>
            <input
              type="number"
              min={0}
              className={inputClass}
              value={cloud[key]}
              onChange={(e) => set({ [key]: Number(e.target.value) } as Partial<VoiceCloudPrefs>)}
            />
          </label>
        ))}
      </div>
      <ToggleRow
        label="Paid usage allowed"
        hint={`Off by default. The billing firewall must also allow paid use (it is ${billing.billing.paidAccess ? "on" : "off"} now).`}
        on={cloud.paidAllowed}
        onToggle={() => set({ paidAllowed: !cloud.paidAllowed })}
      />
      {cloud.paidAllowed ? (
        <div className="grid gap-1">
          <ToggleRow
            label="I approve paid voice use"
            hint="Without this, a paid provider is never chosen, whatever the allowance."
            on={cloud.paidApproved}
            onToggle={() => set({ paidApproved: !cloud.paidApproved })}
          />
          <label className="flex items-center gap-2">
            <span>Spend limit (USD)</span>
            <input
              type="number"
              min={0}
              className={inputClass}
              value={cloud.spendLimitUsd}
              onChange={(e) => set({ spendLimitUsd: Number(e.target.value) })}
            />
          </label>
        </div>
      ) : null}
      <div className="grid gap-1">
        <p className="text-foreground">What would be used right now</p>
        {NEEDS.map(({ need, label }) => {
          const d = routeVoice(
            {
              need,
              sensitive: false,
              privacyMode: prefs.voice.privacyMode === true,
              billingAllowsPaid: billing.billing.paidAccess,
              online: typeof navigator === "undefined" ? true : navigator.onLine,
            },
            settings,
            ledger,
          );
          return (
            <p key={need}>
              <span className="text-foreground">{label}:</span> {d.provider?.label ?? "nothing"} (
              {d.active}) — {d.reason}
            </p>
          );
        })}
      </div>
      <PronunciationSettings />
      <CloudSpeechTest cloud={cloud} keys={keys} ledger={ledger} setKeys={setKeys} set={set} />
      <RealtimeCloudSession prefs={cloud} keys={keys} />
      <div className="grid gap-1">
        <p className="text-foreground">Cloud use counted so far</p>
        {Object.keys(ledger.snapshot()).length === 0 ? (
          <p>No cloud request has been counted.</p>
        ) : (
          Object.entries(ledger.snapshot()).map(([id, u]) => (
            <p key={id}>
              {id}: {u.day} today · {u.month} this month · {Math.round(u.audioMinutes * 10) / 10}{" "}
              audio min
            </p>
          ))
        )}
      </div>
      <div className="grid gap-1">
        <p className="text-foreground">Profile for this PC</p>
        {profile && facts ? (
          <>
            <p>
              {profile.name} — {profile.reasons.join("; ")}.
            </p>
            <p>
              Listening: faster-whisper {profile.stt.model} on {profile.stt.device} (
              {profile.stt.computeType}, {profile.stt.threads} threads). Answers:{" "}
              {profile.llm.model} on {profile.llm.device}, context {profile.llm.context}. Speech:
              Supertonic on the CPU. One background worker.
            </p>
            <p>
              A suggestion only; nothing is changed or downloaded. Models it would use that may need
              your yes to download: {missingModels(profile, {}).join(", ")} (installed models are
              not checked here).
            </p>
          </>
        ) : (
          <p>No live machine reading yet (it needs the desktop app), so no profile is suggested.</p>
        )}
      </div>
    </div>
  );
}
