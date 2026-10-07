/**
 * The tool permission gate: a caller may never approve itself, a token is
 * bound to one tool + one argument set, and it expires.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const authority = require_("../../electron/tool-authority.cjs");

const SECRET = "test-secret";

function parse(token: string) {
  const body = token.split(".")[1] ?? "";
  return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
    tool: string;
    argsHash: string;
    nonce: string;
    exp: number;
  };
}

describe("tool authority", () => {
  it("allows safe tools and asks for everything else by default", () => {
    expect(authority.decide("fs.read", "safe", {})).toBe("allow");
    expect(authority.decide("fs.write", "write", {})).toBe("ask");
    expect(authority.decide("shell.cmd", "exec", {})).toBe("ask");
  });

  it("honours a remembered deny, and never lets a stored allow skip write/exec", () => {
    expect(authority.decide("shell.cmd", "exec", { "shell.cmd": "allow" })).toBe("ask");
    expect(authority.decide("fs.write", "write", { "fs.write": "allow" })).toBe("ask");
    expect(authority.decide("fs.read", "safe", { "fs.read": "allow" })).toBe("allow");
    expect(authority.decide("fs.read", "safe", { "fs.read": "deny" })).toBe("deny");
    expect(authority.decide("shell.cmd", "exec", { "shell.cmd": "deny" })).toBe("deny");
  });

  it("binds a token to the exact tool and arguments", () => {
    const token = authority.issue(SECRET, { tool: "shell.cmd", args: { cmd: "dir" } });
    const payload = parse(token);
    expect(payload.tool).toBe("shell.cmd");
    expect(payload.argsHash).toBe(authority.hashArgs({ cmd: "dir" }));
    expect(payload.argsHash).not.toBe(authority.hashArgs({ cmd: "del *" }));
    expect(payload.exp).toBeGreaterThan(Date.now());
  });

  it("hashes arguments independently of key order", () => {
    expect(authority.hashArgs({ a: 1, b: "x" })).toBe(authority.hashArgs({ b: "x", a: 1 }));
  });

  it("refuses to mint without a secret", () => {
    expect(() => authority.issue("", { tool: "shell.cmd" })).toThrow();
  });

  it("gives every token a fresh nonce", () => {
    const a = parse(authority.issue(SECRET, { tool: "fs.write", args: {} })).nonce;
    const b = parse(authority.issue(SECRET, { tool: "fs.write", args: {} })).nonce;
    expect(a).not.toBe(b);
  });
});
