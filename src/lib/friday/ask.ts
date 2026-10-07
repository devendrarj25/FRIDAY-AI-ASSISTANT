/**
 * One-shot AI ask.
 *
 * FRIDAY's chat pipeline is streaming and session based; some surfaces (the
 * Hub workbench, analysis panels) just need a single answer with the models
 * that are already configured. This wraps the existing `chat:send` bridge —
 * it never opens a second pipeline or talks to a provider directly.
 */
const uid = () => `ask_${Math.random().toString(36).slice(2, 10)}`;

export type AskOptions = {
  system?: string;
  modelIds?: string[];
  /** Give up after this long so a stalled model can never hang the UI. */
  timeoutMs?: number;
  onDelta?: (text: string) => void;
};

export function canAsk(): boolean {
  return typeof window !== "undefined" && Boolean(window.friday?.sendChat);
}

export async function askFriday(prompt: string, options: AskOptions = {}): Promise<string> {
  const api = typeof window === "undefined" ? null : window.friday;
  const sendChat = api?.sendChat;
  const onDeltaEvent = api?.onChatDelta;
  const onDoneEvent = api?.onChatDone;
  const onErrorEvent = api?.onChatError;
  if (!api || !sendChat || !onDeltaEvent || !onDoneEvent || !onErrorEvent) {
    throw new Error("FRIDAY's models are available in the desktop app.");
  }

  const requestId = uid();
  const { system, modelIds, timeoutMs = 90_000, onDelta } = options;

  return new Promise<string>((resolve, reject) => {
    let text = "";
    let settled = false;
    const stops: (() => void)[] = [];
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stops.forEach((stop) => stop());
      fn();
    };

    const timer = setTimeout(() => {
      api.abortChat?.(requestId);
      finish(() =>
        text.trim() ? resolve(text) : reject(new Error("The model did not answer in time.")),
      );
    }, timeoutMs);

    stops.push(
      onDeltaEvent((event) => {
        if (event.requestId !== requestId) return;
        text += event.text;
        onDelta?.(event.text);
      }),
      onDoneEvent((event) => {
        if (event.requestId !== requestId) return;
        finish(() =>
          event.cancelled && !text.trim()
            ? reject(new Error("Cancelled."))
            : resolve(text.trim() || "No answer."),
        );
      }),
      onErrorEvent((event) => {
        if (event.requestId !== requestId) return;
        finish(() => reject(new Error(event.error || "The model failed.")));
      }),
    );

    try {
      sendChat({
        requestId,
        sessionId: `ask-${requestId}`,
        prompt,
        ...(system ? { system } : {}),
        ...(modelIds?.length ? { modelIds } : {}),
      });
    } catch (error) {
      finish(() => reject(error instanceof Error ? error : new Error("Could not reach a model.")));
    }
  });
}
