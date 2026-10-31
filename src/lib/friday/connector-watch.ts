/**
 * FRIDAY · mail and calendar, watched through the connectors the owner already authorised
 *
 * Nothing here connects to anything new. If he has connected Google Calendar, Microsoft Calendar, Gmail or
 * Outlook in Connectors, FRIDAY reads only their safe, read-only actions every half hour (today's events, the
 * unread mail of the last day) and turns them into at most three lines for the morning and evening digest. If
 * none is connected, this does nothing and says so. Mail subjects and senders are untrusted text: orders to an
 * AI inside them are cut before anything is kept, and they stay in memory only (never written to disk). Sending,
 * replying or deleting is not done here and cannot be: only actions marked safe are ever called.
 */

import { quarantine } from "./brain/quarantined-reader";
import { runConnectorAction, type Connector } from "./connectors";
import { prefOn } from "./settings-runtime";

export type WatchKind = "calendar" | "mail";
export type WatchStep = {
  connector: string;
  action: string;
  kind: WatchKind;
  params: Record<string, unknown>;
};

const PLAN: { id: string; action: string; kind: WatchKind; params?: Record<string, unknown> }[] = [
  { id: "google-calendar", action: "today", kind: "calendar" },
  { id: "microsoft-calendar", action: "upcoming", kind: "calendar" },
  {
    id: "google-gmail",
    action: "search",
    kind: "mail",
    params: { query: "is:unread newer_than:1d" },
  },
  { id: "outlook", action: "inbox", kind: "mail" },
];

/** Which reads would run now: connected, the action exists and is marked safe. */
export function plannedReads(connectors: readonly Connector[]): WatchStep[] {
  const steps: WatchStep[] = [];
  for (const row of PLAN) {
    const connector = connectors.find((item) => item.id === row.id);
    const action = connector?.actions.find((item) => item.id === row.action);
    if (connector?.connected && action?.risk === "safe") {
      steps.push({
        connector: row.id,
        action: row.action,
        kind: row.kind,
        params: row.params ?? {},
      });
    }
  }
  return steps;
}

export type CalendarEvent = { at: number; allDay: boolean; title: string };

/** "2026-10-31T10:00:00+05:30 — Standup" or "2026-10-31 — Holiday", as the connectors summarise events. */
export function parseEventLine(line: string): CalendarEvent | null {
  const m =
    /^\s*(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?\s+[—-]\s+(.+)$/.exec(
      line,
    );
  if (!m) return null;
  const [, day, time, zone, title] = m;
  if (!time) {
    const [y, mo, d] = day!.split("-").map(Number);
    return { at: new Date(y!, mo! - 1, d!).getTime(), allDay: true, title: title!.trim() };
  }
  // A time without a zone (Microsoft Graph) is taken as local; with one, it is exact.
  const stamp = zone
    ? Date.parse(
        `${day}T${time}:00${zone.length === 5 ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone}`,
      )
    : Date.parse(`${day}T${time}:00`);
  return Number.isFinite(stamp) ? { at: stamp, allDay: false, title: title!.trim() } : null;
}

const clip = (text: string, n = 60) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
const safe = (text: string) => clip(quarantine(text).text.replace(/\s+/g, " ").trim());

const HOUR = 3_600_000;
const dayKey = (at: number) => new Date(at).toDateString();

const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function calendarLine(lines: readonly string[], now: number): string | null {
  const events = lines
    .map(parseEventLine)
    .filter((event): event is CalendarEvent => Boolean(event))
    .filter((event) => dayKey(event.at) === dayKey(now));
  if (!events.length) return null;
  const upcoming = events
    .filter((event) => event.allDay || event.at >= now)
    .sort((a, b) => a.at - b.at);
  const next = upcoming.find((event) => !event.allDay);
  const head = `${events.length} event(s) today`;
  if (!next) return `${head}; nothing more after now.`;
  const mins = Math.round((next.at - now) / 60_000);
  const when = mins < 90 ? `in ${Math.max(mins, 0)} min` : `at ${clock(next.at)}`;
  return `${head}. Next: ${safe(next.title)} ${when}.`;
}

const NEEDS_LOOK =
  /\b(invoice|payment|due|overdue|deadline|urgent|asap|contract|renewal|interview|bill)\b/i;

export function mailLine(lines: readonly string[]): string | null {
  const rows = lines.filter((line) => line.trim() && !/^\(no messages\)$/i.test(line.trim()));
  if (!rows.length) return null;
  const important = rows.filter((line) => NEEDS_LOOK.test(line));
  const shown = (important.length ? important : rows).slice(0, 2).map((line) => {
    const [from = "", ...rest] = line.split(" — ");
    const sender = from.replace(/<.*>/, "").trim() || "someone";
    return `${safe(sender)}: ${safe(rest.join(" — ") || "(no subject)")}`;
  });
  const lead = important.length
    ? `${important.length} of ${rows.length} unread mail(s) may need a look`
    : `${rows.length} unread mail(s)`;
  return `${lead}: ${shown.join("; ")}.`;
}

export type WatchSnapshot = { at: number; calendar: string[][]; mail: string[][] };

let snapshot: WatchSnapshot = { at: 0, calendar: [], mail: [] };

/** The digest lines from the last read. Empty when nothing is connected or nothing was said. */
export function watchLines(now: number, from: WatchSnapshot = snapshot): string[] {
  if (!from.at || now - from.at > 6 * HOUR) return [];
  const out: string[] = [];
  const cal = calendarLine(from.calendar.flat(), now);
  if (cal) out.push(cal);
  const mail = mailLine(from.mail.flat());
  if (mail) out.push(mail);
  return out;
}

export async function refreshWatch(
  connectors: readonly Connector[],
  now = Date.now(),
): Promise<{ read: number; note: string }> {
  if (!prefOn("connectorWatch", true) || !prefOn("proactiveDigest", true))
    return { read: 0, note: "switched off" };
  const steps = plannedReads(connectors);
  if (!steps.length) return { read: 0, note: "no mail or calendar connector is connected" };
  const next: WatchSnapshot = { at: now, calendar: [], mail: [] };
  let read = 0;
  for (const step of steps) {
    const connector = connectors.find((item) => item.id === step.connector);
    const action = connector?.actions.find((item) => item.id === step.action);
    if (!connector || !action) continue;
    const out = await runConnectorAction(connector, action, step.params);
    if (!out.ok) continue;
    read += 1;
    (step.kind === "calendar" ? next.calendar : next.mail).push(out.lines ?? []);
  }
  if (read) snapshot = next;
  return { read, note: read ? `${read} of ${steps.length} read` : "the connectors did not answer" };
}

export function resetWatchForTests(): void {
  snapshot = { at: 0, calendar: [], mail: [] };
}
