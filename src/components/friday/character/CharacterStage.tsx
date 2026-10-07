/**
 * FRIDAY · desktop companion — overlay stage.
 *
 * This component is what actually lives inside the transparent, frameless
 * overlay window. It renders the GPU rig, the speech bubble, the approval
 * prompt and the mini chat, and it forwards everything the user does back to
 * the real FRIDAY pipeline through the character bridge.
 *
 * It is deliberately self-contained: the overlay window loads only this route,
 * so nothing from the main console is mounted twice.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, MessageSquare, Send, X } from "lucide-react";
import { characterBridge } from "@/lib/friday/character/bridge";
import { CharacterRenderer } from "@/lib/friday/character/rig";
import {
  EMPTY_STATE,
  type CharacterRig,
  type CharacterSettings,
  type CharacterState,
} from "@/lib/friday/character/types";
import { cn } from "@/lib/utils";

/** The shipped artwork, used when the installed copy cannot be read. */
const FALLBACK_TEXTURE = "/character/friday/base.png";

type Gaze = { dx: number; dy: number; near: boolean };

export function CharacterStage() {
  const bridge = useMemo(() => characterBridge(), []);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<CharacterRenderer | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  const [rig, setRig] = useState<CharacterRig | null>(null);
  const [textureSrc, setTextureSrc] = useState<string | null>(null);
  const [settings, setSettings] = useState<CharacterSettings | null>(null);
  const [state, setState] = useState<CharacterState>(EMPTY_STATE);
  const [gaze, setGaze] = useState<Gaze>({ dx: 0, dy: 0, near: false });
  const [glError, setGlError] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [hover, setHover] = useState(false);

  /* ----------------------------------------------------------- asset load */
  useEffect(() => {
    if (!bridge) {
      // Browser preview: the shipped artwork still renders, just without IPC.
      setTextureSrc(FALLBACK_TEXTURE);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const payload = await bridge.characterModel();
        if (cancelled) return;
        setRig(payload.model);
        const texture = await bridge.characterTexture();
        if (cancelled) return;
        setTextureSrc(
          texture
            ? `data:${texture.mime};base64,${texture.base64}`
            : (payload.textureUrl ?? FALLBACK_TEXTURE),
        );
      } catch (error) {
        if (!cancelled) setGlError(String((error as Error).message ?? error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  /* --------------------------------------------------------- live channels */
  useEffect(() => {
    if (!bridge) return;
    const offState = bridge.onCharacterState((next) => setState((prev) => ({ ...prev, ...next })));
    const offSettings = bridge.onCharacterSettings((payload) => {
      setSettings(payload.settings);
      if (payload.model?.model) setRig(payload.model.model);
    });
    const offGaze = bridge.onCharacterGaze((next) => setGaze(next));
    void bridge.characterGet().then((snapshot) => setSettings(snapshot.settings));
    return () => {
      offState();
      offSettings();
      offGaze();
    };
  }, [bridge]);

  /* ------------------------------------------------------------- renderer */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !rig || !textureSrc) return;
    let renderer: CharacterRenderer | null = null;
    let probeTimer = 0;
    try {
      renderer = new CharacterRenderer(canvas, rig);
    } catch (error) {
      setGlError(String((error as Error).message ?? error));
      void bridge?.characterProbe({
        ok: false,
        api: "webgl2",
        renderer: "",
        vendor: "",
        fps: 0,
        frameMs: 0,
        error: String((error as Error).message ?? error),
      });
      return;
    }
    rendererRef.current = renderer;

    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      renderer?.setTexture(image);
      renderer?.start();
      // Report the REAL measured frame rate once the rig has settled.
      probeTimer = window.setTimeout(() => {
        const probe = renderer?.probe();
        if (probe) void bridge?.characterProbe(probe);
      }, 3500);
    };
    image.onerror = () => setGlError("character artwork could not be decoded");
    image.src = textureSrc;

    const resize = () => {
      const host = stageRef.current;
      if (!host || !renderer) return;
      const rect = host.getBoundingClientRect();
      renderer.resize(rect.width, rect.height, Math.min(2, window.devicePixelRatio || 1));
    };
    resize();
    window.addEventListener("resize", resize);

    return () => {
      window.clearTimeout(probeTimer);
      window.removeEventListener("resize", resize);
      renderer?.dispose();
      rendererRef.current = null;
    };
  }, [bridge, rig, textureSrc]);

  /* ------------------------------------------------------------ pose feed */
  useEffect(() => {
    rendererRef.current?.setPose({
      action: state.action,
      emotion: state.emotion,
      amplitude: state.amplitude,
      gaze: settings?.gaze === false ? { dx: 0, dy: 0 } : { dx: gaze.dx, dy: gaze.dy },
      reduceMotion: Boolean(settings?.reduceMotion),
      quality: settings?.quality ?? "high",
    });
  }, [state.action, state.emotion, state.amplitude, gaze, settings]);

  /* ------------------------------------------------------- pointer / drag */
  const setInteractive = useCallback(
    (on: boolean) => {
      setHover(on);
      void bridge?.characterInteractive(on);
    },
    [bridge],
  );

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    dragRef.current = { x: event.screenX, y: event.screenY, moved: false };
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.screenX - drag.x;
    const dy = event.screenY - drag.y;
    if (!dx && !dy) return;
    drag.x = event.screenX;
    drag.y = event.screenY;
    drag.moved = true;
    void bridge?.characterDrag({ dx, dy });
  };
  const endDrag = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    dragRef.current = null;
    (event.target as HTMLElement).releasePointerCapture?.(event.pointerId);
    if (drag?.moved) void bridge?.characterDrag({ dx: 0, dy: 0, commit: true });
  };

  // Mouse-wheel resizing over the character: real width change, persisted by
  // the controller (which also re-lays out the overlay window).
  const wheelRef = useRef(0);
  const onWheel = (event: React.WheelEvent) => {
    if (!bridge || !settings) return;
    const now = Date.now();
    if (now - wheelRef.current < 60) return;
    wheelRef.current = now;
    const step = event.deltaY < 0 ? 12 : -12;
    const width = Math.min(560, Math.max(120, Math.round(settings.width + step)));
    if (width === settings.width) return;
    setSettings({ ...settings, width });
    void bridge.characterSet({ width });
  };

  const ask = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    void bridge?.characterAsk({ text, source: "character" });
  };

  const busy =
    state.action === "working" ||
    state.action === "thinking" ||
    state.action === "installing" ||
    state.action === "updating";
  const bubbleVisible =
    settings?.speechBubble !== false &&
    (Boolean(state.approval) || Boolean(state.speech) || busy || hover);

  return (
    <div
      className="relative h-screen w-screen overflow-hidden bg-transparent select-none"
      onPointerEnter={() => setInteractive(true)}
      onPointerLeave={() => setInteractive(false)}
    >
      {/* Speech / approval bubble */}
      {bubbleVisible ? (
        <div className="pointer-events-auto absolute inset-x-2 top-2 z-10">
          <div className="rounded-lg border border-primary/40 bg-background/85 px-3 py-2 text-[11px] leading-snug text-foreground shadow-lg backdrop-blur">
            <div className="mb-1 flex items-center gap-1.5 text-[10px] tracking-wide text-primary uppercase">
              {busy ? <Loader2 className="size-3 animate-spin" /> : null}
              <span className="truncate">{state.label || "FRIDAY"}</span>
              {state.progress !== null ? (
                <span className="ml-auto tabular-nums">{Math.round(state.progress * 100)}%</span>
              ) : null}
            </div>
            <p className="line-clamp-4 whitespace-pre-wrap">
              {state.approval ? state.approval.question : state.speech || "Ready when you are."}
            </p>
            {state.approval ? (
              <div className="mt-2 flex gap-1.5">
                <button
                  type="button"
                  className="rounded-sm bg-primary px-2 py-1 text-[10px] font-medium text-primary-foreground"
                  onClick={() => void bridge?.characterCommand({ command: "approve" })}
                >
                  Allow
                </button>
                <button
                  type="button"
                  className="rounded-sm border border-border px-2 py-1 text-[10px]"
                  onClick={() => void bridge?.characterCommand({ command: "deny" })}
                >
                  Deny
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* The character itself */}
      <div
        ref={stageRef}
        className="absolute inset-0 flex items-end justify-center"
        style={{ opacity: settings ? settings.opacity : 1 }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onWheel={onWheel}

        onDoubleClick={() => void bridge?.characterShowApp()}
      >
        {glError ? (
          // Real fallback: no GPU rig, but the companion still works.
          <img
            src={textureSrc ?? FALLBACK_TEXTURE}
            alt="FRIDAY companion"
            className={cn(
              "h-full w-full object-contain drop-shadow-[0_0_18px_rgba(80,180,255,0.35)]",
              state.action === "speaking" ? "animate-pulse" : "",
            )}
          />
        ) : (
          <canvas ref={canvasRef} className="h-full w-full" />
        )}
      </div>

      {/* Mini chat */}
      {settings?.miniChat !== false && hover ? (
        <div className="pointer-events-auto absolute inset-x-2 bottom-2 z-10">
          {chatOpen ? (
            <div className="flex items-center gap-1 rounded-lg border border-primary/40 bg-background/90 p-1 backdrop-blur">
              <input
                autoFocus
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") ask();
                  if (event.key === "Escape") setChatOpen(false);
                }}
                placeholder="Ask FRIDAY…"
                className="min-w-0 flex-1 bg-transparent px-2 py-1 text-[11px] text-foreground outline-none"
              />
              <button type="button" className="rounded-sm p-1 text-primary" onClick={ask}>
                <Send className="size-3.5" />
              </button>
              <button
                type="button"
                className="rounded-sm p-1 text-muted-foreground"
                onClick={() => setChatOpen(false)}
              >
                <X className="size-3.5" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setChatOpen(true)}
              className="flex items-center gap-1 rounded-full border border-primary/40 bg-background/85 px-2.5 py-1 text-[10px] text-foreground backdrop-blur"
            >
              <MessageSquare className="size-3" /> Ask
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
