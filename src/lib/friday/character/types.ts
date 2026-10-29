/**
 * FRIDAY · desktop companion — shared types.
 *
 * The overlay renderer and the main window both speak this vocabulary, and
 * every value is derived from something FRIDAY really did: no decorative
 * states, no placeholder moods.
 */

/** What FRIDAY is doing right now, mapped from the real pipeline. */
export type CharacterAction =
  | "idle"
  | "listening"
  | "thinking"
  | "working"
  | "coding"
  | "searching"
  | "speaking"
  | "waiting_approval"
  | "installing"
  | "updating"
  | "success"
  | "error"
  | "offline";

/** Emotional colour, derived from the affect layer and task outcomes. */
export type CharacterEmotion =
  "calm" | "focused" | "curious" | "happy" | "concerned" | "alert" | "sleepy";

export type CharacterState = {
  at: number;
  action: CharacterAction;
  emotion: CharacterEmotion;
  /** Live caption text: the line FRIDAY is speaking or just produced. */
  speech: string;
  /** 0..1 real audio envelope for lip-sync while speaking. */
  amplitude: number;
  /** Long-running work progress (0..1) when a real task reports it. */
  progress: number | null;
  /** Short label for the speech bubble header (task or section name). */
  label: string;
  /** Set when FRIDAY needs a yes/no before a consequential action. */
  approval: { id: string; question: string } | null;
  /** True while the kernel/brain is unreachable. */
  offline: boolean;
};

export type CharacterPlacement = "free" | "title-bar" | "active-window" | "corner" | "mouse";

export type CharacterSettings = {
  enabled: boolean;
  autoStart: boolean;
  characterId: string;
  width: number;
  opacity: number;
  placement: CharacterPlacement;
  corner: "bottom-right" | "bottom-left" | "top-right" | "top-left";
  offsetX: number;
  offsetY: number;
  freeX: number | null;
  freeY: number | null;
  alwaysOnTop: boolean;
  clickThrough: boolean;
  gaze: boolean;
  followSpeed: number;
  hideOnFullscreen: boolean;
  hideWhenIdle: boolean;
  speechBubble: boolean;
  miniChat: boolean;
  voiceReplies: boolean;
  quality: "high" | "balanced" | "battery";
  reduceMotion: boolean;
  greeting: boolean;
};

export type CharacterRig = {
  id: string;
  name: string;
  version: string;
  engine: string;
  texture: string;
  crop: { u0: number; v0: number; u1: number; v1: number };
  aspect: number;
  mesh: { cols: number; rows: number };
  bones: { name: string; pivot: [number, number]; parent: string | null }[];
  landmarks: {
    eyeLeft: { cx: number; cy: number; hw: number; hh: number };
    eyeRight: { cx: number; cy: number; hw: number; hh: number };
    mouth: { cx: number; cy: number; hw: number; hh: number };
    headTop: number;
    headBottom: number;
  };
  motion: {
    breathHz: number;
    swayHz: number;
    blinkMinMs: number;
    blinkMaxMs: number;
    hairSpring: { stiffness: number; damping: number };
  };
  expressions: string[];
};

export type CharacterHealthComponent = {
  id: string;
  label: string;
  status: "ready" | "missing" | "broken" | "outdated" | "degraded" | "blocked" | "unknown";
  version: string;
  location: string;
  detail: string;
};

export type CharacterHealth = {
  id: string;
  ready: boolean;
  assetVersion: string;
  installedVersion: string | null;
  outdated: boolean;
  root: string | null;
  gpu: {
    accelerated: boolean;
    webgl: string;
    webgl2: string;
    compositing: string;
    rasterization: string;
  };
  probe: {
    at: number;
    ok: boolean;
    api: string;
    renderer: string;
    vendor: string;
    fps: number;
    frameMs: number;
    error: string | null;
  } | null;
  components: CharacterHealthComponent[];
};

export const EMPTY_STATE: CharacterState = {
  at: 0,
  action: "idle",
  emotion: "calm",
  speech: "",
  amplitude: 0,
  progress: null,
  label: "",
  approval: null,
  offline: false,
};
