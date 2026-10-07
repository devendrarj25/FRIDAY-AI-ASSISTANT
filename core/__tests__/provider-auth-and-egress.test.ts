/**
 * Regressions for three real, reported faults:
 *
 *  1. Gemini's native listing endpoint was sent BOTH x-goog-api-key and
 *     Authorization: Bearer. Google reads the Bearer header as an OAuth2 access
 *     token and answers 401 "Expected OAuth 2 access token…" even for a valid
 *     API key — and FRIDAY then printed a canned "enable the Generative
 *     Language API" message instead of what Google actually said.
 *  3. The privacy firewall asked on every single message. PUBLIC content to an
 *     already-connected provider now goes out automatically with no click;
 *     everything else still always asks.
 *  5. Sandbox engines installed by winget without a PATH entry reported
 *     "not installed".
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const models = require_("../../electron/models.cjs");
const privacy = require_("../../electron/privacy-firewall.cjs");
const engines = require_("../../electron/sandbox-engines.cjs");

describe("BUG 1 — Gemini uses one surface, authenticated one way", () => {
  it("uses Bearer auth for the model list, with no x-goog-api-key anywhere", () => {
    const headers = models.CLOUD.gemini.headers("AIzaTESTKEY");
    expect(headers["Authorization"]).toBe("Bearer AIzaTESTKEY");
    // Mixing the two auth schemes is what made a valid key look invalid.
    expect(headers["x-goog-api-key"]).toBeUndefined();
  });

  it("uses the same Bearer auth on the OpenAI-compatible chat surface", () => {
    expect(models.chatHeaders(models.CLOUD.gemini, "AIzaTESTKEY")).toEqual({
      Authorization: "Bearer AIzaTESTKEY",
    });
    // Providers with one auth scheme keep using it everywhere.
    expect(models.chatHeaders(models.CLOUD.openai, "sk-x")).toEqual({
      Authorization: "Bearer sk-x",
    });
  });

  it("reports the provider's real status and error body, not a guessed cause", () => {
    const real = {
      ok: false,
      status: 401,
      body: {
        error: { code: 401, message: "Expected OAuth 2 access token", status: "UNAUTHENTICATED" },
      },
    };
    expect(models.providerMessage(real)).toBe("Expected OAuth 2 access token");
    expect(models.describeFailure(real)).toBe("HTTP 401 — Expected OAuth 2 access token");
    // A non-JSON body is still shown rather than dropped.
    expect(
      models.describeFailure({ ok: false, status: 503, body: null, text: "upstream down" }),
    ).toBe("HTTP 503 — upstream down");
    // A transport failure keeps its own wording.
    expect(models.describeFailure({ ok: false, status: 0, error: "getaddrinfo ENOTFOUND" })).toBe(
      "getaddrinfo ENOTFOUND",
    );
  });
});

describe("ISSUE 1 — only SENSITIVE content stops FRIDAY; everything else flows", () => {
  const cloud = { id: "openrouter/free", label: "OpenRouter Free", type: "cloud" };
  const local = { id: "llama3", label: "Ollama llama3", type: "ollama" };

  it("sends PUBLIC content to a connected provider automatically, with no prompt", () => {
    const decision = privacy.guardEgress({ model: cloud, content: "what is 2+2", connected: true });
    expect(decision.classification.level).toBe("public");
    expect(decision.requiresConfirmation).toBe(false);
    expect(decision.autoAllowed).toBe(true);
    for (const text of ["and 3+3?", "summarise this article", "what is the weather idea"]) {
      expect(
        privacy.guardEgress({ model: cloud, content: text, connected: true }).requiresConfirmation,
      ).toBe(false);
    }
  });

  it("sends PRIVATE and INTERNAL content to a connected provider automatically too", () => {
    // A normal chat turn mentioning an email, a phone number or a file path is
    // not a leak — blocking it stopped FRIDAY's core function.
    const cases: Array<[string, string]> = [
      ["mail me at owner@example.com", "private"],
      ["open C:\\Users\\me\\notes.txt", "private"],
      ["look at electron/main.cjs", "internal"],
      ["is localhost reachable", "internal"],
    ];
    for (const [content, level] of cases) {
      const decision = privacy.guardEgress({ model: cloud, content, connected: true });
      expect(decision.classification.level).toBe(level);
      expect(decision.requiresConfirmation).toBe(false);
      expect(decision.autoAllowed).toBe(true);
    }
  });

  it("ALWAYS stops sensitive content — credentials, secrets, financial/identity numbers", () => {
    const cases = [
      "my password: hunter2",
      "password hunter2",
      "the pin is 1234",
      "my passcode is 999999",
      "key sk-abcdefghijklmnopqrst",
      "card 4111 1111 1111 1111",
    ];
    for (const content of cases) {
      for (let i = 0; i < 3; i += 1) {
        const decision = privacy.guardEgress({ model: cloud, content, connected: true });
        expect(decision.classification.level).toBe("sensitive");
        expect(decision.requiresConfirmation).toBe(true);
        expect(decision.autoAllowed).toBe(false);
      }
    }
  });

  it("always asks for a destination that is NOT a connected provider", () => {
    for (let i = 0; i < 3; i += 1) {
      const decision = privacy.guardEgress({
        model: cloud,
        content: "what is 2+2",
        connected: false,
      });
      expect(decision.requiresConfirmation).toBe(true);
      expect(decision.autoAllowed).toBe(false);
    }
  });

  it("exposes no way to remember or skip an approval", () => {
    expect(privacy.grantSession).toBeUndefined();
    expect(privacy.hasSessionGrant).toBeUndefined();
    expect(privacy.clearSessionGrants).toBeUndefined();
  });

  it("does not treat ordinary 'password manager' chat as SENSITIVE", () => {
    const decision = privacy.guardEgress({
      model: cloud,
      content: "which password manager do you recommend",
      connected: true,
    });
    expect(decision.classification.level).not.toBe("sensitive");
    expect(decision.requiresConfirmation).toBe(false);
  });

  it("never gates local inference at all", () => {
    expect(
      privacy.guardEgress({ model: local, content: "my password: hunter2" }).requiresConfirmation,
    ).toBe(false);
    for (const type of ["lmstudio", "vllm", "localai", "jan"]) {
      expect(privacy.isLocalKind({ type })).toBe(true);
      expect(
        privacy.guardEgress({
          model: { id: `${type}/m`, type },
          content: "my password: hunter2",
        }).requiresConfirmation,
      ).toBe(false);
    }
  });
});

describe("BUG 5 — engines installed without a PATH entry are still detected", () => {
  it("knows the real install locations winget and Windows use", () => {
    for (const id of ["qemu", "sandboxie", "windows-sandbox", "wsl"]) {
      expect(engines.WIN_ENGINE_LOCATIONS[id].length).toBeGreaterThan(0);
    }
    // Windows Sandbox and WSL live in System32, never in a package folder.
    expect(engines.WIN_ENGINE_LOCATIONS["windows-sandbox"].join(" ")).toMatch(/System32/i);
    // QEMU and Sandboxie-Plus are winget/MSI installs that skip PATH.
    expect(engines.WIN_ENGINE_LOCATIONS["qemu"].join(" ")).toMatch(/ProgramFiles|WinGet/i);
    expect(engines.WIN_ENGINE_LOCATIONS["sandboxie"].join(" ")).toMatch(/Sandboxie/i);
  });

  it("finds a binary that exists on disk but is absent from PATH", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-engine-"));
    const binary = path.join(dir, "qemu-system-x86_64");
    fs.writeFileSync(binary, "");
    expect(engines.findOnDisk("qemu", [path.join(dir, "nope"), binary])).toBe(binary);
    expect(engines.findOnDisk("qemu", [path.join(dir, "nope")])).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("expands a winget package wildcard one level deep", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-winget-"));
    const pkg = path.join(root, "Sandboxie.Plus_Microsoft.Winget.Source");
    fs.mkdirSync(pkg, { recursive: true });
    const exe = path.join(pkg, "Start.exe");
    fs.writeFileSync(exe, "");
    expect(engines.findOnDisk("sandboxie", [path.join(root, "*", "Start.exe")])).toBe(exe);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps a detected absolute path usable by the command wrapper", () => {
    const line = engines.wrap("sandboxie", { command: "npm test", dir: os.tmpdir() }).line;
    expect(line).toContain("/box:FRIDAY");
    expect(line).toContain("npm test");
  });
});

describe("BUG 1b — a connected provider is recognised for an auto-routed model", () => {
  const main = fs.readFileSync(path.resolve(process.cwd(), "electron/main.cjs"), "utf8");
  const block = main.slice(
    main.indexOf("function providerIsConnected"),
    main.indexOf("function providerIsConnected") + 1400,
  );

  it("matches on the canonical provider id, not the wire format", () => {
    // `model.provider` is the wire ("online"), which never contains
    // "openrouter" — that is why an already-connected provider prompted.
    expect(block).toContain("meta?.providerId");
    expect(block).not.toMatch(/model\?\.provider \|\| model\?\.id/);
  });

  it("only uses the model id through its <provider>: prefix", () => {
    expect(block).toContain('id.includes(":")');
  });
});

describe("BUG 2 — installed-but-not-running engines can really be started", () => {
  it("knows how to start Docker and the Podman machine", () => {
    expect(Object.keys(engines.SERVICES).sort()).toEqual(["docker", "podman"]);
    expect(engines.SERVICES.podman.args).toEqual(["machine", "start"]);
  });

  it("refuses to claim success for an engine that is not installed", async () => {
    const result = await engines.startService("does-not-exist");
    expect(result.ok).toBe(false);
  });

  it("remembers a pending Windows restart until the engine really works", () => {
    engines.noteRestartPending("wsl");
    expect(engines.restartPending.has("wsl")).toBe(true);
    expect(engines.RESTART_MESSAGE).toMatch(/Restart Windows/i);
    engines.clearRestartPending("wsl");
    expect(engines.restartPending.has("wsl")).toBe(false);
  });
});
