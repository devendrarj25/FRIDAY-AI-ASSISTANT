/**
 * Hugging Face hub helpers that stay on the existing download host family.
 * This module does not fetch. Callers pass a listing they already hold.
 */
"use strict";

function fileUrl(repo, file) {
  const name = String(repo || "").trim();
  const leaf = String(file || "").replace(/^\/+/, "");
  if (!name.includes("/") || !leaf) return null;
  return `https://huggingface.co/${name}/resolve/main/${leaf}`;
}

function listingShape(payload) {
  const files = Array.isArray(payload?.files) ? payload.files : [];
  return {
    repo: String(payload?.repo || ""),
    gated: payload?.gated === true,
    files,
    label: "documented shape",
  };
}

module.exports = { fileUrl, listingShape };
