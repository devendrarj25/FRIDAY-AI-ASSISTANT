// Pins "now" to a moment inside the official-knowledge freshness window of
// electron/model-access.cjs (pricing / free-plan documentation TTL).
//
// Why: those classifiers deliberately fail closed once their documentation
// snapshot is older than its TTL. Tests that exercise the classification LOGIC
// must not start failing merely because the calendar moved on. Whether the
// snapshot itself is still fresh is checked separately, by
// `npm run pricing:status` and the weekly health workflow - never by a test
// that depends on today's date.
//
// Only Date is faked; timers stay real so async tests behave normally.
import { createRequire } from "node:module";
import { afterAll, beforeAll, vi } from "vitest";

const require_ = createRequire(import.meta.url);

export function pinKnowledgeClock(): void {
  const access = require_("../../../electron/model-access.cjs");
  const inside = Number(access.KNOWLEDGE_CHECKED_AT) + 24 * 60 * 60 * 1000;
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(inside);
  });
  afterAll(() => {
    vi.useRealTimers();
  });
}
