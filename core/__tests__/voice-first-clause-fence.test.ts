/**
 * The fast first clause is cut before the reply is finished. A code fence that opens inside that clause must not
 * make the words of the fence's body sound: the cut is refused and the fence-aware reader decides instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assistantMode } from "../../src/lib/friday/assistant-mode";
import { preferences } from "../../src/lib/friday/preferences";
import { autonomy } from "../../src/lib/friday/self/autonomy";
import { SpeechArbiter } from "../../src/lib/friday/voice-engine/speech-arbiter";

type Driver = {
  state: Record<string, unknown> & { mode: string; muted: boolean };
  arbiter: SpeechArbiter;
  speakStreamed: (runId: string, text: string, final: boolean) => void;
  drainSpeech: () => Promise<void>;
  emit: () => void;
};
const d = assistantMode as unknown as Driver;
(globalThis as unknown as { window?: unknown }).window ??= globalThis;

let said: string[] = [];

beforeEach(async () => {
  await preferences.hydrate();
  preferences.setVoice({
    hinglish: false,
    speechLang: "en-US",
    speakReplies: true,
    fastFirstClause: true,
  });
  autonomy.reset();
  Object.assign(d.state, { mode: "auto", muted: false, paused: false });
  d.arbiter = new SpeechArbiter({ now: () => Date.now() });
  said = [];
  const enqueue = d.arbiter.enqueue.bind(d.arbiter);
  vi.spyOn(d.arbiter, "enqueue").mockImplementation(((item: { text: string }) => {
    said.push(item.text);
    return enqueue(item as never);
  }) as never);
  d.drainSpeech = async () => undefined;
  d.emit = () => undefined;
});

afterEach(() => {
  autonomy.reset();
  vi.restoreAllMocks();
});

describe("a code fence inside the first clause", () => {
  const OPEN = "Run ```wipe-cache --all now, then check the output and tell me how it looks to you";
  const FULL = `${OPEN}\`\`\` and that is all there is to it for today.`;

  it("an open fence is never spoken while the reply streams", () => {
    d.speakStreamed("fence-1", OPEN, false);
    const all = said.join(" ");
    expect(all).not.toContain("wipe-cache");
    expect(all).not.toContain("check the output");
  });

  it("the finished reply speaks the words outside the fence only", () => {
    d.speakStreamed("fence-2", OPEN, false);
    d.speakStreamed("fence-2", FULL, true);
    const all = said.join(" ");
    expect(all).not.toContain("wipe-cache");
    expect(all).not.toContain("check the output");
    expect(all).toContain("all there is to it");
  });

  it("a first clause that holds a whole fence never speaks the fence", () => {
    const text =
      "Okay so run this ```bash\nwipe node_modules\n``` and then it will be fine for you today ok.";
    d.speakStreamed("fence-3", text, false);
    expect(said.length).toBeGreaterThan(0);
    expect(said.join(" ")).not.toContain("wipe node_modules");
  });
});
