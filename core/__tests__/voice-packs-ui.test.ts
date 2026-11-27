/**
 * The Voice language packs card: every page state, the buttons call the pack store, "Use this language" sets the
 * recognition language, the Doctor pin rows feed the repair, and the card is mounted once and linked from Settings.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  VoicePacksCardView,
  type VoicePacksCardViewProps,
} from "../../src/components/friday/VoicePacksCard";
import { packMembers, voicePackById, voicePacks } from "../../src/lib/friday/model-catalog";
import {
  damagedFromChecks,
  languageHint,
  packCardModel,
  voicePackActions,
} from "../../src/lib/friday/voice-pack-view";
import {
  CONFIRM_LEVELS,
  DEFAULT_PREFERENCES,
  preferences,
  sanitizeConfirmLevel,
} from "../../src/lib/friday/preferences";
import type { Job, PackRunState } from "../../src/lib/friday/models-engine";

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

const idsOf = (packId: string) => packMembers(voicePackById.get(packId)!).map((m) => m.id);
const have = (...ids: string[]) => Object.fromEntries(ids.map((id) => [id, "1"]));

const run = (over: Partial<PackRunState> = {}): PackRunState => ({
  phase: "running",
  current: null,
  done: [],
  remaining: [],
  failed: null,
  startedAt: 1,
  finishedAt: null,
  ...over,
});

const job = (modelId: string, progress: number, phase: Job["phase"] = "Downloading"): Job =>
  ({
    id: `job-${modelId}`,
    modelId,
    kind: "install",
    phase,
    progress,
    detail: "",
    gbTotal: 1,
    gbDone: 0.5,
    speedMbps: 10,
    etaSeconds: 30,
    startedAt: 1,
  }) as unknown as Job;

const fakeActions = (over: Partial<VoicePacksCardViewProps["actions"]> = {}) => ({
  install: vi.fn(async () => undefined),
  stop: vi.fn(() => undefined),
  check: vi.fn(async () => undefined),
  useLanguage: vi.fn(() => "ok"),
  ...over,
});

const base = (over: Partial<VoicePacksCardViewProps> = {}): VoicePacksCardViewProps => ({
  installed: {},
  jobs: [],
  packRuns: {},
  damaged: [],
  recognitionLang: "en-US",
  offline: false,
  loading: false,
  error: null,
  checking: false,
  notice: "",
  actions: fakeActions(),
  ...over,
});

const html = (props: VoicePacksCardViewProps) =>
  renderToStaticMarkup(createElement(VoicePacksCardView, props));

/** Every element in a tree whose props include `label`: the card's buttons, found without a browser. */
type Found = { props: Record<string, unknown> };
function buttons(node: ReactNode, out: Found[] = []) {
  if (Array.isArray(node)) node.forEach((child) => buttons(child as ReactNode, out));
  else if (isValidElement(node)) {
    const props = node.props as Record<string, unknown>;
    // ErrorState draws its own Retry button from onRetry.
    if (typeof props["onRetry"] === "function")
      out.push({ props: { label: "Retry", onClick: props["onRetry"] } });
    if (typeof props["label"] === "string" && typeof props["onClick"] === "function")
      out.push({ props });
    buttons(props["children"] as ReactNode, out);
  }
  return out;
}
const tree = (props: VoicePacksCardViewProps) =>
  (VoicePacksCardView as unknown as (p: VoicePacksCardViewProps) => ReactNode)(props);
const press = (props: VoicePacksCardViewProps, label: string, index = 0) => {
  const found = buttons(tree(props)).filter((b) => b.props["label"] === label);
  expect(found.length, `button ${label}`).toBeGreaterThan(index);
  return (found[index]!.props["onClick"] as () => unknown)();
};

describe("the card shows every pack from real data", () => {
  it("lists the three packs with label, plain description, total size and no credit lines", () => {
    const out = html(base());
    for (const pack of voicePacks) {
      expect(out).toContain(pack.label);
      expect(out).toContain(pack.description.slice(0, 40));
      expect(pack).not.toHaveProperty("credits");
    }
    expect(out).toContain("Voice language packs");
    expect(out).toMatch(/\d(\.\d)? GB/);
  });

  it("badges: not installed, partly installed, installed", () => {
    const badge = (packId: string, installed: Record<string, string>) =>
      packCardModel(voicePackById.get(packId)!, base({ installed })).badge.label;
    expect(badge("voice-pack-hinglish", {})).toBe("Not installed");
    expect(badge("voice-pack-hinglish", have("hindi-ear"))).toBe("Partly installed");
    expect(badge("voice-pack-hindi", have(...idsOf("voice-pack-hindi")))).toBe("Installed");
    const out = html(base({ installed: have(...idsOf("voice-pack-hindi")) }));
    expect(out).toContain("Installed");
    expect(html(base())).toContain("Not installed");
  });

  it("per-member rows carry the role, the size and the state", () => {
    const model = packCardModel(
      voicePackById.get("voice-pack-english")!,
      base({ installed: have("silero-vad") }),
    );
    const states = Object.fromEntries(model.rows.map((r) => [r.id, r.state]));
    expect(states["silero-vad"]).toBe("installed");
    expect(states["smart-turn"]).toBe("not installed");
    expect(model.rows.every((r) => r.role.length > 3 && r.sizeLabel.length > 2)).toBe(true);
    expect(html(base())).toContain("Hears when you start and stop speaking");
  });
});

describe("the page states", () => {
  it("loading draws a loading line, no packs yet", () => {
    const out = html(base({ loading: true }));
    expect(out).toContain("aria-busy");
    expect(out).not.toContain("Install all");
  });

  it("an error shows the message and a Retry that checks again", async () => {
    const actions = fakeActions();
    const props = base({ error: new Error("check failed"), actions });
    expect(html(props)).toContain("check failed");
    await press(props, "Retry");
    expect(actions.check).toHaveBeenCalledTimes(1);
  });

  it("offline shows the notice and disables every install button", () => {
    const out = html(base({ offline: true }));
    expect(out).toMatch(/not connected|desktop app/i);
    const installs = buttons(tree(base({ offline: true }))).filter(
      (b) => b.props["label"] === "Install all",
    );
    expect(installs.length).toBe(3);
    expect(installs.every((b) => b.props["disabled"] === true)).toBe(true);
  });
});

describe("the buttons call the pack store", () => {
  it("Install all installs that pack with no damaged list when nothing is damaged", async () => {
    const actions = fakeActions();
    await press(base({ actions }), "Install all", 1);
    expect(actions.install).toHaveBeenCalledWith("voice-pack-hindi", []);
  });

  it("feeds the Doctor damaged members into the repair", async () => {
    const actions = fakeActions();
    const english = idsOf("voice-pack-english");
    const props = base({
      installed: have(...english),
      damaged: ["silero-vad", "hindi-ear"],
      actions,
    });
    expect(html(props)).toContain("damaged");
    await press(props, "Repair", 0);
    expect(actions.install).toHaveBeenCalledWith("voice-pack-english", ["silero-vad"]);
  });

  it("Stop cancels a running pack and shows the member that is moving with its bar", () => {
    const actions = fakeActions();
    const english = idsOf("voice-pack-english");
    const props = base({
      installed: have(english[0]!),
      packRuns: {
        "voice-pack-english": run({
          current: english[1]!,
          done: [english[0]!],
          remaining: english.slice(1),
        }),
      },
      jobs: [job(english[1]!, 42)],
      actions,
    });
    const out = html(props);
    expect(out).toContain("42%");
    expect(out).toMatch(/Downloading/);
    expect(out).toMatch(/waiting/);
    // One pack at a time: the other two cannot start while this one moves.
    const others = buttons(tree(props)).filter((b) => b.props["label"] === "Install all");
    expect(others.length).toBe(2);
    expect(others.every((b) => b.props["disabled"] === true)).toBe(true);
    press(props, "Stop");
    expect(actions.stop).toHaveBeenCalledWith("voice-pack-english");
  });

  it("a failure mid-way names the member, the reason and offers Run again to continue", async () => {
    const actions = fakeActions();
    const hindi = idsOf("voice-pack-hindi");
    const props = base({
      installed: have(hindi[0]!),
      packRuns: {
        "voice-pack-hindi": run({
          phase: "failed",
          done: [hindi[0]!],
          remaining: hindi.slice(1),
          failed: { id: hindi[1]!, error: "disk full" },
        }),
      },
      actions,
    });
    const out = html(props);
    expect(out).toContain("disk full");
    expect(out).toContain("Run again to continue");
    await press(props, "Run again to continue");
    expect(actions.install).toHaveBeenCalledWith("voice-pack-hindi", []);
  });

  it("a stopped run also offers Run again to continue", () => {
    const props = base({
      packRuns: {
        "voice-pack-hindi": run({ phase: "cancelled", remaining: idsOf("voice-pack-hindi") }),
      },
    });
    expect(html(props)).toContain("Run again to continue");
  });

  it("an Install that throws is caught by the store wrapper and becomes a notice", async () => {
    const store = {
      installPack: vi.fn(async () => {
        throw new Error("boom");
      }),
      cancelPack: vi.fn(),
    };
    const notes: string[] = [];
    const actions = voicePackActions({
      store,
      setVoice: vi.fn(),
      note: (line) => notes.push(line),
      setDamaged: vi.fn(),
    });
    await actions.install("voice-pack-english", []);
    expect(notes.join(" ")).toMatch(/boom/);
  });
});

describe("Use this language", () => {
  it("appears for an installed pack and sets the recognition language", () => {
    const actions = fakeActions();
    const english = idsOf("voice-pack-english");
    const props = base({ installed: have(...english), recognitionLang: "hi-IN", actions });
    expect(html(props)).toContain("Use this language");
    press(props, "Use this language");
    expect(actions.useLanguage).toHaveBeenCalledWith("voice-pack-english");
  });

  it("says In use when the language is already chosen, and is absent for a pack not installed", () => {
    const english = idsOf("voice-pack-english");
    const out = html(base({ installed: have(...english), recognitionLang: "en-IN" }));
    expect(out).toContain("In use");
    expect(html(base())).not.toContain("Use this language");
  });

  it("sets preferences through setVoice with the pack's own language", () => {
    const setVoice = vi.fn();
    const actions = voicePackActions({
      store: { installPack: vi.fn(), cancelPack: vi.fn() },
      setVoice,
      note: vi.fn(),
      setDamaged: vi.fn(),
    });
    for (const pack of voicePacks) {
      setVoice.mockClear();
      const line = actions.useLanguage(pack.id);
      expect(setVoice).toHaveBeenCalledWith({ recognitionLang: pack.recognitionLang });
      expect(line.length).toBeGreaterThan(10);
    }
  });

  it("is honest about which ear each language uses", () => {
    expect(languageHint(voicePackById.get("voice-pack-hindi")!)).toMatch(/Devanagari/);
    expect(languageHint(voicePackById.get("voice-pack-hinglish")!)).toMatch(/hi-Latn/);
    expect(languageHint(voicePackById.get("voice-pack-english")!)).toMatch(/English/);
  });
});

describe("damaged members from the Doctor pin rows", () => {
  it("maps failed pin rows to catalog ids and ignores passing and unrelated rows", () => {
    expect(
      damagedFromChecks([
        { id: "hindi-ear-pin", ok: false },
        { id: "hinglish-ear-pin", ok: true },
        { id: "tts-pin", ok: false },
        { id: "stt-pin-small", ok: false },
        { id: "hindi-punct-pin", ok: false },
        { id: "av-pin", ok: false },
        { id: "stt-transcribe", ok: false },
        { id: "stt-pin-nonsense", ok: false },
      ]).sort(),
    ).toEqual(["faster-whisper-small", "hindi-ear", "hindi-punct", "supertonic-3"]);
  });

  it("a damaged member makes a full pack partial and plans a repair", () => {
    const english = idsOf("voice-pack-english");
    const model = packCardModel(
      voicePackById.get("voice-pack-english")!,
      base({ installed: have(...english), damaged: ["smart-turn"] }),
    );
    expect(model.badge.label).toBe("Partly installed");
    expect(model.action).toBe("repair");
    expect(model.rows.find((r) => r.id === "smart-turn")?.state).toBe("damaged");
  });
});

describe("wiring", () => {
  it("the Models page mounts the card exactly once and Settings > Voice links it", () => {
    const models = read("src/routes/models.tsx");
    expect(models.match(/<VoicePacksCard\b/g)?.length).toBe(1);
    expect(models).toContain("@/components/friday/VoicePacksCard");
    const voice = read("src/components/friday/settings/VoiceSettings.tsx");
    expect(voice).toContain("Voice language packs");
    expect(voice).toMatch(/install Hindi, English or Hinglish in one click/);
    expect(voice).toMatch(/navigate\(\{ to: "\/models" \}\)/);
  });

  it("the live card reads the real stores and not a second timer", () => {
    const src = read("src/components/friday/VoicePacksCard.tsx");
    expect(src).toContain("useModels()");
    expect(src).toContain("useKernelStatus()");
    expect(src).not.toMatch(/setInterval|setTimeout/);
    const lib = read("src/lib/friday/voice-pack-view.ts");
    expect(lib).toContain("installPack(");
    expect(lib).toContain("cancelPack(");
  });
});

describe("How often she asks yes or no (voice.confirmLevel)", () => {
  it("defaults to rare and an old stored shape or an unknown word reads rare", () => {
    expect(DEFAULT_PREFERENCES.voice.confirmLevel).toBe("rare");
    expect(CONFIRM_LEVELS).toEqual(["rare", "normal", "always"]);
    for (const bad of [undefined, null, "", "RARE", "sometimes", 3, {}, "strict"])
      expect(sanitizeConfirmLevel(bad)).toBe("rare");
    for (const good of CONFIRM_LEVELS) expect(sanitizeConfirmLevel(good)).toBe(good);
  });

  it("is stored through setVoice, made safe on a bad value and kept by a patch of another key", () => {
    preferences.setVoice({ confirmLevel: "always" });
    expect(preferences.getSnapshot().voice.confirmLevel).toBe("always");
    preferences.setVoice({ wakeWord: "friday" });
    expect(preferences.getSnapshot().voice.confirmLevel).toBe("always");
    preferences.setVoice({ confirmLevel: "whenever" as never });
    expect(preferences.getSnapshot().voice.confirmLevel).toBe("rare");
    preferences.setVoice({ confirmLevel: "normal" });
    expect(preferences.getSnapshot().voice.confirmLevel).toBe("normal");
    preferences.setVoice({ confirmLevel: "rare" });
  });

  it("has a Settings > Voice row wired to setVoice, with the honest hint, and is in the flow registry", () => {
    const row = read("src/components/friday/settings/VoiceSettings.tsx");
    expect(row).toContain("How often she asks yes or no");
    expect(row).toMatch(/value=\{sanitizeConfirmLevel\(prefs\.voice\.confirmLevel\)\}/);
    expect(row).toMatch(/preferences\.setVoice\(\{ confirmLevel: sanitizeConfirmLevel\(/);
    for (const level of ["rare", "normal", "always"]) expect(row).toContain(`value="${level}"`);
    expect(row.replace(/\s+/g, " ")).toMatch(
      /Dangerous actions \(delete, send, pay, shutdown, uninstall\) always ask/,
    );
    expect(read("src/lib/friday/flow-registry.gen.ts")).toContain('"voice.confirmLevel"');
  });

  it("the conductor reads the same key", () => {
    expect(read("src/lib/friday/assistant-mode.ts")).toContain('["confirmLevel"]');
  });
});
