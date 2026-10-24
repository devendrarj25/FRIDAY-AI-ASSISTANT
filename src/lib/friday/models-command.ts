/**
 * Ask FRIDAY about her own models and providers, in plain words.
 *
 * "Which models are installed?", "which providers are connected?", "any model
 * cooling down?", "how many tokens have I used?", "what is the router doing?"
 * and "download qwen2.5 1.5b" are answered from the same stores the Models page
 * reads, with no model call, so the answer is the page's answer and never a
 * guess. Anything that is not clearly one of these questions returns null and
 * goes on to the normal brain.
 */
import { modelCatalog, providerById, type ModelSpec } from "./model-catalog";
import { formatTokens, modelLive, modelLiveState, type ModelLiveState } from "./model-live";
import { modelRegistry, type RegistryState } from "./model-registry";
import { models as modelsStore, formatGb, isJobActive, type ModelsState } from "./models-engine";

export type ModelsView = {
  models: ModelsState;
  registry: RegistryState;
  live: ModelLiveState;
  now: number;
};

const list = (items: string[], max = 8) =>
  items.length <= max
    ? items.join(", ")
    : `${items.slice(0, max).join(", ")} and ${items.length - max} more`;

function installedLine(view: ModelsView): string {
  const local = modelCatalog.filter((m) => m.kind === "local" && view.models.installed[m.id]);
  const imported = view.models.imported.filter((m) => m.state === "ready").map((m) => m.name);
  const downloading = view.models.jobs.filter((j) => isJobActive(j.phase));
  const parts: string[] = [];
  if (local.length) {
    parts.push(
      `${local.length} local model(s) installed: ${list(local.map((m) => `${m.name} (${formatGb(m.sizeGb)})`))}.`,
    );
  } else {
    parts.push(
      view.models.lastScanAt
        ? "No local model is installed yet."
        : "I have not scanned this PC for local models yet, so I cannot say what is installed.",
    );
  }
  if (imported.length) parts.push(`Your own models, ready: ${list(imported)}.`);
  if (downloading.length) {
    parts.push(
      `Downloading now: ${list(downloading.map((j) => `${j.label ?? j.modelId} ${Math.round(j.progress)}%`))}.`,
    );
  }
  return parts.join(" ");
}

function providersLine(view: ModelsView): string {
  const rows = Object.values(view.models.providerState);
  const cloud = rows.filter((p) => providerById.get(p.id)?.kind === "cloud" && p.apiKey);
  const local = rows.filter((p) => providerById.get(p.id)?.kind === "local" && p.online);
  const name = (id: string) => providerById.get(id as never)?.name ?? id;
  const cloudText = cloud.length
    ? `Cloud connected: ${list(cloud.map((p) => `${name(p.id)} (${p.models} model(s)${p.error ? `, ${p.error}` : ""})`))}.`
    : "No cloud provider has a key yet.";
  const localText = local.length
    ? `Local engines answering: ${list(local.map((p) => `${name(p.id)} (${p.models})`))}.`
    : "No local engine is answering.";
  return `${cloudText} ${localText}`;
}

function healthLine(view: ModelsView): string {
  const rows = Object.values(view.live.byId)
    .map((row) => ({ row, state: modelLiveState(row, view.now) }))
    .filter(({ state }) =>
      ["Quarantined", "Rate limited", "Cooling down", "Recovering"].includes(state.state),
    );
  if (!rows.length) return "No model is cooling down or quarantined right now.";
  const label = (id: string) => view.registry.models.find((m) => m.id === id)?.label ?? id;
  return rows
    .map(
      ({ row, state }) => `${label(row.modelId)}: ${state.state.toLowerCase()} — ${state.detail}`,
    )
    .join(" ");
}

function tokensLine(view: ModelsView): string {
  const { totals } = view.live;
  if (!totals.requests) return "No model has answered since I started counting.";
  const top = Object.values(view.live.byId)
    .sort((a, b) => b.promptTokens + b.completionTokens - (a.promptTokens + a.completionTokens))
    .slice(0, 3)
    .map((row) => {
      const label = view.registry.models.find((m) => m.id === row.modelId)?.label ?? row.modelId;
      return `${label} ≈${formatTokens(row.promptTokens + row.completionTokens)}`;
    });
  return `${totals.requests} request(s), about ${formatTokens(totals.tokens)} tokens in total and ${formatTokens(totals.todayTokens)} today (counted from text length, not billed figures). Most used: ${list(top)}.`;
}

function routerLine(view: ModelsView): string {
  const { registry, live } = view;
  const last = live.decisions[live.decisions.length - 1];
  const lastLabel = last
    ? (registry.models.find((m) => m.id === last.modelId)?.label ?? last.modelId)
    : null;
  return [
    `Router mode ${registry.routeMode}, cost policy ${registry.policy}, quality ${registry.qualityTarget}, strategy ${registry.strategy}.`,
    registry.selected.length
      ? `You picked ${registry.selected.length} model(s) for chat.`
      : "No model is pinned, so I choose.",
    lastLabel ? `Last tried: ${lastLabel} (${last!.outcome}).` : "I have not routed a request yet.",
    registry.hint,
  ]
    .filter(Boolean)
    .join(" ");
}

function freeLine(view: ModelsView): string {
  const free = view.registry.models.filter((m) => m.type === "cloud" && m.access === "free");
  const paid = view.registry.models.filter((m) => m.type === "cloud" && m.access === "paid");
  const unknown = view.registry.models.filter((m) => m.type === "cloud" && m.access === "unknown");
  return `Cloud models I can see: ${free.length} free, ${paid.length} paid, ${unknown.length} unknown cost. Local models are always free.`;
}

const HAS = (re: RegExp, text: string) => re.test(text);

/** The answer for a question about models or providers, or null when it is not one. */
export function answerModelsQuestion(text: string, view: ModelsView): string | null {
  const t = text.toLowerCase().trim();
  if (t.length < 6 || t.length > 220) return null;
  const about = HAS(/\b(models?|providers?|router|routing|tokens?|cooldown|quarantin\w*)\b/, t);
  if (!about) return null;
  const asks = HAS(
    /\b(which|what|kaun\s*s[ei]|kon\s*s[ei]|kya|kitn\w*|how\s+many|show|list|dikha\w*|batao|bata\w*|status|any|koi|is|are)\b/,
    t,
  );
  if (!asks) return null;

  if (HAS(/\b(cooldown|cooling|quarantin\w*|rate.?limit\w*|blocked|recovering)\b/, t)) {
    return healthLine(view);
  }
  if (
    HAS(/\btokens?\b/, t) &&
    HAS(/\b(used|usage|spent|consumed|so far|today|aaj|kharch\w*)\b/, t)
  ) {
    return tokensLine(view);
  }
  if (
    HAS(/\b(router|routing)\b/, t) ||
    HAS(/\bwhich model (are you|is being|did you) us\w*\b/, t)
  ) {
    return routerLine(view);
  }
  if (HAS(/\b(free|paid|cost|price|sasta|muft)\b/, t) && HAS(/\bmodels?\b/, t))
    return freeLine(view);
  if (HAS(/\bproviders?\b/, t)) return providersLine(view);
  if (HAS(/\b(installed|downloaded|download\s*hue|install\s*hue|have|hain|hai|available)\b/, t)) {
    return `${installedLine(view)} ${providersLine(view)}`;
  }
  return null;
}

/** A catalog model the words name exactly, or null (never a guess between two). */
export function modelNamed(text: string): ModelSpec | null {
  const t = ` ${text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}.:]+/gu, " ")
    .trim()} `;
  const hits = modelCatalog.filter((m) => {
    if (m.kind !== "local") return false;
    const forms = [m.name, m.id].map(
      (n) =>
        ` ${n
          .toLowerCase()
          .replace(/[^\p{L}\p{N}.:]+/gu, " ")
          .trim()} `,
    );
    return forms.some((f) => f.trim().length >= 4 && t.includes(f));
  });
  if (hits.length === 0) return null;
  const longest = Math.max(...hits.map((m) => m.name.length));
  const best = hits.filter((m) => m.name.length === longest);
  return best.length === 1 ? best[0]! : null;
}

function currentView(): ModelsView {
  return {
    models: modelsStore.getSnapshot(),
    registry: modelRegistry.getSnapshot(),
    live: modelLive.getSnapshot(),
    now: Date.now(),
  };
}

/** Brain entry point. Questions are answered; "download/install <model>" starts the same job the button does. */
export function handleModelsCommand(text: string): string | null {
  const message = text.trim();
  const lower = message.toLowerCase();
  if (/^(refresh|rescan|scan)\s+(the\s+)?(models?|providers?)\b/.test(lower)) {
    void modelsStore.scan();
    void modelRegistry.refresh(true);
    void modelLive.refresh();
    return "Scanning this PC and every connected provider for models now. The Models page updates as results arrive.";
  }
  const install = /^(download|install|pull)\s+(the\s+)?(.+?)(\s+model)?$/.exec(lower);
  if (install) {
    const spec = modelNamed(install[3]!);
    if (!spec) return null;
    const view = currentView();
    if (view.models.installed[spec.id]) return `${spec.name} is already installed.`;
    modelsStore.install(spec.id);
    return `Downloading ${spec.name} (${formatGb(spec.sizeGb)}). It installs and verifies itself; progress is in the Models page.`;
  }
  // Ask the live stores for fresh data first so the next answer is current.
  const answer = answerModelsQuestion(message, currentView());
  if (answer) void modelLive.refresh();
  return answer;
}
