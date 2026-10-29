/**
 * Main-window layout: Auto Mode HUD/stats and Manual ChatDock toolbars
 * must wrap instead of overlaying the live graphic or each other.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ChatTranscript } from "../../src/components/friday/ChatMessages";
import { IconAction, LevelSwitch } from "../../src/components/friday/ChatToolbar";
import { NeuralCircuit } from "../../src/components/friday/NeuralCircuit";
import type { Message } from "../../src/lib/friday/brain-engine";
import { Search } from "lucide-react";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("Auto Mode HUD is a reserved row, not an overlay", () => {
  const ui = source("src/components/friday/AutoMode.tsx");
  const circuit = source("src/components/friday/NeuralCircuit.tsx");

  it("keeps voice badges and session stats in flex rows, not absolute overlays", () => {
    expect(ui).toContain("flex min-h-0 flex-1 flex-col overflow-hidden");
    expect(ui).not.toContain("absolute left-3 top-3");
    expect(ui).not.toContain("absolute inset-x-3 bottom-3");
    expect(ui).toContain("flex max-w-full shrink-0 flex-wrap items-center gap-1.5 px-3 pt-3");
    expect(ui).toContain("flex shrink-0 flex-col gap-2 px-3 pb-3");
  });

  it("reuses the HudPanel toolbar wrap on the caption bar", () => {
    expect(ui).toContain(
      "flex min-w-0 shrink-0 flex-wrap items-center justify-between gap-3 border-b border-primary/15 px-3 py-1",
    );
  });

  it("parks WORKING/IDLE on the HUD row in Auto Mode so it cannot cover Verification", () => {
    expect(ui).toContain('{working ? "WORKING" : "IDLE"}');
    expect(circuit).toContain("{large ? null : (");
    expect(circuit).toContain("absolute right-3 top-3");
  });
});

describe("Manual ChatDock toolbars wrap at the window minimum", () => {
  const dock = source("src/components/friday/ChatDock.tsx");

  it("wraps the conversation header and composer actions like HudPanel", () => {
    expect(dock).toContain(
      "flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-primary/10 px-3 py-1.5",
    );
    expect(dock).toContain("flex min-w-0 flex-wrap items-center justify-between gap-2");
    expect(dock).toContain("flex min-w-0 flex-wrap items-center justify-end gap-1");
    expect(dock).toContain("flex min-w-0 flex-wrap items-center gap-1");
  });
});

describe("Manual + Auto status stays on live stores", () => {
  it("does not open a chat microphone; Auto mode retries when faster-whisper appears", () => {
    const dock = source("src/components/friday/ChatDock.tsx");
    expect(dock).toContain("Chat does not use the microphone. Auto mode listens.");
    expect(dock).not.toContain("DesktopDictation");
    const assistant = source("src/lib/friday/assistant-mode.ts");
    expect(assistant).toContain('installed["faster-whisper"]');
    expect(assistant).toContain("this.startRecognition()");
  });

  it("Auto Mode still reads the assistant, brain and live stores", () => {
    const ui = source("src/components/friday/AutoMode.tsx");
    expect(ui).toContain("useAssistantMode()");
    expect(ui).toContain("useBrain()");
    expect(ui).toContain("useFridayLive()");
  });

  it("does not offer hands-free or awake while a voice error is showing", () => {
    const ui = source("src/components/friday/AutoMode.tsx");
    expect(ui).toContain("voice.handsFree && !voice.error");
    expect(ui).toContain("voice.awake && !voice.error");
  });
});

describe("Manual chat levels: Compact, Expanded, Full chat", () => {
  const route = source("src/routes/index.tsx");
  const dock = source("src/components/friday/ChatDock.tsx");
  const circuit = source("src/components/friday/NeuralCircuit.tsx");

  it("Full chat (3) does not render the graphic; Expanded (2) fits it; ChatDock keeps its slot", () => {
    expect(route).toContain("const chatSize = useChatLevel();");
    expect(route).toContain("{chatSize === 3 ? null : (");
    expect(route).toContain("<NeuralCircuit fit={chatSize === 2} />");
    // The graphic panel and the mode-enter remount are unchanged.
    expect(route).toContain(
      "hud-panel relative min-h-0 flex-1 overflow-hidden rounded-lg rounded-b-none border-b-0",
    );
    expect(route).toContain('<div key={mode} className="mode-enter flex h-full min-h-0 flex-col">');
    expect(route).toContain("<Stage />");
    expect(route.indexOf("{chatSize === 3 ? null : (")).toBeLessThan(route.indexOf("<ChatDock />"));
    expect(route.match(/<ChatDock \/>/g)).toHaveLength(1);
  });

  it("Auto mode still uses the large graphic, untouched by the chat level", () => {
    const auto = source("src/components/friday/AutoMode.tsx");
    expect(auto).toContain("<NeuralCircuit large onSelectNode={selectCircuitNode} />");
    expect(auto).not.toContain("useChatLevel");
    // Manual scales only when asked (fit); Auto hides readout lines first and
    // scales only when a bare box still cannot fit.
    expect(circuit).toContain("maxDetails === 0");
    expect(circuit).toContain("largeCircuitFitScale(stageW, stageH, viewportH)");
    expect(circuit).toContain(": fit\n      ? circuitFitScale(stageW, stageH, viewportH)");
    const large = renderToStaticMarkup(createElement(NeuralCircuit, { large: true }));
    expect(large).not.toContain("neural-circuit-compact");
    // Unmeasured (static render): no scale, the graphic fills its stage.
    expect(large).toContain("width:100%;height:100%");
    expect(large).not.toContain("transform:scale(");
    expect(large).toContain(
      'class="neural-circuit relative isolate size-full overflow-hidden rounded-lg"',
    );
  });

  it("Compact (1) renders the graphic exactly as Expanded does before any scale applies", () => {
    const compact = renderToStaticMarkup(createElement(NeuralCircuit));
    const expanded = renderToStaticMarkup(createElement(NeuralCircuit, { fit: true }));
    expect(compact).toBe(expanded);
    expect(compact.includes("IDLE") || compact.includes("WORKING")).toBe(true);
    expect(compact).toContain("w-[420px] max-w-[38vh]");
    expect(compact).toContain("width:100%;height:100%");
  });

  it("keeps Compact's preview height and the levels' heights and timing", () => {
    expect(dock).toContain('level === 1 && "max-h-[7.5rem]"');
    expect(dock).toContain('level === 2 && "max-h-[min(22rem,34vh)]"');
    expect(dock).toContain("duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)]");
    expect(source("src/components/friday/ChatMessages.tsx")).toContain('busy && "transition-none"');
    expect(dock).not.toContain("setExpanded");
    expect(dock).not.toContain("ChevronsUpDown");
  });

  it("keeps the composer uncontrolled with Enter to send and the IME check", () => {
    expect(dock).toContain('defaultValue=""');
    expect(dock).not.toMatch(/<Textarea[^>]*\svalue=/);
    expect(dock).toContain('e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing');
    expect(dock).toContain("INPUT_MAX_PX");
    // Level wrappers are display:contents, so the composer never remounts.
    expect(dock).toContain('full ? "flex min-h-0 flex-1" : "contents"');
    expect(dock).toContain('full ? "flex min-h-0 min-w-0 flex-1 flex-col" : "contents"');
  });

  it("Alt+1/2/3 stays inside the chat region; no global shortcut, no polling", () => {
    expect(dock).toContain("levelForKey(e)");
    for (const file of [
      "src/components/friday/ChatDock.tsx",
      "src/components/friday/ChatMessages.tsx",
      "src/components/friday/ChatToolbar.tsx",
      "src/lib/friday/chat-level.ts",
    ]) {
      const text = source(file);
      expect(text).not.toContain('addEventListener("keydown"');
      expect(text).not.toContain("globalShortcut");
      expect(text).not.toContain("Ctrl+Space");
      expect(text).not.toContain("setInterval");
    }
  });

  it("uses the existing saved-chat store and actions for the Full chat rail", () => {
    expect(dock).toContain('aria-label="Saved chats"');
    expect(dock).toContain("chatSwitchHold(brain.loadConversation(s.messages))");
    expect(dock).toContain("persist(sessions.filter((x) => x.id !== id))");
    expect(dock.match(/const SESSION_KEY = /g)).toHaveLength(1);
    expect(dock).toContain("library.subscribe(");
    expect(dock).toContain("projectWorkspaces.subscribe(");
  });
});

describe("Manual chat controls: labels, cursor, glass", () => {
  const dock = source("src/components/friday/ChatDock.tsx");
  const css = source("src/styles.css");

  it("names every icon-only control and keeps the chat mic off", () => {
    for (const label of [
      'label={searching ? "Close search" : "Search conversation"}',
      'label="Chat history"',
      'label="New chat"',
      'label="Regenerate last answer"',
      'label="Copy transcript"',
      'label="Commands"',
      'label="More"',
      'aria-label="Attach files"',
      'aria-label="Models"',
      'aria-label="Message FRIDAY"',
      'aria-label="Microphone off in chat"',
    ]) {
      expect(dock).toContain(label);
    }
    expect(dock).toMatch(/disabled\s+aria-label="Microphone off in chat"/);
    expect(dock).not.toContain("FileSearch");
    expect(dock).toContain('aria-live="polite"');
  });

  it("renders icon buttons with an overlaid label and a radio level switch", () => {
    const button = renderToStaticMarkup(
      createElement(IconAction, { icon: Search, label: "Search conversation" }),
    );
    expect(button).toContain('aria-label="Search conversation"');
    expect(button).toContain('title="Search conversation"');
    expect(button).toContain("chat-hover-label");
    const levels = renderToStaticMarkup(createElement(LevelSwitch, { level: 2 }));
    expect(levels).toContain('role="radiogroup"');
    expect(levels.match(/role="radio"/g)).toHaveLength(3);
    expect(levels).toContain('aria-checked="true" aria-label="Expanded (Alt+2)"');
    expect(levels).toContain('aria-label="Full chat (Alt+3)"');
  });

  it("pins the cursor and glass rules, keeping the global reset", () => {
    expect(css).toContain("html,\nbody,\n#root {\n  cursor: default;\n}");
    expect(css).toContain(
      ".friday-chat button:disabled {\n  pointer-events: auto;\n  cursor: not-allowed;\n}",
    );
    expect(css).toContain(".friday-chat-messages {\n  cursor: auto;\n  user-select: text;\n}");
    expect(css).toContain(".chat-level-switch button {\n  cursor: pointer;\n}");
    expect(css).toContain(".neural-circuit-compact {\n  cursor: default;\n  user-select: none;\n}");
    // Only the Blur setting switches the Full chat blur off. Neon glow never does.
    expect(css).not.toContain("html.no-glow .friday-chat-full");
    expect(css).toContain("html.no-blur .friday-chat-full");
    expect(css).toMatch(/\.chat-hover-label \{[\s\S]*?transition:[\s\S]*?max-width 180ms/);
    expect(css).toContain("@container friday-chat (max-width: 48rem)");
    expect(dock).toContain("friday-chat friday-interactive-region hud-panel");
  });
});

describe("Manual chat transcript rows", () => {
  const msg = (id: string, role: Message["role"], text: string): Message => ({
    id,
    role,
    text,
    at: 0,
  });
  const conversation = [
    msg("u1", "user", "Write a script"),
    msg("f1", "friday", "Here:\n```bash\necho hi\n```\nDone."),
    msg("u2", "user", "Again"),
    msg("f2", "friday", "Plain answer."),
  ];
  const render = (over: Partial<Parameters<typeof ChatTranscript>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(ChatTranscript, {
        messages: conversation,
        conversation,
        level: 1,
        busy: false,
        bubbleStyle: "Compact",
        showTimestamps: false,
        userBubbleClass: "user-bubble",
        empty: "empty",
        className: "transcript",
        ...over,
      }),
    );

  it("gives every message a Copy, code a Copy code, and Regenerate only on the newest answer", () => {
    const html = render();
    expect(html.match(/aria-label="Copy message"/g)).toHaveLength(2);
    expect(html.match(/aria-label="Copy answer"/g)).toHaveLength(2);
    expect(html.match(/aria-label="Copy code"/g)).toHaveLength(1);
    expect(html.match(/aria-label="Regenerate this answer"/g)).toHaveLength(1);
    expect(html).toContain("<code>echo hi</code>");
    expect(html).toContain('role="log"');
    expect(html).toContain("friday-chat-messages");
    expect(render({ busy: true })).not.toContain("Regenerate this answer");
    expect(html).toContain('aria-live="polite"');
    expect(render({ busy: true })).toContain('aria-live="off" aria-busy="true"');
    // A search result that is not the newest answer never offers Regenerate.
    expect(render({ messages: conversation.slice(0, 2) })).not.toContain("Regenerate this answer");
  });

  it("honours timestamps, bubble style and centres the Full chat column", () => {
    const stamp =
      /mt-0\.5 text-meta-sm text-muted-foreground|ml-2 font-mono text-muted-foreground/g;
    expect(render().match(stamp)).toBeNull();
    expect(render({ showTimestamps: true }).match(stamp)).toHaveLength(4);
    const full = render({ level: 3, bubbleStyle: "Comfortable" });
    expect(full).toContain("mx-auto w-full max-w-[48rem]");
    expect(full).toContain("text-sm");
    expect(render({ level: 1, bubbleStyle: "Comfortable" })).not.toContain(
      "whitespace-pre-wrap font-sans leading-relaxed text-sm",
    );
    expect(render({ messages: [], conversation: [] })).toContain("empty");
  });

  it("draws both sides as glass bubbles and caps the user column only once", () => {
    const html = render();
    expect(html).toContain("bubble-friday");
    expect(html).toContain("flex min-w-0 max-w-[85%] flex-col items-end");
    expect(html).toContain("w-fit max-w-full whitespace-pre-wrap text-left user-bubble");
    const dock = readFileSync(resolve(process.cwd(), "src/components/friday/ChatDock.tsx"), "utf8");
    expect(dock).not.toMatch(/userBubbleClass[\s\S]{0,400}max-w-\[/);
    expect(dock).toContain('"bubble-user px-2.5 py-1.5 text-xs"');
    const voice = readFileSync(
      resolve(process.cwd(), "src/components/friday/VoiceTranscript.tsx"),
      "utf8",
    );
    expect(voice).toContain('user ? "bubble-user" : "bubble-friday"');
    const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
    const glass = css.slice(css.indexOf("/* Conversation bubbles"));
    expect(glass).toContain(".bubble-user:hover");
    expect(glass).toContain("prefers-reduced-motion: reduce");
    expect(glass).toContain("html.no-glow .bubble-user:hover");
    expect(glass).toContain("prefers-reduced-transparency: reduce");
  });
});
