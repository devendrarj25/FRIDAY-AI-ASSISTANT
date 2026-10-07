/**
 * FRIDAY — web/dev build config.
 *
 * The Windows desktop app is built by vite.electron.config.ts; this file only
 * serves the development preview and the SSR web bundle. Plugins are declared
 * here with the public Vite / TanStack / Nitro APIs. Nothing in this file is
 * shipped inside the FRIDAY EXE.
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { nitro } from "nitro/vite";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { isExpectedClientAbort } from "./src/lib/client-abort.ts";

const require = createRequire(import.meta.url);
const { readCanonicalIdentity } = require("./scripts/release-engine.cjs") as {
  readCanonicalIdentity: (opts?: { version?: string }) => { releaseVersion: string } | null;
};
const identity = readCanonicalIdentity();
if (!identity?.releaseVersion) {
  throw new Error("config/friday-version.json is the canonical version source and is missing.");
}

// Dev-only guard: FRIDAY keeps top-level runtime folders (plugins/, skills/, agents/,
// tools/, modules/, workflows/ ...) at the project root. Vite's static/transform
// middleware happily serves e.g. `plugins/index.ts` for a navigation to `/plugins`,
// which shadows the React route and produces a blank screen in the preview.
// We hide the URL from the static layer and restore it before the SSR router runs.
const navGuard = {
  name: "friday-nav-route-guard",
  enforce: "pre" as const,
  apply: "serve" as const,
  configureServer(server: {
    httpServer?: {
      prependListener: (
        event: "request",
        listener: (req: {
          on: (event: "error", listener: (error: Error & { code?: string }) => void) => void;
        }) => void,
      ) => void;
    } | null;
    middlewares: {
      use: (
        fn: (
          req: {
            method?: string;
            url?: string;
            headers?: Record<string, unknown>;
            on?: (event: "error", listener: (error: Error & { code?: string }) => void) => void;
          },
          res: unknown,
          next: () => void,
        ) => void,
      ) => void;
    };
  }) {
    const MASK = "/__friday_nav__";
    const absorbExpectedDisconnect = (error: Error & { code?: string }) => {
      if (isExpectedClientAbort(error)) return;
      console.error(error);
    };

    // Attach an observer before Vite's request handler. Crucially, do not
    // replace IncomingMessage.emit or install process-wide exception hooks:
    // TanStack/h3 must still receive the abort event to cancel SSR and release
    // the stream. The listener only prevents Node's no-listener fatal path.
    server.httpServer?.prependListener("request", (req) => {
      req.on("error", absorbExpectedDisconnect);
    });

    // Requests that are still queued on a socket (pipelined, or parsed but not
    // yet dispatched) never fire "request", so they cannot get the listener
    // above. When the browser closes such a socket, Node's abortIncoming emits
    // `Error: aborted` on a request with no error listener, which becomes an
    // uncaught exception and kills the dev SSR process (blank screen).
    // Swallow ONLY that exact signature; anything else keeps Node's behaviour.
    const g = globalThis as typeof globalThis & { __fridayAbortGuard?: boolean };
    if (!g.__fridayAbortGuard) {
      g.__fridayAbortGuard = true;
      process.on("uncaughtException", (error: Error) => {
        if (isExpectedClientAbort(error) && /abortIncoming|socketOnClose/.test(error.stack ?? "")) {
          return;
        }
        // Not a client disconnect: restore Node's default fatal behaviour.
        console.error(error);
        process.exit(1);
      });
    }

    server.middlewares.use((req, _res, next) => {
      // Node raises a client navigation/refresh that closes an incomplete HTTP
      // request as `Error: aborted` from abortIncoming. This happens before the
      // request is converted to a Web Request and therefore cannot be caught by
      // src/server.ts. Handle it on the raw IncomingMessage at the first Vite
      // middleware boundary so a routine disconnect cannot become a runtime
      // overlay or blank screen.
      const accept = String(req.headers?.["accept"] ?? "");
      if (
        req.method === "GET" &&
        accept.includes("text/html") &&
        typeof req.url === "string" &&
        req.url !== "/" &&
        !req.url.startsWith(MASK)
      ) {
        req.url = MASK + req.url;
      }
      next();
    });
    return () => {
      server.middlewares.use((req, _res, next) => {
        if (typeof req.url === "string" && req.url.startsWith(MASK)) {
          req.url = req.url.slice(MASK.length) || "/";
        }
        next();
      });
    };
  },
};

export default defineConfig(({ command }) => ({
  server: {
    host: "::",
    port: 8080,
  },
  resolve: {
    alias: { "@": resolve(import.meta.dirname, "src") },
    dedupe: [
      "react",
      "react-dom",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
      "@tanstack/react-query",
      "@tanstack/query-core",
    ],
  },
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react-dom/client",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
    ],
  },
  define: {
    __FRIDAY_VERSION__: JSON.stringify(identity.releaseVersion),
    __FRIDAY_BUILD__: JSON.stringify(new Date().toISOString().slice(0, 10).replace(/-/g, ".")),
  },
  plugins: [
    navGuard,
    tailwindcss(),
    tsconfigPaths({ projects: ["./tsconfig.json"] }),
    tanstackStart({
      server: { entry: "server" },
    }),
    command === "build" ? nitro() : null,
    react(),
  ],
}));
