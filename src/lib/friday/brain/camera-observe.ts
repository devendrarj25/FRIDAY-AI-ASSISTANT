/**
 * FRIDAY · read-only camera observation
 *
 * Core Brain only reads last-known camera state. Pixels stay on the write-risk
 * camera-capture / camera-clip tools (and the phone 📷 button) after the owner
 * acts. No new IPC from this module.
 */

import { cameraSnapshot, readCamera, type CameraState } from "../camera-awareness";

const LOOK =
  /\b(look at (the |my )?camera|webcam|take a (photo|picture|still)|camera still|short clip|what do you see on (the |my )?camera)\b/i;

export function cameraLookRequested(text: string): boolean {
  return LOOK.test(String(text || ""));
}

export type CameraObservation = {
  readOnly: true;
  capturedPixels: false;
  supported: boolean;
  enabled: boolean;
  captures: number;
  lastCaptureAt: number | null;
  summary: string;
};

export function observationFromCamera(snap: CameraState): CameraObservation {
  let summary: string;
  if (!snap.supported) {
    summary = "desktop bridge unavailable — no camera pixels captured (read-only state only)";
  } else if (!snap.captures) {
    summary =
      "camera ingest ready; pixels only via the existing write-risk camera-capture / camera-clip tools after approval";
  } else {
    summary = `camera ingest available (captures=${snap.captures}); last file is recorded, pixels stay behind the write-risk capture tool`;
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

export function observeCameraState(): CameraObservation {
  return observationFromCamera(cameraSnapshot());
}

export async function refreshCameraObservation(): Promise<CameraObservation> {
  const snap = await readCamera();
  return observationFromCamera(snap);
}
