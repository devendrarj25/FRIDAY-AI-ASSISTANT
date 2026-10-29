/**
 * FRIDAY · real system context.
 *
 * Every answer that depends on "now" reads the OS clock at the moment it is
 * asked — no cached date, no build-time constant. The compiled line is placed
 * in front of the model so it can never answer with a stale date, and it is
 * told explicitly to verify anything newer than its training data.
 */

export type SystemContext = {
  iso: string;
  date: string;
  time: string;
  weekday: string;
  timeZone: string;
  utcOffset: string;
  locale: string;
  online: boolean;
  platform: string;
};

function utcOffset(now: Date): string {
  const minutes = -now.getTimezoneOffset();
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** Read the live OS clock, timezone and connectivity. Never cached. */
export function readSystemContext(): SystemContext {
  const now = new Date();
  const locale =
    typeof navigator !== "undefined" && navigator.language ? navigator.language : "en-IN";
  let timeZone = "UTC";
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    /* keep UTC */
  }
  return {
    iso: now.toISOString(),
    date: now.toLocaleDateString(locale, { day: "2-digit", month: "long", year: "numeric" }),
    time: now.toLocaleTimeString(locale, { hour12: false }),
    weekday: now.toLocaleDateString(locale, { weekday: "long" }),
    timeZone,
    utcOffset: utcOffset(now),
    locale,
    online: typeof navigator === "undefined" ? true : navigator.onLine !== false,
    platform:
      typeof navigator !== "undefined" && (navigator as { platform?: string }).platform
        ? String((navigator as { platform?: string }).platform)
        : "unknown",
  };
}

/** The block injected into every system prompt. */
export function systemContextPrompt(ctx: SystemContext = readSystemContext()): string {
  return [
    "Live system context (read from this machine's OS right now — trust it over anything you remember):",
    `- Current date: ${ctx.weekday}, ${ctx.date}`,
    `- Current local time: ${ctx.time} (${ctx.timeZone}, ${ctx.utcOffset})`,
    `- ISO timestamp: ${ctx.iso}`,
    `- Locale: ${ctx.locale} · platform: ${ctx.platform} · network: ${ctx.online ? "online" : "offline"}`,
    ctx.online
      ? "Live web results, if this turn needs them, are attached in the prompt by FRIDAY before you answer. You do not have a web-search or browser tool in this chat. Do not stall, and do not call Bluetooth, network discovery, or file tools to look up current facts — answer from the attached context. If no live sources are attached, say what you know and that it was not live-verified."
      : "The machine is offline: answer from local memory and models, and say clearly that live verification was not possible.",
  ].join("\n");
}
