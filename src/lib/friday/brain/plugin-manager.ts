/**
 * FRIDAY · plugin manager
 *
 * Plugins are managed on the Plugins page; this is the same through chat: "what plugins do you have", "what did
 * my plugins notice", "turn off the break reminder plugin", "tell me about the secret leak radar plugin". A
 * command must name the word "plugin", so ordinary conversation never changes anything. Reading is free;
 * switching a plugin on or off goes through the same owner approval gate as the skill manager, and a request
 * still waiting for approval is reported as filed, never as done. Removing and installing stay on the page.
 */
import { listCapabilities, setCapabilityEnabled } from "../capability-trees";
import { pluginInsights, setPluginEnabled, type PluginInsight } from "../desktop";
import { gateText, defaultHost as skillHost, type GateOutcome } from "./skill-manager";

export type PluginCommand =
  | { kind: "list"; query: string }
  | { kind: "insights" }
  | { kind: "info"; target: string }
  | { kind: "enable" | "disable"; target: string };

export type ManagedPlugin = {
  /** Capability id (`plugins/installed/<slug>`), also the id the runtime toggles. */
  id: string;
  name: string;
  category: string;
  enabled: boolean;
  summary: string;
  shipped: boolean;
  permissions: string[];
};

export type PluginManagerHost = {
  list(): Promise<ManagedPlugin[]>;
  insights(): Promise<PluginInsight[]>;
  setEnabled(plugin: ManagedPlugin, enabled: boolean): Promise<{ ok: boolean; error?: string }>;
  gate: typeof skillHost.gate;
};

export type PluginManagementResult = {
  handled: true;
  kind: PluginCommand["kind"];
  ok: boolean;
  text: string;
};

const PLUGIN_WORD = /\bplugins?\b/i;

const clean = (raw: string) =>
  raw
    .replace(/^(?:the|my|a|an|ye|woh|wo)\s+/i, "")
    .replace(/\s+(?:plugin|plugins)$/i, "")
    .replace(/["'`.!?]+$/g, "")
    .trim();

export function parsePluginCommand(prompt: string): PluginCommand | null {
  const lower = prompt
    .replace(/\b(?:please|friday|can you|could you|kindly|zara|na)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!lower || lower.length > 300 || !PLUGIN_WORD.test(lower)) return null;

  const verb = "(enable|disable|activate|deactivate|turn on|turn off|switch on|switch off)";
  let m = lower.match(new RegExp(`^${verb}\\s+(?:the\\s+|my\\s+)?(.{2,80}?)\\s+plugin\\s*[.!]?$`));
  if (!m)
    m = lower.match(
      new RegExp(`^${verb}\\s+(?:the\\s+)?plugin\\s+(?:called\\s+)?(.{2,80}?)\\s*[.!]?$`),
    );
  if (m) {
    const kind = /^(?:enable|activate|turn on|switch on)$/.test(m[1]!) ? "enable" : "disable";
    const target = clean(m[2]!);
    return target ? { kind, target } : null;
  }
  m = lower.match(
    /^(.{2,80}?)\s+plugin\s+(?:ko\s+)?(on|off|chalu|band|shuru)(?:\s+kar(?:o|do)?)?\s*[.!]?$/,
  );
  if (m) {
    const target = clean(m[1]!);
    return target
      ? { kind: /^(?:on|chalu|shuru)$/.test(m[2]!) ? "enable" : "disable", target }
      : null;
  }
  m =
    lower.match(
      /^(?:what does|what is|tell me about|explain|describe|details of)\s+(?:the\s+)?(.{2,80}?)\s+plugin(?:\s+do)?\s*[?.!]?$/,
    ) ?? lower.match(/^(.{2,80}?)\s+plugin\s+(?:kya karta hai|kya hai|batao)\s*[?.!]?$/);
  if (m) {
    const target = clean(m[1]!);
    return target ? { kind: "info", target } : null;
  }
  if (
    /\b(?:what|which)\s+(?:did\s+)?(?:my\s+|your\s+|the\s+)?plugins?\s+(?:notice|noticed|found|say|report|reported)\b/.test(
      lower,
    ) ||
    /\bplugins?\s+(?:insights?|report|findings|alerts)\b/.test(lower) ||
    /\b(?:insights?|findings|alerts)\s+(?:from|of)\s+(?:my\s+|the\s+)?plugins?\b/.test(lower) ||
    /\bplugins?\s+ne\s+kya\b/.test(lower)
  )
    return { kind: "insights" };
  const asks =
    /^(?:list|show|display|give me|show me|tell me)\s+(?:me\s+)?(?:all\s+|my\s+|your\s+|the\s+|installed\s+|active\s+|enabled\s+|available\s+)*(?:\w+\s+)?plugins\b/.test(
      lower,
    ) ||
    /\b(?:what|which)\s+(?:\w+\s+)?plugins\s+(?:do you have|are installed|are enabled|are active|are available|have you got)\b/.test(
      lower,
    ) ||
    /\bhow many plugins\b/.test(lower) ||
    /\b(?:your|my)\s+plugins\s*(?:list)?\s*[?.!]?$/.test(lower) ||
    /\bplugins\s+(?:list|dikhao|batao)\b/.test(lower) ||
    /\b(?:installed|enabled|active)\s+plugins\b/.test(lower);
  if (!asks) return null;
  const query = lower
    .replace(
      /\b(?:list|show|display|give|me|tell|all|my|your|the|installed|active|enabled|available|what|which|plugins?|do|you|have|are|how|many|please|dikhao|batao)\b/g,
      " ",
    )
    .replace(/[?.!,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { kind: "list", query };
}

const norm = (s: string) => s.toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
const slug = (id: string) => id.split("/").filter(Boolean).pop() ?? id;

export function resolvePlugin(
  target: string,
  plugins: ManagedPlugin[],
): { plugin: ManagedPlugin } | { candidates: ManagedPlugin[] } | { none: true } {
  const want = norm(target);
  const exact = plugins.filter((p) => norm(slug(p.id)) === want || norm(p.name) === want);
  if (exact.length === 1) return { plugin: exact[0]! };
  const partial = exact.length
    ? exact
    : plugins.filter((p) => norm(p.name).includes(want) || norm(slug(p.id)).includes(want));
  if (partial.length === 1) return { plugin: partial[0]! };
  if (partial.length > 1) return { candidates: partial.slice(0, 6) };
  return { none: true };
}

export function describePlugins(plugins: ManagedPlugin[], query = ""): string {
  const needle = query.trim().toLowerCase();
  const pool = needle
    ? plugins.filter((p) => `${p.name} ${p.category} ${p.summary}`.toLowerCase().includes(needle))
    : plugins;
  const on = pool.filter((p) => p.enabled);
  const off = pool.filter((p) => !p.enabled);
  const lines = [
    `${plugins.length} plugin(s): ${plugins.filter((p) => p.enabled).length} on, ${plugins.filter((p) => !p.enabled).length} off; ${plugins.filter((p) => p.shipped).length} ship with FRIDAY.`,
  ];
  if (needle)
    lines.push(
      pool.length ? `Matching "${query}": ${pool.length}.` : `No plugin matches "${query}".`,
    );
  const by = new Map<string, string[]>();
  for (const p of on)
    by.set(p.category || "other", [...(by.get(p.category || "other") ?? []), p.name]);
  for (const [category, names] of [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])))
    lines.push(
      `${category} (on): ${names.slice(0, 10).join(", ")}${names.length > 10 ? `, and ${names.length - 10} more` : ""}`,
    );
  if (off.length)
    lines.push(
      `Off (${off.length}): ${off
        .slice(0, 10)
        .map((p) => p.name)
        .join(
          ", ",
        )}${off.length > 10 ? ", ..." : ""}. Say "enable the <name> plugin" to switch one on.`,
    );
  return lines.join("\n");
}

export function describeInsights(rows: PluginInsight[]): string {
  if (!rows.length)
    return "No plugin has anything to report yet. Plugins write a note as they see turns, errors and idle time.";
  const lines = [`${rows.length} plugin(s) have something to say (warnings first):`];
  for (const r of rows.slice(0, 10))
    lines.push(`- ${r.level === "warn" ? "WARNING " : ""}${r.name}: ${r.title}. ${r.text}`);
  return lines.join("\n");
}

export async function managePlugins(
  prompt: string,
  host: PluginManagerHost = defaultHost,
): Promise<PluginManagementResult | null> {
  const command = parsePluginCommand(prompt);
  if (!command) return null;
  const result = (ok: boolean, text: string): PluginManagementResult => ({
    handled: true,
    kind: command.kind,
    ok,
    text,
  });
  if (command.kind === "insights") return result(true, describeInsights(await host.insights()));
  const plugins = await host.list();
  if (command.kind === "list") return result(true, describePlugins(plugins, command.query));
  const found = resolvePlugin(command.target, plugins);
  if ("none" in found && command.kind === "info") return null;
  if ("none" in found)
    return result(
      false,
      `No plugin is called "${command.target}". ${describePlugins(plugins).split("\n")[0]}`,
    );
  if ("candidates" in found)
    return result(
      false,
      `More than one plugin matches "${command.target}": ${found.candidates.map((p) => p.name).join("; ")}. Ask the owner which one.`,
    );
  const plugin = found.plugin;
  if (command.kind === "info") {
    const note = (await host.insights()).find((r) => r.id === plugin.id);
    return result(
      true,
      `${plugin.name} (${slug(plugin.id)}, ${plugin.category || "no category"}): ${plugin.summary || "no summary"}. It is ${plugin.enabled ? "on" : "off"}, ${plugin.shipped ? "ships with FRIDAY" : "was installed by the owner"}, permissions: ${plugin.permissions.length ? plugin.permissions.join(", ") : "none"}.${note ? ` Latest note: ${note.title}: ${note.text}` : ""}`,
    );
  }
  const enable = command.kind === "enable";
  if (plugin.enabled === enable)
    return result(true, `${plugin.name} is already ${enable ? "on" : "off"}. Nothing changed.`);
  const out: GateOutcome = await host.gate(
    `${enable ? "Enable" : "Disable"} plugin - ${plugin.name}`,
    enable
      ? `Turns ${plugin.name} on. It then runs on its hooks with ${plugin.permissions.length ? `these permissions: ${plugin.permissions.join(", ")}` : "no permissions"}.`
      : `Turns ${plugin.name} off; it stops receiving hooks.`,
    "review",
    [`capability:${plugin.id}`],
    async () => {
      const r = await host.setEnabled(plugin, enable);
      return {
        ok: r.ok,
        detail: r.ok ? (enable ? "enabled" : "disabled") : (r.error ?? "could not change it"),
      };
    },
  );
  return result(
    out.state === "done" || out.state === "waiting",
    gateText(`${enable ? "Enabling" : "Disabling"} ${plugin.name}`, out),
  );
}

export const defaultHost: PluginManagerHost = {
  async list() {
    const caps = await listCapabilities().catch(() => null);
    return (caps?.items ?? [])
      .filter((item) => item.tree === "plugins")
      .map((item) => ({
        id: item.id,
        name: item.name,
        category: item.category || "",
        enabled: item.enabled,
        summary: item.summary || item.description || "",
        shipped: item.origin === "app",
        permissions: item.permissions ?? [],
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
  insights: () => pluginInsights().catch(() => []),
  async setEnabled(plugin, enabled) {
    if (!(await setCapabilityEnabled(plugin.id, enabled)))
      return { ok: false, error: "Could not update the capability index." };
    const runtime = await setPluginEnabled(plugin.id, enabled);
    return runtime?.ok
      ? { ok: true }
      : { ok: false, error: runtime?.error || "Could not update the plugin runtime." };
  },
  gate: skillHost.gate,
};

export async function managePluginsFromPrompt(
  prompt: string,
): Promise<PluginManagementResult | null> {
  try {
    return await managePlugins(prompt);
  } catch (error) {
    return {
      handled: true,
      kind: "list",
      ok: false,
      text: `Plugin management failed: ${String((error as Error)?.message ?? error)}`,
    };
  }
}

/** Warning-level plugin notes as plain lines, or "" when there are none: FRIDAY's status answers include them. */
export async function pluginWarnings(host: PluginManagerHost = defaultHost): Promise<string> {
  const warn = (await host.insights()).filter((row) => row.enabled && row.level === "warn");
  if (!warn.length) return "";
  return `Plugin warnings (from the owner's plugins, newest data):\n${warn
    .slice(0, 5)
    .map((row) => `- ${row.name}: ${row.title}. ${row.text}`)
    .join("\n")}`;
}
