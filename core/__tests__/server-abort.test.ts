import { describe, expect, it } from "vitest";
import { isExpectedClientAbort } from "../../src/lib/error-capture";

describe("server request cancellation", () => {
  it("recognizes direct and wrapped client disconnects", () => {
    const direct = new Error("aborted");
    const wrapped = new Error("Request failed", { cause: direct });
    const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const truncated = Object.assign(new Error("socket closed"), {
      code: "ECONNRESET",
      stack: "Error: socket closed",
    });

    expect(isExpectedClientAbort(direct)).toBe(true);
    expect(isExpectedClientAbort(wrapped)).toBe(true);
    expect(isExpectedClientAbort(reset)).toBe(true);
    expect(isExpectedClientAbort(truncated)).toBe(true);
  });

  it("does not hide genuine application failures", () => {
    expect(isExpectedClientAbort(new Error("database unavailable"))).toBe(false);
    expect(
      isExpectedClientAbort(new Error("Request failed", { cause: new Error("timeout") })),
    ).toBe(false);
    const unrelated = new Error("database unavailable");
    unrelated.stack = "Error: database unavailable\n at handler (node:_http_server:1:1)";
    expect(isExpectedClientAbort(unrelated)).toBe(false);
  });
});
