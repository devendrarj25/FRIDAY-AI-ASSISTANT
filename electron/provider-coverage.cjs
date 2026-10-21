/**
 * Providers that were not added. A row stays here until an official page
 * on a later run verifies the API and the access class.
 */
"use strict";

const NOT_ADDED = [
  {
    id: "cloudflare-workers-ai",
    reason:
      "Already rejected. The chat base has no OpenAI GET /v1/models and the account id is in the URL. This run did not reverse that.",
  },
  {
    id: "github-models",
    reason:
      "Already rejected. models.github.ai retired on 2026-07-30 with HTTP 410. This run did not reverse that.",
  },
  {
    id: "dashscope",
    reason:
      "Not re-read on 2026-10-21. No module until the official API and access class are verified.",
  },
  {
    id: "siliconflow",
    reason:
      "Not re-read on 2026-10-21. No module until the official API and access class are verified.",
  },
  {
    id: "hyperbolic",
    reason:
      "Not re-read on 2026-10-21. No module until the official API and access class are verified.",
  },
  {
    id: "novita",
    reason:
      "Not re-read on 2026-10-21. No module until the official API and access class are verified.",
  },
  {
    id: "ai21",
    reason:
      "Not re-read on 2026-10-21. No module until the official API and access class are verified.",
  },
  {
    id: "reka",
    reason:
      "Not re-read on 2026-10-21. No module until the official API and access class are verified.",
  },
  {
    id: "inception",
    reason:
      "Not re-read on 2026-10-21. No module until the official API and access class are verified.",
  },
  {
    id: "azure-openai",
    reason:
      "Not re-read on 2026-10-21. No module until the official API and access class are verified.",
  },
  {
    id: "amazon-bedrock",
    reason:
      "Not re-read on 2026-10-21. No module until the official API and access class are verified.",
  },
  {
    id: "google-vertex",
    reason:
      "Not re-read on 2026-10-21. No module until the official API and access class are verified.",
  },
  {
    id: "replicate",
    reason:
      "Not re-read on 2026-10-21. No module until the official API and access class are verified.",
  },
  {
    id: "ollama-cloud",
    reason:
      "The hosted ollama.com API takes a key. It was not added. Local Ollama stays on the loopback native API.",
  },
];

function notAdded() {
  return NOT_ADDED.map((row) => ({ ...row }));
}

module.exports = { NOT_ADDED, notAdded };
