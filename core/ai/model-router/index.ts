/**
 * FRIDAY · core/ai/model-router
 *
 * Picks the model for a job and streams the answer. Supports manual choice,
 * routing by role, automatic selection and ordered fallback when a model is
 * offline — with one shared code path for local and cloud models.
 */
import type { FridayModule, ModuleContext } from "../../types";
import type { ChatMessage, ModelRole, ModelSpec } from "../contracts";
import { providers } from "../providers";
import { bus } from "../../event-bus";

export type RoutingMode = "manual" | "role" | "auto";

export interface RouteQuery {
  mode: RoutingMode;
  /** Explicit model ids, used when mode is "manual". */
  modelIds?: string[];
  role?: ModelRole;
  /** Rough hint used by "auto": long or code-heavy work prefers a bigger model. */
  complexity?: "low" | "medium" | "high";
}

const ROLE_BY_COMPLEXITY: Record<"low" | "medium" | "high", ModelRole> = {
  low: "fast",
  medium: "brain",
  high: "coder",
};

export class ModelRouter {
  private catalog = new Map<string, ModelSpec>();

  setCatalog(models: ModelSpec[]): void {
    this.catalog = new Map(models.map((m) => [m.id, m]));
    bus.emit("router:catalog", models.length);
  }

  all(): ModelSpec[] {
    return [...this.catalog.values()];
  }

  /** Ordered candidates: the best match first, then usable fallbacks. */
  select(query: RouteQuery): ModelSpec[] {
    const all = this.all();
    if (query.mode === "manual" && query.modelIds?.length) {
      const chosen = query.modelIds
        .map((id) => this.catalog.get(id))
        .filter((m): m is ModelSpec => Boolean(m));
      if (chosen.length) return chosen;
    }
    const role =
      query.role ?? ROLE_BY_COMPLEXITY[query.complexity ?? "medium"] ?? ("brain" as ModelRole);
    const byRole = all.filter((m) => m.role === role);
    const rest = all.filter((m) => m.role !== role);
    // Local models are preferred over cloud when both can do the job.
    const localFirst = (list: ModelSpec[]) =>
      [...list].sort((a, b) => Number(b.kind === "local") - Number(a.kind === "local"));
    return [...localFirst(byRole), ...localFirst(rest)];
  }

  /**
   * Streams from the first healthy candidate, falling back down the list.
   * Throws only when every candidate failed.
   */
  async *stream(
    query: RouteQuery,
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): AsyncGenerator<{ modelId: string; delta: string }> {
    const candidates = this.select(query);
    if (!candidates.length) throw new Error("no models configured");
    const errors: string[] = [];

    for (const model of candidates) {
      const health = await providers.checkHealth(model);
      if (health.health !== "ready") {
        errors.push(`${model.label}: ${health.health}`);
        continue;
      }
      bus.emit("router:selected", { modelId: model.id, role: model.role });
      try {
        const provider = providers.resolve(model);
        for await (const delta of provider.stream({
          model,
          messages,
          ...(signal ? { signal } : {}),
        })) {
          yield { modelId: model.id, delta };
        }
        return;
      } catch (error) {
        if (signal?.aborted) throw error;
        errors.push(`${model.label}: ${String(error)}`);
        bus.emit("router:fallback", { modelId: model.id, error: String(error) });
      }
    }
    throw new Error(`all models failed — ${errors.join("; ")}`);
  }
}

export const modelRouter = new ModelRouter();

export type ModelRouterModule = FridayModule;

export const modelRouterModule: ModelRouterModule = {
  id: "core/ai/model-router",
  init(ctx: ModuleContext) {
    bus.on("router:fallback", (payload) => ctx.log("warn", "model fallback", payload));
  },
};

export default modelRouterModule;
