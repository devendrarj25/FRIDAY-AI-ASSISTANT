/**
 * Text that is cut with an ellipsis gets its full text as a tooltip.
 *
 * Pages mark such text with `truncate`; this fills in a `title` for it when it
 * is really cut off, so nothing is clipped without a way to read it. It runs
 * once after a page appears and again when the pointer moves over a cut label
 * (content that arrives later). It never overwrites a title or aria-label the
 * page set itself.
 */

type El = {
  title: string;
  textContent: string | null;
  scrollWidth: number;
  clientWidth: number;
  closest(selector: string): unknown;
};

/** True when the element shows an ellipsis because its text does not fit. */
export function isCut(el: Pick<El, "scrollWidth" | "clientWidth">): boolean {
  return el.scrollWidth > el.clientWidth + 1;
}

/** Give a cut label its tooltip. Returns true when a title was added. */
export function titleIfCut(el: El): boolean {
  if (!isCut(el)) return false;
  if (el.closest("[title],[aria-label]")) return false;
  const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  if (!text) return false;
  el.title = text;
  return true;
}

const SELECTOR = ".truncate, [class*='line-clamp']";

export function titleCutLabels(root: ParentNode = document.body): number {
  let n = 0;
  for (const el of root.querySelectorAll<HTMLElement>(SELECTOR)) if (titleIfCut(el)) n++;
  return n;
}

export function installTruncateTitles(): () => void {
  if (typeof document === "undefined") return () => undefined;
  const onOver = (event: Event) => {
    const el = (event.target as Element | null)?.closest?.(SELECTOR) as HTMLElement | null;
    if (el) titleIfCut(el);
  };
  document.addEventListener("mouseover", onOver, true);
  return () => document.removeEventListener("mouseover", onOver, true);
}
