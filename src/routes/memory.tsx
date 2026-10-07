import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/friday/AppShell";
import { MemoryConsole } from "@/components/friday/MemoryConsole";

export const Route = createFileRoute("/memory")({
  head: () => ({
    meta: [
      { title: "Memory — FRIDAY Console" },
      {
        name: "description",
        content:
          "FRIDAY's six-tier memory, brain recall records, vector index and teach/export tools.",
      },
      { property: "og:title", content: "Memory — FRIDAY Console" },
      {
        property: "og:description",
        content: "Search, teach, index and transfer what FRIDAY remembers.",
      },
    ],
  }),
  component: MemoryPage,
});

function MemoryPage() {
  return (
    <AppShell
      title="Memory"
      subtitle="Six-tier store, brain recall, vector index — one operational console"
    >
      <MemoryConsole />
    </AppShell>
  );
}
