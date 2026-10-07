/**
 * FRIDAY · desktop companion — bridge accessor.
 *
 * One typed door to the character IPC surface. Everything degrades to `null`
 * in the browser preview, so importing this file never breaks the web build.
 */
import { desktopApi, isDesktopApp } from "@/lib/friday/desktop";
import type { CharacterHealth, CharacterRig, CharacterSettings, CharacterState } from "./types";

type CharacterBridge = {
  characterGet: () => Promise<{
    settings: CharacterSettings;
    running: boolean;
    created: boolean;
    status: { running: boolean; lastError: string | null; recovered: number };
    trackerSupported: boolean;
  }>;
  characterSet: (patch: Partial<CharacterSettings>) => Promise<{
    settings: CharacterSettings;
    running: boolean;
    created: boolean;
    status: { running: boolean; lastError: string | null; recovered: number };
    trackerSupported: boolean;
  }>;
  characterStart: () => Promise<unknown>;
  characterStop: () => Promise<unknown>;
  characterRestart: () => Promise<unknown>;
  characterResetPosition: () => Promise<unknown>;
  characterModel: () => Promise<{ model: CharacterRig; textureUrl: string | null; ready: boolean }>;
  characterTexture: () => Promise<{ mime: string; base64: string; file: string } | null>;
  characterHealth: () => Promise<CharacterHealth>;
  characterInstall: () => Promise<{ ok: boolean; error?: string; health?: CharacterHealth }>;
  characterRepair: () => Promise<{ ok: boolean; error?: string; health?: CharacterHealth }>;
  characterUpdate: () => Promise<{ ok: boolean; updated?: boolean; health?: CharacterHealth }>;
  characterRemove: () => Promise<{ ok: boolean; health?: CharacterHealth }>;
  characterProbe: (probe: Record<string, unknown>) => Promise<unknown>;
  characterPublish: (state: Partial<CharacterState>) => Promise<unknown>;
  characterAsk: (payload: { text: string; source: string }) => Promise<unknown>;
  characterCommand: (payload: { command: string; value?: unknown }) => Promise<unknown>;
  characterDrag: (delta: { dx: number; dy: number; commit?: boolean }) => Promise<unknown>;
  characterInteractive: (on: boolean) => Promise<unknown>;
  characterShowApp: () => Promise<unknown>;
  onCharacterState: (cb: (state: CharacterState) => void) => () => void;
  onCharacterSettings: (
    cb: (payload: {
      settings: CharacterSettings;
      model: { model: CharacterRig; ready: boolean };
    }) => void,
  ) => () => void;
  onCharacterGaze: (cb: (gaze: { dx: number; dy: number; near: boolean }) => void) => () => void;
  onCharacterContext: (
    cb: (ctx: { window: { title: string; process: string; maximized: boolean } }) => void,
  ) => () => void;
  onCharacterAsk: (cb: (payload: { text: string; source: string }) => void) => () => void;
  onCharacterCommand: (cb: (payload: { command: string; value?: unknown }) => void) => () => void;
};

/** The character bridge, or null when FRIDAY runs outside the desktop app. */
export function characterBridge(): CharacterBridge | null {
  if (!isDesktopApp()) return null;
  const api = desktopApi() as unknown as Partial<CharacterBridge> | undefined;
  if (!api || typeof api.characterGet !== "function") return null;
  return api as CharacterBridge;
}

export const characterSupported = () => characterBridge() !== null;
