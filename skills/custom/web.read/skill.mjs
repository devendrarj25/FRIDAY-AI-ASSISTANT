// FRIDAY · skill: web.read
// Catalog shape for discovery. Real fetch is the built-in in electron/skills.cjs.

function extractUrl(text) {
  const match = String(text || "").match(/https?:\/\/[^\s<>"']+/i);
  return match ? match[0] : "";
}

export async function run(input = {}) {
  const url = String(input.url || extractUrl(input.prompt || input.text || "")).trim();
  if (!url) return { ok: false, error: "A URL is required." };
  return {
    ok: false,
    error:
      "web.read runs through FRIDAY's built-in browser engine (electron/browser.cjs). Invoke the built-in skill via skills:invoke — this catalog pack does not open a second network client.",
    url,
  };
}

export default run;
