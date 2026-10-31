"use strict";
/**
 * Has a model folder that is already on disk changed upstream?
 *
 * A speech or voice folder used to be reused without asking Hugging Face anything. One listing request per
 * repository (the tree API reports every file's size and, for large files, the SHA-256 of the content) is
 * enough to tell: a file that is here and differs in size is stale. Only files that exist locally are
 * compared (a repository lists files this PC never wanted). A network that cannot answer is "cannot tell",
 * and the folder is kept: freshness never makes a working install worse.
 */
const fs = require("node:fs");
const path = require("node:path");

const API = "https://huggingface.co/api/models";
const TIMEOUT_MS = 8_000;

async function listRepo(
  repo,
  { fetchImpl = globalThis.fetch, token = null, timeoutMs = TIMEOUT_MS } = {},
) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(repo || "")))
    return { ok: false, error: "not a repository id" };
  if (typeof fetchImpl !== "function") return { ok: false, error: "no network client" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${API}/${repo}/tree/main?recursive=1`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = await res.json();
    if (!Array.isArray(body)) return { ok: false, error: "unexpected listing" };
    const files = body
      .filter((item) => item && item.type === "file" && typeof item.path === "string")
      .map((item) => ({
        path: item.path,
        size: Number(item.lfs?.size ?? item.size) || 0,
        sha256: typeof item.lfs?.oid === "string" ? item.lfs.oid.toLowerCase() : null,
      }));
    return { ok: true, files };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

/** Local files whose size differs from the repository's. Files that are not here are not judged. */
function changedFiles(listing, dir, { statSize = (file) => fs.statSync(file).size } = {}) {
  const changed = [];
  for (const entry of listing) {
    const file = path.join(dir, ...entry.path.split("/"));
    let size;
    try {
      size = statSize(file);
    } catch {
      continue;
    }
    if (entry.size > 0 && size !== entry.size) changed.push(entry.path);
  }
  return changed;
}

/** { fresh: true|false|null, changed } where null means the repository could not be asked. */
async function checkRepoFresh({ repo, dir, ...options }) {
  const listing = await listRepo(repo, options);
  if (!listing.ok) return { fresh: null, changed: [], reason: listing.error };
  const changed = changedFiles(listing.files, dir, options);
  return { fresh: changed.length === 0, changed, reason: changed.length ? "changed upstream" : "" };
}

/** The Hugging Face repositories of a prefetch row's sources. */
function reposOf(row) {
  return (row?.job?.sources || [])
    .filter((source) => source && source.kind === "hf-repo" && source.repo)
    .map((source) => source.repo);
}

/** Every changed file across a row's repositories; an empty list when fresh or when nothing could be asked. */
async function staleFor(row, options = {}) {
  const dir = row?.job?.dir && row?.job?.modelId ? path.join(row.job.dir, row.job.modelId) : null;
  if (!dir) return [];
  const stale = [];
  for (const repo of reposOf(row)) {
    const result = await checkRepoFresh({ repo, dir, ...options });
    if (result.fresh === false) stale.push(...result.changed.map((file) => `${repo}/${file}`));
  }
  return stale;
}

module.exports = { listRepo, changedFiles, checkRepoFresh, reposOf, staleFor };
