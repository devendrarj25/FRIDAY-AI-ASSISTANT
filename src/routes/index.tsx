import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/friday/AppShell";
import { AutoMode } from "@/components/friday/AutoMode";
import { ChatDock } from "@/components/friday/ChatDock";
import { NeuralCircuit } from "@/components/friday/NeuralCircuit";
import { Stage } from "@/components/friday/Stage";
import { useAssistantSlice } from "@/lib/friday/use-assistant-mode";
import { backgroundTasks } from "@/lib/friday/self/background-tasks";
import { useChatLevel } from "@/lib/friday/chat-level";
import { useEffect } from "react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "FRIDAY — Personal AI Assistant Console" },
      {
        name: "description",
        content:
          "FRIDAY - AI ASSISTANT. A Private, Autonomous and Self Learning OS Based on Local & Cloud Models.",
      },
      { property: "og:title", content: "FRIDAY — Personal AI Assistant Console" },
      {
        property: "og:description",
        content:
          "FRIDAY - AI ASSISTANT. A Private, Autonomous and Self Learning OS Based on Local & Cloud Models.",
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
 * Manual mode: large live graphic on top, conversation + chat directly beneath
 * it, at one of three chat levels (Compact, Expanded, Full chat). Auto mode:
 * the same FRIDAY mark, centred, with live voice status and captions instead
 * of the chat dock. State lives in the shared stores, so switching either way
 * loses nothing.
 */
function MainWindow() {
  const mode = useAssistantSlice((state) => state.mode);
  const chatSize = useChatLevel();
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
              {/* Chat level 3 (Full chat) drops the graphic; 1 and 2 keep it,
                  and 2 scales it down to fit. ChatDock keeps its slot, so a
                  level change never remounts the composer or loses a draft. */}
              {chatSize === 3 ? null : (
                <div className="hud-panel relative min-h-0 flex-1 overflow-hidden rounded-lg rounded-b-none border-b-0">
                  <NeuralCircuit fit={chatSize === 2} />
                </div>
              )}
              <ChatDock />
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
