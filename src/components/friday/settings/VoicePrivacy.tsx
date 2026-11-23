import { useState } from "react";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ToggleRow } from "@/components/friday/ui";
import { TuneRow } from "@/components/friday/settings/fields";
import type { VoicePrivacyStatus } from "@/lib/friday/desktop";
import { usePreferences } from "@/lib/friday/use-preferences";
import { setKeepUtteranceWavs, setUtteranceWavDays } from "@/lib/friday/voice-hearing";
import { sanitizeWavDays } from "@/lib/friday/preferences";
import { deleteMyVoiceData, giveVoiceConsent } from "@/lib/friday/voice-profile";

const sizeLine = (bytes: number) =>
  bytes >= 1_048_576
    ? `${(bytes / 1_048_576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/**
 * Settings → Voice → My voice → Privacy. Consent before a voice sample is stored, how long spoken clips are kept
 * (nothing by default), and "Delete my voice data". The desktop (electron/voice-privacy.cjs) holds the facts; this
 * only shows them and asks.
 */
export function VoicePrivacy({
  privacy,
  desktop,
  onChanged,
}: {
  privacy: VoicePrivacyStatus | null;
  desktop: boolean;
  onChanged: () => void;
}) {
  const prefs = usePreferences();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const keep = prefs.voice.keepUtteranceWavs === true;
  const days = sanitizeWavDays(prefs.voice.utteranceWavDays);
  const consented = privacy?.consent.given === true;
  const heldClips = privacy?.wavs.count ?? 0;
  const holdsData =
    consented ||
    heldClips > 0 ||
    (privacy?.enrolment.samples ?? 0) > 0 ||
    privacy?.enrolment.profile;

  const agree = async () => {
    setBusy(true);
    const answer = await giveVoiceConsent();
    setBusy(false);
    setResult(answer.ok ? null : answer.message);
    if (answer.ok) toast.success("Saved: you can now record your voice");
    onChanged();
  };

  const remove = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 5000);
      return;
    }
    setConfirmDelete(false);
    setBusy(true);
    const answer = await deleteMyVoiceData();
    setBusy(false);
    setResult(answer.message);
    if (answer.ok) toast.success("Your voice data was deleted");
    onChanged();
  };

  return (
    <div className="grid gap-2 border-t border-border/60 pt-2" data-testid="voice-privacy">
      <p className="text-foreground">Privacy</p>
      <p>
        FRIDAY saves no recording of your voice unless you ask. Voice samples and the voiceprint
        stay on this PC; the voiceprint is encrypted. Recording a sample needs your agreement first,
        and only the time you agreed is stored.
      </p>
      {consented ? (
        <p>
          You agreed on{" "}
          <span className="text-foreground">
            {new Date(privacy?.consent.givenAt ?? 0).toLocaleString()}
          </span>
          .
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span>Not agreed yet: samples cannot be recorded.</span>
          <Button size="sm" disabled={!desktop || busy} onClick={() => agree()}>
            I agree: allow FRIDAY to store my voice samples
          </Button>
        </div>
      )}
      <ToggleRow
        label="Keep my spoken clips for diagnostics"
        hint={`Off by default, so no raw audio is saved. When on, the last few spoken clips stay as WAV files on this PC for ${days} day${days === 1 ? "" : "s"}, then they are deleted.`}
        on={keep}
        onToggle={() => setKeepUtteranceWavs(!keep)}
      />
      {keep ? (
        <TuneRow
          label="Keep clips for"
          value={days}
          min={privacy?.limits.minDays ?? 1}
          max={privacy?.limits.maxDays ?? 90}
          step={1}
          detail={`${days} day${days === 1 ? "" : "s"}`}
          onChange={(next) => setUtteranceWavDays(next)}
        />
      ) : null}
      {heldClips > 0 ? (
        <p>
          {heldClips} kept clip{heldClips === 1 ? "" : "s"} on this PC (
          {sizeLine(privacy?.wavs.bytes ?? 0)}).
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!desktop || busy || (privacy !== null && !holdsData && !result)}
          onClick={() => remove()}
        >
          <Trash2 className="mr-1 h-3 w-3" />
          {confirmDelete ? "Click again to delete" : "Delete my voice data"}
        </Button>
        <span>Removes your recordings, voiceprint, kept clips and your agreement.</span>
      </div>
      {result ? (
        <p className="text-foreground" role="status">
          {result}
        </p>
      ) : null}
    </div>
  );
}
