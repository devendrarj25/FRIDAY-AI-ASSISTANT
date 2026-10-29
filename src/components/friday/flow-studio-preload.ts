/** Warm the Flow Studio chunk when the owner points at a Flow button, so opening is instant. */
export function preloadFlowStudio(): void {
  void import("@/components/friday/FlowStudio");
}
