declare module "elkjs/lib/elk.bundled.js" {
  const ElkBundled: new () => {
    layout(graph: {
      id: string;
      layoutOptions?: Record<string, string>;
      children: { id: string; width: number; height: number }[];
      edges: { id: string; sources: string[]; targets: string[] }[];
    }): Promise<{ children?: { id: string; x?: number; y?: number }[] }>;
  };
  export default ElkBundled;
}
