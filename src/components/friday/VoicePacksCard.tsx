import { useMemo, useState } from "react";
import { Download, Languages, RotateCcw, ShieldCheck, Square, WifiOff, Wrench } from "lucide-react";
import {
  ActionButton,
  EmptyState,
  HudPanel,
  LoadingState,
  MetricBar,
  StatusPill,
} from "@/components/friday/ui";
import { ErrorState } from "@/components/friday/PageStates";
import { assistantMode } from "@/lib/friday/assistant-mode";
import { isDesktopApp } from "@/lib/friday/desktop";
import { packMembers, voicePacks } from "@/lib/friday/model-catalog";
import { bundleFit, fitTitle, type FitState } from "@/lib/friday/installer-fit";
import { models } from "@/lib/friday/models-engine";
import { preferences } from "@/lib/friday/preferences";
import { useInstallerCatalog } from "@/lib/friday/use-installer-catalog";
import { useKernelStatus } from "@/lib/friday/use-kernel-status";
import { useModels } from "@/lib/friday/use-models";
import { usePreferences } from "@/lib/friday/use-preferences";
import {
  damagedFromChecks,
  languageHint,
  packCardModel,
  voicePackActions,
  type PackCardInput,
  type VoicePackActions,
} from "@/lib/friday/voice-pack-view";

export type VoicePacksCardViewProps = PackCardInput & {
  /** The recognition language set in Settings now. */
  recognitionLang: string;
  /** The desktop app or the kernel is not connected: nothing can be installed. */
  offline: boolean;
  loading: boolean;
  /** The file check could not run. The packs stay on screen. */
  error: unknown;
  checking: boolean;
  /** One line about the last button press. */
  notice: string;
  actions: VoicePackActions;
  /** Each pack's fit for this PC, from the installer catalogue (absent until it has been read). */
  fit?: Record<string, { state: FitState; lines: string[] }>;
};

/**
 * Voice language packs: Hindi, English and Hinglish, each one a bundle of models this app already pins. The
 * status comes from what is really installed, the buttons call the pack store, and a pack that stopped part
 * way says where and offers to carry on. Drawn from props so every state can be shown without a desktop.
 */
export function VoicePacksCardView({
  recognitionLang,
  offline,
  loading,
  error,
  checking,
  notice,
  actions,
  fit,
  ...input
}: VoicePacksCardViewProps) {
  const cards = voicePacks.map((pack) => packCardModel(pack, input));
  const anyRunning = cards.some((card) => card.running);
  return (
    <HudPanel
      title="Voice language packs"
      hint="install Hindi, English or Hinglish in one click"
      actions={
        <ActionButton
          icon={ShieldCheck}
          label="Check files"
          labelMode="inline"
          title="Reads every installed voice file against its pinned checksum, so a damaged file is fetched again. This can take a minute."
          busy={checking}
          disabled={offline}
          onClick={() => actions.check()}
        />
      }
    >
      <div className="space-y-3">
        {offline ? (
          <p
            role="status"
            data-offline-banner
            className="flex items-center gap-2 text-meta text-warning"
          >
            <WifiOff className="size-3.5 shrink-0" aria-hidden="true" />
            <span>
              The FRIDAY desktop app or its kernel is not connected, so a pack cannot be installed
              now. What is installed stays listed, and installing comes back when it reconnects.
            </span>
          </p>
        ) : null}
        {loading ? <LoadingState label="Reading what is installed…" rows={2} /> : null}
        {error ? (
          <ErrorState
            title="The installed voice files could not be checked"
            error={error}
            onRetry={() => void actions.check()}
            className="py-3"
          />
        ) : null}
        {!loading && cards.length === 0 ? (
          <EmptyState title="No voice language packs" hint="The catalog has none to offer." />
        ) : null}
        {!loading
          ? cards.map((card) => {
              const { pack, status } = card;
              const inUse = recognitionLang === pack.recognitionLang;
              const blocked = offline || (anyRunning && !card.running);
              return (
                <article
                  key={pack.id}
                  aria-label={pack.label}
                  className="space-y-2 rounded-surface border border-border/60 bg-muted/20 p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="min-w-0 flex-1 text-sm font-medium text-foreground">
                      {pack.label}
                    </h3>
                    <StatusPill label={card.badge.label} tone={card.badge.tone} />
                    {status.damaged.length > 0 ? (
                      <StatusPill label={`${status.damaged.length} damaged`} tone="warning" />
                    ) : null}
                    <span className="text-meta text-muted-foreground">{card.totalLabel}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{pack.description}</p>
                  <p className="text-meta-sm text-muted-foreground">{languageHint(pack)}</p>
                  {fit?.[pack.id] ? (
                    <div data-pack-fit={fit[pack.id]!.state} className="space-y-0.5">
                      <StatusPill
                        label={fitTitle(fit[pack.id]!.state)}
                        tone={
                          fit[pack.id]!.state === "supported"
                            ? "accent"
                            : fit[pack.id]!.state === "limited"
                              ? "warning"
                              : "muted"
                        }
                      />
                      {fit[pack.id]!.lines.map((line) => (
                        <p key={line} className="text-meta-sm text-warning">
                          {line}
                        </p>
                      ))}
                    </div>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2">
                    {card.action !== "none" ? (
                      <ActionButton
                        icon={
                          card.action === "resume"
                            ? RotateCcw
                            : card.action === "repair"
                              ? Wrench
                              : Download
                        }
                        label={
                          card.action === "resume"
                            ? "Run again to continue"
                            : card.action === "repair"
                              ? "Repair"
                              : "Install all"
                        }
                        labelMode="inline"
                        title={
                          offline
                            ? "Installing needs the desktop app and its kernel"
                            : anyRunning
                              ? "Another pack is installing; one at a time"
                              : "Downloads only what is missing, checks every file against its pin"
                        }
                        disabled={blocked}
                        onClick={() => actions.install(pack.id, card.damaged)}
                      />
                    ) : null}
                    {card.running ? (
                      <ActionButton
                        icon={Square}
                        label="Stop"
                        labelMode="inline"
                        title="Stops after the file that is downloading now; what finished stays installed"
                        onClick={() => actions.stop(pack.id)}
                      />
                    ) : null}
                    {status.state === "installed" && !inUse ? (
                      <ActionButton
                        icon={Languages}
                        label="Use this language"
                        labelMode="inline"
                        title="Sets Settings > Voice > Recognition language to this pack's language"
                        onClick={() => actions.useLanguage(pack.id)}
                      />
                    ) : null}
                    {status.state === "installed" && inUse ? (
                      <StatusPill label="In use" tone="accent" />
                    ) : null}
                  </div>
                  {card.progress ? (
                    <MetricBar
                      label={`Downloading: ${card.progress.label}`}
                      value={card.progress.percent}
                      detail={`${card.progress.done} of ${card.progress.total} models ready`}
                    />
                  ) : null}
                  {card.failure ? (
                    <p role="alert" className="text-xs text-destructive">
                      Stopped at {card.failure.id}: {card.failure.error}. What finished stays
                      installed; run it again to continue.
                    </p>
                  ) : null}
                  {card.stopped ? (
                    <p role="status" className="text-xs text-muted-foreground">
                      Stopped. What finished stays installed; run it again to continue.
                    </p>
                  ) : null}
                  <ul className="space-y-1">
                    {card.rows.map((row) => (
                      <li key={row.id} className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="min-w-0 flex-1 text-foreground" title={row.id}>
                          {row.role}
                        </span>
                        <span className="text-meta-sm text-muted-foreground">{row.sizeLabel}</span>
                        <StatusPill label={row.stateLabel} tone={row.tone} />
                      </li>
                    ))}
                  </ul>
                </article>
              );
            })
          : null}
        {notice ? (
          <p role="status" className="text-xs text-muted-foreground">
            {notice}
          </p>
        ) : null}
      </div>
    </HudPanel>
  );
}

/** Reads the real model store, the kernel status and the saved recognition language. */
export function VoicePacksCard() {
  const state = useModels();
  const catalog = useInstallerCatalog().catalog;
  const prefs = usePreferences();
  const kernel = useKernelStatus();
  const [damaged, setDamaged] = useState<string[]>([]);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");

  const actions = useMemo<VoicePackActions>(() => {
    const base = voicePackActions({
      store: models,
      setVoice: (patch) => preferences.setVoice(patch),
      note: setNotice,
      setDamaged,
    });
    return {
      ...base,
      check: async () => {
        setChecking(true);
        setError(null);
        try {
          const result = await assistantMode.verifyVoiceRuntime({ heal: false });
          if (result.checks.some((check) => check.id === "desktop" && !check.ok))
            throw new Error("The voice check runs in the installed FRIDAY app.");
          const hasPins = result.checks.some((check) => /-pin(-|$)/.test(check.id));
          const stopped = result.checks.find((check) => check.id === "stt-model" && !check.ok);
          if (!hasPins && stopped)
            throw new Error(stopped.detail || "The speech files could not be read.");
          const bad = damagedFromChecks(result.checks);
          setDamaged(bad);
          setNotice(
            bad.length
              ? `${bad.length} voice model(s) failed their checksum. Repair fetches only those again.`
              : "Every installed voice file matches its pin.",
          );
        } catch (err) {
          setError(err instanceof Error ? err : new Error(String(err)));
        } finally {
          setChecking(false);
        }
      },
    };
  }, []);

  const packFits = useMemo(() => {
    const out: Record<string, { state: FitState; lines: string[] }> = {};
    for (const pack of voicePacks) {
      const found = bundleFit(
        catalog,
        packMembers(pack, { sttSize: prefs.voice.sttSize }).map((member) => `voice:${member.id}`),
      );
      if (found) out[pack.id] = found;
    }
    return out;
  }, [catalog, prefs.voice.sttSize]);

  return (
    <VoicePacksCardView
      installed={state.installed}
      jobs={state.jobs}
      packRuns={state.packRuns}
      damaged={damaged}
      sttSize={prefs.voice.sttSize}
      recognitionLang={prefs.voice.recognitionLang}
      offline={state.bridge !== "desktop" || (isDesktopApp() && !kernel.connected)}
      loading={state.scanning && state.lastScanAt == null}
      error={error}
      checking={checking}
      notice={notice}
      actions={actions}
      fit={packFits}
    />
  );
}
