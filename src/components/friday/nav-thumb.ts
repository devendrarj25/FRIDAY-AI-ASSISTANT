import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * The sidebar highlight that slides to the active page. One absolutely
 * positioned pill moves by transform only; the first placement is instant
 * (no slide on load) and Classic hides the pill in CSS. The pill follows the
 * active link when the rail collapses, the window resizes or the list scrolls
 * into a new layout, and fades out when the page has no sidebar entry.
 */
export function useNavThumb(
  navRef: RefObject<HTMLElement | null>,
  watch: ReadonlyArray<unknown>,
): RefObject<HTMLSpanElement | null> {
  const thumbRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const nav = navRef.current;
    const thumb = thumbRef.current;
    if (!nav || !thumb) return;
    const place = () => {
      const link = nav.querySelector<HTMLElement>('a[aria-current="page"]');
      if (!link) {
        thumb.dataset["on"] = "false";
        return;
      }
      thumb.style.width = `${link.offsetWidth}px`;
      thumb.style.height = `${link.offsetHeight}px`;
      thumb.style.transform = `translate(${link.offsetLeft}px, ${link.offsetTop}px)`;
      thumb.dataset["on"] = "true";
    };
    place();
    // After the first placement, later moves may animate.
    const arm = requestAnimationFrame(() => {
      thumb.dataset["ready"] = "true";
    });
    if (typeof ResizeObserver === "undefined") return () => cancelAnimationFrame(arm);
    const observer = new ResizeObserver(place);
    observer.observe(nav);
    return () => {
      cancelAnimationFrame(arm);
      observer.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-place when the caller's inputs change
  }, watch);
  return thumbRef;
}
