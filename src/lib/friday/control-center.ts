/**
 * FRIDAY · owner control on the existing System page.
 *
 * One list of senses, listeners, recorders, and the autonomy dial.
 * Panic is stop-everything plus every sense off. It does not add a page.
 */

import { redactRunText } from "./self/run-receipt";
import { SENSE_IDS, SENSE_LABEL, SENSE_TOGGLE, stopAllPatch, type SenseId } from "./senses";

export type ControlKind = "sense" | "listener" | "recorder" | "autonomy";

export type ControlRow = {
  id: string;
  label: string;
  kind: ControlKind;
  on: boolean;
  detail: string;
  stop: string;
};

export type ControlInput = {
  toggles?: Record<string, boolean | undefined>;
  halted: boolean;
  level: "strict" | "balanced" | "trusted" | "full";
  listening: boolean;
  handsFree: boolean;
  screenOn: boolean;
  cameraOn: boolean;
  consent: boolean;
  lastEventAt: number | null;
  lastReceipt: string;
};

const LEVEL = {
  strict: "Ask every time",
  balanced: "Balanced",
  trusted: "Trusted",
  full: "Full",
} as const;

function when(at: number | null): string {
  if (at == null || !Number.isFinite(at)) return "no event yet";
  return `last event ${Math.floor(at)}`;
}

/** Every switch the owner can see. Missing means off. */
export function controlRows(input: ControlInput): ControlRow[] {
  const toggles = input.toggles ?? {};
  const receipt = redactRunText(input.lastReceipt).trim();
  const event = when(input.lastEventAt);
  const senses = SENSE_IDS.map((id: SenseId) => ({
    id: `sense:${id}`,
    label: SENSE_LABEL[id],
    kind: "sense" as const,
    on: toggles[SENSE_TOGGLE[id]] === true,
    detail: event,
    stop: "turn this sense off",
  }));
  return [
    ...senses,
    {
      id: "listener:mic",
      label: "Microphone",
      kind: "listener",
      on: input.listening,
      detail: "Auto mode is the only microphone. Manual and chat stay quiet.",
      stop: "leave Auto mode",
    },
    {
      id: "listener:hands-free",
      label: "Hands-free",
      kind: "listener",
      on: input.handsFree,
      detail: "Off until the wake word. Turning it off needs the wake word again.",
      stop: "turn hands-free off",
    },
    {
      id: "recorder:screen",
      label: "Screen",
      kind: "recorder",
      on: input.screenOn,
      detail: "Off until you start a capture.",
      stop: "turn screen capture off",
    },
    {
      id: "recorder:camera",
      label: "Camera",
      kind: "recorder",
      on: input.cameraOn,
      detail: "Off until you start a capture.",
      stop: "turn the camera off",
    },
    {
      id: "recorder:watch",
      label: "Learn by watching",
      kind: "recorder",
      on: input.consent,
      detail: "A recording stays off until you start it.",
      stop: "clear recording consent",
    },
    {
      id: "autonomy:dial",
      label: "Autonomy",
      kind: "autonomy",
      on: !input.halted,
      detail: input.halted
        ? "Stop everything is on."
        : `${LEVEL[input.level]}. Last receipt: ${receipt || "none"}.`,
      stop: "stop everything",
    },
  ];
}

/** Panic. Senses go off and stop-everything stays on until the owner resumes. */
export function panicPlan(): { halt: true; handsFree: false; toggles: Record<string, boolean> } {
  return { halt: true, handsFree: false, toggles: stopAllPatch() };
}

type ControlNotes = { senseAt: number | null; receipt: string };
let notes: ControlNotes = { senseAt: null, receipt: "" };
const listeners = new Set<() => void>();

export function controlNotes(): ControlNotes {
  return notes;
}

export function subscribeControl(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function noteSense(at: number): void {
  if (!Number.isFinite(at)) return;
  notes = { senseAt: at, receipt: notes.receipt };
  listeners.forEach((listener) => listener());
}

export function noteReceipt(text: string): void {
  notes = { senseAt: notes.senseAt, receipt: redactRunText(text).slice(0, 80) };
  listeners.forEach((listener) => listener());
}
