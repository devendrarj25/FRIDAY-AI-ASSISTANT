/**
 * Every part of a turn that reaches the model is screened for SENSITIVE in full: the attachment text, the
 * caller's extra block (screen text, turn awareness), each recalled memory line and the typed line. A long
 * attachment cannot push a recalled secret past a cut, and text too long to hand to the main-process check
 * whole takes the private route instead of going out half screened.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { attachmentOwnerText, type Attachment } from "../../src/lib/friday/attachments";

const globals = globalThis as unknown as { window?: unknown; friday?: unknown };
globals.window ??= globalThis;
for (const name of ["addEventListener", "removeEventListener"] as const) {
  (globalThis as unknown as Record<string, unknown>)[name] ??= () => undefined;
}
const sentChats: Array<Record<string, unknown>> = [];
const noop = () => () => undefined;
globals.friday = {
  isDesktop: true,
  sendChat: (request: Record<string, unknown>) => {
    sentChats.push(request);
    return String(request["requestId"]);
  },
  abortChat: () => undefined,
  onChatDelta: noop,
  onChatTool: noop,
  onChatDone: noop,
  onChatError: noop,
};

const { brain, screenPromptBorne, OWNER_TEXT_CAP } =
  await import("../../src/lib/friday/brain-engine");
const { coreBrain } = await import("../../src/lib/friday/brain/core-brain");
const { modelRegistry } = await import("../../src/lib/friday/model-registry");

type Inner = {
  state: Record<string, unknown> & {
    runs: unknown[];
    messages: unknown[];
    activeRunId: string | null;
  };
};
const inner = brain as unknown as Inner;

// Built at run time so no secret-looking literal sits in the source.
const OTP_LINE = `${"o"}${"tp"} ${"4829"}${"17"}`;
const INNOCENT = "please summarise the file I attached";
const PUBLIC_24K = "The quarterly report covers sales, staffing and the new office. ".repeat(380);

const cognition = (context: string[] = []) =>
  ({
    taskId: "t",
    prompt: "p",
    mode: "manual",
    system: "sys",
    modelIds: [],
    routing: "test",
    context,
    tools: [],
    sources: [],
    notes: [],
    dispatch: {},
    startedAt: 0,
    useKnowledge: true,
    useProjectMemory: true,
    autoLearn: true,
  }) as never;

async function send(
  options: Record<string, unknown>,
  context: string[] = [],
  prompt = INNOCENT,
): Promise<Record<string, unknown>> {
  sentChats.length = 0;
  vi.spyOn(coreBrain, "cognize").mockResolvedValue(cognition(context));
  const result = brain.send(prompt, { routingSurface: "chat", ...options });
  expect(result.accepted).toBe(true);
  await vi.waitFor(() => expect(sentChats.length).toBe(1));
  return sentChats[0]!;
}

const attachmentTurn = () => ({
  extra: `FILE: report.txt (text/plain, 24 KB)\n--- content ---\n${PUBLIC_24K}\n--- end ---`,
  ownerText: `report.txt\n${PUBLIC_24K}`,
});

beforeEach(() => {
  inner.state.runs = [];
  inner.state.messages = [];
  inner.state.activeRunId = null;
  vi.spyOn(modelRegistry, "getSnapshot").mockImplementation(
    () =>
      ({
        models: [
          { id: "ollama/qwen3", type: "local", access: "free", available: true, eligible: true },
          { id: "openrouter/free", type: "cloud", access: "free", available: true, eligible: true },
        ],
        routeMode: "auto",
        selected: [],
        policy: "free-only",
      }) as never,
  );
});
afterEach(() => {
  brain.stop("all");
  vi.restoreAllMocks();
});

describe("the whole prompt is screened, part by part", () => {
  it("a 24k public attachment plus a recalled one-time code forces local-only", async () => {
    expect(PUBLIC_24K.length).toBeGreaterThan(23_000);
    const request = await send(attachmentTurn(), [`Bank login code: ${OTP_LINE}`]);
    expect(request["turnSensitive"]).toBe(true);
    expect(request["routeMode"]).toBe("local-only");
    const contract = request["routingContract"] as {
      requirements: { privacy?: string; locality?: string };
    };
    expect(contract.requirements).toMatchObject({ privacy: "private", locality: "local" });
    // The main-process gate gets the recalled line too, not a copy cut before it.
    expect(String(request["ownerText"])).toContain(OTP_LINE);
  });

  it("finds a secret in the extra block behind a long attachment", async () => {
    const turn = attachmentTurn();
    const request = await send({
      ...turn,
      extra: `${turn.extra}\nScreen text: ${OTP_LINE}`,
    });
    expect(request["turnSensitive"]).toBe(true);
    expect(request["routeMode"]).toBe("local-only");
  });

  it("keeps a 24k public attachment with public memories on the owner's route", async () => {
    const request = await send(attachmentTurn(), ["The owner likes short answers."]);
    expect(request["turnSensitive"]).toBeUndefined();
    expect(request["routeMode"]).not.toBe("local-only");
    expect(String(request["ownerText"])).toContain("likes short answers");
  });

  it("takes the private route when the prompt-borne text is too long to screen whole downstream", async () => {
    const huge = "Plain public words about the garden. ".repeat(
      Math.ceil((OWNER_TEXT_CAP + 1000) / 37),
    );
    const request = await send({ extra: huge });
    expect(request["turnSensitive"]).toBe(true);
    expect(request["routeMode"]).toBe("local-only");
    expect(String(request["ownerText"]).length).toBeLessThanOrEqual(OWNER_TEXT_CAP);
  });
});

describe("screenPromptBorne", () => {
  it("screens each part in full and reports a cut as private", () => {
    const long = "a ".repeat(OWNER_TEXT_CAP);
    expect(screenPromptBorne({ extra: long, recalled: [OTP_LINE] }).sensitive).toBe(true);
    expect(screenPromptBorne({ ownerText: "notes", recalled: ["tea at four"] })).toEqual({
      ownerText: "notes\ntea at four",
      sensitive: false,
    });
    expect(screenPromptBorne({ prompt: `my ${OTP_LINE}` }).sensitive).toBe(true);
    expect(screenPromptBorne({ extra: long }).sensitive).toBe(true);
  });
});

describe("attachment text is screened whole by the brain, not cut by the composer", () => {
  const file = (over: Partial<Attachment>): Attachment =>
    ({ name: "a.txt", mime: "text/plain", size: 10, kind: "text", ...over }) as Attachment;

  it("two ordinary 20k-char public files stay uncut and on the chosen route", () => {
    const two = [
      file({ text: "plain words about tea ".repeat(1000).slice(0, 20_000) }),
      file({ name: "b.txt", text: "more plain words about milk ".repeat(1000).slice(0, 20_000) }),
    ];
    const words = attachmentOwnerText(two);
    const whole = two.map((item) => item.text).join("\n");
    expect(whole.length).toBeGreaterThanOrEqual(40_000);
    // The brain screens the whole text inside the turn's extra block: the cut copy adds no reason to go private.
    expect(screenPromptBorne({ ownerText: words, extra: whole }).sensitive).toBe(false);
    expect(attachmentOwnerText([])).toBe("");
  });

  it("a secret inside an attachment still makes the turn sensitive", () => {
    const words = attachmentOwnerText([file({ text: `my ${"pass"}word: hunter2-hunter2` })]);
    expect(screenPromptBorne({ ownerText: words }).sensitive).toBe(true);
  });

  it("the composer does not force turnSensitive from the attachment length", () => {
    const source = readFileSync(
      resolve(__dirname, "../../src/components/friday/ChatDock.tsx"),
      "utf8",
    );
    expect(source).not.toMatch(/attachmentOwnerTextCut|fileWordsCut/);
    expect(source).toMatch(/\.\.\.\(fileWords \? \{ ownerText: fileWords \} : \{\}\)/);
  });
});
