import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Mic, Play, Square, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ToggleRow } from "@/components/friday/ui";
import { EditField } from "@/components/friday/settings/fields";
import { VoicePrivacy } from "@/components/friday/settings/VoicePrivacy";
import { desktopApi } from "@/lib/friday/desktop";
import type { VoiceMatchResult, VoicePrivacyStatus } from "@/lib/friday/desktop";
import { preferences } from "@/lib/friday/preferences";
import { usePreferences } from "@/lib/friday/use-preferences";
import { useVoiceProfile } from "@/lib/friday/use-voice-profile";
import {
  ALL_PROMPTS,
  GOOD_WAKE_TAKES,
  MIN_SPEECH_CLIPS,
  buildProfile,
  clearRecordings,
  deleteSample,
  enrollProgress,
  forgetMyVoice,
  loadVoicePrivacy,
  parseThreshold,
  promptText,
  saveSample,
  type EnrollPrompt,
} from "@/lib/friday/voice-profile";
import {
  MAX_SAMPLE_MS,
  startEnrollRecording,
  type EnrollRecorder,
  type EnrollRecording,
} from "@/lib/friday/voice-enroll-recorder";

const pct = (value: number | undefined) =>
  value === undefined ? "—" : `${Math.round(value * 100)}%`;

function Meter({ level }: { level: number }) {
  return (
    <div className="h-1.5 w-24 overflow-hidden rounded bg-border" aria-hidden>
      <div
        className="h-full bg-primary transition-[width] duration-100"
        style={{ width: `${Math.round(Math.min(1, level) * 100)}%` }}
      />
    </div>
  );
}

/**
 * Settings → Voice → My voice. The owner records guided samples; FRIDAY builds a voiceprint and a personal "Friday"
 * template from them (kept encrypted on this PC) and may use them to recognise the owner, wake on the owner's
 * voice and hear the owner better. A voice match never approves an action.
 */
export function VoiceEnrollment() {
  const status = useVoiceProfile();
  const prefs = usePreferences();
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [confirmForget, setConfirmForget] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<VoiceMatchResult | null>(null);
  const [privacy, setPrivacy] = useState<VoicePrivacyStatus | null>(null);
  const recorder = useRef<EnrollRecorder | null>(null);
  const playing = useRef<HTMLAudioElement | null>(null);

  const wakeWord = prefs.voice.wakeWord || "Friday";
  const counts = status?.counts;
  const progress = enrollProgress(counts);
  const summary = status?.profile.summary ?? null;
  const built = status?.profile.built === true;
  const desktop = Boolean(desktopApi()?.voiceEnrollStatus);
  const consented = privacy?.consent.given === true;

  const reloadPrivacy = () => void loadVoicePrivacy().then(setPrivacy);

  useEffect(() => {
    reloadPrivacy();
  }, []);

  useEffect(
    () => () => {
      recorder.current?.cancel();
      playing.current?.pause();
    },
    [],
  );

  const takesFor = (prompt: EnrollPrompt) =>
    (status?.samples ?? []).filter((sample) => sample.promptId === prompt.id);

  const record = async (prompt: EnrollPrompt, take: number) => {
    if (recordingId) return;
    setNote(null);
    const started = await startEnrollRecording({
      deviceId: prefs.voice.inputDeviceId || null,
      onLevel: setLevel,
      onAutoStop: (recording) => void keep(prompt, take, recording),
    });
    if (!started.ok) {
      setNote(started.error);
      return;
    }
    recorder.current = started.recorder;
    setRecordingId(`${prompt.id}-${take}`);
  };

  const keep = async (prompt: EnrollPrompt, take: number, recording: EnrollRecording) => {
    recorder.current = null;
    setRecordingId(null);
    setLevel(0);
    if (recording.durationMs < 400) {
      setNote("That was too short. Press Record, speak, then Stop.");
      return;
    }
    setBusy(true);
    const saved = await saveSample({
      prompt,
      take,
      text: promptText(prompt, wakeWord),
      wavBytes: recording.wavBytes,
    });
    setBusy(false);
    setNote(saved.ok ? null : saved.message);
    if (saved.ok) toast.success("Sample saved");
    reloadPrivacy();
  };

  const stop = async (prompt: EnrollPrompt, take: number) => {
    const active = recorder.current;
    if (!active) return;
    await keep(prompt, take, await active.stop());
  };

  const play = async (id: string) => {
    const api = desktopApi();
    const read = await api?.voiceEnrollReadSample?.(id);
    if (!read?.ok || !read.bytes) {
      setNote("That recording could not be read.");
      return;
    }
    playing.current?.pause();
    const url = URL.createObjectURL(new Blob([read.bytes as BlobPart], { type: "audio/wav" }));
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    playing.current = audio;
    void audio.play().catch(() => URL.revokeObjectURL(url));
  };

  const build = async () => {
    setBusy(true);
    setNote("Building your voice profile…");
    const result = await buildProfile();
    setBusy(false);
    setNote(result.ok ? null : result.message);
    if (result.ok) toast.success(result.message);
  };

  const test = async () => {
    if (recordingId || testing) return;
    setTestResult(null);
    const started = await startEnrollRecording({
      deviceId: prefs.voice.inputDeviceId || null,
      onLevel: setLevel,
    });
    if (!started.ok) {
      setNote(started.error);
      return;
    }
    setTesting(true);
    setNote("Listening for 4 seconds. Say a sentence.");
    await new Promise((resolve) => setTimeout(resolve, 4000));
    const recording = await started.recorder.stop();
    setLevel(0);
    const api = desktopApi();
    const result = await api?.voiceEnrollScore?.({
      audioBytes: recording.wavBytes,
      mime: "audio/wav",
    });
    setTesting(false);
    setNote(null);
    setTestResult(result ?? null);
  };

  const forget = async () => {
    if (!confirmForget) {
      setConfirmForget(true);
      setTimeout(() => setConfirmForget(false), 5000);
      return;
    }
    setConfirmForget(false);
    await forgetMyVoice();
    setTestResult(null);
    reloadPrivacy();
    toast.success("Your voice recordings and profile were removed");
  };

  const threshold = parseThreshold(prefs.fields["speakerThreshold"]);

  return (
    <div className="grid gap-3 rounded-md border border-border p-3 text-meta-sm text-muted-foreground">
      <div>
        <p className="text-foreground">My voice</p>
        <p>
          Record a few sentences so FRIDAY can recognise you, wake up to your voice and hear you
          better. The recordings stay on this PC in your FRIDAY folder and the voiceprint is
          encrypted; nothing is uploaded. A voice match never approves an action, and it is a
          convenience, not a lock.
        </p>
        {!desktop ? <p className="mt-1">Recording needs the FRIDAY desktop app.</p> : null}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-foreground">
          Wake word takes {progress.wakeTakes}/{GOOD_WAKE_TAKES}
        </span>
        <span className="text-foreground">
          Sentences {progress.speechClips}/{MIN_SPEECH_CLIPS}+ ({progress.speechSeconds}s)
        </span>
        {built ? (
          <span className="text-foreground">
            Profile built{status?.profile.stale ? " (recordings changed since: build again)" : ""}
          </span>
        ) : (
          <span>No profile built yet</span>
        )}
      </div>
      {progress.missing ? <p>{progress.missing}</p> : null}

      <ul className="grid gap-1">
        {ALL_PROMPTS.map((prompt) => {
          const takes = takesFor(prompt);
          const take = prompt.kind === "wake" ? 1 : 1;
          const id = `${prompt.id}-${take}`;
          const active = recordingId === id;
          const done = takes.length > 0;
          return (
            <li
              key={prompt.id}
              className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 py-1 last:border-0"
            >
              <span className="min-w-0 flex-1">
                <span className="text-foreground">{promptText(prompt, wakeWord)}</span>{" "}
                <span>({prompt.hint})</span>
                {done ? <span className="ml-1 text-primary">✓</span> : null}
              </span>
              <span className="flex items-center gap-1">
                {active ? <Meter level={level} /> : null}
                {active ? (
                  <Button size="sm" variant="outline" onClick={() => stop(prompt, take)}>
                    <Square className="mr-1 h-3 w-3" />
                    Stop
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!desktop || !consented || busy || Boolean(recordingId) || testing}
                    onClick={() => record(prompt, take)}
                    aria-label={`${done ? "Re-record" : "Record"}: ${promptText(prompt, wakeWord)}`}
                  >
                    <Mic className="mr-1 h-3 w-3" />
                    {done ? "Redo" : "Record"}
                  </Button>
                )}
                {done ? (
                  <>
                    <Button size="sm" variant="ghost" aria-label="Play" onClick={() => play(id)}>
                      <Play className="h-3 w-3" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label="Delete this recording"
                      onClick={() => deleteSample(id)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
      <p>
        Each recording stops by itself after {Math.round(MAX_SAMPLE_MS / 1000)} seconds. Speak in
        your normal voice, close to the microphone, in a quiet room.
      </p>

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={busy || !progress.canBuild || Boolean(recordingId)}
          onClick={() => build()}
        >
          {built ? "Build again" : "Build my voice profile"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!built || testing || Boolean(recordingId)}
          onClick={() => test()}
        >
          {testing ? "Listening…" : "Test: say a sentence"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!counts?.total}
          onClick={() =>
            clearRecordings().then(() => toast.success("Recordings deleted; the profile is kept"))
          }
        >
          Delete recordings, keep profile
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!counts?.total && !built}
          onClick={() => forget()}
        >
          {confirmForget ? "Click again to forget" : "Forget my voice"}
        </Button>
        {testing ? <Meter level={level} /> : null}
      </div>
      {note ? <p className="text-foreground">{note}</p> : null}
      <VoicePrivacy privacy={privacy} desktop={desktop} onChanged={reloadPrivacy} />

      {summary?.speaker || summary?.wake ? (
        <div className="grid gap-1">
          <p className="text-foreground">What was built</p>
          {summary.speaker ? (
            <p>
              Voiceprint: {summary.speaker.ready ? "ready" : "not ready"} ({summary.speaker.clips}{" "}
              clips
              {summary.speaker.seconds ? `, ${Math.round(summary.speaker.seconds)}s` : ""}).
              {summary.speaker.reasons.length ? ` ${summary.speaker.reasons.join("; ")}.` : ""}
            </p>
          ) : null}
          {summary.wake ? (
            <p>
              Personal wake word: {summary.wake.ready ? "ready" : "not ready"} ({summary.wake.takes}{" "}
              takes
              {summary.wake.ready
                ? `; held-out takes refused ${pct(summary.wake.heldOutRefusalRate)}, your other sentences matched ${summary.wake.falseAcceptsOnOwnSentences ?? 0} time(s)`
                : ""}
              ).{summary.wake.reasons.length ? ` ${summary.wake.reasons.join("; ")}.` : ""}
            </p>
          ) : null}
          <p>
            {summary.evidence}. Use the test with someone else saying a sentence to see how far off
            they score.
          </p>
        </div>
      ) : null}

      {testResult ? (
        <div className="grid gap-1">
          <p className="text-foreground">Last test</p>
          <p>
            Voice similarity{" "}
            {testResult.speaker?.similarity == null
              ? "could not be told (too little speech)"
              : `${Math.round(testResult.speaker.similarity * 100)}% (${
                  testResult.speaker.similarity >= threshold ? "matches you" : "does not match you"
                }, bar ${Math.round(threshold * 100)}%)`}
            .
            {testResult.wake?.ready
              ? ` Personal "${wakeWord}": ${testResult.wake.matched ? "matched" : "no match"}.`
              : ""}
          </p>
        </div>
      ) : null}

      <div className="grid gap-1">
        <ToggleRow
          label="Recognise my voice"
          hint="A command that needs your confirmation is not run when the voice clearly is not yours. A match never approves anything."
          on={prefs.voice.recogniseMyVoice !== false}
          onToggle={() =>
            preferences.setVoice({ recogniseMyVoice: prefs.voice.recogniseMyVoice === false })
          }
        />
        <ToggleRow
          label="Only answer my voice"
          hint="Ignores what clearly is not your voice. A spoken stop is always heard. Off by default."
          on={prefs.voice.ownerVoiceOnly === true}
          onToggle={() =>
            preferences.setVoice({ ownerVoiceOnly: prefs.voice.ownerVoiceOnly !== true })
          }
        />
        <ToggleRow
          label="Wake on my own recordings of the wake word"
          hint="Your own takes can wake FRIDAY when the transcript wrote the word differently. Needs the personal wake word to be ready."
          on={prefs.voice.personalWake !== false}
          onToggle={() =>
            preferences.setVoice({ personalWake: prefs.voice.personalWake === false })
          }
        />
        <EditField
          label="Words and names FRIDAY should expect (comma separated)"
          value={prefs.voice.vocabulary ?? ""}
          onChange={(value) => preferences.setVoice({ vocabulary: value })}
        />
        <p>
          Names, places and Hinglish words you use often. They are a hint to the listener on this PC
          and are never sent anywhere by themselves.
        </p>
      </div>
    </div>
  );
}
