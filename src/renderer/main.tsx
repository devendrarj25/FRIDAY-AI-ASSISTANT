import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
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
