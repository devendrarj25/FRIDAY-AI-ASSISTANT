/**
 * FRIDAY · desktop companion — main-window link.
 *
 * The overlay never invents state. This hook runs inside the MAIN window (the
 * only place that owns the real brain, voice and task stores), maps that state
 * into the companion vocabulary and publishes it through the controller. It
 * also carries the overlay's own input (mini-chat turns, quick commands, and
 * approval answers) back into the very same pipeline the main window uses, so
 * a request typed at the character is indistinguishable from one typed in the
 * chat dock.
 *
 * Nothing here changes existing behaviour: when the app runs in the browser
 * preview, or the companion is disabled, every call is a no-op.
 */
import { useEffect, useRef } from "react";
import { assistantMode } from "@/lib/friday/assistant-mode";
import { brain } from "@/lib/friday/brain-engine";
import { useAssistantMode } from "@/lib/friday/use-assistant-mode";
import { useBrain } from "@/lib/friday/use-brain";
import { useFridayLive } from "@/lib/friday/use-friday-live";
import { characterBridge } from "./bridge";
import { onSpeechAmplitude } from "./speech-audio";
import type { CharacterAction, CharacterEmotion, CharacterState } from "./types";

/** Live emotion labels from the pipeline, mapped onto the rig's palette. */
function toEmotion(label: string, error: boolean, approval: boolean): CharacterEmotion {
  if (error) return "concerned";
  if (approval) return "alert";
  switch (label.toLowerCase()) {
    case "curious":
      return "curious";
    case "focused":
    case "concentrating":
    case "careful":
    case "attentive":
      return "focused";
    case "smiling":
    case "content":
      return "happy";
    case "thoughtful":
      return "calm";
    default:
      return "calm";
  }
}

/** The real action FRIDAY is performing, in the companion's vocabulary. */
function toAction(input: {
  voice: string;
  busy: boolean;
  approval: boolean;
  action: string;
  speaking: boolean;
}): CharacterAction {
  if (input.approval) return "waiting_approval";
  if (input.speaking || input.voice === "speaking") return "speaking";
  if (input.voice === "listening" || input.voice === "hearing") return "listening";
  const action = input.action.toLowerCase();
  if (input.busy) {
    if (action.includes("execut") || action.includes("tool")) return "working";
    if (action.includes("memory")) return "thinking";
    if (action.includes("rout") || action.includes("model")) return "thinking";
    if (action.includes("verify") || action.includes("analy")) return "thinking";
    if (action.includes("respons")) return "speaking";
    return "working";
  }
  return "idle";
}

export function useCharacterLink() {
  const brainState = useBrain();
  const voiceState = useAssistantMode();
  const live = useFridayLive();
  const lastPublished = useRef<string>("");
  const amplitudeAt = useRef(0);
  const snapshot = useRef<Partial<CharacterState>>({});

  // ---------------------------------------------------------------- publish
  useEffect(() => {
    const bridge = characterBridge();
    if (!bridge) return;

    const approval = brainState.approval;
    const lastFriday = [...brainState.messages].reverse().find((m) => m.role === "friday");
    const caption = [...voiceState.captions].reverse().find((c) => c.who === "friday");
    // Prefer whatever FRIDAY is saying right now; fall back to her last line.
    const speech =
      voiceState.speaking && caption
        ? caption.text
        : voiceState.interim
          ? voiceState.interim
          : (caption?.text ?? lastFriday?.text ?? "");

    const errored = live.session.errors > 0 && !live.busy && live.emotion === "";
    const state: Partial<CharacterState> = {
      action: toAction({
        voice: live.voice,
        busy: live.busy,
        approval: Boolean(approval),
        action: live.action,
        speaking: voiceState.speaking,
      }),
      emotion: toEmotion(live.emotion, errored, Boolean(approval)),
      speech: speech.slice(0, 400),
      progress: live.busy ? Math.max(0, Math.min(1, live.progress / 100)) : null,
      label: approval ? "Permission needed" : live.busy ? live.action : voiceState.status || "",
      approval: approval
        ? { id: approval.runId, question: `${approval.tool} — ${approval.reason}` }
        : null,
      offline: live.voice === "unavailable" && voiceState.mode === "auto",
    };

    // Publishing is cheap but not free: only send when something really moved.
    const key = JSON.stringify(state);
    if (key === lastPublished.current) return;
    lastPublished.current = key;
    snapshot.current = state;
    void bridge.characterPublish(state);
  }, [brainState.approval, brainState.messages, voiceState, live]);

  // -------------------------------------------------------- lip-sync stream
  useEffect(() => {
    const bridge = characterBridge();
    if (!bridge) return;
    return onSpeechAmplitude((amplitude) => {
      const now = Date.now();
      // ~20 Hz is plenty for a mouth and keeps the IPC channel quiet.
      if (now - amplitudeAt.current < 50 && amplitude > 0) return;
      amplitudeAt.current = now;
      void bridge.characterPublish({ ...snapshot.current, amplitude });
    });
  }, []);

  // ------------------------------------------------- overlay -> real FRIDAY
  useEffect(() => {
    const bridge = characterBridge();
    if (!bridge) return;
    const offAsk = bridge.onCharacterAsk((payload) => {
      const text = String(payload?.text ?? "").trim();
      if (!text) return;
      brain.send(text);
    });
    const offCommand = bridge.onCharacterCommand((payload) => {
      switch (payload?.command) {
        case "approve":
          brain.approve(true);
          break;
        case "deny":
          brain.approve(false);
          break;
        case "confirm-yes":
          assistantMode.confirmPending(true);
          break;
        case "confirm-no":
          assistantMode.confirmPending(false);
          break;
        case "stop":
          brain.stop();
          break;
        case "mode":
          assistantMode.setMode(payload.value === "manual" ? "manual" : "auto");
          break;
        case "mute":
          assistantMode.setMuted(Boolean(payload.value));
          break;
        default:
          break;
      }
    });
    return () => {
      offAsk();
      offCommand();
    };
  }, []);
}
