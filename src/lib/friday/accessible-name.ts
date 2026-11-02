/**
 * A name for a control that has none.
 *
 * Many settings fields put a visible label (`<p class="label-xs">Voice speed</p>`) just before the input in the
 * page, without tying the two together. A screen reader, voice control ("click Voice speed") and the browser's own
 * form tools then see an unnamed box. `nameIfMissing` reads the label-like element that comes right before the
 * control (or before its wrapper, up to three levels) and sets it as `aria-label`. A control that already has a
 * name, a `<label>`, a placeholder or a title is left alone.
 */

const LABEL_TAGS = new Set(["P", "SPAN", "LABEL", "DT", "H3", "H4", "STRONG", "DIV"]);
const CONTROLS = "input,select,textarea,button,[role=slider],[role=switch]";

export function contextLabel(el: Element): string {
  let node: Element | null = el;
  for (let depth = 0; node && depth < 3; depth += 1) {
    const prev: Element | null = node.previousElementSibling;
    if (prev && LABEL_TAGS.has(prev.tagName) && !prev.querySelector(CONTROLS)) {
      const text = (prev.textContent ?? "").replace(/\s+/g, " ").trim();
      // A number with a short unit ("12 ms", "75 %") is a value, not a label.
      const isValue = /^[\d.,:\-+%\s]+\p{L}{0,4}%?$/u.test(text);
      if (/\p{L}/u.test(text) && !isValue && text.length <= 60) return text;
    }
    node = node.parentElement;
    if (!node || node.tagName === "MAIN" || node.tagName === "BODY") break;
  }
  return "";
}

export function nameIfMissing(el: HTMLElement | null): void {
  if (!el || el.getAttribute("aria-label") || el.getAttribute("aria-labelledby")) return;
  if ((el as HTMLInputElement).labels?.length) return;
  if (el.getAttribute("placeholder") || el.getAttribute("title")) return;
  const text = contextLabel(el);
  if (text) el.setAttribute("aria-label", text);
}

const UNNAMED =
  "select,textarea,input:not([type=hidden]):not([type=checkbox]):not([type=radio]),[role=slider]";

/** Names every control under `root` that has no name yet. Cheap: one query and a few attribute reads. */
export function nameUnnamedControls(root: ParentNode): number {
  let named = 0;
  root.querySelectorAll<HTMLElement>(UNNAMED).forEach((el) => {
    if (el.getAttribute("aria-label")) return;
    nameIfMissing(el);
    if (el.getAttribute("aria-label")) named += 1;
  });
  return named;
}

/**
 * Keeps controls named as pages render and sections change. The pass runs once the page has been quiet for
 * `quietMs`, in an idle slot, and not at all while the window is hidden, so it never competes with a click.
 */
export function watchControlNames(root: Node & ParentNode, quietMs = 300): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = () => {
    timer = null;
    if (typeof document !== "undefined" && document.hidden) return;
    nameUnnamedControls(root);
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const idle = (globalThis as { requestIdleCallback?: (cb: () => void) => number })
        .requestIdleCallback;
      if (idle) idle(run);
      else run();
    }, quietMs);
  };
  const observer = new MutationObserver(schedule);
  observer.observe(root, { childList: true, subtree: true });
  schedule();
  return () => {
    observer.disconnect();
    if (timer) clearTimeout(timer);
  };
}
