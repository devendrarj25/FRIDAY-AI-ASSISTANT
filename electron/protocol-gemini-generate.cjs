/**
 * Gemini native list pagination and generateContent.
 * Chat in the product stays on the OpenAI-compatible surface. This module
 * normalises a native page when that payload shape appears. It does not
 * switch the chat URL.
 */
"use strict";

const openai = require("./protocol-openai-compatible.cjs");

function normaliseRow(row) {
  const nativeId = String(row?.name || row?.id || "").replace(/^models\//, "");
  const actions = Array.isArray(row?.supportedGenerationMethods)
    ? row.supportedGenerationMethods
    : Array.isArray(row?.supported_actions)
      ? row.supported_actions
      : null;
  return { nativeId, supportedActions: actions };
}

/** Documented page shape: models[] and nextPageToken. A missing token is null. */
function page(payload) {
  const rows = Array.isArray(payload?.models)
    ? payload.models
    : Array.isArray(payload?.data)
      ? payload.data
      : [];
  return {
    models: rows.map(normaliseRow),
    nextPageToken: payload?.nextPageToken || null,
  };
}

function buildGenerate(spec, input) {
  const model = String(input?.model || input?.modelId || "");
  const base = String(
    spec?.nativeBase || "https://generativelanguage.googleapis.com/v1beta",
  ).replace(/\/+$/, "");
  return {
    url: model ? `${base}/models/${model}:generateContent` : "",
    wire: "gemini",
    body: { contents: Array.isArray(input?.contents) ? input.contents : [] },
  };
}

function buildChat(spec, input) {
  return openai.buildChat(spec, input);
}

function parseStream(text) {
  return openai.parseStream(text);
}

module.exports = { page, normaliseRow, buildGenerate, buildChat, parseStream };
