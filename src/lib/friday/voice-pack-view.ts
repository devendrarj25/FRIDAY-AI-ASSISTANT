/**
 * What the Voice language packs card shows and does, as plain functions: the status of each pack from what is
 * installed, the run that is moving, the members the Doctor found damaged, and the three buttons. The store
 * (`models-engine.ts`) does the installing; this file only reads it and calls it.
 */
import {
  ENGLISH_EAR_CHOICES,
  modelById,
  packStatus,
  voicePacks,
  type InstalledIds,
  type PackMemberState,
  type PackStatus,
  type VoicePack,
} from "./model-catalog";
import {
  formatGb,
  isJobActive,
  type Job,
  type PackRunResult,
  type PackRunState,
} from "./models-engine";

export type PackCardInput = {
  installed: InstalledIds;
  jobs: readonly Job[];
  packRuns: Readonly<Record<string, PackRunState | undefined>>;
  /** Catalog ids the Doctor found on disk but failing their pin. */
  damaged: readonly string[];
  sttSize?: string | undefined;
};

export type MemberDisplay =
  "installed" | "not installed" | "damaged" | "waiting" | "downloading" | "failed";

export type PackMemberRow = {
  id: string;
  role: string;
  sizeLabel: string;
  state: MemberDisplay;
  /** Words for the state: "downloading 42%", the failure reason, or the plain state. */
  stateLabel: string;
  tone: "accent" | "warning" | "destructive" | "muted" | "primary";
};

export type PackCardModel = {
  pack: VoicePack;
  status: PackStatus;
  badge: { label: string; tone: "accent" | "warning" | "muted" };
  totalLabel: string;
  rows: PackMemberRow[];
  running: boolean;
  /** What the install button does now: fetch, fetch again what is damaged, or carry on after a stop. */
  action: "install" | "repair" | "resume" | "none";
  failure: { id: string; error: string } | null;
  stopped: boolean;
  progress: { label: string; percent: number; done: number; total: number } | null;
  /** The members to fetch again, to hand to the store. */
  damaged: string[];
};

const sizeLabel = (bytes: number) => formatGb(bytes / 1024 ** 3);

/** The last run of a pack, only while it still matters to the page (moving, failed, or stopped). */
function activeRun(pack: VoicePack, input: PackCardInput): PackRunState | null {
  const run = input.packRuns[pack.id];
  return run && run.phase !== "done" ? run : null;
}

export function packCardModel(pack: VoicePack, input: PackCardInput): PackCardModel {
  const status = packStatus(pack, input.installed, {
    damaged: input.damaged,
    sttSize: input.sttSize,
  });
  const run = activeRun(pack, input);
  const running = run?.phase === "running";
  const failure = run?.phase === "failed" ? run.failed : null;
  const stopped = run?.phase === "cancelled";
  const jobOf = (id: string) =>
    input.jobs.find((job) => job.modelId === id && isJobActive(job.phase));

  const rows: PackMemberRow[] = status.members.map((member) => {
    const base = (state: PackMemberState): Pick<PackMemberRow, "state" | "stateLabel" | "tone"> =>
      state === "installed"
        ? { state: "installed", stateLabel: "installed", tone: "accent" }
        : state === "damaged"
          ? { state: "damaged", stateLabel: "damaged, install fetches it again", tone: "warning" }
          : { state: "not installed", stateLabel: "not installed", tone: "muted" };
    let shown = base(member.state);
    if (run && failure && failure.id === member.id) {
      shown = { state: "failed", stateLabel: `failed: ${failure.error}`, tone: "destructive" };
    } else if (running && run) {
      if (run.current === member.id) {
        const job = jobOf(member.id);
        const percent = job ? Math.max(0, Math.min(100, Math.round(job.progress))) : 0;
        shown = {
          state: "downloading",
          stateLabel: job ? `downloading ${percent}%` : "starting",
          tone: "primary",
        };
      } else if (member.state !== "installed" && run.remaining.includes(member.id)) {
        shown = { state: "waiting", stateLabel: "waiting", tone: "muted" };
      }
    }
    return {
      id: member.id,
      role: member.role,
      sizeLabel: sizeLabel(member.bytes),
      ...shown,
    };
  });

  let progress: PackCardModel["progress"] = null;
  if (running && run) {
    const total = status.members.length;
    const done = status.members.filter((m) => m.state === "installed").length;
    const current = run.current ? status.members.find((m) => m.id === run.current) : undefined;
    const job = current ? jobOf(current.id) : undefined;
    progress = {
      label: current ? current.role : "Starting",
      percent: job ? Math.max(0, Math.min(100, Math.round(job.progress))) : 0,
      done,
      total,
    };
  }

  const badge: PackCardModel["badge"] =
    status.state === "installed"
      ? { label: "Installed", tone: "accent" }
      : status.state === "partial"
        ? { label: "Partly installed", tone: "warning" }
        : { label: "Not installed", tone: "muted" };

  const action: PackCardModel["action"] =
    status.state === "installed"
      ? "none"
      : failure || stopped
        ? "resume"
        : status.missing.length === 0 && status.damaged.length > 0
          ? "repair"
          : "install";

  return {
    pack,
    status,
    badge,
    totalLabel: sizeLabel(status.bytesTotal),
    rows,
    running,
    action: running ? "none" : action,
    failure,
    stopped,
    progress,
    damaged: status.damaged,
  };
}

/**
 * Catalog ids of the members whose Doctor pin row failed. The rows are `<catalog id>-pin` for the ears, the
 * punctuation and the light voice, `tts-pin` for the neural voice and `stt-pin-<size>` for the English ear.
 */
export function damagedFromChecks(checks: ReadonlyArray<{ id: string; ok: boolean }>): string[] {
  const out = new Set<string>();
  for (const check of checks) {
    if (check.ok) continue;
    const row = String(check.id);
    let id = "";
    if (row === "tts-pin") id = "supertonic-3";
    else if (row.startsWith("stt-pin-")) {
      const size = row.slice("stt-pin-".length);
      id = Object.prototype.hasOwnProperty.call(ENGLISH_EAR_CHOICES, size)
        ? ENGLISH_EAR_CHOICES[size]!.id
        : "";
    } else if (row.endsWith("-pin") && modelById.has(row.slice(0, -"-pin".length))) {
      id = row.slice(0, -"-pin".length);
    }
    if (id) out.add(id);
  }
  return [...out];
}

const LANGUAGE_LABEL: Record<string, string> = {
  "hi-IN": "Hindi (India)",
  "hi-Latn": "Hinglish in Roman letters",
  "en-IN": "English (India)",
  "en-US": "English (US)",
};

export const languageLabel = (lang: string) => LANGUAGE_LABEL[lang] ?? lang;

/** What choosing this pack's language really does, so the button never promises a different ear. */
export function languageHint(pack: Pick<VoicePack, "recognitionLang">): string {
  if (pack.recognitionLang === "hi-IN")
    return "Hindi in Devanagari: the Hindi ear listens and writes Hindi in Devanagari letters.";
  if (pack.recognitionLang === "hi-Latn")
    return "Hinglish in Roman letters: the Hinglish ear listens only while the recognition language is hi-Latn.";
  return "English: the English ear listens and writes English.";
}

/** The pack store, as the card uses it. */
export type PackStore = {
  installPack: (
    packId: string,
    options?: { damaged?: readonly string[] },
  ) => Promise<PackRunResult>;
  cancelPack: (packId: string) => void;
};

export type VoicePackActions = {
  install: (packId: string, damaged: readonly string[]) => Promise<void>;
  stop: (packId: string) => void;
  useLanguage: (packId: string) => string;
  /** Reads the Doctor pin rows again; the connected card provides it. */
  check: () => Promise<void>;
};

/** The three buttons on the pack store. A failure becomes a line for the page, never a thrown error. */
export function voicePackActions(deps: {
  store: PackStore;
  setVoice: (patch: { recognitionLang: string }) => void;
  note: (line: string) => void;
  setDamaged: (update: (current: string[]) => string[]) => void;
  packs?: readonly VoicePack[];
}): Omit<VoicePackActions, "check"> {
  const packOf = (id: string) => (deps.packs ?? voicePacks).find((pack) => pack.id === id);
  return {
    install: async (packId, damaged) => {
      const label = packOf(packId)?.label ?? packId;
      try {
        const result = await deps.store.installPack(packId, { damaged });
        if (result.ok) {
          deps.setDamaged((current) => current.filter((id) => !result.installed.includes(id)));
          deps.note(`${label} is installed.`);
        } else if (result.cancelled) {
          deps.note(`${label} stopped. Run again to continue.`);
        } else {
          deps.note(
            `${label} stopped at ${result.failed?.id ?? "a model"}: ${result.failed?.error ?? "unknown error"}. Run again to continue.`,
          );
        }
      } catch (err) {
        deps.note(
          `${label} could not be installed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    stop: (packId) => deps.store.cancelPack(packId),
    useLanguage: (packId) => {
      const pack = packOf(packId);
      if (!pack) return "That language pack is not known.";
      deps.setVoice({ recognitionLang: pack.recognitionLang });
      return `Recognition language is now ${languageLabel(pack.recognitionLang)}. ${languageHint(pack)}`;
    },
  };
}
