import { useEffect, useState, useSyncExternalStore } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { HudPanel, ToggleRow } from "@/components/friday/ui";
import { brain as brainStore } from "@/lib/friday/brain-engine";
import {
  identity,
  type AnswerFormat,
  type ReplyEmoji,
  type ReplyHumour,
  type ReplyLanguage,
  type ReplyTone,
  type WhenUncertain,
} from "@/lib/friday/brain/identity";
import { userProfile, type AddressAs } from "@/lib/friday/brain/user-profile";
import { PROJECT_IDENTITY } from "@/lib/friday/brain/project-identity";
import { useBrain } from "@/lib/friday/use-brain";
import { preferences, DEFAULT_PREFERENCES } from "@/lib/friday/preferences";
import { usePreferences } from "@/lib/friday/use-preferences";
import { useModels } from "@/lib/friday/use-models";
import {
  modelRegistry,
  QUALITY_TARGETS,
  QUALITY_TARGET_LABELS,
  ROUTE_MODES,
  ROUTE_MODE_LABELS,
  ROUTE_MODE_HINTS,
  ROUTE_STRATEGIES,
  ROUTE_STRATEGY_LABELS,
} from "@/lib/friday/model-registry";
import { useModelRegistry } from "@/lib/friday/use-model-registry";
import { modelById, type RoutingTask } from "@/lib/friday/model-catalog";
import { Field, EditField, SelectField } from "@/components/friday/settings/fields";
import { shouldRememberChats } from "@/lib/friday/settings-runtime";
import { toast } from "sonner";

/**
 * AI settings — extracted from src/routes/settings.tsx without changing the
 * JSX, handlers, or stores. CompanionSetting moved with it because it only
 * rendered inside this panel.
 */
export function AISettings() {
  const navigate = useNavigate();
  const prefs = usePreferences();
  const brainState = useBrain();
  const identityState = useSyncExternalStore(
    identity.subscribe,
    identity.getSnapshot,
    identity.getSnapshot,
  );
  const userState = useSyncExternalStore(
    userProfile.subscribe,
    userProfile.getSnapshot,
    userProfile.getSnapshot,
  );
  const modelsState = useModels();
  const registry = useModelRegistry();
  const routedLabel = (task: RoutingTask) => {
    const id = modelsState.routing[task];
    if (!id) return "not routed";
    return modelById.get(id)?.name ?? id;
  };
  const brainModel = modelById.get(modelsState.routing.brain ?? "");
  const contextLabel = brainModel
    ? `${brainModel.name} · ${brainModel.ctxK}k context`
    : "no brain model routed";

  return (
    <HudPanel title="AI Settings">
      <p className="label-xs text-muted-foreground">You</p>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Saved about you — also by telling FRIDAY. Not the project owner.
      </p>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        <EditField
          label="Preferred name (optional)"
          value={userState.preferredName}
          onChange={(value) => userProfile.update({ preferredName: value })}
        />
        <SelectField
          label="Address me as"
          value={userState.addressAs}
          options={[
            { value: "sir", label: "Sir" },
            { value: "boss", label: "Boss" },
            { value: "none", label: "Don't use an honorific" },
            { value: "custom", label: "Custom" },
          ]}
          onChange={(value) => userProfile.update({ addressAs: value as AddressAs })}
        />
      </div>
      {userState.addressAs === "custom" ? (
        <div className="mt-3">
          <EditField
            label="Custom honorific"
            value={userState.customHonorific}
            onChange={(value) => userProfile.update({ customHonorific: value })}
          />
        </div>
      ) : null}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <EditField
          label="Work / role"
          value={userState.occupation}
          onChange={(value) => userProfile.update({ occupation: value })}
        />
        <EditField
          label="Location"
          value={userState.location}
          onChange={(value) => userProfile.update({ location: value })}
        />
        <EditField
          label="Languages you speak"
          value={userState.languages}
          onChange={(value) => userProfile.update({ languages: value })}
        />
      </div>
      <p className="label-xs mt-3 text-muted-foreground">About you</p>
      <Textarea
        value={userState.about}
        onChange={(e) => userProfile.update({ about: e.target.value })}
        placeholder="Anything she should know about you — work, language, habits. Not used as a greeting name."
        className="mt-2 min-h-24 border-primary/25 bg-surface font-mono text-xs"
      />
      <p className="label-xs mt-3 text-muted-foreground">Standing notes</p>
      <Textarea
        value={userState.notes}
        onChange={(e) => userProfile.update({ notes: e.target.value })}
        placeholder='Facts to keep — same store as saying "remember that …".'
        className="mt-2 min-h-24 border-primary/25 bg-surface font-mono text-xs"
      />
      <ToggleRow
        label="Use my name when addressing me"
        hint="Off by default. Honorifics (sir / Boss) stay; your name stays out of hi/bye."
        on={userState.useNameInAddress}
        onToggle={() => userProfile.update({ useNameInAddress: !userState.useNameInAddress })}
      />

      <p className="label-xs mt-4 text-muted-foreground">FRIDAY</p>
      <p className="mt-1 text-[11px] text-muted-foreground">
        How she behaves. Same store as telling her in chat. Not your profile, not the publisher.
      </p>
      <p className="label-xs mt-3 text-muted-foreground">Personality</p>
      <Textarea
        value={prefs.fields["personality"] ?? ""}
        onChange={(e) => preferences.setField("personality", e.target.value)}
        className="mt-2 min-h-32 border-primary/25 bg-surface font-mono text-xs"
      />
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <SelectField
          label="Tone"
          value={identityState.profile.tone}
          options={[
            { value: "warm", label: "Warm" },
            { value: "professional", label: "Professional" },
            { value: "playful", label: "Playful" },
            { value: "direct", label: "Direct" },
          ]}
          onChange={(value) => identity.updateProfile({ tone: value as ReplyTone })}
        />
        <SelectField
          label="Humour"
          value={identityState.profile.humour}
          options={[
            { value: "none", label: "None" },
            { value: "light", label: "Light" },
            { value: "dry", label: "Dry" },
          ]}
          onChange={(value) => identity.updateProfile({ humour: value as ReplyHumour })}
        />
        <SelectField
          label="Emoji"
          value={identityState.profile.emoji}
          options={[
            { value: "off", label: "Off" },
            { value: "sparse", label: "Sparse" },
            { value: "on", label: "On" },
          ]}
          onChange={(value) => identity.updateProfile({ emoji: value as ReplyEmoji })}
        />
        <SelectField
          label="Reply language"
          value={identityState.profile.replyLanguage}
          options={[
            { value: "follow-user", label: "Follow what I write" },
            { value: "hinglish", label: "Hinglish" },
            { value: "english", label: "English" },
            { value: "hindi", label: "Hindi" },
          ]}
          onChange={(value) => identity.updateProfile({ replyLanguage: value as ReplyLanguage })}
        />
        <SelectField
          label="Answer format"
          value={identityState.profile.answerFormat}
          options={[
            { value: "auto", label: "Auto" },
            { value: "prose", label: "Prose" },
            { value: "bullets", label: "Bullets" },
          ]}
          onChange={(value) => identity.updateProfile({ answerFormat: value as AnswerFormat })}
        />
        <SelectField
          label="When uncertain"
          value={identityState.profile.whenUncertain}
          options={[
            { value: "ask", label: "Ask me" },
            { value: "guess-and-flag", label: "Guess and flag" },
            { value: "say-unknown", label: "Say you don't know" },
          ]}
          onChange={(value) => identity.updateProfile({ whenUncertain: value as WhenUncertain })}
        />
      </div>
      {/* Live routing from the Models manager — never a placeholder. */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Field label="Brain role model" value={routedLabel("brain")} />
        <Field label="Coder role model" value={routedLabel("coding")} />
        <Field label="Research role model" value={routedLabel("research")} />
        <Field label="Embeddings" value={routedLabel("embedding")} />
      </div>

      {/* Answer style + owner instructions. These compile into the one
          system prompt every model receives (brain/identity.ts), so
          they apply to local and cloud models alike. */}
      <div className="mt-4">
        <p className="label-xs text-muted-foreground">Answer style</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {(
            [
              ["brief", "Brief"],
              ["balanced", "Balanced"],
              ["detailed", "Detailed"],
            ] as const
          ).map(([value, label]) => (
            <Button
              key={value}
              size="sm"
              variant={identityState.profile.responseStyle === value ? "default" : "outline"}
              onClick={() => identity.updateProfile({ responseStyle: value })}
            >
              {label}
            </Button>
          ))}
        </div>
        <ToggleRow
          label="Show her reasoning steps in replies"
          on={identityState.profile.showReasoning}
          onToggle={() =>
            identity.updateProfile({ showReasoning: !identityState.profile.showReasoning })
          }
        />
        <p className="label-xs mt-3 text-muted-foreground">Custom instructions</p>
        <Textarea
          value={identityState.profile.customInstructions}
          placeholder="Anything she should always do or never do — how to address you, formats you prefer, tools to avoid."
          onChange={(e) => identity.updateProfile({ customInstructions: e.target.value })}
          className="mt-2 min-h-24 border-primary/25 bg-surface font-mono text-xs"
        />
      </div>

      <div className="mt-4">
        <p className="label-xs text-muted-foreground">Project identity (fixed)</p>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Creator, publisher and copyright. Cannot be changed here or by telling FRIDAY.
        </p>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <Field label="Project owner (fixed)" value={PROJECT_IDENTITY.publisher} />
          <Field label="GitHub" value={PROJECT_IDENTITY.github} />
          <Field label="Copyright (fixed)" value={PROJECT_IDENTITY.copyright} />
        </div>
      </div>

      {/* Real brain switches — these are the same flags the runtime
          reads on every turn, persisted with the rest of the brain. */}
      <div className="mt-4">
        <p className="label-xs text-muted-foreground">Reasoning &amp; routing</p>
        <ToggleRow
          label="Answer with multiple models and reconcile"
          on={brainState.settings.multiModel}
          onToggle={() => brainStore.toggleSetting("multiModel")}
        />
        <ToggleRow
          label="Use FRIDAY's knowledge base for context"
          on={brainState.settings.useKnowledge}
          onToggle={() => brainStore.toggleSetting("useKnowledge")}
        />
        <ToggleRow
          label="Use project memory (workspace context)"
          on={brainState.settings.useProjectMemory}
          onToggle={() => brainStore.toggleSetting("useProjectMemory")}
        />
        <ToggleRow
          label="Learn from finished tasks"
          on={brainState.settings.autoLearn}
          onToggle={() => brainStore.toggleSetting("autoLearn")}
        />
        <ToggleRow
          label="Confirm before consequential actions"
          on={brainState.settings.confirmImportant}
          onToggle={() => brainStore.toggleSetting("confirmImportant")}
        />
        <ToggleRow
          label="Propose self-improvements in the background"
          on={brainState.settings.selfImprove}
          onToggle={() => brainStore.toggleSetting("selfImprove")}
        />
        <ToggleRow
          label="Speak replies in Auto mode"
          hint="Manual and chat stay silent"
          on={prefs.voice.speakReplies}
          onToggle={() => {
            const next = !prefs.voice.speakReplies;
            preferences.setVoice({ speakReplies: next });
            if (brainState.settings.voiceReplies !== next) brainStore.toggleSetting("voiceReplies");
          }}
        />
        <ToggleRow
          label="Check for model/app updates on start"
          on={brainState.settings.checkUpdatesOnStart}
          onToggle={() => brainStore.toggleSetting("checkUpdatesOnStart")}
        />
      </div>

      {/* Routing mode — the same switch the Models page and the main-process
          router read. Not a display-only copy. */}
      <div className="mt-4">
        <p className="label-xs text-muted-foreground">Routing mode</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {ROUTE_MODES.map((mode) => (
            <Button
              key={mode}
              size="sm"
              variant={registry.routeMode === mode ? "default" : "outline"}
              className="h-7 px-3 text-xs"
              onClick={() => void modelRegistry.setRouteMode(mode)}
            >
              {ROUTE_MODE_LABELS[mode]}
            </Button>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          {ROUTE_MODE_HINTS[registry.routeMode]}
        </p>
      </div>

      <div className="mt-4">
        <p className="label-xs text-muted-foreground">Quality target</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {QUALITY_TARGETS.map((target) => (
            <Button
              key={target}
              size="sm"
              variant={registry.qualityTarget === target ? "default" : "outline"}
              className="h-7 px-3 text-xs"
              onClick={() => void modelRegistry.setQualityTarget(target)}
            >
              {QUALITY_TARGET_LABELS[target]}
            </Button>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Balanced keeps today's order. Private keeps the prompt on this PC.
        </p>
      </div>

      <div className="mt-4">
        <p className="label-xs text-muted-foreground">Multi strategy</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {ROUTE_STRATEGIES.map((strategy) => (
            <Button
              key={strategy}
              size="sm"
              variant={registry.strategy === strategy ? "default" : "outline"}
              className="h-7 px-3 text-xs"
              onClick={() => void modelRegistry.setStrategy(strategy)}
            >
              {ROUTE_STRATEGY_LABELS[strategy]}
            </Button>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Auto keeps one answer, and a second-opinion run stays parallel until you pick another
          shape.
        </p>
      </div>

      {/* Free API connection policy — enforced by the model router on
          every turn, not a display preference. */}
      <div className="mt-4">
        <p className="label-xs text-muted-foreground">Free API connections</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {(
            [
              ["free-only", "Free only"],
              ["free-preferred", "Free preferred"],
              ["allow-paid", "Allow paid"],
              ["paid-only", "Paid only"],
            ] as const
          ).map(([value, label]) => (
            <Button
              key={value}
              size="sm"
              variant={registry.policy === value ? "default" : "outline"}
              className="h-7 px-3 text-xs"
              onClick={() => void modelRegistry.setPolicy(value)}
            >
              {label}
            </Button>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          {registry.models.filter((m) => m.eligible).length} of {registry.models.length} detected
          models are eligible under this policy. Paid models stay blocked unless “Allow paid” or
          “Paid only” is selected. “Paid only” never uses free or local models.
        </p>
      </div>

      <CompanionSetting />

      <div className="mt-4">
        <p className="label-xs text-muted-foreground">Memory in replies</p>
        <ToggleRow
          label="Remember conversations automatically"
          on={shouldRememberChats()}
          onToggle={() => preferences.setToggle("rememberChats", !shouldRememberChats())}
        />
        <p className="mt-2 text-[11px] text-muted-foreground">
          Off pauses new memory writes (Claude-style). Existing records stay until you clear them on
          Memory.
        </p>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Field label="Routed brain context" value={contextLabel} />
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => void navigate({ to: "/models" })}>
          Open Models →
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            preferences.setField("personality", DEFAULT_PREFERENCES.fields["personality"] ?? "");
            toast.success("Personality notes restored");
          }}
        >
          Reset personality notes
        </Button>
      </div>
    </HudPanel>
  );
}

/**
 * Phone companion access. The local AI service listens on the WiFi network
 * only while this is on; everything stays inside the network and a phone still
 * has to be paired with a one-time code before it can talk to FRIDAY.
 */
const companionBridge = () =>
  (
    window as unknown as {
      friday?: {
        companionEnabled?: () => Promise<{ enabled: boolean }>;
        setCompanionEnabled?: (value: boolean) => Promise<unknown>;
        companionRemote?: () => Promise<{
          enabled: boolean;
          available: boolean;
          url: string | null;
          detail: string;
        } | null>;
        setCompanionRemote?: (value: boolean) => Promise<{
          enabled: boolean;
          available: boolean;
          url: string | null;
          detail: string;
        } | null>;
      };
    }
  ).friday;

function CompanionSetting() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [remote, setRemote] = useState<{
    enabled: boolean;
    available: boolean;
    url: string | null;
    detail: string;
  } | null>(null);

  useEffect(() => {
    const api = companionBridge();
    if (!api?.companionEnabled) return;
    void api.companionEnabled().then((state) => setEnabled(Boolean(state?.enabled)));
    void api.companionRemote?.().then((state) => setRemote(state ?? null));
  }, []);

  if (enabled === null) return null;

  return (
    <div className="mt-4">
      <ToggleRow
        label="Allow phone companion on this WiFi network"
        on={enabled}
        onToggle={() => {
          const next = !enabled;
          const api = companionBridge();
          if (!api?.setCompanionEnabled) {
            toast.error("Companion access is applied by the FRIDAY desktop app");
            return;
          }
          setEnabled(next);
          void Promise.resolve(api.setCompanionEnabled(next)).catch(() => {
            setEnabled(!next);
            toast.error("Could not change companion access");
          });
        }}
      />
      <p className="mt-2 text-[11px] text-muted-foreground">
        Off means loopback only. On, a phone on the same network can open FRIDAY after entering a
        one-time pairing code from the Devices page. Nothing is relayed over the internet.
      </p>
      {remote ? (
        <>
          <div className="mt-3">
            <ToggleRow
              label="Also reach FRIDAY off this network (private device network)"
              on={remote.enabled}
              onToggle={() => {
                const snapshot = remote;
                const next = !snapshot.enabled;
                setRemote({ ...snapshot, enabled: next });
                const api = companionBridge();
                if (!api?.setCompanionRemote) {
                  setRemote(snapshot);
                  toast.error("Off-network companion is applied by the FRIDAY desktop app");
                  return;
                }
                void Promise.resolve(api.setCompanionRemote(next))
                  .then((state) => setRemote(state ?? { ...snapshot, enabled: next }))
                  .catch(() => {
                    setRemote(snapshot);
                    toast.error("Could not change off-network companion access");
                  });
              }}
            />
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            {remote.detail}
            {remote.url ? ` Open ${remote.url} on your paired phone.` : ""}
          </p>
        </>
      ) : null}
    </div>
  );
}
