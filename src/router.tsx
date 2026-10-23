import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { RouteError } from "./components/friday/PageStates";
import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  const queryClient = new QueryClient();

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    // Hovering a sidebar entry warms its lazy chunk, so switching sections is
    // instant instead of showing a blank frame while the chunk downloads.
    // A route that throws shows the message, Retry and a way back inside the shell.
    defaultErrorComponent: RouteError,
    defaultPreload: "intent",
    defaultPreloadDelay: 40,
    defaultPreloadStaleTime: 0,
  });

  return router;
};
