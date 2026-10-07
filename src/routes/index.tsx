import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/friday/AppShell";
import { AutoMode } from "@/components/friday/AutoMode";
import { ChatDock } from "@/components/friday/ChatDock";
import { NeuralCircuit } from "@/components/friday/NeuralCircuit";
import { Stage } from "@/components/friday/Stage";
import { useAssistantMode } from "@/lib/friday/use-assistant-mode";
import { backgroundTasks } from "@/lib/friday/self/background-tasks";
import { useEffect } from "react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "FRIDAY — Personal AI Assistant Console" },
      {
        name: "description",
        content:
          "FRIDAY is a local-first AI assistant desk: a live execution graphic, real action and emotion state, and a full multi-model chat console on your own PC.",
      },
      { property: "og:title", content: "FRIDAY — Personal AI Assistant Console" },
      {
        property: "og:description",
        content:
          "Live neon console for local AI: real-time workflow visualisation and chat with models, tools, skills and plugins.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: MainWindow,
});

/**
 * FRIDAY main window.
 *
 * Manual mode (unchanged): large live graphic on top, compact conversation +
 * chat directly beneath it. Auto mode: the same FRIDAY mark, centred, with
 * live voice status and captions instead of the chat dock. State lives in the
 * shared stores, so switching either way loses nothing.
 */
function MainWindow() {
  const { mode } = useAssistantMode();
  // FRIDAY keeps working in the background while the window is open.
  useEffect(() => {
    backgroundTasks.start();
  }, []);
  return (
    <AppShell fill>
      <div className="relative flex h-full min-h-0 flex-col">
        <Stage />
        <div key={mode} className="mode-enter flex h-full min-h-0 flex-col">
          {mode === "auto" ? (
            <AutoMode />
          ) : (
            <div className="flex h-full min-h-0 flex-col">
              <div className="hud-panel relative min-h-0 flex-1 overflow-hidden rounded-lg rounded-b-none border-b-0">
                <NeuralCircuit />
              </div>
              <ChatDock />
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
