import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createRouter, createMemoryHistory } from "@tanstack/react-router";

import { RouteError, RoutePending } from "@/components/friday/PageStates";
import { routeTree } from "@/routeTree.gen";

/**
 * FRIDAY desktop renderer root.
 *
 * file:// has no server to resolve paths against, so the desktop shell drives
 * navigation through an in-memory history instead of the URL bar.
 */
export const queryClient = new QueryClient();

export const router = createRouter({
  routeTree,
  context: { queryClient },
  history: createMemoryHistory({ initialEntries: ["/"] }),
  scrollRestoration: true,
  // A route that throws shows the message, Retry and a way back inside the shell. A section that is slow
  // to arrive shows a waiting state after 200 ms, and keeps it for at least 300 ms so it never flashes.
  defaultErrorComponent: RouteError,
  defaultPendingComponent: RoutePending,
  defaultPendingMs: 200,
  defaultPendingMinMs: 300,
  // Warm each section's lazy chunk on hover so clicks in the packaged app open
  // instantly instead of blocking on a chunk fetch.
  defaultPreload: "intent",
  defaultPreloadDelay: 40,
  defaultPreloadStaleTime: 0,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
