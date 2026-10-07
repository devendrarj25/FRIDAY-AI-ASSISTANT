import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { readCanonicalIdentity } = require("./scripts/release-engine.cjs") as {
  readCanonicalIdentity: (opts?: { version?: string }) => { releaseVersion: string } | null;
};
const identity = readCanonicalIdentity();
if (!identity?.releaseVersion) {
  throw new Error("config/friday-version.json is the canonical version source and is missing.");
}

/**
 * Renderer bundle for the Electron desktop app.
 *
 * The web build (vite.config.ts) produces an SSR/Nitro server, which cannot be
 * loaded over file:// inside Electron. This config builds the exact same routes
 * as a self-contained client-only bundle in dist-desktop/ with relative asset
 * paths. The web build is untouched.
 */
export default defineConfig({
  base: "./",
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      routesDirectory: resolve(import.meta.dirname, "src/routes"),
      generatedRouteTree: resolve(import.meta.dirname, "src/routeTree.gen.ts"),
    }),
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "@": resolve(import.meta.dirname, "src") } },
  // Tells the shared root route to render a fragment instead of a second
  // <html>/<body> pair, because this bundle mounts inside an existing document.
  define: {
    "import.meta.env.VITE_DESKTOP_SHELL": JSON.stringify("1"),
    __FRIDAY_VERSION__: JSON.stringify(identity.releaseVersion),
    __FRIDAY_BUILD__: JSON.stringify(new Date().toISOString().slice(0, 10).replace(/-/g, ".")),
  },
  root: resolve(import.meta.dirname, "src/renderer"),
  // The renderer root is src/renderer, so Vite would look for static assets in
  // src/renderer/public and silently drop the real ones. The project's public/
  // folder holds the shipped character artwork (public/character/friday/base.png)
  // which MUST land in dist-desktop/character/friday/ for the packaged EXE.
  publicDir: resolve(import.meta.dirname, "public"),
  build: {
    outDir: resolve(import.meta.dirname, "dist-desktop"),
    emptyOutDir: true,
    // Keep production crash stacks actionable in the installed desktop app.
    sourcemap: true,
  },
});
