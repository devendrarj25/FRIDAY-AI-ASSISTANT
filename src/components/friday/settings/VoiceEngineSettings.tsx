import { useEffect, useMemo, useState } from "react";
import { ToggleRow } from "@/components/friday/ui";
import { desktopApi } from "@/lib/friday/desktop";
import { preferences } from "@/lib/friday/preferences";
import { useBilling } from "@/lib/friday/use-billing";
import { usePreferences } from "@/lib/friday/use-preferences";
import { useSystemSample } from "@/lib/friday/use-live-metrics";
import { missingModels, selectProfile } from "@/lib/friday/voice-engine/hardware-profile";
import {
  factsFromSample,
  loadLedger,
  sanitizeCloudPrefs,
  toRouterSettings,
  type VoiceCloudPrefs,
} from "@/lib/friday/voice-engine/voice-cloud-settings";
import { PROVIDERS, routeVoice, type Need } from "@/lib/friday/voice-engine/voice-provider-router";

const NEEDS: { need: Need; label: string }[] = [
  { need: "text", label: "Answers" },
  { need: "stt", label: "Listening" },
  { need: "tts", label: "Speaking" },
  { need: "realtime-audio", label: "Realtime audio" },
];

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
    void desktopApi()
      ?.providerKeys?.()
      .then((saved) => live && setKeys(saved ?? {}))
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
