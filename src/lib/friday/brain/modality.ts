/**
 * FRIDAY · modality classification
 *
 * Every supported modality collapses to text (or an honest "cannot see
 * pixels" note) and then enters the SAME understand → memory → knowledge →
 * reason pipeline. This is not a per-modality brain.
 *
 * Supported today: typed text, voice (existing STT → same chat path),
 * documents (attachment extract / docs.extract), images (named + vision
 * role; chat IPC is still text-only so pixels are not claimed), screen
 * state (read-only observe), camera stills and short clips (write-risk
 * tools after approval). Unbounded live video watch is not a platform
 * capability — a still or short clip is.
 */

import { cameraLookRequested } from "./camera-observe";
import { screenLookRequested } from "./screen-observe";

export type ModalityKind = "text" | "voice" | "document" | "image" | "screen" | "video";

export type ModalityClass = {
  kinds: ModalityKind[];
  needsDeep: boolean;
  wantsScreen: boolean;
  wantsCamera: boolean;
  videoSupported: boolean;
  summary: string;
  notBuilt: string[];
};

const VIDEO =
  /\b(live video|webcam|camera feed|watch this video|real-?time video|video stream|camera still|short clip)\b/i;
const LIVE_WATCH =
  /\b(continuously|all day|24\/7|live (video|stream|feed)|real-?time video|video stream|watch this live)\b/i;
const IMAGE_FILE = /\ban image was attached\b/i;
const DOCUMENT_FILE = /\bFILE:|\b--- content ---|\bdocs\.extract\b/i;
const IMAGE_ASK = /\b(image|picture|photo|diagram|screenshot)\b/i;

export function classifyModality(input: {
  prompt: string;
  mode?: "manual" | "auto";
  extra?: string;
}): ModalityClass {
  const prompt = String(input.prompt || "");
  const extra = String(input.extra || "");
  const kinds = new Set<ModalityKind>(["text"]);
  const notBuilt: string[] = [];

  if (input.mode === "auto") kinds.add("voice");
  if (DOCUMENT_FILE.test(extra) || DOCUMENT_FILE.test(prompt)) kinds.add("document");
  if (IMAGE_FILE.test(extra) || IMAGE_ASK.test(prompt) || IMAGE_ASK.test(extra)) kinds.add("image");
  if (screenLookRequested(prompt) || screenLookRequested(extra)) kinds.add("screen");
  if (
    cameraLookRequested(prompt) ||
    cameraLookRequested(extra) ||
    VIDEO.test(prompt) ||
    VIDEO.test(extra)
  ) {
    kinds.add("video");
  }

  if (LIVE_WATCH.test(prompt) || LIVE_WATCH.test(extra)) {
    notBuilt.push(
      "unbounded live video watch — camera stills and short clips are available after approval",
    );
  }

  const list = [...kinds];
  const needsDeep = list.some(
    (kind) => kind === "document" || kind === "image" || kind === "screen" || kind === "video",
  );
  return {
    kinds: list,
    needsDeep,
    wantsScreen: list.includes("screen"),
    wantsCamera: list.includes("video"),
    videoSupported: true,
    summary: list.join("+"),
    notBuilt,
  };
}
