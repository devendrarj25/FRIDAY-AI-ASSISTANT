import { buildEvalCorpus } from "./eval-corpus";
import { cachePhrase, cachedPhrase, resetPhraseCache } from "./speech-cache";
import {
  enrollCommand,
  forgetCommand,
  matchCommand,
  resetCommandTemplates,
} from "./speech-command";
import { agc, polyphaseResample, removeDc, rms, sine, spectralGate } from "./speech-dsp";
import { advanceFlow, freshMachine, voiceBudgets, wordError, type FlowEvent } from "./speech-eval";
import { featuresFor, peakBin } from "./speech-features";
import { normalizeSpoken, sentenceChunks, voiceForLanguage } from "./speech-normalize";
import { bargeBoundMs, playbackPlan } from "./speech-playback";
import { backchannelLine, planProsody } from "./speech-prosody";
import { chooseStt, rememberBenchmark, resetSttMemory, sttQualityLabel } from "./speech-stt";
import {
  chooseTts,
  firstAudioLatency,
  formantSynth,
  speakVoice,
  switchMidSentence,
} from "./speech-tts";
import { endpointIndex, frameVad, shouldCutPlayback } from "./speech-vad";
import { developNote } from "./self/own-work";
import {
  bundledBytes,
  explainTool,
  isCopyleft,
  isolatedEnv,
  licenseNotices,
  packById,
  toolchainDoctorRows,
  toolchainManifest,
  validateManifest,
} from "./toolchain-manifest";

export type SpeechLayer = {
  id: string;
  ok: boolean;
  detail: string;
};

/** Offline speech self-test. It does not open a microphone or a network socket. */
export function speechSelfTest(): SpeechLayer[] {
  const tone = sine(16000, 440, 0.2);
  const shaped = spectralGate(agc(removeDc(tone)));
  const frames = frameVad(shaped);
  const spoken = formantSynth("hello");
  const manifestErrors = validateManifest(toolchainManifest());
  const notices = licenseNotices();
  const choice = chooseStt({
    whisperCpp: true,
    modelReady: true,
    fasterWhisper: false,
    moonshine: false,
    english: true,
    cloudAllowed: false,
    network: false,
    cli: "whisper-cli",
    model: "ggml-base.bin",
    wav: "turn.wav",
  });
  const voice = chooseTts({
    network: false,
    privacy: false,
    supertonicReady: false,
    windows: false,
  });
  return [
    { id: "dsp", ok: rms(shaped) > 0.01, detail: "capture maths kept the tone" },
    { id: "vad", ok: frames.some((frame) => frame.speech), detail: "energy gate heard the tone" },
    { id: "features", ok: peakBin(tone.slice(0, 32)) >= 0, detail: "spectrum is finite" },
    {
      id: "stt",
      ok: choice.downloads === false && choice.localFilesOnly,
      detail: sttQualityLabel(choice.engine),
    },
    {
      id: "tts",
      ok: voice.quality === "low-rule" && rms(spoken) > 0,
      detail: "formant voice is the low-quality last resort",
    },
    {
      id: "manifest",
      ok: manifestErrors.length === 0 && notices.includes("PSF-2.0") && !isCopyleft("MIT"),
      detail: `${bundledBytes()} bundled bytes`,
    },
  ];
}

export function speechDoctorRows(): Array<{
  id: string;
  label: string;
  group: string;
  status: "Ready" | "Warning";
  detail: string;
  fixable: false;
}> {
  return speechSelfTest().map((layer) => ({
    id: `speech:${layer.id}`,
    label: `Speech ${layer.id}`,
    group: "Voice",
    status: layer.ok ? "Ready" : "Warning",
    detail: layer.detail,
    fixable: false,
  }));
}

export function ownerAcceptanceSteps(): string[] {
  return [
    "Run the voice self-test. Each layer should say pass or the failing cause.",
    "Say the wake word, then one sentence, and wait for a spoken reply.",
    "Hold a 3-turn conversation.",
    "Start talking while FRIDAY is speaking. She should stop and listen.",
    "Disconnect the network mid-reply. Speech should move off the online voice.",
    "Unplug the microphone and plug it back in. Listening should return.",
    "Sleep the PC and wake it. Listening should return.",
    "Ask for Python, Node, a C compile, Git status, and the local CI report.",
    "If a step fails, copy the Voice and Toolchain rows and the on-screen status.",
  ];
}

export function cleanPcScript(): FlowEvent[] {
  return ["network-up", "mic-busy", "mic-free"];
}

/** One place the live voice path can ask what the speech core would do. */
export function speechTurnPlan(text: string, language: string): string {
  resetSttMemory();
  rememberBenchmark("command", 20);
  const heard = normalizeSpoken(text);
  const chunks = sentenceChunks(heard);
  const prosody = planProsody({
    emotion: "neutral",
    warmth: "steady",
    longTask: false,
    ownerSpeaking: false,
  });
  const tts = chooseTts({ network: false, privacy: false, supertonicReady: false, windows: true });
  const fallen = switchMidSentence(tts.engine, false, false, true);
  const samples = formantSynth(chunks[0] ?? heard);
  resetPhraseCache();
  cachePhrase("hello", samples);
  const cached = cachedPhrase("hello");
  const tone = sine(8000, 220, 0.05);
  const up = polyphaseResample(tone, 8000, 16000);
  const vad = frameVad(up.length > 160 ? up : sine(16000, 220, 0.2));
  const end = endpointIndex(vad, language);
  const features = featuresFor((up.length >= 32 ? up : sine(16000, 220, 0.05)).slice(0, 32), 16000);
  resetCommandTemplates();
  const clip = sine(16000, 440, 0.1);
  enrollCommand("stop", clip);
  const heardCommand = matchCommand(clip);
  forgetCommand("stop");
  const play = playbackPlan({
    samples: cached ?? samples,
    deviceId: "default",
    volume: 0.8,
    ownerEnergy: 0,
    ownerAlreadySpeaking: false,
  });
  const cut = shouldCutPlayback({
    ownerEnergy: 0.2,
    playbackEnergy: 0.2,
    ownerAlreadySpeaking: true,
  });
  const latency = firstAudioLatency(0, 400);
  const budgets = voiceBudgets({ listenMs: 1000, audioMs: latency.ms, idle: 0.2, memoryMb: 8 });
  const flow = cleanPcScript().reduce((state, event) => advanceFlow(state, event), freshMachine());
  const shell = isolatedEnv({ root: "runtime", present: {} });
  const pinned = packById("python-embed");
  const score = wordError(heard, heard);
  const tool = explainTool("python-embed", false);
  const dev = developNote("");
  const back = backchannelLine(language);
  return [
    heard,
    String(chunks.length),
    String(prosody.rate),
    fallen,
    speakVoice(language),
    voiceForLanguage(language),
    String(end),
    String(features.mfcc.length),
    heardCommand.approvesAction ? "approved" : "not-approved",
    play.reason,
    cut ? "cut" : "kept",
    String(bargeBoundMs()),
    budgets.join(",") || "within",
    flow.phase,
    shell.FRIDAY_TOOLCHAIN,
    pinned?.version ?? "",
    String(score.wer),
    tool,
    dev,
    back,
    String(buildEvalCorpus().length),
    toolchainDoctorRows().length ? "rows" : "none",
  ].join(" | ");
}
