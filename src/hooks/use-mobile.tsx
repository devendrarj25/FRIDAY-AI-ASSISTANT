import * as React from "react";

const MOBILE_BREAKPOINT = 768;

function mobileQuery(): string {
  return `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;
}

function readMobile(): boolean {
  return window.innerWidth < MOBILE_BREAKPOINT;
}

export function useIsMobile() {
  return React.useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(mobileQuery());
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    readMobile,
    () => false,
  );
}
