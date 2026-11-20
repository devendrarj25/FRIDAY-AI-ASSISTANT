import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import "@/lib/friday/fonts";
import "@/styles.css";

window.addEventListener("securitypolicyviolation", (event) => {
  void window.friday?.reportCspViolation?.({
    directive: event.effectiveDirective,
    blocked: event.blockedURI,
    source: event.sourceFile,
  });
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The static splash (index.html) hands over to the boot screen. If the interface never gets that far the splash
// must not hide a failure screen for ever, so it leaves after a while either way.
window.setTimeout(() => document.getElementById("friday-splash")?.remove(), 15000);
