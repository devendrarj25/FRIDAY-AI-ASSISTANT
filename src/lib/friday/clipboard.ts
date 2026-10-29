/**
 * Copying text must never throw. The async clipboard API is refused when the
 * document is not focused or the permission is denied (which happens inside
 * the packaged desktop shell too), so fall back to a hidden textarea and
 * report success as a boolean instead of an unhandled rejection.
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof window === "undefined" || !text) return false;

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }

  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    area.style.pointerEvents = "none";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
