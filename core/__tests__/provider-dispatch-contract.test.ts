/**
 * Provider dispatch contract (cross-layer).
 *
 * electron/models.cjs decides WHICH base URL a provider's models are routed
 * with; kernel/router.py decides HOW that base becomes a real chat URL. When
 * the two disagree the UI still shows "connected" (the key check uses the
 * right surface) while every real chat request 404s — that was the Gemini
 * `.../v1beta/v1/chat/completions` bug.
 *
 * This test reads BOTH layers and asserts the URL they jointly produce equals
 * each provider's officially documented endpoint.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { providers } from "@/lib/friday/model-catalog";

const require_ = createRequire(import.meta.url);
const models = require_("../../electron/models.cjs");

const routerSource = fs.readFileSync(path.join(process.cwd(), "kernel", "router.py"), "utf8");

/** Officially documented chat URLs — the reference the app is held to. */
const REFERENCE: Record<string, string> = {
  openai: "https://api.openai.com/v1/chat/completions",
  anthropic: "https://api.anthropic.com/v1/messages",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  groq: "https://api.groq.com/openai/v1/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  deepseek: "https://api.deepseek.com/v1/chat/completions",
  mistral: "https://api.mistral.ai/v1/chat/completions",
  together: "https://api.together.ai/v1/chat/completions",
  cohere: "https://api.cohere.ai/compatibility/v1/chat/completions",
  perplexity: "https://api.perplexity.ai/chat/completions",
  xai: "https://api.x.ai/v1/chat/completions",
  nvidia: "https://integrate.api.nvidia.com/v1/chat/completions",
  fireworks: "https://api.fireworks.ai/inference/v1/chat/completions",
  deepinfra: "https://api.deepinfra.com/v1/openai/chat/completions",
  cerebras: "https://api.cerebras.ai/v1/chat/completions",
  huggingface: "https://router.huggingface.co/v1/chat/completions",
  sambanova: "https://api.sambanova.ai/v1/chat/completions",
  moonshot: "https://api.moonshot.ai/v1/chat/completions",
  zhipu: "https://api.z.ai/api/paas/v4/chat/completions",
  nebius: "https://api.tokenfactory.nebius.com/v1/chat/completions",
};

type CloudSpec = { chat?: string; chatPath?: string; wire?: string };
const CLOUD = models.CLOUD as Record<string, CloudSpec | undefined>;

const specOf = (id: string): CloudSpec & { chat: string } => {
  const spec = CLOUD[id];
  if (!spec?.chat) throw new Error(`${id} missing a chat base in electron/models.cjs CLOUD`);
  return { ...spec, chat: spec.chat };
};

describe("provider dispatch contract", () => {
  it("routes Gemini through the OpenAI-compatible surface, never /v1beta/v1", () => {
    const spec = specOf("gemini");
    const url = models.openaiChatUrl(spec.chat, spec.chatPath);
    expect(url).toBe(REFERENCE["gemini"]);
    expect(url).not.toContain("/v1beta/v1/");
  });

  it("builds the documented chat URL for every routable cloud provider", () => {
    for (const [id, expected] of Object.entries(REFERENCE)) {
      const spec = specOf(id);
      if (spec.wire === "anthropic") {
        expect(spec.chat.replace(/\/+$/, "") + "/messages", id).toBe(expected);
        continue;
      }
      expect(models.openaiChatUrl(spec.chat, spec.chatPath), id).toBe(expected);
    }
  });

  it("uses the same chat URL builder for a health probe as for a live turn", () => {
    const gemini = specOf("gemini");
    expect(
      models.openaiChatUrl(gemini.chat, gemini.chatPath).endsWith("/v1/chat/completions"),
    ).toBe(false);
    expect(models.openaiChatUrl(gemini.chat, gemini.chatPath)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    );
    expect(models.openaiChatUrl("https://api.deepinfra.com/v1/openai")).toBe(
      "https://api.deepinfra.com/v1/openai/chat/completions",
    );
    expect(models.openaiChatUrl("https://api.z.ai/api/paas/v4")).toBe(
      "https://api.z.ai/api/paas/v4/chat/completions",
    );
    expect(models.openaiChatUrl("https://api.perplexity.ai", "/chat/completions")).toBe(
      "https://api.perplexity.ai/chat/completions",
    );
    expect(models.openaiChatUrl("http://127.0.0.1:1234")).toBe(
      "http://127.0.0.1:1234/v1/chat/completions",
    );
  });

  it("gives every routable provider an explicit entry in kernel/router.py", () => {
    for (const id of Object.keys(REFERENCE)) {
      const entry = new RegExp(`"${id}":\\s*\\{\\s*"wire":`);
      expect(entry.test(routerSource), `${id} has no dispatch entry in router.py`).toBe(true);
    }
    // The catch-all that hid the bug is gone: dispatch is a table lookup.
    expect(routerSource).toContain("wire = wire_for(model.provider)");
    expect(routerSource).toContain('openai_chat_url(base, model.options.get("chat_path"))');
  });

  it("keeps kernel/router.py's registered base identical to models.cjs", () => {
    for (const id of Object.keys(REFERENCE)) {
      const spec = specOf(id);
      const base = spec.chat.replace(/\/+$/, "");
      const wire = spec.wire === "anthropic" ? "anthropic" : "openai";
      const entry = new RegExp(
        `"${id}":\\s*\\{\\s*"wire":\\s*"${wire}",\\s*"base":\\s*"${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`,
      );
      expect(entry.test(routerSource), `${id} base drifted from models.cjs`).toBe(true);
    }
  });

  it("keeps the model catalog's Gemini endpoint on the same surface it routes through", () => {
    const gemini = providers.find((p) => p.id === "gemini");
    expect(gemini?.endpoint.replace(/\/+$/, "")).toBe(specOf("gemini").chat.replace(/\/+$/, ""));
  });

  it("registers every live local engine on the kernel surface table", () => {
    const locals = models.LOCAL_ENGINES as Record<string, { endpoint?: string }>;
    for (const [id, spec] of Object.entries(locals)) {
      const endpoint = String(spec.endpoint || "").replace(/\/+$/, "");
      expect(routerSource, id).toContain(`"${id}":`);
      expect(routerSource, `${id} base`).toContain(endpoint);
    }
  });
});
