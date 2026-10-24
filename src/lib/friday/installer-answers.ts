/**
 * Ask FRIDAY about her own tools in plain words, and tell her to run them.
 *
 * "What is missing?", "what needs an update?", "what is broken?", "what is
 * running?", "is git installed?", "start docker", "ollama band karo" are
 * answered from the same data the Install Manager shows, without a model call.
 * Anything else returns null and goes on to the normal brain.
 */
import type { CatalogEntry, CatalogStatus } from "./catalog";

export type ServiceFact = {
  id: string;
  installed?: boolean | undefined;
  running?: boolean | undefined;
  ownedByFriday?: boolean | undefined;
  needsAdmin?: boolean | undefined;
  canStart?: boolean | undefined;
  idleMinutes?: number | null | undefined;
};

export type InstallerView = {
  desktop: boolean;
  scanned: boolean;
  entries: CatalogEntry[];
  installedVersion: (pkg: string) => string | null;
  latestOf: (entry: CatalogEntry) => string;
  latestKnown: (entry: CatalogEntry) => boolean;
  statusOf: (entry: CatalogEntry) => CatalogStatus;
  probe: (
    pkg: string,
  ) =>
    | { status: string; path: string | null; manager: string; manual?: string | null | undefined }
    | undefined;
  services: ServiceFact[];
  failedJobs: { pkg: string; detail: string }[];
  match: (text: string) => CatalogEntry | undefined;
};

export type ServiceRequest = { op: "start" | "stop" | "restart"; target: string };

const list = (items: string[], max = 10) =>
  items.length <= max
    ? items.join(", ")
    : `${items.slice(0, max).join(", ")} and ${items.length - max} more`;

const NOT_SCANNED =
  "I have not scanned this PC yet, so I cannot say. Press Scan All in the Install Manager and ask again.";

/** "start docker", "restart ollama", "docker band karo", "ollama chalu karo". */
export function parseServiceRequest(text: string): ServiceRequest | null {
  const t = text.trim().replace(/[.!?]+$/, "");
  const en = /^(start|stop|restart)\s+(?:the\s+)?(.+)$/i.exec(t);
  if (en) return { op: en[1]!.toLowerCase() as ServiceRequest["op"], target: en[2]!.trim() };
  const hi =
    /^(.+?)\s+(start|chalu|shuru|band|stop|restart)\s*(?:kar|karo|kar do|kardo|kijiye)?$/i.exec(t);
  if (hi) {
    const word = hi[2]!.toLowerCase();
    const op =
      word === "band" || word === "stop" ? "stop" : word === "restart" ? "restart" : "start";
    return { op, target: hi[1]!.trim() };
  }
  return null;
}

function describe(view: InstallerView, entry: CatalogEntry): string {
  const installed = view.installedVersion(entry.pkg);
  const status = view.statusOf(entry);
  const probe = view.probe(entry.pkg);
  const service = view.services.find((s) => s.id === entry.pkg);
  const parts: string[] = [];
  if (!installed) {
    parts.push(`${entry.pkg} is not installed (${entry.requirement}).`);
    parts.push(
      probe?.manual
        ? `It is installed by hand: ${probe.manual}`
        : `FRIDAY installs it with ${entry.method === "winget" ? "winget" : entry.method}${view.latestKnown(entry) ? `, newest ${view.latestOf(entry)}` : ""}.`,
    );
  } else {
    parts.push(
      `${entry.pkg} ${installed === "installed" ? "is installed" : `is at ${installed}`}${probe?.path ? ` (${probe.path})` : ""}.`,
    );
    if (status === "Update available")
      parts.push(`Newest is ${view.latestOf(entry)}, so an update is available.`);
    else if (view.latestKnown(entry)) parts.push("It is up to date.");
    else parts.push("No source names a newer version.");
    if (probe && !["Ready", "Running"].includes(probe.status))
      parts.push(`Health check: ${probe.status}.`);
  }
  if (service) {
    parts.push(
      service.running
        ? `Its service is running${service.ownedByFriday ? " (I started it)" : ""}.`
        : service.installed
          ? "Its service is stopped."
          : "",
    );
  }
  return parts.filter(Boolean).join(" ");
}

const HAS = (re: RegExp, text: string) => re.test(text);

export function answerInstallerQuestion(text: string, view: InstallerView): string | null {
  const t = text.toLowerCase().trim().replace(/\s+/g, " ");
  if (t.length < 6 || t.length > 160) return null;

  // One tool: "is git installed", "version of node", "tell me about ffmpeg", "node ka version".
  const single =
    /^(?:is|are)\s+(.+?)\s+installed\??$/.exec(t) ||
    /^(?:what\s+)?version\s+of\s+(.+?)(?:\s+do\s+i\s+have)?\??$/.exec(t) ||
    /^(?:tell me about|details of|info on|status of)\s+(.+)$/.exec(t) ||
    /^(.+?)\s+(?:installed hai(?: kya)?|ka version|ki details|kaisa hai)\??$/.exec(t);
  if (single) {
    const entry = view.match(single[1]!);
    if (!entry) return null;
    return view.scanned || !view.desktop ? describe(view, entry) : NOT_SCANNED;
  }

  const scope = HAS(
    /\b(tools?|packages?|software|runtimes?|install manager|installs?|setup|programs?|dependencies)\b/,
    t,
  );
  const asks = HAS(
    /\b(which|what|kaun|kya|koi|any|list|show|dikha\w*|batao|bata\w*|kitne|how many)\b/,
    t,
  );

  if (
    HAS(/\b(services?|running|chal rah\w*|background)\b/, t) &&
    (scope || HAS(/\bservices?\b/, t)) &&
    asks
  ) {
    if (!view.services.length)
      return view.desktop ? "I have not read the services yet." : "Services need the desktop app.";
    const on = view.services
      .filter((s) => s.running)
      .map((s) => `${s.id}${s.ownedByFriday ? " (mine)" : ""}`);
    const off = view.services.filter((s) => s.installed && !s.running).map((s) => s.id);
    return [
      on.length ? `Running: ${list(on)}.` : "No tool service is running.",
      off.length ? `Installed but stopped: ${list(off)}. Say "start <name>" to run one.` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (!scope || !asks) return null;
  if (view.desktop && !view.scanned) return NOT_SCANNED;

  if (HAS(/\b(broken|not working|failed|errors?|problems?|kharab|issues?|wrong)\b/, t)) {
    const bad = view.entries
      .filter((e) => {
        const probe = view.probe(e.pkg);
        return (
          view.installedVersion(e.pkg) && probe && !["Ready", "Running"].includes(probe.status)
        );
      })
      .map((e) => `${e.pkg} (${view.probe(e.pkg)!.status})`);
    const missing = view.entries
      .filter((e) => e.requirement === "required" && !view.installedVersion(e.pkg))
      .map((e) => e.pkg);
    const failed = view.failedJobs.map((j) => `${j.pkg}: ${j.detail}`);
    const out = [
      bad.length ? `Installed but not healthy: ${list(bad)}.` : "",
      missing.length ? `Required and missing: ${list(missing)}.` : "",
      failed.length ? `Last install problems: ${list(failed, 4)}.` : "",
    ].filter(Boolean);
    return out.length
      ? out.join(" ")
      : "Nothing is broken that I can see: every installed tool answers and the required set is present.";
  }
  if (HAS(/\b(updates?|outdated|old versions?|purane|upgrades?)\b/, t)) {
    const rows = view.entries
      .filter((e) => view.statusOf(e) === "Update available")
      .map((e) => `${e.pkg} ${view.installedVersion(e.pkg)} → ${view.latestOf(e)}`);
    return rows.length
      ? `${rows.length} update(s) available: ${list(rows)}. Say "update all" to apply them.`
      : "Everything installed is up to date.";
  }
  if (HAS(/\b(missing|not installed|nahi hai|need to install|should i install|chahiye)\b/, t)) {
    const gone = view.entries.filter(
      (e) => !view.installedVersion(e.pkg) && e.method !== "api-key",
    );
    const required = gone.filter((e) => e.requirement === "required").map((e) => e.pkg);
    const recommended = gone.filter((e) => e.requirement === "recommended").map((e) => e.pkg);
    if (!required.length && !recommended.length)
      return "Every required and recommended tool is installed.";
    return [
      required.length
        ? `Required and missing: ${list(required)}. Say "install required".`
        : "Every required tool is installed.",
      recommended.length ? `Recommended: ${list(recommended)}.` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (HAS(/\b(installed|detected|have|hain)\b/, t)) {
    const have = view.entries.filter((e) => view.installedVersion(e.pkg));
    return `${have.length} of ${view.entries.length} tools are installed: ${list(
      have.map((e) => e.pkg),
      12,
    )}.`;
  }
  return null;
}
