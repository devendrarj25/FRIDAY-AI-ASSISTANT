/**
 * FRIDAY · composer capabilities
 *
 * One place that answers "what can FRIDAY actually use right now?".
 *
 * Everything here is derived from real state: the models engine (installed /
 * active / routable models) and the workspace scan (skills, plugins, agents,
 * workflows, modules, tools that really exist inside the FRIDAY folder). The
 * An empty workspace stays an empty list. Sample catalogs are not a fallback.
 *
 * The composer uses this for three things: the Attach menu, the removable
 * chips under the input, and the "related capability" suggestions FRIDAY
 * offers while the owner is typing.
 */
import type { WorkspaceScanResult } from "./desktop";
import type { ModelsState } from "./models-engine";
import { modelCatalog } from "./model-catalog";
import { knownConnectors } from "./connectors";

export type CapabilityKind =
  "models" | "modules" | "tools" | "workflows" | "skills" | "plugins" | "agents" | "connectors";

export type Capability = {
  /** Stable id used for selection: `${kind}:${name}`. */
  id: string;
  kind: CapabilityKind;
  /** Group label shown in the menu and on the chip. */
  group: string;
  name: string;
  /** Real reference (model id, plugin id, skill id …) when we have one. */
  ref?: string;
  detail?: string;
  /** True when this entry came from real local state rather than a fallback. */
  live: boolean;
};

export type CapabilityGroup = {
  kind: CapabilityKind;
  label: string;
  items: Capability[];
};

const GROUP_LABEL: Record<CapabilityKind, string> = {
  models: "Models",
  modules: "Modules",
  tools: "Tools",
  workflows: "Workflows",
  skills: "Skills",
  plugins: "Plugins",
  agents: "Agents",
  connectors: "Connectors",
};

export const capabilityId = (kind: CapabilityKind, name: string) => `${kind}:${name}`;

function make(
  kind: CapabilityKind,
  name: string,
  extra: { ref?: string; detail?: string; live: boolean },
): Capability {
  return {
    id: capabilityId(kind, name),
    kind,
    group: GROUP_LABEL[kind],
    name,
    ...(extra.ref ? { ref: extra.ref } : {}),
    ...(extra.detail ? { detail: extra.detail } : {}),
    live: extra.live,
  };
}

function dedupe(items: Capability[]): Capability[] {
  const seen = new Set<string>();
  const out: Capability[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

/** Built-in tools FRIDAY always ships with (they live in her own runtime). */
const BUILTIN_TOOLS: { name: string; detail: string }[] = [
  { name: "Web Search", detail: "her own browser — search the live web" },
  { name: "Web Open", detail: "open a page and read it" },
  { name: "Download", detail: "fetch a file into the workspace" },
  { name: "File System", detail: "read/write inside the FRIDAY workspace" },
  { name: "Shell", detail: "run a command (approval required)" },
  { name: "Python", detail: "run Python in the sandbox" },
  { name: "Sandbox", detail: "verify code before it is applied" },
  { name: "Memory", detail: "recall and store long-term memory" },
  { name: "Screenshot", detail: "capture a page or the screen" },
];

/** Compose every capability FRIDAY can attach to a message. */
export function buildCapabilityGroups(
  modelsState: ModelsState | null,
  scan: WorkspaceScanResult | null,
): CapabilityGroup[] {
  // --- models: what is really installed / active, then the known catalog.
  const modelItems: Capability[] = [];
  if (modelsState) {
    for (const id of modelsState.active) {
      const meta = modelCatalog.find((m) => m.id === id);
      modelItems.push(
        make("models", meta?.name ?? id, {
          ref: id,
          detail: `${meta?.provider ?? "local"} · active`,
          live: true,
        }),
      );
    }
    for (const [id, version] of Object.entries(modelsState.installed)) {
      const meta = modelCatalog.find((m) => m.id === id);
      modelItems.push(
        make("models", meta?.name ?? id, {
          ref: id,
          detail: `${meta?.provider ?? "local"}${version ? ` · ${version}` : ""} · installed`,
          live: true,
        }),
      );
    }
    for (const imported of modelsState.imported) {
      modelItems.push(
        make("models", imported.name ?? imported.id, {
          ref: imported.id,
          detail: "imported",
          live: true,
        }),
      );
    }
  }
  if (!modelItems.length) {
    for (const m of modelCatalog.slice(0, 16)) {
      modelItems.push(make("models", m.name, { ref: m.id, detail: m.provider, live: false }));
    }
  }

  const fromScan = (
    kind: CapabilityKind,
    rows: { id: string; name: string; version: string | null }[] | undefined,
  ): Capability[] =>
    (rows ?? []).map((row) =>
      make(kind, row.name || row.id, {
        ref: row.id,
        ...(row.version ? { detail: row.version } : {}),
        live: true,
      }),
    );

  const skills = fromScan("skills", scan?.skills);
  const plugins = fromScan("plugins", scan?.plugins);
  const agents = fromScan("agents", scan?.agents);
  const workflows = fromScan("workflows", scan?.workflows);
  const modules = fromScan("modules", scan?.modules);
  const scanTools = fromScan("tools", scan?.tools);

  const groups: CapabilityGroup[] = [
    { kind: "models", label: GROUP_LABEL.models, items: dedupe(modelItems) },
    {
      kind: "tools",
      label: GROUP_LABEL.tools,
      items: dedupe([
        ...scanTools,
        ...BUILTIN_TOOLS.map((t) => make("tools", t.name, { detail: t.detail, live: true })),
      ]),
    },
    {
      kind: "skills",
      label: GROUP_LABEL.skills,
      items: dedupe(skills),
    },
    {
      kind: "agents",
      label: GROUP_LABEL.agents,
      items: dedupe(agents),
    },
    {
      kind: "workflows",
      label: GROUP_LABEL.workflows,
      items: dedupe(workflows),
    },
    {
      kind: "plugins",
      label: GROUP_LABEL.plugins,
      items: dedupe(plugins),
    },
    {
      kind: "modules",
      label: GROUP_LABEL.modules,
      items: dedupe(modules),
    },
    {
      kind: "connectors",
      label: GROUP_LABEL.connectors,
      items: knownConnectors().map((connector) =>
        make("connectors", connector.name, {
          ref: connector.id,
          detail: connector.connected
            ? connector.account
              ? `connected as ${connector.account}`
              : "connected"
            : "not connected",
          live: true,
        }),
      ),
    },
  ];
  return groups.filter((group) => group.items.length > 0);
}

/** Flatten groups into one lookup list. */
export function flatten(groups: CapabilityGroup[]): Capability[] {
  return groups.flatMap((g) => g.items);
}

/** Keyword hints that map what the owner is typing to a capability. */
const HINTS: { test: RegExp; kinds: CapabilityKind[]; names: RegExp }[] = [
  {
    test: /\b(search|google|web|online|latest|news|browse)\b/i,
    kinds: ["tools"],
    names: /web|search|browser|download/i,
  },
  {
    test: /\b(file|folder|read|write|open|save|zip|document)\b/i,
    kinds: ["tools"],
    names: /file|system|download/i,
  },
  {
    test: /\b(run|execute|command|terminal|shell|install)\b/i,
    kinds: ["tools"],
    names: /shell|sandbox|python/i,
  },
  {
    test: /\b(code|bug|refactor|script|python|typescript|compile|build)\b/i,
    kinds: ["tools", "skills", "agents"],
    names: /code|python|sandbox|develop/i,
  },
  { test: /\b(remember|memory|recall|note|forget)\b/i, kinds: ["tools"], names: /memory/i },
  {
    test: /\b(screenshot|image|picture|screen|vision)\b/i,
    kinds: ["tools", "models"],
    names: /screenshot|vision/i,
  },
  {
    test: /\b(workflow|automate|automation|pipeline|schedule)\b/i,
    kinds: ["workflows"],
    names: /./,
  },
  { test: /\b(plugin|extension|integration)\b/i, kinds: ["plugins"], names: /./ },
  { test: /\b(agent|delegate|team)\b/i, kinds: ["agents"], names: /./ },
  {
    test: /\b(github|repo|commit|clone|pull request|slack|notion|trello|jira)\b/i,
    kinds: ["connectors", "tools"],
    names: /github|slack|notion|trello|jira|file|download/i,
  },
  { test: /\b(model|llm|ollama|gpt|llama|qwen|mistral)\b/i, kinds: ["models"], names: /./ },
];

/**
 * Related capabilities for what is being typed right now.
 * Direct name matches always come first, then keyword-driven hints.
 */
export function suggestCapabilities(
  text: string,
  groups: CapabilityGroup[],
  selected: string[],
  limit = 5,
): Capability[] {
  const query = text.trim();
  if (query.length < 3) return [];
  const chosen = new Set(selected);
  const all = flatten(groups).filter((c) => !chosen.has(c.id));
  const out: Capability[] = [];
  const push = (c: Capability) => {
    if (out.length >= limit || out.some((x) => x.id === c.id)) return;
    out.push(c);
  };

  const lower = query.toLowerCase();
  const words = lower.split(/[^a-z0-9+.#-]+/).filter((w) => w.length >= 3);
  for (const cap of all) {
    const name = cap.name.toLowerCase();
    if (words.some((w) => name.includes(w) || w.includes(name))) push(cap);
  }

  for (const hint of HINTS) {
    if (!hint.test.test(query)) continue;
    for (const cap of all) {
      if (!hint.kinds.includes(cap.kind)) continue;
      if (!hint.names.test(cap.name)) continue;
      push(cap);
    }
  }
  return out.slice(0, limit);
}

/**
 * Turn the attached capabilities into a real instruction block for the model
 * plus the concrete model ids FRIDAY must run this turn.
 */
export function capabilityDirective(caps: Capability[]): { extra: string; modelIds: string[] } {
  if (!caps.length) return { extra: "", modelIds: [] };
  const modelIds = caps.filter((c) => c.kind === "models" && c.ref).map((c) => c.ref as string);
  const others = caps.filter((c) => c.kind !== "models");
  const lines: string[] = [];
  if (others.length) {
    lines.push(
      "The owner attached these capabilities to this message. Use them for this turn — prefer them over anything else, and say so plainly if one of them is not available:",
      ...others.map((c) => `- ${c.group}: ${c.name}${c.detail ? ` (${c.detail})` : ""}`),
    );
  }
  if (modelIds.length > 1) {
    lines.push(
      `Run this turn across the ${modelIds.length} models the owner pinned and reconcile the answers.`,
    );
  }
  return { extra: lines.join("\n"), modelIds };
}
