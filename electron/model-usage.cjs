/**
 * Per-model usage ledger: how many requests each model answered or failed and
 * how many tokens went through it today and in total.
 *
 * Providers FRIDAY streams from do not all report usage to the kernel bridge, so
 * a count is an estimate (about four characters a token) and says so; a figure a
 * provider reported replaces the estimate for that request. Nothing here spends
 * money, calls a provider or stores prompt text: only counts are kept.
 */
const MAX_MODELS = 400;

function estimateTokens(text) {
  const length = String(text || "").length;
  return length ? Math.max(1, Math.ceil(length / 4)) : 0;
}

function dayOf(at) {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function emptyRow(modelId) {
  return {
    modelId,
    providerId: null,
    type: null,
    requests: 0,
    answered: 0,
    failed: 0,
    blocked: 0,
    promptTokens: 0,
    completionTokens: 0,
    estimated: false,
    estimatedRequests: 0,
    todayDay: "",
    todayRequests: 0,
    todayTokens: 0,
    lastAt: 0,
    lastOutcome: null,
  };
}

function createUsageLedger({ now = Date.now, initial = null, onChange = () => {} } = {}) {
  const rows = new Map();
  function load(saved) {
    if (!saved || !Array.isArray(saved.models)) return;
    for (const row of saved.models.slice(0, MAX_MODELS)) {
      if (row && typeof row.modelId === "string") {
        rows.set(row.modelId, { ...emptyRow(row.modelId), ...row });
      }
    }
  }
  load(initial);

  function rollDay(row, at) {
    const day = dayOf(at);
    if (row.todayDay !== day) {
      row.todayDay = day;
      row.todayRequests = 0;
      row.todayTokens = 0;
    }
  }

  /**
   * @param {{modelId: string, providerId?: string, type?: string, prompt?: string,
   *   text?: string, ok?: boolean, cancelled?: boolean, blocked?: boolean,
   *   usage?: {promptTokens?: number, completionTokens?: number}}} event
   */
  function record(event) {
    const modelId = String(event?.modelId || "");
    if (!modelId || event.cancelled) return null;
    const at = now();
    let row = rows.get(modelId);
    if (!row) {
      if (rows.size >= MAX_MODELS) {
        const oldest = [...rows.values()].sort((a, b) => a.lastAt - b.lastAt)[0];
        if (oldest) rows.delete(oldest.modelId);
      }
      row = emptyRow(modelId);
      rows.set(modelId, row);
    }
    rollDay(row, at);
    if (event.providerId) row.providerId = String(event.providerId);
    if (event.type) row.type = String(event.type);
    row.lastAt = at;
    if (event.blocked) {
      row.blocked += 1;
      row.lastOutcome = "blocked";
      onChange();
      return row;
    }
    row.requests += 1;
    row.todayRequests += 1;
    const reported =
      event.usage &&
      (Number(event.usage.promptTokens) > 0 || Number(event.usage.completionTokens) > 0);
    const prompt = reported ? Number(event.usage.promptTokens) || 0 : estimateTokens(event.prompt);
    const completion = reported
      ? Number(event.usage.completionTokens) || 0
      : event.ok
        ? estimateTokens(event.text)
        : 0;
    if (!reported) row.estimatedRequests = (row.estimatedRequests || 0) + 1;
    row.estimated = (row.estimatedRequests || 0) > 0;
    row.promptTokens += prompt;
    row.completionTokens += completion;
    row.todayTokens += prompt + completion;
    if (event.ok) {
      row.answered += 1;
      row.lastOutcome = "answered";
    } else {
      row.failed += 1;
      row.lastOutcome = "failed";
    }
    onChange();
    return row;
  }

  function snapshot() {
    const at = now();
    const day = dayOf(at);
    const models = [...rows.values()].map((row) => ({
      ...row,
      // A row last touched on an earlier day has nothing for today.
      todayRequests: row.todayDay === day ? row.todayRequests : 0,
      todayTokens: row.todayDay === day ? row.todayTokens : 0,
    }));
    const totals = models.reduce(
      (sum, row) => ({
        requests: sum.requests + row.requests,
        tokens: sum.tokens + row.promptTokens + row.completionTokens,
        todayTokens: sum.todayTokens + row.todayTokens,
      }),
      { requests: 0, tokens: 0, todayTokens: 0 },
    );
    return { at, models, totals };
  }

  function reset(modelId) {
    if (modelId) rows.delete(String(modelId));
    else rows.clear();
    onChange();
  }

  return { record, snapshot, reset, load };
}

module.exports = { createUsageLedger, estimateTokens, dayOf };
