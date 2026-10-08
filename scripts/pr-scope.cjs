#!/usr/bin/env node
/**
 * pr-scope.cjs - the ONE definition of "this pull request only changes documentation".
 *
 * Workflows use it to decide how much to run, so a typo fix in a Markdown file does
 * not start a Windows installer build, while anything that could change the product
 * or its tests always gets the full validation.
 *
 *   printf '%s\n' <changed files> | node scripts/pr-scope.cjs   ->  docs_only=true|false
 *
 * Documentation-only means EVERY changed path (renames count on both sides) is a file
 * that is neither packaged into the installer (see electron-builder.yml) nor read by
 * the release engine. CHANGELOG.md is packaged, so it is not documentation-only.
 * Anything unknown, an empty list, or a read error means "full". The safe direction
 * is always more validation, never less.
 *
 * PR Validation does not use GitHub `paths-ignore`. A required check that GitHub
 * skips stays pending and blocks the merge. The gate job runs this script instead.
 * PATHS_IGNORE is the same documentation set, kept so a test can see the list
 * did not drift away from DOC_FILES and DOC_PREFIXES.
 */
"use strict";

const ROOT_DOCS = [
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  "ARCHITECTURE.md",
  "AUDIT.md",
  "CONTRIBUTING.md",
  "INSTALL.md",
  "RELEASE.md",
  "SECURITY.md",
  "VERSIONING.md",
  "FRIDAY_STATE.md",
];

const DOC_PREFIXES = ["docs/", ".github/ISSUE_TEMPLATE/"];

const DOC_FILES = [...ROOT_DOCS, ".github/pull_request_template.md"];

/** Documentation globs. PR Validation reads this script; it does not copy the list into `paths-ignore`. */
const PATHS_IGNORE = [...DOC_PREFIXES.map((p) => `${p}**`), ...DOC_FILES];

function isDocPath(file) {
  const f = String(file).trim().replace(/\\/g, "/");
  if (!f || f.startsWith("/") || f.split("/").includes("..")) return false;
  return DOC_FILES.includes(f) || DOC_PREFIXES.some((p) => f.startsWith(p) && f.length > p.length);
}

/** True only for a non-empty list in which every path is documentation. */
function isDocsOnly(files) {
  const list = (files || []).map((f) => String(f).trim()).filter(Boolean);
  return list.length > 0 && list.every(isDocPath);
}

module.exports = { ROOT_DOCS, DOC_PREFIXES, DOC_FILES, PATHS_IGNORE, isDocPath, isDocsOnly };

if (require.main === module) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (input += c));
  process.stdin.on("end", () => {
    console.log(`docs_only=${isDocsOnly(input.split("\n"))}`);
  });
  process.stdin.on("error", () => console.log("docs_only=false"));
}
