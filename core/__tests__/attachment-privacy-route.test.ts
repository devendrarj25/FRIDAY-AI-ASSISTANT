/**
 * Text the model did not write but that goes into the prompt (an attachment, recalled memory, screen text) is
 * checked for SENSITIVE like the typed line. A hit forces the private route (local only) and the same text is
 * sent as `ownerText`, so the main process and the kernel screen it too. An innocent prompt does not hide it.
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

const { brain } = await import("../../src/lib/friday/brain-engine");
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
const SECRET_LINE = `${"pass"}${"word"}: ${"hunter"}${"2"}-${"correct"}-${"horse"}`;
const INNOCENT = "please summarise the file I attached";

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
): Promise<Record<string, unknown>> {
  sentChats.length = 0;
  vi.spyOn(coreBrain, "cognize").mockResolvedValue(cognition(context));
  const result = brain.send(INNOCENT, { routingSurface: "chat", ...options });
  expect(result.accepted).toBe(true);
  await vi.waitFor(() => expect(sentChats.length).toBe(1));
  return sentChats[0]!;
}

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

describe("attachment text is screened like the typed line", () => {
  it("forces the private route and sends ownerText for a sensitive attachment with an innocent prompt", async () => {
    const request = await send({
      extra: `FILE: notes.txt\n${SECRET_LINE}`,
      ownerText: SECRET_LINE,
    });
    expect(request["turnSensitive"]).toBe(true);
    expect(request["routeMode"]).toBe("local-only");
    const contract = request["routingContract"] as {
      routeMode: string;
      requirements: { privacy?: string; locality?: string };
    };
    expect(contract.routeMode).toBe("local-only");
    expect(contract.requirements).toMatchObject({ privacy: "private", locality: "local" });
    expect(String(request["ownerText"])).toContain(SECRET_LINE);
  });

  it("catches sensitive recalled memory that the typed line never mentions", async () => {
    const request = await send({}, [`The owner's ${SECRET_LINE}`]);
    expect(request["turnSensitive"]).toBe(true);
    expect(request["routeMode"]).toBe("local-only");
    expect(String(request["ownerText"])).toContain(SECRET_LINE);
  });

  it("leaves a harmless attachment on the owner's route and marks nothing", async () => {
    const request = await send({ ownerText: "Meeting notes: lunch at one, review at three." });
    expect(request["turnSensitive"]).toBeUndefined();
    expect(request["routeMode"]).not.toBe("local-only");
  });

  it("honours a caller's turnSensitive flag with no text at all", async () => {
    const request = await send({ turnSensitive: true });
    expect(request["turnSensitive"]).toBe(true);
    expect(request["routeMode"]).toBe("local-only");
  });
});

describe("attachmentOwnerText and ChatDock", () => {
  const file = (over: Partial<Attachment>): Attachment =>
    ({ name: "a.txt", mime: "text/plain", size: 10, kind: "text", ...over }) as Attachment;

  it("carries extracted text only, capped, and nothing for binary or image files", () => {
    const text = attachmentOwnerText([
      file({ text: SECRET_LINE }),
      file({ kind: "image", dataUrl: "data:image/png;base64,AAAA" }),
      file({ kind: "binary" }),
    ]);
    expect(text).toContain(SECRET_LINE);
    expect(text).not.toContain("base64");
    expect(attachmentOwnerText([file({ text: "x".repeat(200_000) })]).length).toBeLessThanOrEqual(
      40_000,
    );
    expect(attachmentOwnerText([])).toBe("");
  });

  it("is passed from the composer to brain.send", () => {
    const source = readFileSync(
      resolve(__dirname, "../../src/components/friday/ChatDock.tsx"),
      "utf8",
    );
    expect(source).toMatch(/attachmentOwnerText\(files\)/);
    expect(source).toMatch(/ownerText/);
  });
});
