/**
 * One footer for both route-tree writers.
 * The desktop Vite plugin and the web Start plugin both rewrite
 * src/routeTree.gen.ts. The Start plugin appends this block. The desktop
 * plugin must append the same bytes, or a desktop build dirties the tree.
 */
const ROUTE_TREE_START_FOOTER = `import type { getRouter } from './router.tsx'
import type { startInstance } from './start.ts'
declare module '@tanstack/react-start' {
  interface Register {
    ssr: true
    router: Awaited<ReturnType<typeof getRouter>>
    config: Awaited<ReturnType<typeof startInstance.getOptions>>
  }
}`;

module.exports = { ROUTE_TREE_START_FOOTER };
