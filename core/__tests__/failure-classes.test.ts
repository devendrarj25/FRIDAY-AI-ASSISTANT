import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import {
  backoffMs,
  classifyFailure,
  failureDomain,
  recoverFailure,
} from "../../src/lib/friday/failure-guard";

const router = createRequire(import.meta.url)("../../electron/model-router.cjs") as {
  classifyError: (input: unknown) => {
    category: string;
    retryable: boolean;
    cooldownMs: number;
    nextStep?: string;
  };
  orderFallbacks: (candidates: unknown[], failed: unknown, category: string) => { id: string }[];
  blipRetry: (input: Record<string, unknown>) => { retry: boolean; waitMs: number };
};

const cloud = (message: string, extra: Record<string, unknown> = {}) =>
  router.classifyError({ message, kind: "cloud", ...extra });

describe("the router names real network and provider failures", () => {
  it.each([
    ["connect ETIMEDOUT 104.18.0.1:443", "network"],
    ["socket hang up", "network"],
    ["read ECONNRESET", "network"],
    ["network request failed", "network"],
    ["Failed to fetch", "network"],
    ["EAI_AGAIN getaddrinfo EAI_AGAIN api.openai.com", "network"],
    ["EHOSTUNREACH 10.0.0.4", "network"],
    ["The operation was aborted due to timeout", "timeout"],
    ["request timed out after 20s", "timeout"],
  ])("%s -> %s", (message, category) => {
    const row = cloud(message);
    expect(row.category).toBe(category);
    expect(row.retryable).toBe(true);
  });

  it("a certificate or proxy problem is named, not retried, and tells the owner what to check", () => {
    for (const message of [
      "unable to verify the first certificate",
      "self signed certificate in certificate chain",
      "CERT_HAS_EXPIRED",
      "Hostname/IP does not match certificate's altnames",
    ]) {
      const row = cloud(message);
      expect(row.category, message).toBe("tls");
      expect(row.retryable, message).toBe(false);
      expect(row.nextStep).toMatch(/clock|proxy|antivirus/i);
    }
    const proxy = cloud("proxy authentication required", { status: 407 });
    expect(proxy.category).toBe("proxy_auth");
    expect(proxy.retryable).toBe(false);
  });

  it("a request that is too big is treated like a full context, so it is made smaller", () => {
    expect(cloud("payload too large", { status: 413 }).category).toBe("context_overflow");
  });

  it("5xx and overloaded are provider errors that move to another provider", () => {
    expect(cloud("overloaded_error", { status: 529 }).category).toBe("provider_error");
    expect(cloud("Bad gateway", { status: 502 }).category).toBe("provider_error");
  });

  it("keys, access and missing models keep their own categories", () => {
    expect(cloud("Unauthorized", { status: 401 }).category).toBe("invalid_key");
    expect(cloud("Forbidden", { status: 403 }).category).toBe("model_access");
    expect(cloud("model not found", { status: 404 }).category).toBe("model_unavailable");
  });

  it("a certificate problem sends the next try to a different backend", () => {
    const failed = { id: "a/one", provider: "a", providerId: "a" };
    const same = { id: "a/two", provider: "a", providerId: "a" };
    const other = { id: "b/one", provider: "b", providerId: "b" };
    const order = router.orderFallbacks([failed, same, other], failed, "tls").map((m) => m.id);
    expect(order[0]).toBe("b/one");
  });
});

describe("the app classifies the same failures, and says what to do next", () => {
  it.each([
    ["HTTP 503 Service Unavailable", "provider-outage"],
    ["overloaded_error: Overloaded", "provider-outage"],
    ["429 Too Many Requests", "provider-outage"],
    ["read ECONNRESET", "network-down"],
    ["socket hang up", "network-down"],
    ["getaddrinfo ENOTFOUND api.openai.com", "network-down"],
    ["The request timed out after 20s", "timeout"],
    ["connect ETIMEDOUT", "timeout"],
    ["Unauthorized 401", "auth"],
    ["Incorrect API key provided", "auth"],
    ["unable to verify the first certificate", "tls"],
    ["context_length_exceeded", "context-length"],
    ["payload too large", "context-length"],
    ["ENOSPC: no space left on device", "disk-full"],
    ["EACCES: permission denied", "permission-denied"],
  ])("%s -> %s", (message, kind) => {
    expect(classifyFailure(message)).toBe(kind);
  });

  it("names the network domain for transport and timeout words", () => {
    for (const message of [
      "request timed out",
      "read ECONNRESET",
      "socket hang up",
      "fetch failed",
      "certificate problem",
    ]) {
      expect(failureDomain(message), message).toBe("network");
    }
  });

  it("a dropped connection is retried with a growing wait, then falls back to local instead of looping", () => {
    const mid = () => 0.5;
    const waits = [0, 1, 2].map((attempt) => recoverFailure("network-down", attempt, mid));
    expect(waits.map((row) => row.action)).toEqual(["retry", "retry", "retry"]);
    expect(waits.map((row) => row.delayMs)).toEqual([1000, 2000, 4000]);
    expect(recoverFailure("network-down", 3, mid).action).toBe("fallback");
  });

  it("one retry for a timeout, then a faster model; a provider fault gets two; none of them loop", () => {
    expect(recoverFailure("timeout", 0).action).toBe("retry");
    expect(recoverFailure("timeout", 1).action).toBe("fallback");
    expect(recoverFailure("provider-outage", 1).action).toBe("retry");
    expect(recoverFailure("provider-outage", 2).action).toBe("fallback");
  });

  it("a rejected key and a bad certificate are not retried", () => {
    expect(recoverFailure("auth", 0).action).toBe("fallback");
    expect(recoverFailure("auth", 0).delayMs).toBeUndefined();
    const tls = recoverFailure("tls", 0);
    expect(tls.action).toBe("stop");
    expect(tls.reason).toMatch(/clock|proxy/i);
  });

  it("the wait grows, is capped at fifteen seconds, and stays within a fifth of the base", () => {
    expect(backoffMs(0, () => 0)).toBe(800);
    expect(backoffMs(0, () => 1)).toBe(1200);
    expect(backoffMs(3, () => 0.5)).toBe(8000);
    expect(backoffMs(10, () => 0.5)).toBe(15000);
    expect(backoffMs(-4, () => 0.5)).toBe(1000);
  });
});

describe("a blip does not cost the owner a good model", () => {
  const low = () => 0;
  const high = () => 1;
  it("retries the same model once, after a short jittered wait, for a dropped connection or a gateway error", () => {
    expect(router.blipRetry({ category: "network", online: true, random: low })).toEqual({
      retry: true,
      waitMs: 600,
    });
    expect(router.blipRetry({ category: "network", online: true, random: high })).toEqual({
      retry: true,
      waitMs: 1400,
    });
    for (const status of [502, 503, 504]) {
      expect(router.blipRetry({ category: "provider_error", status, online: true }).retry).toBe(
        true,
      );
    }
  });

  it("does not retry offline, after one retry, after the answer has begun, or for faults a retry cannot fix", () => {
    expect(router.blipRetry({ category: "network", online: false }).retry).toBe(false);
    expect(
      router.blipRetry({ category: "network", online: true, alreadyRetried: true }).retry,
    ).toBe(false);
    expect(router.blipRetry({ category: "network", online: true, received: true }).retry).toBe(
      false,
    );
    for (const category of [
      "rate_limited",
      "invalid_key",
      "tls",
      "proxy_auth",
      "context_overflow",
      "timeout",
      "unknown",
    ]) {
      expect(router.blipRetry({ category, online: true }).retry, category).toBe(false);
    }
    expect(router.blipRetry({ category: "provider_error", status: 500, online: true }).retry).toBe(
      false,
    );
    expect(router.blipRetry({ category: "provider_error", status: 529, online: true }).retry).toBe(
      false,
    );
  });
});
