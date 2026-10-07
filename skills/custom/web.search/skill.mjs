// FRIDAY · skill: web.search
// Catalog shape for discovery. Real search is the built-in in electron/skills.cjs
// which calls electron/browser.cjs — one browser engine, no second client.

export async function run(input = {}) {
  const query = String(input.query || input.prompt || input.text || "").trim();
  if (!query) return { ok: false, error: "Empty search query." };
  return {
    ok: false,
    error:
      "web.search runs through FRIDAY's built-in browser engine (electron/browser.cjs). Invoke the built-in skill via skills:invoke — this catalog pack does not open a second network client.",
    query,
  };
}

export default run;
