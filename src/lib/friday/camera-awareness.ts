/**
 * FRIDAY · camera awareness (renderer side)
 *
 * Thin wrapper over the main-process webcam bridge. Without the desktop app,
 * or when getUserMedia fails, the caller gets the real error — never a
 * placeholder image.
 */

export type CameraState = {
  enabled: boolean;
  lastCaptureAt: number | null;
  captures: number;
  lastFile: string | null;
  supported: boolean;
};

export type CameraCapture = {
  ok: boolean;
  kind?: "still" | "clip";
  file?: string;
  frames?: string[];
  at?: number;
  captures?: number;
  error?: string;
};

type CameraApi = {
  cameraState?: () => Promise<Omit<CameraState, "supported">>;
  setCamera?: (patch: { enabled?: boolean }) => Promise<Omit<CameraState, "supported">>;
  captureCamera?: (options?: { dataUrl?: string }) => Promise<CameraCapture>;
  ingestCamera?: (payload: { dataUrl: string }) => Promise<CameraCapture>;
  clipCamera?: (options?: { frames?: number }) => Promise<CameraCapture>;
};

const UNAVAILABLE = "camera capture needs the FRIDAY desktop app";

const api = (): CameraApi | undefined =>
  typeof window === "undefined" ? undefined : (window.friday as unknown as CameraApi | undefined);

const OFFLINE: CameraState = {
  enabled: false,
  lastCaptureAt: null,
  captures: 0,
  lastFile: null,
  supported: false,
};

let cached: CameraState = OFFLINE;

export const cameraSnapshot = (): CameraState => cached;

/** Owner stop. A missing desktop bridge leaves the camera off. */
export async function setCameraEnabled(enabled: boolean): Promise<CameraState> {
  const bridge = api();
  if (!bridge?.setCamera) return (cached = { ...OFFLINE, enabled: false });
  try {
    const state = await bridge.setCamera({ enabled });
    cached = { ...OFFLINE, ...state, supported: true };
    return cached;
  } catch {
    return (cached = { ...OFFLINE, enabled: false });
  }
}

export async function readCamera(): Promise<CameraState> {
  const bridge = api();
  if (!bridge?.cameraState) return (cached = OFFLINE);
  try {
    const state = await bridge.cameraState();
    cached = { ...OFFLINE, ...state, supported: true };
    return cached;
  } catch {
    return (cached = OFFLINE);
  }
}

async function captureFromDevice(): Promise<string> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("this environment has no webcam API");
  }
  const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  try {
    const video = document.createElement("video");
    video.autoplay = true;
    video.muted = true;
    video.srcObject = stream;
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error("webcam video element failed"));
      setTimeout(() => reject(new Error("webcam start timed out")), 8000);
    });
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("could not draw the webcam frame");
    ctx.drawImage(video, 0, 0);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    stream.getTracks().forEach((track) => track.stop());
  }
}

/** Renderer getUserMedia still, then the same main-process ingest the tools use. */
export async function captureCameraStill(): Promise<CameraCapture> {
  const bridge = api();
  if (!bridge?.ingestCamera && !bridge?.captureCamera) return { ok: false, error: UNAVAILABLE };
  try {
    const dataUrl = await captureFromDevice();
    if (bridge.ingestCamera) return await bridge.ingestCamera({ dataUrl });
    return (await bridge.captureCamera?.({ dataUrl })) ?? { ok: false, error: UNAVAILABLE };
  } catch (error) {
    return { ok: false, error: String((error as Error)?.message ?? error) };
  }
}
