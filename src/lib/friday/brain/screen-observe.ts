/**
 * FRIDAY · read-only screen observation
 *
 * Uses the existing renderer wrapper over the desktop screen-vision bridge.
 * This module never captures pixels and never clicks, types, or drives the
 * UI. Pixel capture stays on the existing write-risk `screen-capture` tool;
 * OCR stays on `screen.read_text` (exec). Both already go through
 * tool-authority / owner approval. No new IPC, no governance bypass.
 */

import {
  readScreenVision,
  screenVisionSnapshot,
  type ScreenVisionState,
} from "../screen-awareness";

const LOOK =
  /\b(look at (the |my )?screen|what(?:'s| is) on (my |the )?screen|screenshot|screen vision|window list|capture the screen)\b/i;

export function screenLookRequested(text: string): boolean {
  return LOOK.test(String(text || ""));
}

export type ScreenObservation = {
  readOnly: true;
  capturedPixels: false;
  supported: boolean;
  enabled: boolean;
  captures: number;
  lastCaptureAt: number | null;
  summary: string;
};

export function observationFromState(snap: ScreenVisionState): ScreenObservation {
  let summary: string;
  if (!snap.supported) {
    summary = "desktop bridge unavailable — no pixels captured (read-only state only)";
  } else if (!snap.enabled) {
    summary = "screen vision disabled by owner — no pixels captured";
  } else {
    summary = `screen vision enabled (captures=${snap.captures}); pixels only via the existing write-risk capture tool after approval`;
  }
  return {
    readOnly: true,
    capturedPixels: false,
    supported: snap.supported,
    enabled: snap.enabled,
    captures: snap.captures,
    lastCaptureAt: snap.lastCaptureAt,
    summary,
  };
}

/** Synchronous last-known state. Never captures. */
export function observeScreenState(): ScreenObservation {
  return observationFromState(screenVisionSnapshot());
}

/** Refresh state over the existing `screen:state` IPC. Never captures. */
export async function refreshScreenObservation(): Promise<ScreenObservation> {
  const snap = await readScreenVision();
  return observationFromState(snap);
}
