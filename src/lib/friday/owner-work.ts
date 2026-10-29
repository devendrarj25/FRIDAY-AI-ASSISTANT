/**
 * FRIDAY · owner-work skills (chat, voice, skill-router, capability registry)
 *
 * One implementation of the owner's personal-productivity, books, tender and
 * site-status work. Chat and Auto Mode hit `handleOwnerWork`; the skill
 * router and capability snapshot see the same ids. Nothing here is a stub
 * catalog entry — each skill runs the persist/extract functions above.
 */

import { capabilityRegistry } from "./brain/capability-registry";
import type { SkillManifest } from "./brain/skill-forge";
import { connectorTools } from "./connectors";
import { hisab } from "./hisab-kitab";
import {
  cmsConnectHint,
  cmsWriteActionId,
  formatAdvice,
  interpretSiteStatus,
  namedCms,
  namedSocial,
  parsePayeeAsk,
  SITE_PLATFORM_NEEDED,
  socialConnectHint,
  SOCIAL_UNSUPPORTED,
  socialWriteActionId,
  structureAdvice,
} from "./owner-work-logic";
import { parseTaskTitle, personalDesk } from "./personal-desk";
import { describeTender, tenderModelPlan } from "./tender-reader";
import { handleLibraryChat } from "./library-engine";
import { handleProjectWorkspaceChat } from "./project-workspace-engine";

export type OwnerWorkReply = {
  text: string;
  action?: {
    kind?: "tool" | "skill" | "connector";
    tool: string;
    args: Record<string, unknown>;
    risk: "safe" | "write" | "exec";
    label: string;
  };
};

const skill = (
  id: string,
  name: string,
  summary: string,
  capabilities: string[],
  risk: SkillManifest["risk"],
): SkillManifest => ({
  id,
  name,
  summary,
  category: "owner-work",
  capabilities,
  risk,
  inputs: ["prompt", "text", "csv"],
  version: 1,
  author: "friday-core",
  enabled: true,
  builtin: true,
  runs: 0,
  failures: 0,
});

export const OWNER_WORK_SKILLS: SkillManifest[] = [
  skill(
    "desk.tasks",
    "Personal tasks",
    "Track tasks and reminders with real persistence.",
    ["task", "remind", "todo"],
    "safe",
  ),
  skill(
    "desk.notes",
    "Personal notes",
    "File and retrieve notes through FRIDAY memory.",
    ["note", "remember"],
    "safe",
  ),
  skill(
    "desk.summary",
    "Activity summary",
    "Summarise the last day or week from real logs.",
    ["summary", "digest"],
    "safe",
  ),
  skill(
    "desk.advice",
    "Decision frame",
    "Structure a real question into options and owner-stated reasons.",
    ["advice", "decision"],
    "safe",
  ),
  skill(
    "hisab.import",
    "Import books",
    "Import CSV/statement rows into the persisted ledger.",
    ["hisab", "bookkeeping", "csv"],
    "safe",
  ),
  skill(
    "hisab.report",
    "Profit and loss",
    "P&L from stored running totals of imported records.",
    ["hisab", "profit", "loss"],
    "safe",
  ),
  skill(
    "tender.read",
    "Read a tender",
    "Extract stated tender/RFP clauses and flag gaps.",
    ["tender", "rfp"],
    "safe",
  ),
  skill(
    "site.status",
    "Site status",
    "Check whether a URL answers. WordPress and Shopify publish/edit use the Connectors page.",
    ["website", "uptime"],
    "safe",
  ),
  skill(
    "site.publish",
    "Publish a page",
    "Publish or edit a WordPress post or Shopify page through the connected connector after approval.",
    ["website", "wordpress", "shopify", "publish"],
    "write",
  ),
  skill(
    "social.draft",
    "Draft a post",
    "Keep a local draft; posting uses a connected social connector and approval.",
    ["social", "draft", "slack", "twitter", "instagram", "facebook", "linkedin"],
    "write",
  ),
];

capabilityRegistry.registerProvider(() =>
  OWNER_WORK_SKILLS.map((item) => ({
    id: `skill:${item.id}`,
    type: "skill" as const,
    name: item.name,
    ref: item.id,
    capabilities: item.capabilities,
    available: true,
    health: "ready" as const,
    reliability: null,
    latencyMs: null,
    cost: "free" as const,
    permission: item.risk === "safe" ? ("open" as const) : ("ask" as const),
    detail: item.summary,
  })),
);

export function isOwnerWorkSkill(id: string): boolean {
  return OWNER_WORK_SKILLS.some((item) => item.id === id);
}

function inputText(input: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = input[key];
    if (value != null && String(value).trim()) return String(value);
  }
  return "";
}

export async function runOwnerWorkSkill(id: string, input: Record<string, unknown> = {}) {
  const started = Date.now();
  const prompt = inputText(input, ["prompt", "text", "csv"]);
  const handled = handleOwnerWork(prompt) ?? handleOwnerWorkFromSkill(id, input);
  if (!handled) {
    return {
      ok: false as const,
      error: `Nothing for ${id} in that input.`,
      ms: Date.now() - started,
    };
  }
  return { ok: true as const, value: handled, ms: Date.now() - started };
}

function handleOwnerWorkFromSkill(
  id: string,
  input: Record<string, unknown>,
): OwnerWorkReply | null {
  const text = inputText(input, ["text", "csv", "prompt"]);
  if (id === "hisab.import" && text) {
    const result = hisab.importCsv(text, inputText(input, ["source"]) || "skill");
    return {
      text: `Imported ${result.added} row(s)${result.skipped ? `, skipped ${result.skipped}` : ""}. ${hisab.formatReport()}`,
    };
  }
  if (id === "hisab.report") return { text: hisab.formatReport() };
  if (id === "tender.read" && text) return { text: describeTender(text) };
  if (id === "desk.advice" && text) return { text: formatAdvice(structureAdvice(text)) };
  if (id === "desk.summary")
    return { text: personalDesk.summarise(/\bweek\b/i.test(text) ? "week" : "day") };
  if (id === "site.status") {
    const url = inputText(input, ["url"]) || extractUrl(text) || "";
    if (!url) return { text: "Give me the URL to check." };
    if (input["status"] != null || input["ok"] != null || input["error"] != null) {
      return {
        text: describeFetchedSite(url, {
          status: typeof input["status"] === "number" ? input["status"] : undefined,
          ok: typeof input["ok"] === "boolean" ? input["ok"] : undefined,
          ms: typeof input["ms"] === "number" ? input["ms"] : undefined,
          text: typeof input["body"] === "string" ? input["body"] : undefined,
          error: typeof input["error"] === "string" ? input["error"] : undefined,
        }),
      };
    }
    return {
      text: `I will fetch ${url} and report the real status code.`,
      action: {
        kind: "tool",
        tool: "http.fetch",
        args: { url },
        risk: "write",
        label: `check ${url}`,
      },
    };
  }
  return null;
}

const REMIND =
  /^(?:please\s+)?(remind me to|add (?:a |the )?task\b|add to(?: my)? (?:list|tasks)|todo:)\s+(.+)/i;
const LIST_TASKS =
  /\b(what(?:'s| is)? on my (?:list|plate)|my tasks|show (?:my )?tasks|open tasks|what do i need to do)\b/i;
const DONE_TASK = /^(?:please\s+)?(?:mark |tick )?(?:done|complete|finished)\s+(?:task\s+)?(.+)/i;
const NOTE_ADD =
  /^(?:please\s+)?(?:note that|write down|file a note|remember this(?: note)?)\s*[:-]\s*(.+)/i;
const NOTE_FIND = /\b(?:find|search|what are) my notes\b(?:\s+about\s+(.+))?/i;
const SUMMARY =
  /\b(daily summary|weekly summary|what did we do (today|this week)|summarise (?:my|the) (?:day|week))\b/i;
const ADVICE = /\bshould i\b|\bvs\.?\b|\bversus\b/i;
const HISAB_IMPORT =
  /\b(import (?:these |the )?(?:books|csv|statement|expenses|invoices)|add (?:these )?expenses)\b/i;
const HISAB_REPORT =
  /\b(profit\s*(?:and|&)\s*loss|p\s*&\s*l|hisab(?: kitab)?|how (?:are|is) (?:the )?books|running totals?)\b/i;
const TENDER = /\b(tender|rfp|request for proposal|notice inviting tender)\b/i;
const SITE_UP =
  /\b(is (https?:\/\/\S+) (?:up|down|online)|check (?:site |url )?(https?:\/\/\S+)|site status (https?:\/\/\S+))\b/i;
const SITE_PUBLISH = /\b(publish|edit (?:the )?(?:site|page|post))\b/i;
const SOCIAL_DRAFT = /\b(draft (?:a |this )?post|schedule (?:a |this )?post)\b/i;
const SOCIAL_OTHER = /\b(twitter|x\.com|instagram|facebook|linkedin)\b/i;

export function handleOwnerWork(prompt: string): OwnerWorkReply | null {
  const text = String(prompt || "").trim();
  if (!text) return null;

  const libraryReply = handleLibraryChat(text);
  if (libraryReply) return libraryReply;

  const projectReply = handleProjectWorkspaceChat(text);
  if (projectReply) return projectReply;

  const remind = REMIND.exec(text);
  if (remind?.[2]) {
    const parsed = parseTaskTitle(remind[2]);
    const task = personalDesk.add(parsed.title, parsed.dueAt);
    const when = task.dueAt ? ` I'll remind you at ${new Date(task.dueAt).toISOString()}.` : "";
    return { text: `Tracked: ${task.title}.${when}` };
  }

  if (LIST_TASKS.test(text)) {
    const open = personalDesk.list();
    if (!open.length) return { text: "Your task list is empty." };
    return {
      text: open
        .map(
          (task) =>
            `• ${task.title}${task.dueAt ? ` (due ${new Date(task.dueAt).toISOString()})` : ""}`,
        )
        .join("\n"),
    };
  }

  const done = DONE_TASK.exec(text);
  if (done?.[1]) {
    const task = personalDesk.complete(done[1]);
    return {
      text: task
        ? `Marked done: ${task.title}.`
        : `I could not find an open task matching “${done[1].trim()}”.`,
    };
  }

  const note = NOTE_ADD.exec(text);
  if (note?.[1]) {
    const body = note[1].trim();
    const title = body.slice(0, 60);
    personalDesk.addNote(title, body);
    return { text: `Filed that in memory as a note: ${title}` };
  }

  const find = NOTE_FIND.exec(text);
  if (find) {
    const query = (find[1] || "note").trim();
    const hits = personalDesk.findNotes(query);
    if (!hits.length) {
      const all = personalDesk.listNotes();
      return {
        text: all.length
          ? `I have ${all.length} note(s) but none matched “${query}”.`
          : "I have no notes stored yet.",
      };
    }
    return {
      text: hits.map((hit) => `• ${hit.item.title}: ${hit.item.text}`).join("\n"),
    };
  }

  if (SUMMARY.test(text)) {
    const range = /week/i.test(text) ? "week" : "day";
    return { text: personalDesk.summarise(range) };
  }

  if ((ADVICE.test(text) && /\?/.test(text)) || /^(should i)\b/i.test(text)) {
    return { text: formatAdvice(structureAdvice(text)) };
  }

  if (HISAB_IMPORT.test(text) || looksLikeCsv(text) || looksLikeCsv(stripCsvFence(text))) {
    const csv = looksLikeCsv(stripCsvFence(text)) ? stripCsvFence(text) : text;
    if (!looksLikeCsv(csv)) {
      return {
        text: "Paste the CSV/statement (headers + rows) and I will import the real figures into the books.",
      };
    }
    const result = hisab.importCsv(csv, "chat");
    if (!result.added) {
      return {
        text: `I parsed that as a table but could not turn any row into a debit or credit. ${result.skipped} row(s) skipped.`,
      };
    }
    return { text: `Imported ${result.added} record(s) into the books. ${hisab.formatReport()}` };
  }

  const payeeAsk = parsePayeeAsk(text);
  if (payeeAsk) {
    return { text: hisab.payeeReport(payeeAsk.payee, payeeAsk.range).text };
  }

  if (HISAB_REPORT.test(text)) {
    return { text: hisab.formatReport() };
  }

  if (TENDER.test(text) && text.length > 80) {
    const body = stripCsvFence(text);
    const plan = tenderModelPlan(text.slice(0, 200));
    const roles = plan.steps
      .map((step) => `${step.role}${step.modelLabel ? ` → ${step.modelLabel}` : ""}`)
      .join(", ");
    return {
      text: `${describeTender(body)}\n\nFor a reasoning pass I would use: ${roles || "no model available yet"}. I will not fill missing clauses from training data.`,
    };
  }
  if (TENDER.test(text)) {
    return {
      text: "Paste the tender/RFP text (or the extracted document) and I will quote only what it actually says.",
    };
  }

  const site = SITE_UP.exec(text);
  if (site) {
    const url = site[2] || site[3] || site[4] || extractUrl(text);
    if (!url) return { text: "Give me the URL to check." };
    return {
      text: "",
      action: {
        kind: "tool",
        tool: "http.fetch",
        args: { url },
        risk: "write",
        label: `check ${url}`,
      },
    };
  }

  if (SITE_PUBLISH.test(text) && /\b(site|website|page|wordpress|shopify|post)\b/i.test(text)) {
    const cms = namedCms(text);
    if (!cms) return { text: SITE_PLATFORM_NEEDED };
    const actionId = cmsWriteActionId(cms.id, text);
    const tool = connectorTools().find(
      (entry) => entry.connectorId === cms.id && entry.action.id === actionId,
    );
    if (!tool?.connected) return { text: cmsConnectHint(cms.name) };
    const body = text
      .replace(
        /^.*?(?:publish|edit)\s+(?:this |the |a )?(?:site|website|page|post)?\s*[:-]\s*/i,
        "",
      )
      .trim();
    return {
      text: `I can ${actionId.includes("edit") ? "edit" : "publish"} this on ${cms.name} after you approve it.`,
      action: {
        kind: "connector",
        tool: tool.tool,
        args: {
          title: body.slice(0, 80) || "FRIDAY update",
          content: body,
          body,
          text: body,
          status: /\bpublish\b/i.test(text) ? "publish" : "draft",
        },
        risk: "exec",
        label: `${cms.name} · ${tool.action.label}`,
      },
    };
  }

  const social = namedSocial(text);
  if (social && /\b(post|schedule|publish|draft|tweet)\b/i.test(text)) {
    const body =
      text
        .replace(
          /^.*?(?:draft|schedule|post|publish|tweet)\s+(?:a |this |to |on )?(?:post |tweet )?\s*[:-]\s*/i,
          "",
        )
        .trim() ||
      text
        .replace(SOCIAL_OTHER, "")
        .replace(/\b(draft|schedule|post|publish|tweet|to|on)\b/gi, " ")
        .trim();
    if (body.length >= 4) personalDesk.addSocialDraft(body);
    const actionId = socialWriteActionId(social.id);
    const tool = connectorTools().find(
      (entry) => entry.connectorId === social.id && entry.action.id === actionId,
    );
    if (!tool?.connected) {
      return {
        text: `${body.length >= 4 ? `Filed a local draft (“${body.slice(0, 80)}”). ` : ""}${socialConnectHint(social.name)}`,
      };
    }
    return {
      text: `I ${body.length >= 4 ? "filed a local draft and " : ""}can post this to ${social.name} after you approve it:\n${body}`,
      action: {
        kind: "connector",
        tool: tool.tool,
        args: { message: body, text: body, caption: body },
        risk: "exec",
        label: `${social.name} · ${tool.action.label}`,
      },
    };
  }

  if (SOCIAL_DRAFT.test(text)) {
    const slack = connectorTools().find(
      (tool) => tool.connectorId === "slack" && tool.action.id === "post",
    );
    const body = text.replace(/^.*?(?:draft|schedule)\s+(?:a |this )?post\s*[:-]\s*/i, "").trim();
    if (!body || body.length < 4) {
      return { text: "Give me the post text after a colon, e.g. draft a post: shipping Friday." };
    }
    personalDesk.addSocialDraft(body);
    const due = parseTaskTitle(text).dueAt;
    if (/\bschedule\b/i.test(text) && due) {
      personalDesk.add(`Post: ${body.slice(0, 80)}`, due);
    }
    if (!slack?.connected) {
      return {
        text: `Filed a local draft (“${body.slice(0, 80)}”). ${SOCIAL_UNSUPPORTED}`,
      };
    }
    return {
      text: `I filed a local draft and can post this to Slack after you approve it:\n${body}`,
      action: {
        kind: "connector",
        tool: slack.tool,
        args: { message: body, text: body },
        risk: "exec",
        label: "Slack · Post a message",
      },
    };
  }

  return null;
}

function looksLikeCsv(text: string): boolean {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return false;
  const header = lines[0]!.toLowerCase();
  return (
    /,/.test(lines[0]!) &&
    /\b(date|amount|debit|credit|description|narration)\b/.test(header) &&
    lines.slice(1).some((line) => /,/.test(line))
  );
}

function stripCsvFence(text: string): string {
  const fenced = /```(?:csv|text)?\n([\s\S]*?)```/.exec(text);
  if (fenced?.[1]) return fenced[1];
  const idx = text.search(/\bdate\b.*,/i);
  return idx >= 0 ? text.slice(idx) : text;
}

function extractUrl(text: string): string | null {
  const match = /https?:\/\/[^\s)]+/i.exec(text);
  return match?.[0] ?? null;
}

/** After http.fetch returns, turn the real status into a sentence. */
export function describeFetchedSite(
  url: string,
  result: {
    ok?: boolean | undefined;
    status?: number | undefined;
    text?: string | undefined;
    error?: string | undefined;
    ms?: number | undefined;
  },
) {
  return interpretSiteStatus({
    url,
    status: result.status,
    ok: result.ok,
    ms: result.ms,
    body: result.text,
    error: result.error,
  }).note;
}
