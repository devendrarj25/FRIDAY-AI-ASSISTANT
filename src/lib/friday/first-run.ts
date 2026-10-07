/**
 * FRIDAY · first-run bootstrap (renderer side).
 *
 * `installer/first-run/index.ts` only ever tracked a completed/not-completed
 * flag; nothing was actually set up, so a fresh install had no local model, no
 * transcriber and no voice output until the owner configured all of it by
 * hand. This module performs the REAL setup, and it does it entirely through
 * the mechanisms that already exist:
 *
 *   • cloud keys      → models.connectProvider() (the same call Settings uses,
 *                       which stores the key in the encrypted credential store
 *                       and validates it against the live provider);
 *   • local model     → models.install() (Ollama registry → Hugging Face →
 *                       direct URL, the Install Manager's real downloader);
 *   • voice engines   → installer.enqueue() for the catalog rows that already
 *                       exist ("faster-whisper" for STT, "edge-tts" for TTS).
 *
 * Nothing is invented, nothing is faked and no second install path is built.
 * The completed flag lives in <root>/config/first-run.json (main process).
 * AppShell does not gate launch on that flag — the owner can run this
 * bootstrap from Models / Install Manager. It is not a startup screen.
 */

import { installer, isJobActive } from "./installer-engine";
import { models } from "./models-engine";
import type { ProviderId } from "./model-catalog";

/** One good, fast, small general-chat model — the offline fallback. */
export const BOOTSTRAP_MODEL_ID = "llama3.2-3b";

/** The voice engines Auto Mode actually needs, as named in the catalog. */
export const BOOTSTRAP_VOICE_PACKAGES = ["faster-whisper", "edge-tts"] as const;

/** Providers with a genuinely free tier the owner may paste a key for. */
export const FREE_TIER_PROVIDERS: Array<{ id: ProviderId; name: string; keysUrl: string }> = [
  { id: "groq", name: "Groq", keysUrl: "https://console.groq.com/keys" },
  { id: "openrouter", name: "OpenRouter", keysUrl: "https://openrouter.ai/keys" },
  { id: "gemini", name: "Google Gemini", keysUrl: "https://aistudio.google.com/app/apikey" },
];

export type BootstrapStep = {
  id: string;
  label: string;
  state: "pending" | "running" | "done" | "failed" | "skipped";
  detail: string;
};

export type BootstrapResult = {
  completed: boolean;
  steps: BootstrapStep[];
};

export type FirstRunRecord = {
  completed: boolean;
  completedAt: number | null;
  version: string | null;
  steps?: Array<{ id: string; state: string; detail: string }>;
};

export type VoiceCheck = { id: string; label: string; ok: boolean; detail: string };

/**
 * Real post-install verification, run in the main process: python discovery,
 * `import faster_whisper`, an actual Whisper model load, `import edge_tts` and
 * a real voice listing. Voice is only "ready" when every check passes.
 */
export async function verifyVoiceRuntime(): Promise<{ ok: boolean; checks: VoiceCheck[] }> {
  const api = bridge();
  if (!api?.verifyVoiceRuntime)
    return {
      ok: false,
      checks: [
        { id: "desktop", label: "Desktop runtime", ok: false, detail: "desktop app required" },
      ],
    };
  try {
    const result = await api.verifyVoiceRuntime({ loadModel: true });
    return { ok: Boolean(result?.ok), checks: result?.checks ?? [] };
  } catch (error) {
    return {
      ok: false,
      checks: [
        {
          id: "verify",
          label: "Voice runtime",
          ok: false,
          detail: String((error as Error)?.message || error),
        },
      ],
    };
  }
}

type FirstRunBridge = {
  verifyVoiceRuntime?: (payload?: { loadModel?: boolean }) => Promise<{
    ok: boolean;
    checks: VoiceCheck[];
  }>;
  firstRunState?: () => Promise<FirstRunRecord>;
  completeFirstRun?: (payload: {
    steps: Array<{ id: string; state: string; detail: string }>;
  }) => Promise<{ ok: boolean; error?: string }>;
};

const bridge = (): FirstRunBridge | null =>
  typeof window === "undefined"
    ? null
    : ((window as unknown as { friday?: FirstRunBridge }).friday ?? null);

/** Has this installation already finished its first run? */
export async function firstRunState(): Promise<FirstRunRecord> {
  const api = bridge();
  if (!api?.firstRunState) return { completed: true, completedAt: null, version: null };
  try {
    return await api.firstRunState();
  } catch {
    // Never block startup on a read failure — treat it as already done.
    return { completed: true, completedAt: null, version: null };
  }
}

/** Mark first run finished. Called after a real pass OR an explicit skip. */
export async function markFirstRunComplete(steps: BootstrapStep[]): Promise<void> {
  try {
    const { installCognitiveBaseline } = await import("./brain/cognitive-baseline");
    installCognitiveBaseline();
  } catch {
    /* baseline seed is best-effort — first-run must still complete */
  }
  const api = bridge();
  await api?.completeFirstRun?.({
    steps: steps.map((s) => ({ id: s.id, state: s.state, detail: s.detail })),
  });
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Poll a store until `check` reports a terminal outcome, or the deadline
 * passes. The stores are the real ones, so this observes real job phases.
 */
async function until(
  check: () => { done: boolean; ok: boolean; detail: string },
  timeoutMs: number,
): Promise<{ ok: boolean; detail: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = check();
    if (result.done) return { ok: result.ok, detail: result.detail };
    if (Date.now() > deadline) return { ok: false, detail: `${result.detail} (timed out)` };
    await wait(1000);
  }
}

/** Install one Install Manager package and report what really happened. */
export async function installVoicePackage(
  pkg: string,
  timeoutMs = 15 * 60_000,
): Promise<{ ok: boolean; detail: string }> {
  const before = installer.getSnapshot().installed[pkg];
  if (before) return { ok: true, detail: `already installed (${before})` };
  const job = installer.enqueue(pkg, "install");
  if (!job) return { ok: false, detail: `"${pkg}" is not in the Install Manager catalog` };
  return until(() => {
    const state = installer.getSnapshot();
    const live = state.jobs.find((j) => j.id === job.id) ?? job;
    if (isJobActive(live.phase)) return { done: false, ok: false, detail: live.phase };
    if (live.phase === "Done") return { done: true, ok: true, detail: live.detail || "installed" };
    return { done: true, ok: false, detail: live.error || live.detail || live.phase };
  }, timeoutMs);
}

/** Download the offline chat model through the real model downloader. */
export async function installBootstrapModel(
  modelId = BOOTSTRAP_MODEL_ID,
  timeoutMs = 45 * 60_000,
): Promise<{ ok: boolean; detail: string }> {
  if (models.getSnapshot().installed[modelId]) {
    return { ok: true, detail: "already installed" };
  }
  models.install(modelId);
  return until(() => {
    const state = models.getSnapshot();
    if (state.installed[modelId]) return { done: true, ok: true, detail: "installed" };
    const job = state.jobs.find((j) => j.modelId === modelId);
    if (!job) return { done: false, ok: false, detail: "queued" };
    if (job.phase === "Failed")
      return { done: true, ok: false, detail: job.error || job.detail || "download failed" };
    if (job.phase === "Done") return { done: true, ok: true, detail: "installed" };
    return { done: false, ok: false, detail: job.phase };
  }, timeoutMs);
}

/** Store and validate one pasted key through the existing provider path. */
export async function connectFreeProvider(
  id: ProviderId,
  apiKey: string,
): Promise<{ ok: boolean; detail: string }> {
  const key = apiKey.trim();
  if (!key) return { ok: false, detail: "no key entered" };
  models.connectProvider(id, key);
  return until(() => {
    const state = models.getSnapshot().providerState[id];
    if (!state) return { done: true, ok: false, detail: "unknown provider" };
    if (state.online)
      return { done: true, ok: true, detail: `key accepted · ${state.models} models` };
    if (state.error) return { done: true, ok: false, detail: state.error };
    return { done: false, ok: false, detail: "validating" };
  }, 60_000);
}

/**
 * The whole first-run pass. Every step runs for real; a failure is reported
 * rather than hidden, and the run still completes so the owner is not stuck on
 * a setup screen forever.
 */
export async function runFirstRunBootstrap(options: {
  keys?: Array<{ id: ProviderId; apiKey: string }>;
  onStep?: (steps: BootstrapStep[]) => void;
}): Promise<BootstrapResult> {
  const keys = (options.keys ?? []).filter((k) => k.apiKey.trim());
  const steps: BootstrapStep[] = [
    ...keys.map((k) => ({
      id: `provider:${k.id}`,
      label: `Connect ${k.id}`,
      state: "pending" as const,
      detail: "waiting",
    })),
    {
      id: `model:${BOOTSTRAP_MODEL_ID}`,
      label: "Download the offline chat model",
      state: "pending",
      detail: "waiting",
    },
    ...BOOTSTRAP_VOICE_PACKAGES.map((pkg) => ({
      id: `voice:${pkg}`,
      label: `Install ${pkg}`,
      state: "pending" as const,
      detail: "waiting",
    })),
    {
      id: "voice:verify",
      label: "Verify the voice runtime really works",
      state: "pending" as const,
      detail: "waiting",
    },
  ];
  const publish = () => options.onStep?.(steps.map((s) => ({ ...s })));
  const mark = (id: string, state: BootstrapStep["state"], detail: string) => {
    const step = steps.find((s) => s.id === id);
    if (step) {
      step.state = state;
      step.detail = detail;
    }
    publish();
  };
  publish();

  for (const entry of keys) {
    mark(`provider:${entry.id}`, "running", "validating the key");
    const result = await connectFreeProvider(entry.id, entry.apiKey);
    mark(`provider:${entry.id}`, result.ok ? "done" : "failed", result.detail);
  }

  mark(`model:${BOOTSTRAP_MODEL_ID}`, "running", "downloading");
  const model = await installBootstrapModel();
  mark(`model:${BOOTSTRAP_MODEL_ID}`, model.ok ? "done" : "failed", model.detail);

  for (const pkg of BOOTSTRAP_VOICE_PACKAGES) {
    mark(`voice:${pkg}`, "running", "installing");
    const result = await installVoicePackage(pkg);
    mark(`voice:${pkg}`, result.ok ? "done" : "failed", result.detail);
  }

  // A finished pip install is NOT a working voice: verify for real that
  // faster_whisper imports AND loads its model, and that edge_tts imports AND
  // has a usable voice. Every failure is reported exactly as the runtime saw it.
  mark("voice:verify", "running", "checking the installed voice runtime");
  const verified = await verifyVoiceRuntime();
  mark(
    "voice:verify",
    verified.ok ? "done" : "failed",
    verified.checks.map((c) => `${c.label}: ${c.detail}`).join(" · ") || "no checks ran",
  );

  await markFirstRunComplete(steps);
  return { completed: true, steps: steps.map((s) => ({ ...s })) };
}

/** The owner chose "Skip" — remember that so this never asks again. */
export async function skipFirstRun(): Promise<void> {
  await markFirstRunComplete([
    {
      id: "skipped",
      label: "Skipped by the owner",
      state: "skipped",
      detail: "no setup performed",
    },
  ]);
}
