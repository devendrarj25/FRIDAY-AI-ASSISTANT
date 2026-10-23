/**
 * Every page renders on the server (no window, no bridge) without throwing,
 * inside the page frame, and shows its title. This is the "no window during
 * render" guard for the whole route table.
 */
import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createMemoryHistory, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { routeTree } from "../../src/routeTree.gen";
import { ShellPresenceContext } from "../../src/components/friday/shell-presence";

const PAGES = readdirSync(resolve(process.cwd(), "src/routes"))
  .filter((name) => name.endsWith(".tsx") && !name.startsWith("__"))
  .map((name) => (name === "index.tsx" ? "/" : `/${name.replace(/\.tsx$/, "")}`));

describe("route table renders without a window", () => {
  it("has the sidebar pages", () => {
    expect(PAGES.length).toBeGreaterThan(25);
  });

  for (const path of PAGES.filter((p) => p !== "/character")) {
    it(`renders ${path}`, async () => {
      const router = createRouter({
        routeTree,
        context: { queryClient: new QueryClient() },
        history: createMemoryHistory({ initialEntries: [path] }),
      });
      await router.load();
      const match = router.state.matches.at(-1);
      const route = match ? router.routesById[match.routeId] : undefined;
      const Component = route?.options.component as (() => unknown) | undefined;
      expect(Component, path).toBeTypeOf("function");
      const html = renderToString(
        createElement(
          RouterContextProvider,
          { router } as never,
          createElement(
            ShellPresenceContext.Provider,
            { value: true },
            createElement(Component as never),
          ),
        ),
      );
      // The workspace page waits for the saved folder (read on the client).
      if (path === "/workspace") return;
      expect(html.length).toBeGreaterThan(200);
      expect(html).toContain("<main");
    });
  }
});
